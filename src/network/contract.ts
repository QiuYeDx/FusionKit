import { z } from 'zod';

/**
 * Network settings shared by the main process and the settings page. The main process owns them:
 * it saves them in the user data directory and applies them at startup, before any request.
 */
export const NETWORK_CHANNEL_PREFIX = 'network:';
export const NETWORK_CHANNELS = {
  getSettings: 'network:get-settings',
  setSettings: 'network:set-settings',
  test: 'network:test',
} as const;

export const PROXY_MODES = ['none', 'system', 'custom'] as const;
export type NetworkProxyMode = (typeof PROXY_MODES)[number];
/** auto: measure and pick, official: only the publisher's address, mirror: domestic mirrors first. */
export const DOWNLOAD_SOURCE_MODES = ['auto', 'official', 'mirror'] as const;
export type DownloadSourceMode = (typeof DOWNLOAD_SOURCE_MODES)[number];

export interface NetworkProxySettings {
  readonly mode: NetworkProxyMode;
  /** Custom mode only. May carry a scheme: "http://" (default) or "socks5://". */
  readonly host: string;
  readonly port: string;
}

export interface NetworkSettings {
  readonly proxy: NetworkProxySettings;
  readonly downloadSource: DownloadSourceMode;
}

export interface NetworkSettingsSnapshot extends NetworkSettings {
  /** False until the settings were saved once; the renderer then offers its older local copy. */
  readonly stored: boolean;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = Object.freeze({
  proxy: Object.freeze({ mode: 'system', host: '', port: '' }),
  downloadSource: 'auto',
});

export const networkSettingsPatchSchema = z.object({
  proxy: z.object({
    mode: z.enum(PROXY_MODES),
    host: z.string().trim().max(255),
    port: z.string().trim().regex(/^\d{0,5}$/),
  }).partial().strict().optional(),
  downloadSource: z.enum(DOWNLOAD_SOURCE_MODES).optional(),
}).strict();
export type NetworkSettingsPatch = z.input<typeof networkSettingsPatchSchema>;

/**
 * Why a connection failed, without status codes: "the server answered" is success for a
 * reachability test. Later features turn these into friendly messages.
 */
export const NETWORK_ERROR_CATEGORIES = [
  'dns',
  'timeout',
  'refused',
  'reset',
  'network_unreachable',
  'proxy_failed',
  'proxy_auth',
  'tls',
  'aborted',
  'unknown',
] as const;
export type NetworkErrorCategory = (typeof NETWORK_ERROR_CATEGORIES)[number];

export type NetworkTestTargetKind = 'model_api' | 'model_download' | 'github';

export interface NetworkTestTarget {
  readonly kind: NetworkTestTargetKind;
  /** Host name shown to the user, such as "api.deepseek.com". */
  readonly host: string;
  /** model_download only: the publisher's address or a domestic mirror. */
  readonly source?: 'official' | 'mirror';
  readonly ok: boolean;
  readonly latencyMs: number;
  /** HTTP status of a reachable server; any answer counts as reachable. */
  readonly status?: number;
  readonly category?: NetworkErrorCategory;
  /** How the request left the computer: directly, or through this proxy ("127.0.0.1:7890"). */
  readonly via: string | null;
}

export interface NetworkTestResult {
  readonly proxyMode: NetworkProxyMode;
  readonly downloadSource: DownloadSourceMode;
  readonly targets: readonly NetworkTestTarget[];
}

export const NETWORK_TEST_MAX_ENDPOINTS = 6;
/** Only model service addresses are sent, never their keys. */
export const networkTestRequestSchema = z.object({
  modelEndpoints: z.array(z.string().trim().max(2048)).max(32).default([]),
}).strict();
export type NetworkTestRequest = z.input<typeof networkTestRequestSchema>;

export interface NetworkApi {
  getSettings(): Promise<NetworkSettingsSnapshot>;
  setSettings(patch: NetworkSettingsPatch): Promise<NetworkSettingsSnapshot>;
  test(request: NetworkTestRequest): Promise<NetworkTestResult>;
}
