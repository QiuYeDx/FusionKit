import type { HelpSectionId } from "@/pages/Help/helpNavigation";

/**
 * Plain words for the classic transcriber's error codes: what happened and what to do next, with
 * a button where one helps. The main process reports these errors in English for the logs; the
 * notice shows this guide instead and keeps the original text, code, stage and field in its
 * copyable diagnostics.
 */
export type LocalSubtitleErrorAction = "open_network_settings" | "open_model_settings" | "open_translator" | "open_help";

export interface LocalSubtitleErrorGuide {
  readonly causeKey: LocalSubtitleErrorCauseKey;
  readonly nextKey?: LocalSubtitleErrorNextKey;
  readonly actions: readonly LocalSubtitleErrorAction[];
  readonly helpSection?: HelpSectionId;
  /** No wording of its own: the code is unknown to this version, or there is no code. */
  readonly generic: boolean;
}

const GROUPS = [
  "runtime_crashed", "accelerator", "model_missing", "model_incompatible", "verify", "download", "disk", "not_allowed",
  "authorization", "media", "no_audio", "media_changed", "transcription", "memory", "output_conflict", "output_write",
  "cleanup", "artifact", "preview", "limit", "partial", "page_stale", "translation_setup", "duplicate",
  "unsupported_format", "import_failed", "not_started", "unknown",
] as const;
type Group = (typeof GROUPS)[number];
/** Groups whose cause says it all. */
type GroupWithoutNext = "partial";
/** Groups whose next step names "Retry on CPU", for where that button is shown. */
const CPU_RETRY_GROUPS = ["runtime_crashed", "accelerator", "transcription"] as const;
type CpuRetryGroup = (typeof CPU_RETRY_GROUPS)[number];

const ENVIRONMENT_CODES = [
  "unsupported_platform", "unsupported_architecture", "runtime_missing", "runtime_protocol_mismatch",
  "media_runtime_missing", "media_runtime_invalid", "media_runtime_launch_failed",
] as const;
type EnvironmentCode = (typeof ENVIRONMENT_CODES)[number];

const POST_ACTION_CODES = ["configuration_not_ready", "directory_authorization_required", "profile_required"] as const;
type PostActionCode = (typeof POST_ACTION_CODES)[number];

export type LocalSubtitleErrorCauseKey =
  | `subtitle:local_transcriber.error_guide.${Group}.cause`
  | `subtitle:local_transcriber.environment.error.${EnvironmentCode}`
  | `subtitle:local_transcriber.post_action.error.${PostActionCode}`
  | "subtitle:local_transcriber.resources.shared_busy_error"
  | "common:transcription_empty.message";

export type LocalSubtitleErrorNextKey =
  | `subtitle:local_transcriber.error_guide.${Exclude<Group, GroupWithoutNext>}.next`
  | `subtitle:local_transcriber.error_guide.${CpuRetryGroup}.next_cpu`
  | "subtitle:local_transcriber.environment.error.recovery"
  | "common:transcription_empty.help";

const GROUP_OF_CODE: Readonly<Record<string, Group>> = {
  invalid_ipc_request: "page_stale",
  owner_released: "page_stale",
  runtime_crashed: "runtime_crashed",
  runtime_unresponsive: "runtime_crashed",
  accelerator_unavailable: "accelerator",
  backend_mismatch: "accelerator",
  backend_unverified: "accelerator",
  model_missing: "model_missing",
  model_incompatible: "model_incompatible",
  model_corrupt: "verify",
  resource_signature_invalid: "verify",
  model_download_failed: "download",
  model_disk_full: "disk",
  insufficient_disk: "disk",
  resource_not_allowed: "not_allowed",
  authorization_expired: "authorization",
  media_probe_failed: "media",
  media_decode_failed: "media",
  unsupported_media: "media",
  no_audio_stream: "no_audio",
  media_changed: "media_changed",
  transcription_failed: "transcription",
  transcript_quality_failed: "transcription",
  out_of_memory: "memory",
  output_conflict: "output_conflict",
  output_write_failed: "output_write",
  cleanup_failed: "cleanup",
  cancel_failed: "cleanup",
  artifact_expired: "artifact",
  artifact_changed: "artifact",
  content_too_large: "preview",
  invalid_content: "preview",
  limit_exceeded: "limit",
  cancelled_after_partial_commit: "partial",
  // Handing generated subtitles to the subtitle translator.
  configuration_required: "translation_setup",
  profile_unavailable: "translation_setup",
  duplicate: "duplicate",
  unsupported_format: "unsupported_format",
  import_failed: "import_failed",
  estimate_failed: "not_started",
  start_rejected: "not_started",
};

const GROUP_ACTIONS: Partial<Record<Group, { actions: readonly LocalSubtitleErrorAction[]; helpSection?: HelpSectionId }>> = {
  download: { actions: ["open_network_settings", "open_help"], helpSection: "download-failed" },
  verify: { actions: ["open_network_settings", "open_help"], helpSection: "download-failed" },
  runtime_crashed: { actions: ["open_help"], helpSection: "transcription-failed" },
  model_incompatible: { actions: ["open_help"], helpSection: "transcription-failed" },
  accelerator: { actions: ["open_help"], helpSection: "transcription-failed" },
  disk: { actions: ["open_help"], helpSection: "transcription-failed" },
  translation_setup: { actions: ["open_model_settings", "open_translator"] },
  duplicate: { actions: ["open_translator"] },
  import_failed: { actions: ["open_translator"] },
  not_started: { actions: ["open_translator"] },
};

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T => (values as readonly string[]).includes(value);

export interface LocalSubtitleErrorGuideOptions {
  /** The "Retry on CPU" button is shown next to this error, so the next step may name it. */
  readonly cpuRetry?: boolean;
}

/**
 * The guide for one error code. An error without a code, or with a code this version does not
 * know, gets the generic guide: its message is not written for the user (the classic page shows
 * thrown errors and its own English placeholders that way), so it goes to the diagnostics.
 */
export function localSubtitleErrorGuide(code: string | undefined, options: LocalSubtitleErrorGuideOptions = {}): LocalSubtitleErrorGuide {
  if (code && isOneOf(ENVIRONMENT_CODES, code)) {
    return { causeKey: `subtitle:local_transcriber.environment.error.${code}`, nextKey: "subtitle:local_transcriber.environment.error.recovery", actions: [], generic: false };
  }
  if (code && isOneOf(POST_ACTION_CODES, code)) return { causeKey: `subtitle:local_transcriber.post_action.error.${code}`, actions: [], generic: false };
  if (code === "resource_busy") return { causeKey: "subtitle:local_transcriber.resources.shared_busy_error", actions: [], generic: false };
  if (code === "no_speech_detected") return { causeKey: "common:transcription_empty.message", nextKey: "common:transcription_empty.help", actions: [], generic: false };
  const group = (code && GROUP_OF_CODE[code]) || "unknown";
  const extra = GROUP_ACTIONS[group];
  return {
    causeKey: `subtitle:local_transcriber.error_guide.${group}.cause`,
    ...nextKeyOf(group, options.cpuRetry === true),
    actions: extra?.actions ?? [],
    ...(extra?.helpSection ? { helpSection: extra.helpSection } : {}),
    generic: group === "unknown",
  };
}

function nextKeyOf(group: Group, cpuRetry: boolean): { nextKey?: LocalSubtitleErrorNextKey } {
  if (group === "partial") return {};
  if (cpuRetry && isOneOf(CPU_RETRY_GROUPS, group)) return { nextKey: `subtitle:local_transcriber.error_guide.${group}.next_cpu` };
  return { nextKey: `subtitle:local_transcriber.error_guide.${group as Exclude<Group, GroupWithoutNext>}.next` };
}

/** The original error, one fact per line, for "copy diagnostics". */
export function localSubtitleErrorDiagnostics(error: { readonly code?: string; readonly stage?: string; readonly field?: string; readonly message: string }): string {
  return [
    error.message,
    error.code ? `code: ${error.code}` : null,
    error.stage ? `stage: ${error.stage}` : null,
    error.field ? `field: ${error.field}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * Messages the classic page writes for the user itself. Its index.tsx is frozen, so it cannot say
 * which of its messages are meant to be read; the notice knows them by their translated text.
 * A "complete" message says what happened and what to do (and is truer than the code's own
 * wording: a stale page needs a restart, not a reinstall); a "headline" names the operation that
 * failed, and the code's guide says why.
 */
const PAGE_MESSAGES = [
  ["subtitle:local_transcriber.error.bridge_protocol_mismatch", "complete"],
  ["subtitle:local_transcriber.post_action.manual_failed", "headline"],
] as const;

/** Every text the view looks up, so callers can hand it a typed translate function. */
export type LocalSubtitleErrorTextKey = LocalSubtitleErrorCauseKey | LocalSubtitleErrorNextKey | (typeof PAGE_MESSAGES)[number][0];

export interface LocalSubtitleErrorViewOptions extends LocalSubtitleErrorGuideOptions {
  /** The cause in this place's own words; replaces the code's (the environment check has its own). */
  readonly cause?: string;
  /** The next step for where the notice is shown; replaces the code's own. */
  readonly guidance?: string;
}

export interface LocalSubtitleErrorView {
  /** What failed, when the page named the operation; the cause then says why. */
  readonly headline?: string;
  readonly cause: string;
  readonly next?: string;
  readonly actions: readonly LocalSubtitleErrorAction[];
  readonly helpSection?: HelpSectionId;
  /** The original error for "copy diagnostics"; empty when there is nothing more to show. */
  readonly diagnostics: string;
}

/** What the notice shows for one error, in the current language. */
export function localSubtitleErrorView(
  error: { readonly code?: string; readonly stage?: string; readonly field?: string; readonly message: string },
  t: (key: LocalSubtitleErrorTextKey) => string,
  options: LocalSubtitleErrorViewOptions = {},
): LocalSubtitleErrorView {
  const pageMessage = error.message ? PAGE_MESSAGES.find(([key]) => t(key) === error.message)?.[1] : undefined;
  if (pageMessage === "complete") {
    return { cause: options.cause ?? error.message, next: options.guidance, actions: [], diagnostics: error.code ? localSubtitleErrorDiagnostics(error) : "" };
  }
  const guide = localSubtitleErrorGuide(error.code, options);
  const cause = options.cause ?? t(guide.causeKey);
  const next = options.guidance ?? (guide.nextKey ? t(guide.nextKey) : undefined);
  const shared = {
    next,
    actions: guide.actions,
    ...(guide.helpSection ? { helpSection: guide.helpSection } : {}),
    diagnostics: localSubtitleErrorDiagnostics(error),
  };
  if (pageMessage === "headline") {
    // The page's words already say more than "the operation did not finish".
    return guide.generic && !options.cause ? { cause: error.message, ...shared } : { headline: error.message, cause, ...shared };
  }
  return { cause, ...shared };
}

export const LOCAL_SUBTITLE_ERROR_GUIDE_GROUPS = GROUPS;
export const LOCAL_SUBTITLE_PAGE_MESSAGE_KEYS = PAGE_MESSAGES.map(([key]) => key);
