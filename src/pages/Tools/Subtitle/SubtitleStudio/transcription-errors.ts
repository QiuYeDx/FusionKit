import type { HelpSectionId } from '@/pages/Help/helpNavigation';
import { LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES } from '@/subtitle-studio/transcription/domain';
import type { TranscriptionTaskSummary } from '@/subtitle-studio/transcription/task-contract';
import { vcRuntimeMayExplain } from './transcription-hints';

/**
 * Why a transcription task or a resource job failed, in plain words, and what to do next, by the
 * error's code. The Studio cannot use the classic transcriber's guide (it is outside the Studio's
 * boundaries, and its words name the classic page's own controls), so this one names the Studio's:
 * "Manage resources", "Device", one-click prepare. Only a code this version does not know gets the
 * generic text. Every task failure offers to copy its diagnostics for a report.
 */
export type StudioErrorAction = 'open_resources' | 'open_help';

const TASK_GROUPS = [
  'runtime', 'unsupported', 'crashed', 'accelerator', 'model_missing', 'model_broken', 'not_allowed', 'busy', 'disk',
  'memory', 'authorization', 'media', 'no_audio', 'media_changed', 'transcription', 'quality', 'limit', 'save', 'interrupted',
  'page_stale',
] as const;
type TaskGroup = (typeof TASK_GROUPS)[number];

export type TaskErrorCauseKey = `studio:transcription.task_error.${TaskGroup}.cause` | 'studio:transcription.task_failed' | 'studio:transcription.vc_runtime_failure';
export type TaskErrorNextKey = `studio:transcription.task_error.${TaskGroup | 'unknown'}.next`;

const TASK_GROUP_OF_CODE: Readonly<Record<string, TaskGroup>> = {
  runtime_missing: 'runtime', runtime_protocol_mismatch: 'runtime', media_runtime_missing: 'runtime',
  media_runtime_invalid: 'runtime', media_runtime_launch_failed: 'runtime',
  unsupported_platform: 'unsupported', unsupported_architecture: 'unsupported',
  runtime_crashed: 'crashed', runtime_unresponsive: 'crashed',
  accelerator_unavailable: 'accelerator', backend_mismatch: 'accelerator', backend_unverified: 'accelerator',
  model_missing: 'model_missing', model_download_failed: 'model_missing',
  model_incompatible: 'model_broken', model_corrupt: 'model_broken', resource_signature_invalid: 'model_broken',
  resource_not_allowed: 'not_allowed',
  resource_busy: 'busy',
  model_disk_full: 'disk', insufficient_disk: 'disk',
  out_of_memory: 'memory',
  authorization_expired: 'authorization', access_denied: 'authorization',
  media_probe_failed: 'media', media_decode_failed: 'media', unsupported_media: 'media',
  no_audio_stream: 'no_audio',
  media_changed: 'media_changed',
  transcription_failed: 'transcription', transcript_quality_failed: 'quality',
  limit_exceeded: 'limit', content_too_large: 'limit',
  output_write_failed: 'save', output_conflict: 'save', document_unavailable: 'save',
  interrupted: 'interrupted',
  invalid_ipc_request: 'page_stale', owner_released: 'page_stale',
};

const TASK_GROUP_ACTIONS: Partial<Record<TaskGroup, { readonly actions: readonly StudioErrorAction[]; readonly helpSection?: HelpSectionId }>> = {
  runtime: { actions: ['open_help'], helpSection: 'transcription-failed' },
  unsupported: { actions: ['open_help'], helpSection: 'system-requirements' },
  crashed: { actions: ['open_help'], helpSection: 'transcription-failed' },
  accelerator: { actions: ['open_resources', 'open_help'], helpSection: 'transcription-failed' },
  model_missing: { actions: ['open_resources'] },
  model_broken: { actions: ['open_resources', 'open_help'], helpSection: 'transcription-failed' },
  disk: { actions: ['open_help'], helpSection: 'transcription-failed' },
  // A smaller model needs less memory.
  memory: { actions: ['open_resources'] },
  transcription: { actions: ['open_help'], helpSection: 'transcription-failed' },
};
/**
 * Where the program was already recognizing: a broken response there is one window's recognition failing
 * (garbled or repeated text, no usable answer), not a broken or mismatched program.
 */
const RECOGNITION_STAGES = new Set(['transcribing', 'post_processing']);

export interface TaskErrorGuide {
  readonly causeKey: TaskErrorCauseKey;
  readonly nextKey?: TaskErrorNextKey;
  readonly actions: readonly StudioErrorAction[];
  readonly helpSection?: HelpSectionId;
  /** No wording of its own: the code is unknown to this version. */
  readonly generic: boolean;
}

/**
 * The guide for a failed transcription task. A missing VC++ runtime explains a crashed program first. `stage` is
 * where it failed: a protocol mismatch while recognizing is a recognition quality problem, not a reinstall.
 */
export function transcriptionTaskErrorGuide(code: string | undefined, options: { readonly vcRuntimeMissing: boolean; readonly stage?: string }): TaskErrorGuide {
  if (options.vcRuntimeMissing && vcRuntimeMayExplain(code)) {
    return { causeKey: 'studio:transcription.vc_runtime_failure', actions: ['open_help'], helpSection: 'transcription-failed', generic: false };
  }
  const group = code === 'runtime_protocol_mismatch' && options.stage && RECOGNITION_STAGES.has(options.stage) ? 'quality'
    : code ? TASK_GROUP_OF_CODE[code] : undefined;
  if (!group) return { causeKey: 'studio:transcription.task_failed', nextKey: 'studio:transcription.task_error.unknown.next', actions: [], generic: true };
  const extra = TASK_GROUP_ACTIONS[group];
  return {
    causeKey: `studio:transcription.task_error.${group}.cause`,
    nextKey: `studio:transcription.task_error.${group}.next`,
    actions: extra?.actions ?? [],
    ...(extra?.helpSection ? { helpSection: extra.helpSection } : {}),
    generic: false,
  };
}

export type ResourceErrorKey =
  | 'studio:transcription.resource_failed' | 'studio:transcription.resource_failed_disk' | 'studio:transcription.resource_failed_vad_needs_model'
  | 'studio:transcription.vc_runtime_failure' | 'studio:transcription.resource_import_mismatch' | 'studio:transcription.resource_import_failed'
  | 'studio:transcription.resource_failed_network' | 'studio:transcription.resource_failed_verify' | 'studio:transcription.resource_failed_accelerator'
  | 'studio:transcription.resource_failed_load' | 'studio:transcription.resource_failed_runtime' | 'studio:transcription.resource_failed_not_allowed'
  | 'studio:transcription.resource_failed_memory' | 'studio:transcription.resource_failed_stale' | 'studio:transcription.shared_busy_error';

export interface ResourceErrorGuide {
  /** One sentence or two: what happened and what to do. */
  readonly key: ResourceErrorKey;
  /** The network settings can help (another download source, a proxy). */
  readonly network: boolean;
  readonly help?: HelpSectionId;
  readonly generic: boolean;
}

const RUNTIME_CODES = new Set(['runtime_missing', 'runtime_protocol_mismatch', 'media_runtime_missing', 'media_runtime_invalid',
  'media_runtime_launch_failed', 'unsupported_platform', 'unsupported_architecture']);
const ACCELERATOR_CODES = new Set(['accelerator_unavailable', 'backend_mismatch', 'backend_unverified']);
const LOAD_CHECK_CODES = new Set(['runtime_crashed', 'runtime_unresponsive', 'model_incompatible']);

/**
 * Why a resource job failed, so the row says what to do next instead of only "try again". Imports
 * share the download codes (a wrong file is model_corrupt, an unreadable one model_download_failed),
 * so they get their own wording; `network` says the network settings can help, `help` which help
 * section explains it further.
 */
export function resourceErrorGuide(code: string | undefined, options: { readonly imported: boolean; readonly vad: boolean; readonly vcRuntimeMissing: boolean }): ResourceErrorGuide {
  const { imported, vad, vcRuntimeMissing } = options;
  const known = (key: ResourceErrorKey, extra: { network?: boolean; help?: HelpSectionId } = {}): ResourceErrorGuide =>
    ({ key, network: extra.network ?? false, ...(extra.help ? { help: extra.help } : {}), generic: false });
  if (code === 'model_disk_full' || code === 'insufficient_disk') return known('studio:transcription.resource_failed_disk');
  // Voice detection's load check runs with the recommended model, so it can only install after it.
  if (vad && code === 'model_missing') return known('studio:transcription.resource_failed_vad_needs_model');
  if (code === 'resource_busy') return known('studio:transcription.shared_busy_error');
  // A load check that crashed the transcription program: without the VC++ runtime it does, whatever the file.
  if (vcRuntimeMissing && vcRuntimeMayExplain(code) && !(imported && code === 'model_incompatible')) {
    return known('studio:transcription.vc_runtime_failure', { help: 'transcription-failed' });
  }
  if (imported) {
    return code === 'model_corrupt' || code === 'model_incompatible'
      ? known('studio:transcription.resource_import_mismatch')
      : known('studio:transcription.resource_import_failed');
  }
  if (code === 'model_download_failed') return known('studio:transcription.resource_failed_network', { network: true, help: 'download-failed' });
  if (code === 'model_corrupt' || code === 'resource_signature_invalid') return known('studio:transcription.resource_failed_verify', { network: true, help: 'download-failed' });
  if (code && ACCELERATOR_CODES.has(code)) return known('studio:transcription.resource_failed_accelerator', { help: 'transcription-failed' });
  if (code && LOAD_CHECK_CODES.has(code)) return known('studio:transcription.resource_failed_load', { help: 'transcription-failed' });
  if (code && RUNTIME_CODES.has(code)) return known('studio:transcription.resource_failed_runtime', { help: 'transcription-failed' });
  if (code === 'resource_not_allowed') return known('studio:transcription.resource_failed_not_allowed');
  if (code === 'out_of_memory') return known('studio:transcription.resource_failed_memory');
  if (code === 'invalid_ipc_request' || code === 'owner_released') return known('studio:transcription.resource_failed_stale');
  return { key: 'studio:transcription.resource_failed', network: false, generic: true };
}

/** What "copy diagnostics" copies: the facts a report needs, one per line, without paths or file names. */
export function studioErrorDiagnostics(facts: Readonly<Record<string, string | number | undefined>>): string {
  return Object.entries(facts).filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => `${name}: ${value}`).join('\n');
}

type RetryTask = Pick<TranscriptionTaskSummary, 'status' | 'resolvedBackend' | 'audioProfile' | 'error' | 'cleanupPending'>;

/** A failed task's diagnostics: code, stage, model, device and audio type, never its file. */
export function transcriptionTaskDiagnostics(task: RetryTask & Pick<TranscriptionTaskSummary, 'modelId'>): string {
  return studioErrorDiagnostics({ code: task.error?.code, stage: task.error?.stage, model: task.modelId, device: task.resolvedBackend,
    audioType: task.audioProfile ?? 'standard' });
}

/** A failed or empty task can be submitted again from its file, unless its cleanup is still pending. */
export function transcriptionTaskRetryable(task: RetryTask): boolean {
  return (task.status === 'failed' || task.status === 'no_content') && !task.cleanupPending;
}

export type TranscriptionRetrySuggestion = 'quiet' | 'cpu';

/**
 * The one retry a result suggests: the quiet audio type for an empty result (unless it already had it), the CPU
 * for a failure the graphics card can cause. Nothing for any other result.
 */
export function transcriptionRetrySuggestion(task: RetryTask): TranscriptionRetrySuggestion | undefined {
  if (!transcriptionTaskRetryable(task)) return undefined;
  if (task.status === 'no_content') return task.audioProfile === 'quiet_whisper_v1' ? undefined : 'quiet';
  return task.resolvedBackend !== 'cpu' && task.error
    && (LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES as readonly string[]).includes(task.error.code) ? 'cpu' : undefined;
}

export const STUDIO_TASK_ERROR_GROUPS = TASK_GROUPS;
