import { describe, expect, it } from 'vitest';
import { computeWhisperLogMel, WHISPER_FEATURE_SIZE, WHISPER_MAX_FRAMES, WHISPER_SAMPLE_RATE } from '../../../src/subtitle-studio/transcription/whisper-log-mel';

describe('Whisper log-mel preparation', () => {
  it('creates the fixed 30-second CPU input layout', () => {
    const audio = new Float32Array(WHISPER_SAMPLE_RATE);
    audio[WHISPER_SAMPLE_RATE / 2] = 1;
    const features = computeWhisperLogMel(audio);
    expect(features).toHaveLength(WHISPER_FEATURE_SIZE * WHISPER_MAX_FRAMES);
    expect([...features].every(Number.isFinite)).toBe(true);
    let maximum = -Infinity;
    for (const value of features) maximum = Math.max(maximum, value);
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(1);
  });

  it('pads empty input without producing NaN', () => {
    const features = computeWhisperLogMel(new Float32Array(), 4);
    expect(features).toHaveLength(WHISPER_FEATURE_SIZE * 4);
    expect([...features].every(Number.isFinite)).toBe(true);
  });
});
