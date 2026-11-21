import { DEFAULT_AGENT_TRANSCRIPTION_MODE, JAPANESE_ASMR_MODEL_ID, STUDIO_TRANSCRIPTION_MODES, type StudioTranscriptionMode } from '../../subtitle-studio/transcription/japanese-asmr-contract';
import { transcriptionTaskConfigSchema, type EnqueueTranscriptionRequest } from '../../subtitle-studio/transcription/task-contract';
import { transcriptionModelMismatch } from '../../subtitle-studio/transcription-model-profiles';
import { effectiveTranscriptionConfig, type StudioTranscriptionState } from './transcription-controller';

type Config = EnqueueTranscriptionRequest['config'];

/**
 * A transcription batch a caller other than the page asks for. The mode is the caller's own choice: leaving it out
 * follows the user's setting for assistant transcription, never whatever mode the page happens to show.
 */
export interface AgentTranscriptionRequest {
  readonly mode?: StudioTranscriptionMode;
  readonly modelId?: string;
  readonly language?: string;
  readonly devicePreference?: Config['devicePreference'];
  readonly taskMode?: Config['taskMode'];
  readonly initialPrompt?: string;
}
/** Settings only the standard pipeline has; Japanese/ASMR fixes them itself. */
const STANDARD_ONLY_SETTINGS = ['modelId', 'language', 'taskMode', 'initialPrompt'] as const;
export type StandardOnlySetting = typeof STANDARD_ONLY_SETTINGS[number];

export type AgentTranscriptionPlan =
  | { readonly ok: true; readonly mode: StudioTranscriptionMode; readonly config: Config
    /** Settings the caller named that the mode does not have, so it did not use them. */
    readonly ignoredSettings?: readonly StandardOnlySetting[] }
  | { readonly ok: false; readonly error: string; readonly hint?: string };

const MODE_LABELS: Readonly<Record<StudioTranscriptionMode, string>> = { standard: 'standard', japanese_asmr: 'Japanese/ASMR' };

/**
 * The mode and config one batch runs with. `defaultMode` is what the user chose in Settings for batches that name no
 * mode (the workspace default when unset).
 *
 * The mode decides the pipeline, and nothing else does. A setting only the standard pipeline has is never used by the
 * Japanese/ASMR pipeline, and it does not change which pipeline runs either: a caller that passes one alongside
 * Japanese/ASMR just gets Japanese/ASMR with that setting unused. Models routinely send such arguments imprecisely,
 * and a stray argument must not fail the batch or quietly redirect it. `ignoredSettings` reports what went unused, so
 * the caller can correct itself on the next call.
 */
export function planAgentTranscription(state: Pick<StudioTranscriptionState, 'config' | 'asmrDevice'>, input: AgentTranscriptionRequest,
  defaultMode: StudioTranscriptionMode = DEFAULT_AGENT_TRANSCRIPTION_MODE): AgentTranscriptionPlan {
  const mode = input.mode ?? defaultMode;
  if (!STUDIO_TRANSCRIPTION_MODES.includes(mode)) return { ok: false, error: 'studio_transcription_mode_invalid' };
  if (mode !== 'japanese_asmr') return standardPlan(state, input);
  // A value equal to what the pipeline uses anyway is not worth reporting as unused.
  const ignored = STANDARD_ONLY_SETTINGS.filter(key => key === 'initialPrompt' ? input.initialPrompt !== undefined
    : key === 'modelId' ? !!input.modelId && input.modelId !== JAPANESE_ASMR_MODEL_ID
      : key === 'language' ? !!input.language && input.language !== 'ja'
        : !!input.taskMode && input.taskMode !== 'transcribe');
  return { ok: true, mode, config: effectiveTranscriptionConfig({ config: state.config, mode, asmrDevice: input.devicePreference ?? state.asmrDevice }),
    ...(ignored.length ? { ignoredSettings: ignored } : {}) };
}

/** The standard pipeline: the page's settings, with what the caller named applied over them. */
function standardPlan(state: Pick<StudioTranscriptionState, 'config'>, input: AgentTranscriptionRequest): AgentTranscriptionPlan {
  // The page's own mode field is not carried over: absence means standard.
  const { mode: _pageMode, ...pageConfig } = state.config;
  const config = { ...pageConfig, ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.language ? { language: input.language } : {}),
    ...(input.devicePreference ? { devicePreference: input.devicePreference } : {}),
    // Omitted task mode and prompt keep the Studio transcription settings.
    ...(input.taskMode ? { taskMode: input.taskMode } : {}),
    advanced: { ...state.config.advanced, ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}) } };
  const parsed = transcriptionTaskConfigSchema.safeParse(config);
  if (!parsed.success) return { ok: false, error: 'studio_transcription_configuration_invalid' };
  return { ok: true, mode: 'standard', config: parsed.data };
}

/** Why the chosen model cannot take this batch, when the caller asked for what it cannot do. */
export function agentTranscriptionMismatch(plan: Extract<AgentTranscriptionPlan, { ok: true }>, input: AgentTranscriptionRequest) {
  const mismatch = transcriptionModelMismatch(plan.config);
  if (!mismatch) return null;
  if (mismatch === 'language' && !input.language) return null;
  if (mismatch === 'translate' && !input.taskMode) return null;
  if (mismatch === 'prompt' && input.initialPrompt === undefined) return null;
  return mismatch;
}

export const agentTranscriptionModeLabel = (mode: StudioTranscriptionMode) => MODE_LABELS[mode];
