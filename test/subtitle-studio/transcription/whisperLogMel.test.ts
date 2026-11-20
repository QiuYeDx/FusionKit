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

  it('matches WhisperFeatureExtractor for short PCM with impulses at both edges', () => {
    const audio = new Float32Array(641);
    audio[1] = 0.5;
    audio[120] = -0.25;
    audio[400] = 0.5;
    audio[610] = -0.125;
    audio[640] = 0.25;
    const features = computeWhisperLogMel(audio);
    // Transformers 4.55.4 WhisperFeatureExtractor, NumPy CPU, default whisper-base settings.
    const reference = [
      [0, 0, 0.6101412773], [0, 4, 0.1931005716], [12, 2, 0.3563292623],
      [19, 0, 0.6079989076], [25, 4, 0.2829971313], [62, 1, 0.2769210339],
      [74, 4, 0.2780908942], [79, 5, -0.2097108364], [79, 6, -1.3732719421],
      [79, 2999, -1.3732719421],
    ] as const;
    for (const [band, frame, expected] of reference) {
      expect(features[band * WHISPER_MAX_FRAMES + frame]).toBeCloseTo(expected, 5);
    }
  });

  it('pads empty input without producing NaN', () => {
    const features = computeWhisperLogMel(new Float32Array(), 4);
    expect(features).toHaveLength(WHISPER_FEATURE_SIZE * 4);
    expect([...features].every(Number.isFinite)).toBe(true);
  });
});
