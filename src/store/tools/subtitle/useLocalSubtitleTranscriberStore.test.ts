import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";
import {
  getLocalSubtitleRuntimeService,
  resetLocalSubtitleRuntimeServiceForTests,
} from "@/services/local-subtitle/localSubtitleRuntimeService";
import type { LocalSubtitleRendererApi } from "@/type/localSubtitleIpc";
import {
  DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
  sanitizeLocalSubtitleTranscriberPreferences,
} from "./localSubtitleTranscriberConfig";
import useLocalSubtitleTranscriberStore, {
  LOCAL_SUBTITLE_TRANSCRIBER_STORE_VERSION,
  migrateLocalSubtitleTranscriberPersistedState,
} from "./useLocalSubtitleTranscriberStore";

beforeEach(() => {
  storage.clear();
  useLocalSubtitleTranscriberStore.setState({
    preferences: sanitizeLocalSubtitleTranscriberPreferences(
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
    ),
    draftInputFiles: [],
    draftOutputDirectory: null,
    draftInitialPrompt: "",
    draftTaskMode: "transcribe",
    draftConflictPolicy: "index",
    draftPostActionMode: "export_only",
    draftPreferredHandoffFormat: "SRT",
  });
});

afterEach(() => {
  resetLocalSubtitleRuntimeServiceForTests();
  Reflect.deleteProperty(globalThis, "window");
});

describe("local subtitle transcriber store", () => {
  it("persists only the exact safe preference whitelist", () => {
    const state = useLocalSubtitleTranscriberStore.getState();
    state.updatePreferences({ language: "ja", outputFormats: ["SRT", "LRC"] });
    state.setDraftInputFiles([
      {
        fileToken: "private-input-token",
        sourceKey: "private-source-key",
        displayName: "private-input.wav",
        byteSize: 128,
        expiresAt: Date.now() + 60_000,
      },
    ]);
    state.setDraftOutputDirectory({
      cancelled: false,
      outputDirToken: "private-output-token",
      displayLabel: "Exports",
      expiresAt: Date.now() + 60_000,
    });
    state.setDraftInitialPrompt("private spoken names");
    state.setDraftPostActionMode("enqueue_and_start_translation");

    const persisted = storage.get("fusionkit-local-subtitle-transcriber") ?? "";
    expect(persisted).toContain('"language":"ja"');
    expect(persisted).toContain('"outputDirectoryDisplayLabel":"Exports"');
    expect(persisted).not.toMatch(
      /private-(?:input|output)-token|private spoken names|draftInputFiles|draftOutputDirectory|expiresAt/,
    );
    expect(persisted).not.toContain("enqueue_and_start_translation");
    expect(persisted).not.toContain("qualityPreset");
  });

  it("hydrates same-version dirty data without runtime or free-text state", async () => {
    localStorage.setItem(
      "fusionkit-local-subtitle-transcriber",
      JSON.stringify({
        version: LOCAL_SUBTITLE_TRANSCRIBER_STORE_VERSION,
        state: {
          preferences: {
            ...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
            language: "zh",
            outputMode: "custom",
            outputDirectoryDisplayLabel: "Subtitles",
          },
          draftInputFiles: [{ fileToken: "persisted-input-token" }],
          draftOutputDirectory: { outputDirToken: "persisted-output-token" },
          draftInitialPrompt: "persisted private prompt",
          draftPostActionMode: "enqueue_and_start_translation",
          batches: [{ taskId: "persisted-task" }],
          artifactRef: "persisted-artifact",
          segmentText: "persisted subtitle text",
        },
      }),
    );

    vi.resetModules();
    const { default: hydratedStore } = await import(
      "./useLocalSubtitleTranscriberStore"
    );
    const state = hydratedStore.getState();

    expect(state.preferences).toMatchObject({
      language: "zh",
      outputMode: "custom",
      outputDirectoryDisplayLabel: "Subtitles",
    });
    expect(state).toMatchObject({
      draftInputFiles: [],
      draftOutputDirectory: null,
      draftInitialPrompt: "",
      draftTaskMode: "transcribe",
      draftConflictPolicy: "index",
      draftPostActionMode: "export_only",
      draftPreferredHandoffFormat: "SRT",
    });
    expect(JSON.stringify(state)).not.toMatch(
      /persisted-(?:input|output|task|artifact)|private prompt|subtitle text/,
    );
  });

  it("migrates arbitrary envelopes to sanitized preferences only", () => {
    expect(
      migrateLocalSubtitleTranscriberPersistedState(
        {
          preferences: {
            ...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
            language: "ja",
            qualityPreset: "balanced",
          },
          fileToken: "legacy-token",
          initialPrompt: "legacy prompt",
        },
        0,
      ),
    ).toEqual({
      preferences: {
        ...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
        language: "ja",
      },
    });
  });

  it("consumes only committed capabilities without resetting preferences", () => {
    const state = useLocalSubtitleTranscriberStore.getState();
    state.updatePreferences({ language: "ja" });
    state.setDraftInputFiles([
      {
        fileToken: "leased-input-token",
        sourceKey: "leased-source-key",
        displayName: "input.wav",
        byteSize: 128,
        expiresAt: Date.now() + 60_000,
      },
      {
        fileToken: "waiting-input-token",
        sourceKey: "waiting-source-key",
        displayName: "waiting.wav",
        byteSize: 256,
        expiresAt: Date.now() + 60_000,
      },
    ]);
    state.setDraftOutputDirectory({
      cancelled: false,
      outputDirToken: "leased-output-token",
      displayLabel: "Exports",
      expiresAt: Date.now() + 60_000,
    });

    state.consumeDraftCapabilitiesAfterCommit(["leased-input-token"]);

    expect(useLocalSubtitleTranscriberStore.getState()).toMatchObject({
      preferences: {
        language: "ja",
        outputMode: "custom",
        outputDirectoryDisplayLabel: "Exports",
      },
      draftInputFiles: [
        expect.objectContaining({ fileToken: "waiting-input-token" }),
      ],
      draftOutputDirectory: null,
    });
  });

  it("appends later file selections without replacing the existing draft", () => {
    const store = useLocalSubtitleTranscriberStore.getState();
    store.setDraftInputFiles([
      {
        fileToken: "first-selection-token",
        sourceKey: "first-selection-source",
        displayName: "first.wav",
        byteSize: 128,
        expiresAt: Date.now() + 60_000,
      },
    ]);
    store.addDraftInputFiles([
      {
        fileToken: "second-selection-token",
        sourceKey: "second-selection-source",
        displayName: "second.mp4",
        byteSize: 256,
        expiresAt: Date.now() + 60_000,
      },
      {
        fileToken: "third-selection-token",
        sourceKey: "third-selection-source",
        displayName: "third.wav",
        byteSize: 512,
        expiresAt: Date.now() + 60_000,
      },
    ]);

    expect(
      useLocalSubtitleTranscriberStore
        .getState()
        .draftInputFiles.map((file) => file.fileToken),
    ).toEqual([
      "first-selection-token",
      "second-selection-token",
      "third-selection-token",
    ]);
  });

  it("rejects and revokes a later authorization for the same source", async () => {
    const revokeInputFile = vi.fn().mockResolvedValue({
      ok: true,
      data: { revoked: true },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localSubtitleApi: {
          revokeInputFile,
        } as unknown as LocalSubtitleRendererApi,
      },
    });
    const store = useLocalSubtitleTranscriberStore.getState();
    store.setDraftInputFiles([{
      fileToken: "first-token",
      sourceKey: "same-source",
      displayName: "same.wav",
      byteSize: 128,
      expiresAt: Date.now() + 60_000,
    }]);

    store.addDraftInputFiles([{
      fileToken: "duplicate-token",
      sourceKey: "same-source",
      displayName: "same.wav",
      byteSize: 128,
      expiresAt: Date.now() + 60_000,
    }]);
    await getLocalSubtitleRuntimeService().flushPendingDraftRevocations();

    expect(useLocalSubtitleTranscriberStore.getState().draftInputFiles)
      .toHaveLength(1);
    expect(revokeInputFile).toHaveBeenCalledWith("duplicate-token");
  });

  it("does not revoke the accepted capability when the same token is repeated", async () => {
    const revokeInputFile = vi.fn().mockResolvedValue({
      ok: true,
      data: { revoked: true },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localSubtitleApi: {
          revokeInputFile,
        } as unknown as LocalSubtitleRendererApi,
      },
    });
    const file = {
      fileToken: "shared-token",
      sourceKey: "shared-source",
      displayName: "same.wav",
      byteSize: 128,
      expiresAt: Date.now() + 60_000,
    };

    useLocalSubtitleTranscriberStore.getState().setDraftInputFiles([file, file]);
    await getLocalSubtitleRuntimeService().flushPendingDraftRevocations();

    expect(useLocalSubtitleTranscriberStore.getState().draftInputFiles)
      .toEqual([file]);
    expect(revokeInputFile).not.toHaveBeenCalled();
  });

  it("bounds in-memory prompts without persisting them", () => {
    useLocalSubtitleTranscriberStore
      .getState()
      .setDraftInitialPrompt(
        "x".repeat(LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars + 10),
      );

    expect(
      useLocalSubtitleTranscriberStore.getState().draftInitialPrompt,
    ).toHaveLength(LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars);
    expect(storage.get("fusionkit-local-subtitle-transcriber") ?? "").not.toContain(
      '"draftInitialPrompt"',
    );
  });

  it("queues failed draft cleanup before removing the renderer token", async () => {
    const revokeInputFile = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "invalid_ipc_request",
          message: "temporary transport failure",
          stage: "ipc",
          retryable: false,
        },
      })
      .mockResolvedValueOnce({ ok: true, data: { revoked: false } });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localSubtitleApi: {
          revokeInputFile,
        } as unknown as LocalSubtitleRendererApi,
      },
    });
    const store = useLocalSubtitleTranscriberStore.getState();
    store.setDraftInputFiles([
      {
        fileToken: "retry-input-token",
        sourceKey: "retry-input-source",
        displayName: "input.wav",
        byteSize: 128,
        expiresAt: Date.now() + 60_000,
      },
    ]);

    store.removeDraftInputFile("retry-input-token");
    await flushMicrotasks();

    expect(useLocalSubtitleTranscriberStore.getState().draftInputFiles).toEqual(
      [],
    );
    expect(getLocalSubtitleRuntimeService().pendingDraftRevocationCount).toBe(1);

    await getLocalSubtitleRuntimeService().flushPendingDraftRevocations();
    await flushMicrotasks();
    await getLocalSubtitleRuntimeService().flushPendingDraftRevocations();
    expect(revokeInputFile).toHaveBeenCalledTimes(2);
    expect(getLocalSubtitleRuntimeService().pendingDraftRevocationCount).toBe(0);
  });

  it("revokes newly authorized files that exceed the draft limit", async () => {
    const revokeInputFile = vi.fn().mockResolvedValue({
      ok: true,
      data: { revoked: true },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localSubtitleApi: {
          revokeInputFile,
        } as unknown as LocalSubtitleRendererApi,
      },
    });
    const files = Array.from(
      { length: LOCAL_SUBTITLE_LIMITS.maxBatchFiles + 1 },
      (_, index) => ({
        fileToken: `input-${index}`,
        sourceKey: `source-${index}`,
        displayName: `input-${index}.wav`,
        byteSize: 128,
        expiresAt: Date.now() + 60_000,
      }),
    );

    useLocalSubtitleTranscriberStore.getState().setDraftInputFiles(files);
    await getLocalSubtitleRuntimeService().flushPendingDraftRevocations();

    expect(useLocalSubtitleTranscriberStore.getState().draftInputFiles).toHaveLength(
      LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
    );
    expect(revokeInputFile).toHaveBeenCalledOnce();
    expect(revokeInputFile).toHaveBeenCalledWith(
      `input-${LOCAL_SUBTITLE_LIMITS.maxBatchFiles}`,
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
