export const STUDIO_TRANSCRIPTION_MODES = ['standard', 'japanese_asmr'] as const;
export type StudioTranscriptionMode = typeof STUDIO_TRANSCRIPTION_MODES[number];

export const JAPANESE_ASMR_MODEL_ID = 'anime-whisper-q8_0' as const;
export const JAPANESE_ASMR_VAD_MODEL_ID = 'whisper-vad-encdec-asmr-onnx' as const;
export const JAPANESE_ASMR_FRAME_DURATION_MS = 20 as const;
export const JAPANESE_ASMR_SAMPLE_RATE = 16_000 as const;

export interface JapaneseAsmrSpeechInterval {
  readonly startFrame: number;
  readonly endFrame: number;
}
