import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
  });
  return items;
});

import { DEFAULT_REALTIME_CAPTIONS_PREFERENCES } from "./realtimeCaptionsConfig";
import useRealtimeCaptionsStore, {
  REALTIME_CAPTIONS_STORE_VERSION,
  migrateRealtimeCaptionsPersistedState,
} from "./useRealtimeCaptionsStore";

beforeEach(() => {
  storage.clear();
  useRealtimeCaptionsStore.setState({
    preferences: { ...DEFAULT_REALTIME_CAPTIONS_PREFERENCES },
    status: "idle",
    micState: "idle",
    sessionId: null,
    startedAtMs: null,
    lastError: null,
    lines: [],
    partial: {},
  });
});

describe("realtime captions store v4", () => {
  it("migrates v3 state to sanitized preferences only", () => {
    const migrated = migrateRealtimeCaptionsPersistedState(
      createDirtyPersistedState(),
      3,
    );

    expect(migrated).toEqual({
      preferences: {
        language: "ja",
        instructions: "",
        inputAudioFormat: "pcma",
        turnDetection: "server_vad",
        outputFormat: "srt",
        showAssistantTranscript: false,
      },
    });
    expect(JSON.stringify(migrated)).not.toMatch(
      /legacy_(?:session|line|partial|profile_seed)/,
    );
    expect(REALTIME_CAPTIONS_STORE_VERSION).toBe(4);
  });

  it("hydrates a real v3 envelope without session or transcript state", async () => {
    localStorage.setItem(
      "fusionkit-realtime-captions",
      JSON.stringify({ state: createDirtyPersistedState(), version: 3 }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import(
      "./useRealtimeCaptionsStore"
    );
    expect(hydratedStore.getState()).toMatchObject({
      preferences: {
        language: "ja",
        inputAudioFormat: "pcma",
        outputFormat: "srt",
      },
      status: "idle",
      micState: "idle",
      sessionId: null,
      startedAtMs: null,
      lastError: null,
      lines: [],
      partial: {},
    });

    const envelope = JSON.parse(
      localStorage.getItem("fusionkit-realtime-captions") ?? "null",
    ) as { state: Record<string, unknown>; version: number };
    expect(envelope).toEqual({
      state: { preferences: hydratedStore.getState().preferences },
      version: REALTIME_CAPTIONS_STORE_VERSION,
    });
  });

  it("drops runtime fields from a same-version dirty envelope", async () => {
    localStorage.setItem(
      "fusionkit-realtime-captions",
      JSON.stringify({
        state: createDirtyPersistedState(),
        version: REALTIME_CAPTIONS_STORE_VERSION,
      }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import(
      "./useRealtimeCaptionsStore"
    );
    expect(hydratedStore.getState()).toMatchObject({
      status: "idle",
      micState: "idle",
      sessionId: null,
      startedAtMs: null,
      lastError: null,
      lines: [],
      partial: {},
    });
  });

  it("persists preferences without runtime session state", () => {
    useRealtimeCaptionsStore.getState().setStatus("listening");
    useRealtimeCaptionsStore.getState().setSessionId("private_session");
    useRealtimeCaptionsStore.getState().addLine({
      id: "private_line",
      role: "user",
      text: "private transcript",
      startedAtMs: 0,
      endedAtMs: 1000,
    });
    useRealtimeCaptionsStore.getState().updatePreferences({
      language: "zh",
      outputFormat: "srt",
    });

    const persisted = storage.get("fusionkit-realtime-captions") ?? "";
    expect(persisted).toContain('"language":"zh"');
    expect(persisted).toContain('"outputFormat":"srt"');
    expect(persisted).not.toMatch(
      /private_(?:session|line)|private transcript|status|sessionId|lines|partial/,
    );
  });
});

function createDirtyPersistedState(): Record<string, unknown> {
  return {
    preferences: {
      language: "ja",
      instructions: "legacy instructions",
      inputAudioFormat: "pcma",
      turnDetection: "manual",
      outputFormat: "srt",
      showAssistantTranscript: true,
    },
    profileSeedKey: "legacy_profile_seed",
    profileLanguageOverridden: true,
    status: "listening",
    micState: "granted",
    sessionId: "legacy_session",
    startedAtMs: 123,
    lastError: { code: "renderer_error", message: "legacy error" },
    lines: [{ id: "legacy_line", text: "private" }],
    partial: { legacy_partial: { role: "user", text: "private" } },
  };
}
