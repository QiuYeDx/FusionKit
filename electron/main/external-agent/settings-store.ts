import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXTERNAL_AGENT_SETTINGS,
  externalAgentSettingsSchema,
  externalAgentSettingsUpdateSchema,
  type ExternalAgentSettings,
} from "../../../src/agent/external/contract";

export const newExternalToken = () => randomBytes(32).toString("base64url");

/** Each field falls back on its own, so one bad value does not reset the others. */
export function normalizeSettings(raw: unknown): ExternalAgentSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const shape = externalAgentSettingsSchema.shape;
  const field = <K extends keyof ExternalAgentSettings>(key: K): ExternalAgentSettings[K] => {
    const parsed = shape[key].safeParse(record[key]);
    return parsed.success ? parsed.data as ExternalAgentSettings[K] : DEFAULT_EXTERNAL_AGENT_SETTINGS[key];
  };
  const settings: ExternalAgentSettings = { version: 1, enabled: field("enabled"), port: field("port"), token: field("token"), trust: field("trust"), notices: field("notices") };
  // Access without a token would be unusable; keep it off until a token exists.
  if (settings.enabled && !settings.token) settings.token = newExternalToken();
  return settings;
}

/** The main process alone reads and writes `<userData>/external-agent/settings.json`. */
export class ExternalAgentSettingsStore {
  private current: ExternalAgentSettings = { ...DEFAULT_EXTERNAL_AGENT_SETTINGS };
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  get file() { return path.join(this.directory, "settings.json"); }
  get settings(): ExternalAgentSettings { return { ...this.current }; }

  async load(): Promise<ExternalAgentSettings> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, "utf8")); }
    catch { raw = undefined; }
    const settings = normalizeSettings(raw);
    const stored = raw && typeof raw === "object" ? (raw as { token?: unknown }).token : undefined;
    this.current = settings;
    // A token minted while loading must be the one clients are given next time too.
    if (settings.token && settings.token !== stored) await this.save(settings).catch(() => undefined);
    return this.settings;
  }

  /** Validates the whole change first; a failed write leaves the settings as they were. */
  async update(input: unknown): Promise<ExternalAgentSettings> {
    const parsed = externalAgentSettingsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new Error("invalid_settings");
    const next: ExternalAgentSettings = { ...this.current, ...parsed.data };
    if (next.enabled && !next.token) next.token = newExternalToken();
    await this.save(next);
    return this.settings;
  }

  async regenerateToken(): Promise<ExternalAgentSettings> {
    await this.save({ ...this.current, token: newExternalToken() });
    return this.settings;
  }

  private save(next: ExternalAgentSettings): Promise<void> {
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.current = next;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
