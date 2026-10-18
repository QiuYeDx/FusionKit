import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_NETWORK_SETTINGS,
  DOWNLOAD_SOURCE_MODES,
  networkSettingsPatchSchema,
  PROXY_MODES,
  type NetworkSettings,
  type NetworkSettingsPatch,
  type NetworkSettingsSnapshot,
} from '../../../src/network/contract';

export const NETWORK_SETTINGS_FILE = 'network-settings.json';
const SCHEMA_VERSION = 1;

/** Reads what it can of a saved file; anything unknown or malformed falls back to the default. */
export function normalizeNetworkSettings(raw: unknown): NetworkSettings {
  const record = isRecord(raw) ? raw : {};
  const proxy = isRecord(record.proxy) ? record.proxy : {};
  const mode = PROXY_MODES.find(value => value === proxy.mode) ?? DEFAULT_NETWORK_SETTINGS.proxy.mode;
  const host = typeof proxy.host === 'string' ? proxy.host.trim().slice(0, 255) : '';
  const port = typeof proxy.port === 'string' && /^\d{0,5}$/.test(proxy.port.trim()) ? proxy.port.trim() : '';
  const downloadSource = DOWNLOAD_SOURCE_MODES.find(value => value === record.downloadSource)
    ?? DEFAULT_NETWORK_SETTINGS.downloadSource;
  return Object.freeze({ proxy: Object.freeze({ mode, host, port }), downloadSource });
}

export interface NetworkSettingsStoreOptions {
  readonly directory: string;
  readonly fileName?: string;
}

/**
 * The main process's copy of the network settings, saved as JSON in the user data directory.
 * Loading is synchronous so the settings apply before the first request of a launch.
 */
export class NetworkSettingsStore {
  readonly filePath: string;
  #settings: NetworkSettings = DEFAULT_NETWORK_SETTINGS;
  #stored = false;
  readonly #listeners = new Set<(settings: NetworkSettings) => void>();

  constructor(options: NetworkSettingsStoreOptions) {
    this.filePath = path.join(options.directory, options.fileName ?? NETWORK_SETTINGS_FILE);
  }

  load(): NetworkSettings {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      this.#settings = normalizeNetworkSettings(parsed);
      this.#stored = true;
    } catch {
      this.#settings = DEFAULT_NETWORK_SETTINGS;
      this.#stored = false;
    }
    return this.#settings;
  }

  get settings(): NetworkSettings {
    return this.#settings;
  }

  snapshot(): NetworkSettingsSnapshot {
    return Object.freeze({ ...this.#settings, stored: this.#stored });
  }

  /** Validates, saves and announces a change. A failed save keeps the change for this launch. */
  update(input: unknown): NetworkSettingsSnapshot {
    const patch: NetworkSettingsPatch = networkSettingsPatchSchema.parse(input ?? {});
    const next = normalizeNetworkSettings({
      proxy: { ...this.#settings.proxy, ...patch.proxy },
      downloadSource: patch.downloadSource ?? this.#settings.downloadSource,
    });
    const changed = JSON.stringify(next) !== JSON.stringify(this.#settings);
    this.#settings = next;
    try {
      this.#write(next);
      this.#stored = true;
    } catch (error) {
      console.error('[network] settings could not be saved:', (error as Error)?.message ?? error);
    }
    if (changed) {
      for (const listener of [...this.#listeners]) {
        try { listener(next); } catch { /* a listener cannot undo a saved change */ }
      }
    }
    return this.snapshot();
  }

  onChanged(listener: (settings: NetworkSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #write(settings: NetworkSettings): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...settings }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
