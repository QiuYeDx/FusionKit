import { DEEPSEEK_API_KEYS_URL, DEEPSEEK_TOP_UP_URL } from "@/constants/model";
import {
  classifyModelErrorSignals,
  isModelErrorCategory,
  providerErrorFromBody,
  responseBodySignals,
  type ModelErrorCategory,
} from "@/lib/model-error-category";
import type { ModelConnectionTestReason } from "@/model-setup/contract";
import { helpPath, type HelpSectionId } from "@/pages/Help/helpNavigation";
import { settingPath } from "@/pages/Setting/settingNavigation";
import { Model, type ModelProfile } from "@/type/model";

// ---------------------------------------------------------------------------
// One place that turns a failed model request into "why + what to do next".
// The Agent, Subtitle Studio, the classic tools and the connection test in the
// model settings all show model errors through this mapping.
// ---------------------------------------------------------------------------

export type ModelErrorActionKind =
  | "open_model_settings"
  | "open_network_settings"
  | "open_deepseek_keys"
  | "open_deepseek_topup"
  | "open_help";

/**
 * The help page section that explains a category further (what a key is and what it costs; what
 * the system proxy is). Offered under the errors of real requests; the profile form and the
 * welcome wizard keep the user where they are filling things in.
 */
const HELP_SECTIONS = {
  auth: "models-and-cost",
  balance: "models-and-cost",
  network: "proxy",
  proxy: "proxy",
} as const satisfies Partial<Record<ModelErrorCategory, HelpSectionId>>;

export function modelErrorHelpSection(category: ModelErrorCategory): HelpSectionId | undefined {
  return (HELP_SECTIONS as Partial<Record<ModelErrorCategory, HelpSectionId>>)[category];
}

/**
 * Where the advice is shown: under the error of a real request, under a connection test in the
 * profile form (the fields are right there), or in the welcome wizard (DeepSeek's preset, no form).
 */
export type ModelErrorContext = "runtime" | "connection_test" | "wizard";

/** Next steps that would send the user somewhere they already are get their own wording. */
const CONNECTION_TEST_NEXT_KEYS = {
  model_not_found: "common:model_error.model_not_found.next_test",
  bad_url: "common:model_error.bad_url.next_test",
  unknown: "common:model_error.unknown.next_test",
} as const satisfies Partial<Record<ModelErrorCategory, string>>;
const WIZARD_NEXT_KEYS = {
  ...CONNECTION_TEST_NEXT_KEYS,
  model_not_found: "common:model_error.model_not_found.next_wizard",
  bad_url: "common:model_error.bad_url.next_wizard",
} as const satisfies Partial<Record<ModelErrorCategory, string>>;

/** The wizard's address is DeepSeek's own, so "wrong address" there means the answer came from somewhere else. */
const WIZARD_CAUSE_KEYS = {
  bad_url: "common:model_error.bad_url.cause_wizard",
} as const satisfies Partial<Record<ModelErrorCategory, string>>;

type ModelErrorCauseKey =
  | `common:model_error.${ModelErrorCategory}.cause`
  | (typeof WIZARD_CAUSE_KEYS)[keyof typeof WIZARD_CAUSE_KEYS];

type ModelErrorNextKey =
  | `common:model_error.${ModelErrorCategory}.next`
  | (typeof WIZARD_NEXT_KEYS)[keyof typeof WIZARD_NEXT_KEYS]
  | (typeof CONNECTION_TEST_NEXT_KEYS)[keyof typeof CONNECTION_TEST_NEXT_KEYS];

export interface ModelErrorGuide {
  readonly category: ModelErrorCategory;
  readonly causeKey: ModelErrorCauseKey;
  readonly nextKey: ModelErrorNextKey;
  /** Next-step buttons, most useful first. */
  readonly actions: readonly ModelErrorActionKind[];
}

/**
 * A connection test that stopped for a known reason (a field left empty or malformed, no answer
 * in time) says exactly that instead of the category's general cause.
 */
export const CONNECTION_TEST_REASON_KEYS = {
  missing_key: { cause: "common:model_error.reason.missing_key.cause", next: "common:model_error.reason.missing_key.next" },
  key_characters: { cause: "common:model_error.reason.key_characters.cause", next: "common:model_error.reason.key_characters.next" },
  missing_url: { cause: "common:model_error.reason.missing_url.cause", next: "common:model_error.reason.missing_url.next" },
  invalid_url: { cause: "common:model_error.reason.invalid_url.cause", next: "common:model_error.reason.invalid_url.next" },
  missing_model: { cause: "common:model_error.reason.missing_model.cause", next: "common:model_error.reason.missing_model.next" },
  timeout: { cause: "common:model_error.reason.timeout.cause" },
} as const satisfies Record<ModelConnectionTestReason, { cause: string; next?: string }>;

export type ModelErrorActionTarget =
  | { readonly kind: "route"; readonly to: string }
  | { readonly kind: "external"; readonly url: string };

export const MODEL_ERROR_ACTION_LABEL_KEYS = {
  open_model_settings: "common:model_error.actions.open_model_settings",
  open_network_settings: "common:model_error.actions.open_network_settings",
  open_deepseek_keys: "common:model_error.actions.open_deepseek_keys",
  open_deepseek_topup: "common:model_error.actions.open_deepseek_topup",
  open_help: "common:model_error.actions.open_help",
} as const satisfies Record<ModelErrorActionKind, string>;

/** The profile the failed request used, when known: DeepSeek gets its own top-up and key links. */
export type ModelErrorProfileHint = Pick<ModelProfile, "provider" | "baseUrl"> | null | undefined;

export function isDeepSeekProfile(profile: ModelErrorProfileHint): boolean {
  if (!profile) return false;
  if (profile.provider === Model.DeepSeek) return true;
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(profile.baseUrl).hostname);
  } catch {
    return false;
  }
}

export function modelErrorGuide(
  category: ModelErrorCategory,
  profile?: ModelErrorProfileHint,
  context: ModelErrorContext = "runtime",
): ModelErrorGuide {
  const deepseek = isDeepSeekProfile(profile);
  const actions: ModelErrorActionKind[] = (() => {
    switch (category) {
      case "auth": return deepseek ? ["open_model_settings", "open_deepseek_keys"] : ["open_model_settings"];
      case "balance": return deepseek ? ["open_deepseek_topup"] : [];
      // The wizard's address is DeepSeek's own: a page that is not the API means something on the way intercepted it.
      case "bad_url": return context === "wizard" ? ["open_network_settings"] : ["open_model_settings"];
      case "model_not_found":
      case "unknown":
        return ["open_model_settings"];
      case "network":
      case "proxy":
        return ["open_network_settings"];
      case "rate_limited":
      case "server":
        return [];
    }
  })();
  if (context === "runtime" && modelErrorHelpSection(category)) actions.push("open_help");
  const contextCause: Partial<Record<ModelErrorCategory, ModelErrorCauseKey>> = context === "wizard" ? WIZARD_CAUSE_KEYS : {};
  const contextNext: Partial<Record<ModelErrorCategory, ModelErrorNextKey>> =
    context === "wizard" ? WIZARD_NEXT_KEYS : context === "connection_test" ? CONNECTION_TEST_NEXT_KEYS : {};
  return {
    category,
    causeKey: contextCause[category] ?? `common:model_error.${category}.cause`,
    nextKey: contextNext[category] ?? `common:model_error.${category}.next`,
    actions,
  };
}

/** Where a button goes; "open_help" opens the help section of the error's category. */
export function modelErrorActionTarget(kind: ModelErrorActionKind, category?: ModelErrorCategory): ModelErrorActionTarget {
  switch (kind) {
    case "open_model_settings": return { kind: "route", to: settingPath("model") };
    case "open_network_settings": return { kind: "route", to: settingPath("proxy") };
    case "open_deepseek_keys": return { kind: "external", url: DEEPSEEK_API_KEYS_URL };
    case "open_deepseek_topup": return { kind: "external", url: DEEPSEEK_TOP_UP_URL };
    case "open_help": return { kind: "route", to: helpPath(category ? modelErrorHelpSection(category) : undefined) };
  }
}

/** Opens a web page in the system browser (the main process hands https links to the shell). */
export function openExternalPage(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

type ErrorRecord = Record<string, unknown>;
const asRecord = (value: unknown): ErrorRecord | undefined =>
  value && typeof value === "object" ? value as ErrorRecord : undefined;

/**
 * Classifies an error raised in the renderer: the Agent's own requests (AI SDK errors with a
 * status and response body, or a fetch that could not connect), and payloads from the main
 * process that already carry a category.
 */
export function classifyModelError(error: unknown, depth = 0): ModelErrorCategory {
  const record = asRecord(error);
  if (record && isModelErrorCategory(record.category)) return record.category;
  if (depth < 4 && record) {
    // AI SDK retry wrapper: the last attempt says what went wrong.
    if (record.lastError) return classifyModelError(record.lastError, depth + 1);
  }
  const name = typeof record?.name === "string" ? record.name : "";
  // The answer arrived but is not what a chat API sends.
  if (/^AI_(JSONParseError|TypeValidationError|InvalidResponseDataError|EmptyResponseBodyError)$/.test(name)) return "bad_url";
  const status = typeof record?.statusCode === "number" ? record.statusCode
    : typeof record?.status === "number" ? record.status : undefined;
  const body = record?.responseBody;
  const provider = providerErrorFromBody(body);
  const ownMessage = typeof record?.message === "string" ? record.message
    : record ? "" : String(error ?? "");
  const cause = asRecord(record?.cause);
  const causeMessage = typeof cause?.message === "string" ? cause.message : "";
  return classifyModelErrorSignals({
    status,
    providerCode: provider.providerCode,
    providerType: provider.providerType,
    message: [provider.message, ownMessage, causeMessage].filter(Boolean).join(" "),
    ...(status !== undefined ? responseBodySignals(body) : {}),
  });
}
