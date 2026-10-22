import { describe, expect, it } from 'vitest';
import {
  conditionQuietPcm16,
  conditionWhisperPcm16,
} from '../../../electron/main/subtitle-studio/transcription/native/quiet-audio';
import { MODERATE_SIGNAL, TRANSIENT_SIGNAL, WHISPER_SIGNAL, quietSignal } from './quietAudioSignals';

type Range = readonly [number, number];
const CEILING = Math.ceil(32768 * 10 ** (-1 / 20));
const ms = (value: number) => value * 16;

function peak(pcm: Buffer, [start, end]: Range = [0, pcm.length / 2]) {
  let value = 0;
  for (let i = start; i < end; i++) value = Math.max(value, Math.abs(pcm.readInt16LE(i * 2)));
  return value;
}
function rmsDb(pcm: Buffer, [start, end]: Range) {
  let energy = 0;
  for (let i = start; i < end; i++) energy += (pcm.readInt16LE(i * 2) / 32768) ** 2;
  return 10 * Math.log10(energy / (end - start));
}
const boostDb = (input: Buffer, output: Buffer, range: Range) => rmsDb(output, range) - rmsDb(input, range);
function tone(amplitude: number, samples: number) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * i / 40)), i * 2);
  return pcm;
}

describe('gated quiet PCM conditioning', () => {
  it('boosts -65 dBFS speech the whole-window policy skips, keeping samples, positions and digital silence', () => {
    const { pcm: input, speech } = quietSignal(WHISPER_SIGNAL, -90);
    input.fill(0, 0, ms(300) * 2);
    const before = Buffer.from(input);
    expect(conditionQuietPcm16(input).gainDb).toBe(0);
    const result = conditionWhisperPcm16(input);
    expect(result.gainDb).toBe(30);
    expect(result.pcm.length).toBe(input.length);
    expect(input.equals(before)).toBe(true);
    expect(result.pcm.subarray(0, ms(300) * 2).every(value => value === 0)).toBe(true);
    for (const range of speech) expect(boostDb(input, result.pcm, range)).toBeGreaterThan(29.5);
    // A gain never flips a sample's sign or moves it in time.
    for (let i = 0; i < input.length; i += 2) {
      const original = input.readInt16LE(i), boosted = result.pcm.readInt16LE(i);
      expect(Math.sign(boosted) === Math.sign(original) || boosted === 0).toBe(true);
    }
    expect(peak(result.pcm)).toBeLessThanOrEqual(CEILING);
    expect(conditionWhisperPcm16(input).pcm.equals(result.pcm)).toBe(true);
  });

  it('raises noise-floor frames away from speech by at most 6 dB but holds full gain around speech', () => {
    const { pcm: input, speech } = quietSignal(MODERATE_SIGNAL, -75);
    const result = conditionWhisperPcm16(input);
    expect(result.gainDb).toBeGreaterThan(10);
    expect(result.gainDb).toBeLessThan(30);
    const [first, second] = speech as [Range, Range];
    const far: Range[] = [[0, first[0] - ms(400)], [first[1] + ms(400), second[0] - ms(400)], [second[1] + ms(400), input.length / 2]];
    for (const [start, end] of far) {
      expect(end - start).toBeGreaterThanOrEqual(ms(400));
      for (let i = start; i < end; i++) {
        expect(Math.abs(result.pcm.readInt16LE(i * 2))).toBeLessThanOrEqual(Math.abs(input.readInt16LE(i * 2)) * 10 ** (6 / 20) + 0.5);
      }
    }
    for (const range of speech) expect(boostDb(input, result.pcm, range)).toBeCloseTo(result.gainDb, 0);
    // 100 ms lead before and 250 ms hold after the active frames.
    expect(boostDb(input, result.pcm, [first[0] - ms(50), first[0]])).toBeGreaterThan(result.gainDb - 1);
    expect(boostDb(input, result.pcm, [first[1], first[1] + ms(150)])).toBeGreaterThan(result.gainDb - 1);
    expect(peak(result.pcm)).toBeLessThanOrEqual(CEILING);
  });

  it('boosts a quiet window with strong transients that the whole-window policy refuses', () => {
    const { pcm: input, speech, clicks } = quietSignal(TRANSIENT_SIGNAL, -80);
    expect(conditionQuietPcm16(input).gainDb).toBe(0);
    const result = conditionWhisperPcm16(input);
    expect(result.gainDb).toBeGreaterThan(15);
    expect(peak(result.pcm)).toBeLessThanOrEqual(CEILING);
    for (const range of clicks) {
      expect(peak(result.pcm, range)).toBeLessThanOrEqual(CEILING);
      // The frame peak limit, not the soft knee, holds each click under -1 dBFS.
      expect(boostDb(input, result.pcm, range)).toBeLessThanOrEqual(20 * Math.log10(10 ** (-1 / 20) / 0.5));
    }
    // Away from the clicks the speech keeps the full gain.
    for (const [start, end] of speech) {
      const near = clicks.filter(([clickStart, clickEnd]) => clickEnd >= start - ms(60) && clickStart <= end + ms(60));
      const clear: Range = [near.some(([, clickEnd]) => clickEnd <= start) ? start + ms(60) : start,
        near.some(([clickStart]) => clickStart >= end) ? end - ms(60) : end];
      expect(boostDb(input, result.pcm, clear)).toBeCloseTo(result.gainDb, 0);
    }
  });

  it('returns silence, full scale, very short, normal-level and too little speech unchanged', () => {
    const fullScale = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++) fullScale.writeInt16LE(i % 2 ? 32767 : -32768, i * 2);
    const brief = quietSignal([{ pauseMs: 1300 }, { speechMs: 300, rmsDb: -65 }, { pauseMs: 1400 }], -90).pcm;
    const normal = quietSignal(MODERATE_SIGNAL.map(part => 'rmsDb' in part ? { ...part, rmsDb: -20 } : part), -55).pcm;
    for (const input of [Buffer.alloc(32000), fullScale, Buffer.alloc(2, 1), tone(20, 100), tone(20, 7999), brief, normal, tone(2, 16000)]) {
      const result = conditionWhisperPcm16(input);
      expect(result.pcm).toBe(input);
      expect(result.gainDb).toBe(0);
    }
  });

  it('rejects unbounded or malformed PCM', () => {
    for (const input of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(960002)]) expect(() => conditionWhisperPcm16(input)).toThrow(TypeError);
  });
});
