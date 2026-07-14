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
} from "./audioTranscriberConfig";
import {
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
} from "./speechSynthesizerConfig";
import useAudioTranscriberStore, {
  migrateAudioTranscriberPersistedState,
} from "./useAudioTranscriberStore";
import useSpeechSynthesizerStore, {
  migrateSpeechSynthesizerPersistedState,
} from "./useSpeechSynthesizerStore";

const authorization = {
  outputDirToken: "output_dir_token",
  directoryName: "Exports",
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  storage.clear();
  useAudioTranscriberStore.setState({
    preferences: { ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES },
    outputDirectoryAuthorization: null,
  });
  useSpeechSynthesizerStore.setState({
    preferences: { ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES },
    outputDirectoryAuthorization: null,
  });
});

describe("audio output directory store state", () => {
  it("does not persist session authorizations and clears them on reset", () => {
    useAudioTranscriberStore
      .getState()
      .setOutputDirectoryAuthorization(authorization);
    useSpeechSynthesizerStore
      .getState()
      .setOutputDirectoryAuthorization(authorization);

    expect(JSON.stringify([...storage.values()])).not.toContain(
      "output_dir_token",
    );

    useAudioTranscriberStore.getState().resetTaskState();
    useSpeechSynthesizerStore.getState().resetTaskState();

    expect(
      useAudioTranscriberStore.getState().outputDirectoryAuthorization,
    ).toBeNull();
    expect(
      useSpeechSynthesizerStore.getState().outputDirectoryAuthorization,
    ).toBeNull();
  });

  it("clears authorization when the display label changes", () => {
    useAudioTranscriberStore
      .getState()
      .setOutputDirectoryAuthorization(authorization);
    useSpeechSynthesizerStore
      .getState()
      .setOutputDirectoryAuthorization(authorization);

    useAudioTranscriberStore
      .getState()
      .updatePreferences({ outputDir: "Other" });
    useSpeechSynthesizerStore
      .getState()
      .updatePreferences({ outputDir: "Other" });

    expect(
      useAudioTranscriberStore.getState().outputDirectoryAuthorization,
    ).toBeNull();
    expect(
      useSpeechSynthesizerStore.getState().outputDirectoryAuthorization,
    ).toBeNull();
  });

  it("normalizes legacy paths and discards persisted authorizations", () => {
    const migratedTranscriber = migrateAudioTranscriberPersistedState(
      {
        preferences: { outputDir: "/Users/qiuye/Exports/" },
        outputDirectoryAuthorization: authorization,
      },
      2,
    );
    expect(migratedTranscriber).toMatchObject({
      preferences: { outputDir: "Exports" },
    });
    expect(migratedTranscriber).not.toHaveProperty(
      "outputDirectoryAuthorization",
    );
    expect(
      migrateSpeechSynthesizerPersistedState(
        {
          preferences: { outputDir: "C:\\Users\\qiuye\\Exports\\" },
          outputDirectoryAuthorization: authorization,
        },
        3,
      ),
    ).toMatchObject({
      preferences: { outputDir: "Exports" },
    });
  });
});
