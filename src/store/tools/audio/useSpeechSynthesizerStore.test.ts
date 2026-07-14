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
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
  sanitizeSpeechSynthesizerPreferences,
} from "./speechSynthesizerConfig";
import useSpeechSynthesizerStore, {
  SPEECH_SYNTHESIZER_STORE_VERSION,
  migrateSpeechSynthesizerPersistedState,
} from "./useSpeechSynthesizerStore";

beforeEach(() => {
  storage.clear();
  useSpeechSynthesizerStore.setState({
    preferences: sanitizeSpeechSynthesizerPreferences(
      DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
    ),
    outputDirectoryAuthorization: null,
    voiceSample: null,
    voiceSampleAuthorizationPending: false,
    result: null,
    status: "idle",
    lastError: null,
    activeRequestId: null,
    activeMode: null,
    streamText: "",
    streamStats: { chunkCount: 0, totalBytes: 0 },
  });
});

describe("speech synthesizer store v5", () => {
  it("migrates v4 mode and removes profile-derived persistence", () => {
    const migrated = migrateSpeechSynthesizerPersistedState(
      {
        preferences: {
          input: "Legacy design input",
          mimoMode: "voice_design",
          mimoStyleInstruction: "Legacy style",
        },
        profileSeedKey: "legacy-profile-seed",
        profileDefaultOverrides: { voice: true, mimoMode: true },
        voiceSample: { fileToken: "must-not-survive" },
      },
      4,
    );

    expect(migrated).toEqual({
      preferences: expect.objectContaining({
        input: "Legacy design input",
        speechMode: "voice_design",
        styleInstruction: "Legacy style",
        modeInputDrafts: { voice_design: "Legacy design input" },
      }),
    });
    expect(JSON.stringify(migrated)).not.toContain("profileSeedKey");
    expect(JSON.stringify(migrated)).not.toContain("must-not-survive");
    expect(SPEECH_SYNTHESIZER_STORE_VERSION).toBe(5);
  });

  it("hydrates a real v4 envelope into preferences-only v5 state", async () => {
    const v4Envelope = JSON.stringify({
      state: {
        preferences: {
          input: "Legacy design input",
          voice: "legacy_voice",
          instructions: "Speak softly",
          responseFormat: "wav",
          speed: 1.25,
          stream: true,
          outputMode: "custom_dir",
          outputDir: "Legacy exports",
          fileNameHint: "legacy-design",
          mimoMode: "voice_design",
          mimoStyleInstruction: "Warm and calm",
          voiceDesignPrompt: "A clear documentary narrator",
          optimizeTextPreview: true,
          audioTagsEnabled: true,
        },
        profileSeedKey: "legacy-profile-seed",
        profileDefaultOverrides: { voice: true, mimoMode: true },
        outputDirectoryAuthorization: {
          outputDirToken: "legacy_output_dir_token",
          directoryName: "Legacy exports",
          expiresAt: Date.now() + 60_000,
        },
        voiceSample: {
          sourceFile: { runtimeMarker: "legacy_source_file" },
          fileToken: "legacy_voice_sample_token",
          fileName: "legacy-voice.wav",
          mimeType: "audio/wav",
          sizeBytes: 128,
        },
        voiceSampleAuthorizationPending: true,
        result: {
          outputToken: "legacy_result_token",
          mimeType: "audio/wav",
          responseFormat: "wav",
          sizeBytes: 256,
        },
        status: "streaming",
        lastError: { code: "renderer_error", message: "legacy error" },
        activeRequestId: "legacy_request_id",
        activeMode: "stream",
        streamText: "legacy stream text",
        streamStats: { chunkCount: 4, totalBytes: 512 },
      },
      version: 4,
    });
    localStorage.setItem("fusionkit-speech-synthesizer", v4Envelope);

    vi.resetModules();
    const { default: hydratedStore } = await import(
      "./useSpeechSynthesizerStore"
    );
    const state = hydratedStore.getState();

    expect(state.preferences).toEqual({
      input: "Legacy design input",
      modeInputDrafts: { voice_design: "Legacy design input" },
      speechMode: "voice_design",
      voice: "legacy_voice",
      instructions: "Speak softly",
      responseFormat: "wav",
      speed: 1.25,
      stream: true,
      outputMode: "custom_dir",
      outputDir: "Legacy exports",
      fileNameHint: "legacy-design",
      styleInstruction: "Warm and calm",
      voiceDesignPrompt: "A clear documentary narrator",
      optimizeTextPreview: true,
    });
    expect(state).toMatchObject({
      outputDirectoryAuthorization: null,
      voiceSample: null,
      voiceSampleAuthorizationPending: false,
      result: null,
      status: "idle",
      lastError: null,
      activeRequestId: null,
      activeMode: null,
      streamText: "",
      streamStats: { chunkCount: 0, totalBytes: 0 },
    });

    const migratedEnvelope = JSON.parse(
      localStorage.getItem("fusionkit-speech-synthesizer") ?? "null",
    ) as { state: Record<string, unknown>; version: number };
    expect(migratedEnvelope).toEqual({
      state: { preferences: state.preferences },
      version: SPEECH_SYNTHESIZER_STORE_VERSION,
    });
    expect(JSON.stringify(migratedEnvelope)).not.toMatch(
      /legacy_(?:source_file|voice_sample_token|result_token|request_id)/,
    );
  });

  it("keeps independent input drafts when switching modes", () => {
    const store = useSpeechSynthesizerStore.getState();
    store.updatePreferences({ input: "Preset draft" });
    store.setSpeechMode("voice_design");
    useSpeechSynthesizerStore.getState().updatePreferences({
      input: "Design draft",
      voiceDesignPrompt: "Bright voice",
    });
    useSpeechSynthesizerStore.getState().setSpeechMode("preset_voice");

    expect(useSpeechSynthesizerStore.getState().preferences).toMatchObject({
      input: "Preset draft",
      speechMode: "preset_voice",
      modeInputDrafts: {
        preset_voice: "Preset draft",
        voice_design: "Design draft",
      },
      voiceDesignPrompt: "Bright voice",
    });

    useSpeechSynthesizerStore.getState().setSpeechMode("voice_design");
    expect(useSpeechSynthesizerStore.getState().preferences.input).toBe(
      "Design draft",
    );
  });

  it("never persists file tokens or runtime task state", () => {
    useSpeechSynthesizerStore.getState().setVoiceSample({
      fileToken: "voice_sample_secret_token",
      fileName: "voice.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      expiresAt: Date.now() + 60_000,
    });
    useSpeechSynthesizerStore.getState().beginTask("request_1", "non_stream");
    useSpeechSynthesizerStore.getState().updatePreferences({ input: "Persist me" });

    const persisted = storage.get("fusionkit-speech-synthesizer") ?? "";
    expect(persisted).toContain("Persist me");
    expect(persisted).not.toContain("voice_sample_secret_token");
    expect(persisted).not.toContain("request_1");
  });

  it("keeps the generated result while rotating a one-time voice token", () => {
    useSpeechSynthesizerStore.getState().setResult({
      outputToken: "output_token",
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: 256,
    });
    useSpeechSynthesizerStore.getState().setVoiceSample({
      fileToken: "first_voice_token",
      fileName: "voice.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
    });
    useSpeechSynthesizerStore.getState().setVoiceSample({
      fileToken: null,
      fileName: "voice.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
    });

    expect(useSpeechSynthesizerStore.getState().result?.outputToken).toBe(
      "output_token",
    );
  });

  it.each([
    ["non_stream", "running"],
    ["stream", "streaming"],
  ] as const)(
    "recovers a %s task after cleanup without clearing user state",
    (mode, runningStatus) => {
      const outputDirectoryAuthorization = {
        outputDirToken: "output_dir_token",
        directoryName: "Speech exports",
        expiresAt: Date.now() + 60_000,
      };
      const result = {
        outputToken: "previous_output_token",
        mimeType: "audio/wav",
        responseFormat: "wav" as const,
        sizeBytes: 256,
      };
      useSpeechSynthesizerStore.getState().updatePreferences({
        input: "Keep this draft",
        voice: "coral",
      });
      useSpeechSynthesizerStore
        .getState()
        .setOutputDirectoryAuthorization(outputDirectoryAuthorization);
      useSpeechSynthesizerStore.getState().beginTask("request_before_unmount", mode);
      useSpeechSynthesizerStore.getState().setResult(result);

      expect(useSpeechSynthesizerStore.getState().status).toBe(runningStatus);
      useSpeechSynthesizerStore
        .getState()
        .invalidateTask("request_before_unmount");

      expect(useSpeechSynthesizerStore.getState()).toMatchObject({
        preferences: {
          input: "Keep this draft",
          voice: "coral",
        },
        outputDirectoryAuthorization,
        result,
        status: "cancelled",
        activeRequestId: null,
        activeMode: null,
      });

      useSpeechSynthesizerStore.getState().beginTask("request_after_remount", mode);
      expect(useSpeechSynthesizerStore.getState()).toMatchObject({
        status: runningStatus,
        activeRequestId: "request_after_remount",
        activeMode: mode,
      });
    },
  );

  it("does not let stale cleanup invalidate a newer task", () => {
    useSpeechSynthesizerStore.getState().beginTask("current_request", "stream");

    useSpeechSynthesizerStore.getState().invalidateTask("stale_request");

    expect(useSpeechSynthesizerStore.getState()).toMatchObject({
      status: "streaming",
      activeRequestId: "current_request",
      activeMode: "stream",
    });
  });
});
