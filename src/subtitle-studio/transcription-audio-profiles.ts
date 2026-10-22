/**
 * The audio types a transcription can be tuned for. "Standard" sends no profile and keeps the verified
 * defaults; each profile adds fixed voice-detection and decoder fields (main process: server-contract).
 * Shared by the renderer and the main process, so it imports nothing.
 */
export const TRANSCRIPTION_AUDIO_PROFILES = ['quiet_whisper_v1', 'noisy_music_v1'] as const;
export type TranscriptionAudioProfile = typeof TRANSCRIPTION_AUDIO_PROFILES[number];
export type TranscriptionAudioType = 'standard' | TranscriptionAudioProfile;
/** The order the settings offer them in. */
export const TRANSCRIPTION_AUDIO_TYPES: readonly TranscriptionAudioType[] = ['standard', ...TRANSCRIPTION_AUDIO_PROFILES];

export const TRANSCRIPTION_AUDIO_TYPE_KEYS = {
  standard: { label: 'studio:transcription.audio_standard', description: 'studio:transcription.audio_standard_description',
    hint: 'studio:transcription.audio_standard_hint' },
  quiet_whisper_v1: { label: 'studio:transcription.audio_quiet', description: 'studio:transcription.audio_quiet_description',
    hint: 'studio:transcription.audio_quiet_hint', short: 'studio:transcription.audio_quiet_short' },
  noisy_music_v1: { label: 'studio:transcription.audio_noisy', description: 'studio:transcription.audio_noisy_description',
    hint: 'studio:transcription.audio_noisy_hint', short: 'studio:transcription.audio_noisy_short' },
} as const;

/** The audio type a task's advanced settings name; absent (and historical tasks) means standard. */
export function transcriptionAudioTypeOf(advanced: { readonly audioProfile?: TranscriptionAudioProfile }): TranscriptionAudioType {
  return advanced.audioProfile ?? 'standard';
}

/** The advanced settings with this audio type. Standard leaves the field out rather than setting it empty. */
export function withTranscriptionAudioType<T extends { readonly audioProfile?: TranscriptionAudioProfile }>(advanced: T, type: TranscriptionAudioType): T {
  const { audioProfile: _previous, ...rest } = advanced;
  return (type === 'standard' ? rest : { ...rest, audioProfile: type }) as T;
}
