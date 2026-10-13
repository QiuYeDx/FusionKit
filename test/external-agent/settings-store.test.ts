import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExternalAgentSettingsStore, normalizeSettings } from "../../electron/main/external-agent/settings-store";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "fusionkit-external-settings-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("external agent settings", () => {
  it("starts off on port 47361, confirming writes, without a token, when nothing is saved", async () => {
    const store = new ExternalAgentSettingsStore(directory);
    expect(await store.load()).toEqual({ version: 1, enabled: false, port: 47361, token: "", trust: "confirm_writes" });
  });

  it("falls back field by field when the file is damaged", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "settings.json"), "{not json");
    expect((await new ExternalAgentSettingsStore(directory).load()).port).toBe(47361);
    await writeFile(path.join(directory, "settings.json"), JSON.stringify({ enabled: "yes", port: 80, trust: "auto", token: "short" }));
    expect(await new ExternalAgentSettingsStore(directory).load()).toEqual({ version: 1, enabled: false, port: 47361, token: "", trust: "auto" });
  });

  it("mints a 43-character base64url token on first enable and keeps changes across restarts", async () => {
    const store = new ExternalAgentSettingsStore(directory);
    await store.load();
    const saved = await store.update({ enabled: true, port: 50123, trust: "read_only" });
    expect(saved.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const reloaded = await new ExternalAgentSettingsStore(directory).load();
    expect(reloaded).toEqual(saved);
    expect(JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"))).toEqual(saved);
  });

  it("rejects invalid changes whole and leaves the settings untouched", async () => {
    const store = new ExternalAgentSettingsStore(directory);
    await store.load();
    await expect(store.update({ enabled: true, port: 22 })).rejects.toThrow("invalid_settings");
    await expect(store.update({ trust: "everything" })).rejects.toThrow("invalid_settings");
    await expect(store.update({ token: "x".repeat(43) })).rejects.toThrow("invalid_settings");
    expect(store.settings.enabled).toBe(false);
  });

  it("replaces the token on request and persists it", async () => {
    const store = new ExternalAgentSettingsStore(directory);
    await store.load();
    const first = (await store.update({ enabled: true })).token;
    const second = (await store.regenerateToken()).token;
    expect(second).not.toBe(first);
    expect((await new ExternalAgentSettingsStore(directory).load()).token).toBe(second);
  });

  it("gives an enabled file without a token a token and saves it", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "settings.json"), JSON.stringify({ version: 1, enabled: true, port: 50000, trust: "auto" }));
    const loaded = await new ExternalAgentSettingsStore(directory).load();
    expect(loaded.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")).token).toBe(loaded.token);
    expect(normalizeSettings({ enabled: false }).token).toBe("");
  });
});
