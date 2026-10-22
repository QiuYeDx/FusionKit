/**
 * What each local model can be used for. The shared catalog only pins the files; this table, Studio's own, says
 * which models transcribe whole media and which choices they support. The settings offer only what fits, the main
 * process refuses a request that does not (task-service), and recognizing cues again reads it too.
 * Shared by the renderer and the main process, so it imports nothing.
 */
export interface TranscriptionModelProfile {
  /** "transcribe": whole media, timed cues. "recognize": only recognizing existing cues again. */
  readonly role: 'transcribe' | 'recognize';
  /** The spoken languages it can be told; a locked set leaves out automatic detection. */
  readonly languages: 'any' | readonly string[];
  /** Whether it can translate speech to English. */
  readonly translate: boolean;
  /** Whether a context hint (initial prompt) may be sent. */
  readonly prompt: 'allow' | 'forbid';
  /** "none": its segments have no usable times (records/model-smoke.md), so cues keep their own. */
  readonly timestamps: 'model' | 'none';
  readonly experimental: boolean;
  /** What it suits, and a notice when its training data limits use. */
  readonly scenarioKey?: TranscriptionModelScenarioKey;
  readonly licenseKey?: TranscriptionModelLicenseKey;
}
export type TranscriptionModelScenarioKey = 'studio:transcription.model_scenario_fast' | 'studio:transcription.model_scenario_chinese'
  | 'studio:transcription.model_scenario_anime';
export type TranscriptionModelLicenseKey = 'studio:transcription.model_license_belle' | 'studio:transcription.model_license_anime';

const WHOLE_MEDIA: TranscriptionModelProfile = Object.freeze({ role: 'transcribe', languages: 'any', translate: true, prompt: 'allow',
  timestamps: 'model', experimental: false });
const PROFILES: ReadonlyMap<string, TranscriptionModelProfile> = new Map<string, TranscriptionModelProfile>([
  ['large-v3-q5_0', WHOLE_MEDIA],
  ['large-v3', WHOLE_MEDIA],
  // Trained without the translate task.
  ['large-v3-turbo-q8_0', Object.freeze({ ...WHOLE_MEDIA, translate: false, scenarioKey: 'studio:transcription.model_scenario_fast' })],
  // One segment per 30 s window, so only cues that already have times.
  ['belle-large-v3-turbo-zh', Object.freeze({ role: 'recognize', languages: Object.freeze(['zh']), translate: false, prompt: 'allow',
    timestamps: 'none', experimental: true, scenarioKey: 'studio:transcription.model_scenario_chinese',
    licenseKey: 'studio:transcription.model_license_belle' })],
  // Trained without prompts or timestamps; long audio breaks down, single cues work.
  ['anime-whisper-q8_0', Object.freeze({ role: 'recognize', languages: Object.freeze(['ja']), translate: false, prompt: 'forbid',
    timestamps: 'none', experimental: true, scenarioKey: 'studio:transcription.model_scenario_anime',
    licenseKey: 'studio:transcription.model_license_anime' })],
]);

/** The model's profile; one this version does not know may do whatever a whole-media model may. */
export function transcriptionModelProfile(modelId: string): TranscriptionModelProfile {
  return PROFILES.get(modelId) ?? WHOLE_MEDIA;
}

/** Whether the model can be told this language ("auto" only when it is not locked). */
export function transcriptionModelSpeaks(profile: TranscriptionModelProfile, language: string): boolean {
  return profile.languages === 'any' || profile.languages.includes(language);
}

interface ModelChoices {
  readonly modelId: string; readonly language: string; readonly taskMode: 'transcribe' | 'translate_to_english';
  readonly advanced: { readonly initialPrompt?: string };
}
export type TranscriptionModelMismatch = 'recognize_only' | 'translate' | 'prompt' | 'language';

/** The first choice in a transcription request its model (or the profile given) does not support, or null when it fits. */
export function transcriptionModelMismatch(config: ModelChoices, profile = transcriptionModelProfile(config.modelId)): TranscriptionModelMismatch | null {
  if (profile.role !== 'transcribe') return 'recognize_only';
  if (config.taskMode === 'translate_to_english' && !profile.translate) return 'translate';
  // Any hint is sent as a prompt, an empty one too.
  if (profile.prompt === 'forbid' && config.advanced.initialPrompt !== undefined) return 'prompt';
  if (!transcriptionModelSpeaks(profile, config.language)) return 'language';
  return null;
}

/**
 * The choices with what the model cannot do set back: the original language instead of English, the model's own
 * language, no hint. The model itself is kept; a recognize-only one still does not fit (transcriptionModelMismatch).
 */
export function fitTranscriptionConfig<T extends ModelChoices>(config: T): T {
  const profile = transcriptionModelProfile(config.modelId);
  let fitted: T = config;
  if (fitted.taskMode === 'translate_to_english' && !profile.translate) fitted = { ...fitted, taskMode: 'transcribe' } as T;
  if (!transcriptionModelSpeaks(profile, fitted.language)) fitted = { ...fitted, language: (profile.languages as readonly string[])[0]! } as T;
  if (profile.prompt === 'forbid' && fitted.advanced.initialPrompt !== undefined) {
    const { initialPrompt: _hint, ...advanced } = fitted.advanced;
    fitted = { ...fitted, advanced } as T;
  }
  return fitted;
}
