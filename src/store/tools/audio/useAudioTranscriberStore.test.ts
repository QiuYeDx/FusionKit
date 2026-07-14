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

import {
  DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
  sanitizeAudioTranscriberPreferences,
} from "./audioTranscriberConfig";
import useAudioTranscriberStore, {
  AUDIO_TRANSCRIBER_STORE_VERSION,
  migrateAudioTranscriberPersistedState,
} from "./useAudioTranscriberStore";

beforeEach(() => {
  storage.clear();
  useAudioTranscriberStore.setState({
    preferences: sanitizeAudioTranscriberPreferences(
      DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
    ),
    outputDirectoryAuthorization: null,
    selectedFile: null,
    fileAuthorizationPending: false,
    result: null,
    status: "idle",
    lastError: null,
    activeRequestId: null,
    requestGeneration: 0,
  });
});

describe("audio transcriber store v4", () => {
  it("migrates v3 state to preferences only", () => {
    const migrated = migrateAudioTranscriberPersistedState(
      createLegacyRuntimeState(),
      3,
    );

    expect(migrated).toEqual({
      preferences: expect.objectContaining({
        language: "ja",
        responseFormat: "verbose_json",
        prompt: "Legacy prompt",
        outputDir: "exports",
      }),
    });
    expect(JSON.stringify(migrated)).not.toMatch(
      /legacy_(?:file_token|request|output_token|profile_seed)/,
    );
    expect(AUDIO_TRANSCRIBER_STORE_VERSION).toBe(4);
  });

  it("hydrates a real v3 envelope without runtime files, tokens, or task state", async () => {
    localStorage.setItem(
      "fusionkit-audio-transcriber",
      JSON.stringify({ state: createLegacyRuntimeState(), version: 3 }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import("./useAudioTranscriberStore");
    const state = hydratedStore.getState();

    expect(state.preferences).toEqual({
      language: "ja",
      responseFormat: "verbose_json",
      timestampGranularities: ["word"],
      prompt: "Legacy prompt",
      stream: true,
      outputMode: "custom_dir",
      outputDir: "exports",
    });
    expect(state).toMatchObject({
      outputDirectoryAuthorization: null,
      selectedFile: null,
      fileAuthorizationPending: false,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      requestGeneration: 0,
    });

    const migratedEnvelope = JSON.parse(
      localStorage.getItem("fusionkit-audio-transcriber") ?? "null",
    ) as { state: Record<string, unknown>; version: number };
    expect(migratedEnvelope).toEqual({
      state: { preferences: state.preferences },
      version: AUDIO_TRANSCRIBER_STORE_VERSION,
    });
  });

  it("drops runtime fields from a same-version persisted envelope", async () => {
    localStorage.setItem(
      "fusionkit-audio-transcriber",
      JSON.stringify({
        state: createLegacyRuntimeState(),
        version: AUDIO_TRANSCRIBER_STORE_VERSION,
      }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import("./useAudioTranscriberStore");
    const state = hydratedStore.getState();

    expect(state.preferences).toMatchObject({
      language: "ja",
      prompt: "Legacy prompt",
    });
    expect(state).toMatchObject({
      outputDirectoryAuthorization: null,
      selectedFile: null,
      fileAuthorizationPending: false,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      requestGeneration: 0,
    });
  });

  it("never persists source files, capability tokens, or runtime task state", () => {
    const sourceFile = new File(["audio"], "private-input.wav", {
      type: "audio/wav",
    });
    useAudioTranscriberStore.getState().setSelectedFile({
      sourceFile,
      fileToken: "private_file_token",
      fileName: sourceFile.name,
      mimeType: "audio/wav",
      sizeBytes: sourceFile.size,
      expiresAt: Date.now() + 60_000,
    });
    useAudioTranscriberStore.getState().setFileAuthorizationPending(true);
    useAudioTranscriberStore.getState().beginRequest("private_request");
    useAudioTranscriberStore.getState().updatePreferences({
      prompt: "Persist this prompt",
    });

    const persisted = storage.get("fusionkit-audio-transcriber") ?? "";
    expect(persisted).toContain("Persist this prompt");
    expect(persisted).not.toMatch(
      /private_(?:file_token|request|input)|fileAuthorizationPending|selectedFile/,
    );
  });

  it("rotates runtime file tokens without clearing user preferences", () => {
    const sourceFile = new File(["audio"], "input.wav", {
      type: "audio/wav",
    });
    useAudioTranscriberStore.getState().updatePreferences({
      prompt: "Keep this prompt",
    });
    useAudioTranscriberStore.getState().setSelectedFile({
      sourceFile,
      fileToken: "first_token",
      fileName: sourceFile.name,
      mimeType: "audio/wav",
      sizeBytes: sourceFile.size,
    });
    useAudioTranscriberStore.getState().setSelectedFile({
      sourceFile,
      fileToken: null,
      fileName: sourceFile.name,
      mimeType: "audio/wav",
      sizeBytes: sourceFile.size,
    });

    expect(useAudioTranscriberStore.getState()).toMatchObject({
      preferences: { prompt: "Keep this prompt" },
      selectedFile: { sourceFile, fileToken: null },
      fileAuthorizationPending: false,
    });
  });

  it("invalidates active requests while preserving preferences and file state", () => {
    const sourceFile = new File(["audio"], "input.wav", {
      type: "audio/wav",
    });
    useAudioTranscriberStore.getState().updatePreferences({ language: "zh" });
    useAudioTranscriberStore.getState().setSelectedFile({
      sourceFile,
      fileToken: "request_file_token",
      fileName: sourceFile.name,
      mimeType: "audio/wav",
      sizeBytes: sourceFile.size,
    });
    const generation = useAudioTranscriberStore
      .getState()
      .beginRequest("active_request");

    const invalidated = useAudioTranscriberStore
      .getState()
      .invalidateActiveRequest("cancelled");

    expect(invalidated).toEqual({
      requestId: "active_request",
      generation: generation + 1,
    });
    expect(useAudioTranscriberStore.getState()).toMatchObject({
      preferences: { language: "zh" },
      selectedFile: { sourceFile, fileToken: "request_file_token" },
      status: "cancelled",
      activeRequestId: null,
    });
    expect(
      useAudioTranscriberStore
        .getState()
        .isRequestCurrent("active_request", generation),
    ).toBe(false);
  });
});

function createLegacyRuntimeState(): Record<string, unknown> {
  return {
    preferences: {
      language: "ja",
      responseFormat: "verbose_json",
      timestampGranularities: ["word"],
      prompt: "Legacy prompt",
      stream: true,
      outputMode: "custom_dir",
      outputDir: "/private/exports/",
    },
    profileSeedKey: "legacy_profile_seed",
    profileDefaultOverrides: { language: true },
    outputDirectoryAuthorization: {
      outputDirToken: "legacy_output_dir_token",
      directoryName: "exports",
      expiresAt: Date.now() + 60_000,
    },
    selectedFile: {
      sourceFile: { runtimeMarker: "legacy_source_file" },
      fileToken: "legacy_file_token",
      fileName: "legacy.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
    },
    fileAuthorizationPending: true,
    result: { outputToken: "legacy_output_token" },
    status: "running",
    lastError: { code: "renderer_error", message: "legacy error" },
    activeRequestId: "legacy_request",
    requestGeneration: 7,
  };
}
