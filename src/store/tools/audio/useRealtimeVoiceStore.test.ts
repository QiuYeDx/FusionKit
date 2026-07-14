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

import { DEFAULT_REALTIME_VOICE_PREFERENCES } from "./realtimeVoiceConfig";
import useRealtimeVoiceStore, {
  REALTIME_VOICE_STORE_VERSION,
  migrateRealtimeVoicePersistedState,
} from "./useRealtimeVoiceStore";

beforeEach(() => {
  storage.clear();
  useRealtimeVoiceStore.setState({
    preferences: { ...DEFAULT_REALTIME_VOICE_PREFERENCES },
    status: "idle",
    micState: "idle",
    sessionId: null,
    startedAtMs: null,
    assistantSpeaking: false,
    activeResponseId: null,
    muted: false,
    lastError: null,
    lines: [],
    partial: {},
  });
});

describe("realtime voice store v4", () => {
  it("migrates v3 state to sanitized preferences only", () => {
    const migrated = migrateRealtimeVoicePersistedState(
      createDirtyPersistedState(),
      3,
    );

    expect(migrated).toEqual({
      preferences: {
        voice: "ash",
        instructions: "legacy instructions",
        turnDetection: "server_vad",
        inputAudioFormat: "pcma",
        outputAudioFormat: "pcmu",
      },
    });
    expect(JSON.stringify(migrated)).not.toMatch(
      /legacy_(?:session|line|partial|response|profile_seed)/,
    );
    expect(REALTIME_VOICE_STORE_VERSION).toBe(4);
  });

  it("hydrates a real v3 envelope without runtime state", async () => {
    localStorage.setItem(
      "fusionkit-realtime-voice",
      JSON.stringify({ state: createDirtyPersistedState(), version: 3 }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import("./useRealtimeVoiceStore");
    expect(hydratedStore.getState()).toMatchObject({
      preferences: {
        voice: "ash",
        inputAudioFormat: "pcma",
        outputAudioFormat: "pcmu",
      },
      status: "idle",
      micState: "idle",
      sessionId: null,
      startedAtMs: null,
      assistantSpeaking: false,
      activeResponseId: null,
      muted: false,
      lastError: null,
      lines: [],
      partial: {},
    });

    const envelope = JSON.parse(
      localStorage.getItem("fusionkit-realtime-voice") ?? "null",
    ) as { state: Record<string, unknown>; version: number };
    expect(envelope).toEqual({
      state: { preferences: hydratedStore.getState().preferences },
      version: REALTIME_VOICE_STORE_VERSION,
    });
  });

  it("drops runtime fields from a same-version dirty envelope", async () => {
    localStorage.setItem(
      "fusionkit-realtime-voice",
      JSON.stringify({
        state: createDirtyPersistedState(),
        version: REALTIME_VOICE_STORE_VERSION,
      }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import("./useRealtimeVoiceStore");
    expect(hydratedStore.getState()).toMatchObject({
      status: "idle",
      micState: "idle",
      sessionId: null,
      assistantSpeaking: false,
      activeResponseId: null,
      lines: [],
      partial: {},
    });
  });

  it("persists sanitized preferences without session state", () => {
    useRealtimeVoiceStore.getState().setStatus("connected");
    useRealtimeVoiceStore.getState().setSessionId("private_session");
    useRealtimeVoiceStore.getState().setActiveResponseId("private_response");
    useRealtimeVoiceStore.getState().addLine({
      id: "private_line",
      role: "assistant",
      text: "private transcript",
      final: true,
      createdAtMs: 1,
    });
    useRealtimeVoiceStore.getState().updatePreferences({
      voice: `  ${"v".repeat(150)}  `,
      turnDetection: "manual",
    });

    const persisted = storage.get("fusionkit-realtime-voice") ?? "";
    const envelope = JSON.parse(persisted) as {
      state: { preferences: { voice: string; turnDetection: string } };
      version: number;
    };
    expect(envelope.version).toBe(REALTIME_VOICE_STORE_VERSION);
    expect(envelope.state.preferences.voice).toHaveLength(120);
    expect(envelope.state.preferences.turnDetection).toBe("server_vad");
    expect(persisted).not.toMatch(
      /private_(?:session|response|line)|private transcript|status|sessionId|lines|partial/,
    );
  });

  it("clears conversation text without losing the active response", () => {
    useRealtimeVoiceStore.setState({
      status: "connected",
      assistantSpeaking: true,
      activeResponseId: "response_active",
      lines: [{
        id: "line",
        role: "assistant",
        text: "speaking",
        final: true,
        createdAtMs: 1,
      }],
      partial: { item: { role: "assistant", text: "partial" } },
      lastError: { code: "renderer_error", message: "old" },
    });

    useRealtimeVoiceStore.getState().clearConversation();

    expect(useRealtimeVoiceStore.getState()).toMatchObject({
      status: "connected",
      assistantSpeaking: true,
      activeResponseId: "response_active",
      lines: [],
      partial: {},
      lastError: null,
    });
  });
});

function createDirtyPersistedState(): Record<string, unknown> {
  return {
    preferences: {
      voice: " ash ",
      instructions: "legacy instructions",
      turnDetection: "manual",
      inputAudioFormat: "pcma",
      outputAudioFormat: "pcmu",
    },
    profileSeedKey: "legacy_profile_seed",
    profileVoiceOverridden: true,
    status: "connected",
    micState: "granted",
    sessionId: "legacy_session",
    startedAtMs: 123,
    assistantSpeaking: true,
    activeResponseId: "legacy_response",
    muted: false,
    lastError: { code: "renderer_error", message: "legacy error" },
    lines: [{ id: "legacy_line", text: "private" }],
    partial: { legacy_partial: { role: "user", text: "private" } },
  };
}
