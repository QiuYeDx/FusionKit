import { z } from "zod";
import type { ModelErrorCategory } from "../lib/model-error-category";

/**
 * Model setup shared by the main process, the model settings dialog and the welcome wizard:
 * a real one-request connection test, and what the wizard needs to know at launch.
 */
export const MODEL_SETUP_CHANNEL_PREFIX = "model-setup:";
export const MODEL_SETUP_CHANNELS = {
  testConnection: "model-setup:test-connection",
  launchConfig: "model-setup:launch-config",
  freeDiskSpace: "model-setup:free-disk-space",
} as const;

/** The whole test, connection included, gives up after this long. */
export const MODEL_CONNECTION_TEST_TIMEOUT_MS = 20_000;

/** What a connection test needs from a profile. The key is used for this one request and never stored or logged. */
export const modelConnectionTestRequestSchema = z.object({
  baseUrl: z.string().trim().max(2048),
  apiFormat: z.enum(["chat_completions", "responses"]),
  modelKey: z.string().trim().max(256),
  apiKey: z.string().max(8000),
  outputTokenParameter: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
}).strict();
export type ModelConnectionTestRequest = z.input<typeof modelConnectionTestRequestSchema>;

export type ModelConnectionCategory = "ok" | ModelErrorCategory;

/**
 * Why a test failed when the reason is known exactly: something missing or malformed in the
 * profile (nothing was sent), or no answer in time. The window says it in the user's language.
 */
export const MODEL_CONNECTION_TEST_REASONS = ["missing_key", "key_characters", "missing_url", "invalid_url", "missing_model", "timeout"] as const;
export type ModelConnectionTestReason = (typeof MODEL_CONNECTION_TEST_REASONS)[number];

export interface ModelConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly category: ModelConnectionCategory;
  /** Status of a server that answered. */
  readonly httpStatus?: number;
  readonly reason?: ModelConnectionTestReason;
  /** The provider's own words, or what the connection reported; shortened and without the key. */
  readonly detail?: string;
  /** Where the detail comes from: the service that answered, or the connection that failed. */
  readonly detailSource?: "service" | "connection";
}

/**
 * A key is printable ASCII without spaces. Anything else (Chinese or full-width text, a space, a
 * line break copied along with it) means more than the key was pasted; non-Latin-1 characters
 * cannot even be put into a request header.
 */
export function apiKeyHasUnsendableCharacters(key: string): boolean {
  return /[^\x21-\x7e]/.test(key.trim());
}

/**
 * How the welcome wizard may open at launch: "auto" opens it when nothing is set up yet, "off"
 * never opens it by itself (automated UI tests), "forced" lets a UI test exercise it.
 */
export type OnboardingLaunchMode = "auto" | "off" | "forced";

export interface ModelSetupLaunchConfig {
  readonly onboarding: OnboardingLaunchMode;
  /** UI tests only: the DeepSeek address the wizard uses instead of the official one. */
  readonly deepseekBaseUrl?: string;
}

export interface ModelSetupApi {
  testConnection(request: ModelConnectionTestRequest): Promise<ModelConnectionTestResult>;
  getLaunchConfig(): Promise<ModelSetupLaunchConfig>;
  /** Free space where local resources are kept, or null when it cannot be read. */
  getFreeDiskSpace(): Promise<number | null>;
}
