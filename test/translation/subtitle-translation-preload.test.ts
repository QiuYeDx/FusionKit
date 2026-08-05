import { describe, expect, it, vi } from "vitest";
import {
  SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS,
  subtitleTranslationIpcSuccess,
} from "@/type/subtitleTranslationIpc";
import {
  assertLegacySubtitleTranslationChannelAllowed,
  isProtectedSubtitleTranslationChannel,
} from "../../electron/preload/subtitle-translation-channel-policy";
import { createSubtitleTranslationRendererApi } from "../../electron/preload/subtitle-translation-api";

const OWNER_SESSION_ID = "12345678-1234-4123-8123-123456789abc";
const LOCAL_OWNER_SESSION_ID = "22345678-1234-4123-8123-123456789abc";

describe("subtitle translation preload policy", () => {
  it("blocks the complete namespace from the legacy bridge", () => {
    for (const channel of [
      ...Object.values(SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS),
      "subtitle-translation:future-channel",
    ]) {
      expect(isProtectedSubtitleTranslationChannel(channel)).toBe(true);
      expect(() => assertLegacySubtitleTranslationChannelAllowed(channel))
        .toThrow(/fixed subtitleTranslationApi/);
    }
    expect(isProtectedSubtitleTranslationChannel("subtitle-translationx:test"))
      .toBe(false);
    expect(() => assertLegacySubtitleTranslationChannelAllowed("translate-subtitle"))
      .not.toThrow();
  });
});

describe("subtitle translation fixed preload API", () => {
  it("exposes only fixed operations with a private owner envelope", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile) {
        return subtitleTranslationIpcSuccess({
          inputToken: "subtitle-translation-input-one",
          displayName: "selected.srt",
          expiresAt: 2_000,
        });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeInputFile) {
        return subtitleTranslationIpcSuccess({ revoked: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readInputFile) {
        return subtitleTranslationIpcSuccess({
          displayName: "selected.srt",
          content: "subtitle content",
        });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectAgentInputFiles) {
        return subtitleTranslationIpcSuccess({
          cancelled: false as const,
          selectionRef: "subtitle-translation-selection-one",
          files: [{
            itemRef: "subtitle-translation-selection-item-one",
            displayName: "selected.srt",
          }],
          expiresAt: 2_000,
        });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile) {
        return subtitleTranslationIpcSuccess({
          displayName: "selected.srt",
          content: "subtitle content",
        });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeAgentInputSelection) {
        return subtitleTranslationIpcSuccess({ revoked: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask) {
        return subtitleTranslationIpcSuccess({
          kind: "authorized_task_v1" as const,
          source: {
            kind: "authorized_file" as const,
            token: "subtitle-translation-source-agent",
            displayName: "selected.srt",
          },
          target: {
            kind: "authorized_directory" as const,
            token: "subtitle-translation-target-agent",
            displayLabel: "Output",
          },
        });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAuthorizedTask) {
        return subtitleTranslationIpcSuccess({
          kind: "authorized_task_v1" as const,
          source: {
            kind: "authorized_file" as const,
            token: "subtitle-translation-source-one",
            displayName: "selected.srt",
          },
          target: {
            kind: "authorized_directory" as const,
            token: "subtitle-translation-target-one",
            displayLabel: "Output",
          },
        });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskSource) {
        return subtitleTranslationIpcSuccess({ revealed: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory) {
        return subtitleTranslationIpcSuccess({ cancelled: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory) {
        return subtitleTranslationIpcSuccess({ revoked: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.acquireImportDirectoryLease) {
        return subtitleTranslationIpcSuccess({
          directoryLeaseToken: "subtitle-translation-lease-one",
          displayLabel: "Output",
          expiresAt: 2_000,
        });
      }
      if (
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseImportDirectoryLease ||
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedImportCandidate ||
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedTask
      ) {
        return subtitleTranslationIpcSuccess({ released: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.commitGeneratedImportCandidate) {
        return subtitleTranslationIpcSuccess({ committed: true });
      }
      if (channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.createGeneratedImportCandidate) {
        return subtitleTranslationIpcSuccess({
          taskId: "subtitle-task-one",
          handoffKey: "subtitle-handoff-one",
          candidateBinding: "subtitle-candidate-one",
          displayName: "generated.srt",
          format: "SRT" as const,
          content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
          reference: {
            kind: "generated_task_v1" as const,
            source: {
              kind: "generated_content" as const,
              displayName: "generated.srt",
            },
            target: {
              kind: "authorized_directory" as const,
              token: "subtitle-translation-target-one",
              displayLabel: "Output",
            },
          },
        });
      }
      return subtitleTranslationIpcSuccess({
        cancelled: false as const,
        taskId: "subtitle-task-one",
        target: {
          kind: "authorized_directory" as const,
          token: "subtitle-translation-target-next",
          displayLabel: "Output",
        },
        expiresAt: 2_000,
      });
    });
    const api = createSubtitleTranslationRendererApi({
      ipcRenderer: { invoke } as never,
      webUtils: { getPathForFile: () => "/private/selected.srt" } as never,
      ownerSessionRegistration: subtitleTranslationIpcSuccess({
        ownerSessionId: OWNER_SESSION_ID,
      }),
      localSubtitleOwnerSessionRegistration: subtitleTranslationIpcSuccess({
        ownerSessionId: LOCAL_OWNER_SESSION_ID,
      }),
    });

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "acquireImportDirectoryLease",
      "authorizeInputFile",
      "commitGeneratedImportCandidate",
      "createGeneratedImportCandidate",
      "prepareRecoveredTasks",
      "readAgentInputFile",
      "readInputFile",
      "reauthorizeTaskTarget",
      "registerAgentAuthorizedTask",
      "registerAuthorizedTask",
      "releaseGeneratedImportCandidate",
      "releaseGeneratedTask",
      "releaseImportDirectoryLease",
      "revealRecoveryCheckpoint",
      "revealTaskOutput",
      "revealTaskSource",
      "revokeAgentInputSelection",
      "revokeInputFile",
      "revokeOutputDirectory",
      "revokeRecoveryScan",
      "selectAgentInputFiles",
      "selectOutputDirectory",
      "selectRecoveryDirectory",
      "selectRecoveryManifest",
    ]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("ownerSessionId");

    await api.authorizeInputFile({} as File);
    await api.revokeInputFile("subtitle-translation-input-one");
    await api.readInputFile("subtitle-translation-input-one");
    await api.selectAgentInputFiles();
    await api.readAgentInputFile({
      selectionRef: "subtitle-translation-selection-one",
      itemRef: "subtitle-translation-selection-item-one",
    });
    await api.revokeAgentInputSelection("subtitle-translation-selection-one");
    await api.registerAgentAuthorizedTask({
      selectionRef: "subtitle-translation-selection-one",
      itemRef: "subtitle-translation-selection-item-one",
      taskId: "subtitle-task-agent-one",
      outputMode: "source",
      outputFileName: "selected.srt",
    });
    await api.registerAuthorizedTask({
      taskId: "subtitle-task-one",
      inputToken: "subtitle-translation-input-one",
      outputMode: "source",
      outputFileName: "selected.srt",
    });
    await api.revealTaskSource("subtitle-task-one");
    await api.selectOutputDirectory();
    await api.revokeOutputDirectory("subtitle-translation-draft-one");
    await api.reauthorizeTaskTarget("subtitle-task-one");
    await api.acquireImportDirectoryLease({
      directoryToken: "subtitle-translation-draft-one",
      snapshotId: "snapshot-one",
      expiresAt: 2_000,
    });
    await api.releaseImportDirectoryLease("subtitle-translation-lease-one");
    await api.createGeneratedImportCandidate({
      translationImportToken: "ls-import-one",
      snapshotId: "snapshot-one",
      outputMode: "source",
    });
    const control = {
      taskId: "subtitle-task-one",
      handoffKey: "subtitle-handoff-one",
      candidateBinding: "subtitle-candidate-one",
    };
    await api.commitGeneratedImportCandidate(control);
    await api.releaseGeneratedImportCandidate(control);
    await api.releaseGeneratedTask("subtitle-task-one");
    expect(invoke.mock.calls).toEqual([
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { filePath: "/private/selected.srt" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeInputFile, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { inputToken: "subtitle-translation-input-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readInputFile, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { inputToken: "subtitle-translation-input-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectAgentInputFiles, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {},
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          selectionRef: "subtitle-translation-selection-one",
          itemRef: "subtitle-translation-selection-item-one",
        },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeAgentInputSelection, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { selectionRef: "subtitle-translation-selection-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          selectionRef: "subtitle-translation-selection-one",
          itemRef: "subtitle-translation-selection-item-one",
          taskId: "subtitle-task-agent-one",
          outputMode: "source",
          outputFileName: "selected.srt",
        },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAuthorizedTask, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          taskId: "subtitle-task-one",
          inputToken: "subtitle-translation-input-one",
          outputMode: "source",
          outputFileName: "selected.srt",
        },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskSource, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { taskId: "subtitle-task-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {},
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { directoryToken: "subtitle-translation-draft-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.reauthorizeTaskTarget, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { taskId: "subtitle-task-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.acquireImportDirectoryLease, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          directoryToken: "subtitle-translation-draft-one",
          snapshotId: "snapshot-one",
          expiresAt: 2_000,
        },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseImportDirectoryLease, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { directoryLeaseToken: "subtitle-translation-lease-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.createGeneratedImportCandidate, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          localOwnerSessionId: LOCAL_OWNER_SESSION_ID,
          translationImportToken: "ls-import-one",
          snapshotId: "snapshot-one",
          outputMode: "source",
        },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.commitGeneratedImportCandidate, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: control,
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedImportCandidate, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: control,
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedTask, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { taskId: "subtitle-task-one" },
      }],
    ]);
  });

  it("fails closed for malformed registration, request, and response data", async () => {
    const invoke = vi.fn(async () => ({ ok: true, data: { path: "/private" } }));
    const unavailable = createSubtitleTranslationRendererApi({
      ipcRenderer: { invoke } as never,
      webUtils: { getPathForFile: () => "" } as never,
      ownerSessionRegistration: { ok: true, data: { ownerSessionId: "unsafe" } },
    });
    await expect(unavailable.selectOutputDirectory()).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
    expect(invoke).not.toHaveBeenCalled();

    const api = createSubtitleTranslationRendererApi({
      ipcRenderer: { invoke } as never,
      webUtils: { getPathForFile: () => "/private/selected.srt" } as never,
      ownerSessionRegistration: subtitleTranslationIpcSuccess({
        ownerSessionId: OWNER_SESSION_ID,
      }),
    });
    await expect(api.revokeOutputDirectory("../raw/path")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    await expect(api.selectOutputDirectory()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_content" },
    });
  });

  it("keeps recovery operations on fixed owner-bound methods", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS
          .selectRecoveryDirectory ||
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS
          .selectRecoveryManifest
      ) {
        return subtitleTranslationIpcSuccess({ cancelled: true as const });
      }
      if (
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS
          .revokeRecoveryScan
      ) {
        return subtitleTranslationIpcSuccess({ released: true });
      }
      if (
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS
          .revealRecoveryCheckpoint ||
        channel === SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskOutput
      ) {
        return subtitleTranslationIpcSuccess({ revealed: true });
      }
      return subtitleTranslationIpcSuccess({
        tasks: [],
        totalCandidates: 0,
        batchStart: 0,
        batchEnd: 0,
        hasMore: false,
        nextBatchStart: null,
      });
    });
    const api = createSubtitleTranslationRendererApi({
      ipcRenderer: { invoke } as never,
      webUtils: { getPathForFile: () => "" } as never,
      ownerSessionRegistration: subtitleTranslationIpcSuccess({
        ownerSessionId: OWNER_SESSION_ID,
      }),
    });

    await api.selectRecoveryDirectory({ includeCompleted: true });
    await api.selectRecoveryManifest();
    await api.prepareRecoveredTasks({
      recoveryScanId: "recovery-scan-one",
      directoryToken: "subtitle-directory-one",
      batchStart: 0,
      batchSize: 10,
    });
    await api.revokeRecoveryScan("recovery-scan-one");
    await api.revealRecoveryCheckpoint("checkpoint-one");
    await api.revealTaskOutput("subtitle-task-one");

    expect(invoke.mock.calls).toEqual([
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectRecoveryDirectory, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { includeCompleted: true },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectRecoveryManifest, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {},
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.prepareRecoveredTasks, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          recoveryScanId: "recovery-scan-one",
          directoryToken: "subtitle-directory-one",
          batchStart: 0,
          batchSize: 10,
        },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeRecoveryScan, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { recoveryScanId: "recovery-scan-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealRecoveryCheckpoint, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { checkpointRef: "checkpoint-one" },
      }],
      [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskOutput, {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { taskId: "subtitle-task-one" },
      }],
    ]);
  });
});
