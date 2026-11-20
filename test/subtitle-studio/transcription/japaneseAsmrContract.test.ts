import { describe, expect, it } from 'vitest';
import { enqueueTranscriptionRequestSchema } from '../../../src/subtitle-studio/transcription/task-contract';
import { transcriptionModelMismatch } from '../../../src/subtitle-studio/transcription-model-profiles';

const config = {
  mode: 'japanese_asmr' as const,
  modelId: 'anime-whisper-q8_0',
  devicePreference: 'auto' as const,
  language: 'ja',
  taskMode: 'transcribe' as const,
  vadEnabled: true,
  advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 300, maxCueDurationMs: 10_000, maxCueChars: 80, maxLineChars: 40 },
};

describe('Japanese ASMR transcription contract', () => {
  it('accepts the fixed two-stage model combination', () => {
    const result = enqueueTranscriptionRequestSchema.safeParse({ files: [{ fileToken: 'file-1' }], config });
    expect(result.success).toBe(true);
    expect(transcriptionModelMismatch(config)).toBeNull();
  });

  it('keeps the legacy standard request unchanged', () => {
    const result = enqueueTranscriptionRequestSchema.safeParse({ files: [{ fileToken: 'file-1' }], config: { ...config, mode: undefined, modelId: 'large-v3-q5_0', language: 'auto' } });
    expect(result.success).toBe(true);
  });

  it('rejects changing the Japanese ASMR content model or language', () => {
    const result = enqueueTranscriptionRequestSchema.safeParse({ files: [{ fileToken: 'file-1' }], config: { ...config, modelId: 'large-v3-q5_0' } });
    expect(result.success).toBe(false);
  });
});
