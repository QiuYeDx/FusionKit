import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS,
  subtitleTranslationIpcSuccess,
} from "@/type/subtitleTranslationIpc";
import { SubtitleTranslationDirectoryCapabilityRegistry } from "../../electron/main/translation/directory-capability";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

const OWNER_SESSION_A = "12345678-1234-4123-8123-123456789abc";
const OWNER_SESSION_B = "22345678-1234-4123-8123-123456789abc";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("subtitle translation IPC service", () => {
  it("turns the fixed Agent picker into an owner-bound path-free selection receipt", async () => {
    const sourceDirectory = await outputDirectory("agent-source");
    const sourcePath = path.join(sourceDirectory, "agent-selected.srt");
    await writeFile(sourcePath, "1\n00:00:00,000 --> 00:00:01,000\nAgent\n");
    const capabilities = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("input", "item", "selection", "source", "target"),
    });
    const { SubtitleTranslationIpcService } = await import(
      "../../electron/main/translation/ipc"
    );
    const service = new SubtitleTranslationIpcService({
      ownerSessions: fakeOwnerSessions() as never,
      directoryCapabilities: capabilities,
      selectAgentInputFiles: async () => ({
        canceled: false,
        filePaths: [sourcePath],
      }),
    });
    const eventA = fakeEvent(29);
    const eventB = fakeEvent(30);

    const selected = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectAgentInputFiles,
      eventA as never,
      envelope(OWNER_SESSION_A, {}),
    );
    expect(selected).toMatchObject({
      ok: true,
      data: {
        cancelled: false,
        selectionRef: "subtitle-translation-selection-selection",
        files: [{
          itemRef: "subtitle-translation-selection-item-item",
          displayName: "agent-selected.srt",
        }],
      },
    });
    expect(JSON.stringify(selected)).not.toContain(sourceDirectory);
    if (!selected.ok || (selected.data as { cancelled: boolean }).cancelled) {
      throw new Error("Agent selection failed");
    }
    const selection = selected.data as {
      selectionRef: string;
      files: Array<{ itemRef: string; displayName: string }>;
    };

    const denied = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile,
      eventB as never,
      envelope(OWNER_SESSION_B, {
        selectionRef: selection.selectionRef,
        itemRef: selection.files[0].itemRef,
      }),
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    const content = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile,
      eventA as never,
      envelope(OWNER_SESSION_A, {
        selectionRef: selection.selectionRef,
        itemRef: selection.files[0].itemRef,
      }),
    );
    expect(content).toMatchObject({
      ok: true,
      data: { displayName: "agent-selected.srt", content: expect.stringContaining("Agent") },
    });
    const reference = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask,
      eventA as never,
      envelope(OWNER_SESSION_A, {
        selectionRef: selection.selectionRef,
        itemRef: selection.files[0].itemRef,
        taskId: "subtitle-task-agent-ipc",
        outputMode: "source",
        outputFileName: "agent-selected.srt",
      }),
    );
    expect(reference).toMatchObject({
      ok: true,
      data: { kind: "authorized_task_v1" },
    });
    const replay = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask,
      eventA as never,
      envelope(OWNER_SESSION_A, {
        selectionRef: selection.selectionRef,
        itemRef: selection.files[0].itemRef,
        taskId: "subtitle-task-agent-replay",
        outputMode: "source",
        outputFileName: "agent-selected.srt",
      }),
    );
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
  });

  it("binds selected files to path-free task authority and fixed reveal", async () => {
    const sourceDirectory = await outputDirectory("selected-source");
    const sourcePath = path.join(sourceDirectory, "selected.srt");
    await writeFile(sourcePath, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    const capabilities = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("input", "source", "target"),
    });
    const { SubtitleTranslationIpcService } = await import(
      "../../electron/main/translation/ipc"
    );
    const { shell } = await import("electron");
    const service = new SubtitleTranslationIpcService({
      ownerSessions: fakeOwnerSessions() as never,
      directoryCapabilities: capabilities,
    });
    const event = fakeEvent(30);

    const input = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile,
      event as never,
      envelope(OWNER_SESSION_A, { filePath: sourcePath }),
    );
    expect(input).toMatchObject({
      ok: true,
      data: {
        inputToken: "subtitle-translation-input-input",
        displayName: "selected.srt",
      },
    });
    if (!input.ok) throw new Error("input authorization failed");
    const content = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readInputFile,
      event as never,
      envelope(OWNER_SESSION_A, {
        inputToken: (input.data as { inputToken: string }).inputToken,
      }),
    );
    expect(content).toMatchObject({
      ok: true,
      data: { displayName: "selected.srt", content: expect.stringContaining("Hello") },
    });
    const reference = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAuthorizedTask,
      event as never,
      envelope(OWNER_SESSION_A, {
        taskId: "subtitle-task-selected-ipc",
        inputToken: (input.data as { inputToken: string }).inputToken,
        outputMode: "source",
        outputFileName: "selected.srt",
      }),
    );
    expect(reference).toMatchObject({
      ok: true,
      data: {
        kind: "authorized_task_v1",
        source: { displayName: "selected.srt" },
        target: { displayLabel: "selected-source" },
      },
    });
    if (!reference.ok) throw new Error("task registration failed");

    await expect(service.resolveExecutionTaskForSender(30, {
      task: {
        taskId: "subtitle-task-selected-ipc",
        fileName: "selected.srt",
        fileContent: "subtitle content",
        sliceType: "NORMAL",
        status: "NotStarted",
        executionBinding: { status: "needs_configuration" },
      },
      reference: reference.data,
    })).resolves.toMatchObject({
      authorized: true,
      generated: false,
      task: {
        originFileURL: await realpath(sourcePath),
        targetFileURL: sourceDirectory,
      },
    });
    const revealed = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskSource,
      event as never,
      envelope(OWNER_SESSION_A, { taskId: "subtitle-task-selected-ipc" }),
    );
    expect(revealed).toEqual(subtitleTranslationIpcSuccess({ revealed: true }));
    expect(shell.showItemInFolder).toHaveBeenCalledWith(await realpath(sourcePath));
  });

  it("keeps picker and reauthorization authority owner-bound", async () => {
    const first = await outputDirectory("first");
    const second = await outputDirectory("second");
    const third = await outputDirectory("third");
    const selections = [first, second, third];
    const capabilities = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("draft", "initial", "rotated"),
    });
    const { SubtitleTranslationIpcService } = await import(
      "../../electron/main/translation/ipc"
    );
    const service = new SubtitleTranslationIpcService({
      ownerSessions: fakeOwnerSessions() as never,
      directoryCapabilities: capabilities,
      selectOutputDirectory: async () => ({
        canceled: false,
        filePaths: [selections.shift()!],
      }),
    });
    const eventA = fakeEvent(31);
    const eventB = fakeEvent(32);

    const selected = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory,
      eventA as never,
      envelope(OWNER_SESSION_A, {}),
    );
    expect(selected).toMatchObject({
      ok: true,
      data: {
        cancelled: false,
        directoryToken: "subtitle-translation-draft-draft",
        displayLabel: "first",
      },
    });
    if (!selected.ok || selected.data.cancelled) throw new Error("selection failed");

    const reference = await capabilities.registerGeneratedTask({
      owner: { webContentsId: 31, ownerSessionId: OWNER_SESSION_A },
      taskId: "subtitle-task-ipc-owner",
      sourceDisplayName: "owner.srt",
      outputFileName: "owner.srt",
      directoryToken: (selected.data as { directoryToken: string }).directoryToken,
    });

    const denied = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.reauthorizeTaskTarget,
      eventB as never,
      envelope(OWNER_SESSION_B, { taskId: "subtitle-task-ipc-owner" }),
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    await expect(capabilities.resolveTaskReference(
      { webContentsId: 31, ownerSessionId: OWNER_SESSION_A },
      "subtitle-task-ipc-owner",
      reference,
    )).resolves.toMatchObject({ targetDirectoryPath: first });

    const rotated = await service.handleInternal(
      SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.reauthorizeTaskTarget,
      eventA as never,
      envelope(OWNER_SESSION_A, { taskId: "subtitle-task-ipc-owner" }),
    );
    expect(rotated).toMatchObject({
      ok: true,
      data: {
        cancelled: false,
        taskId: "subtitle-task-ipc-owner",
        target: {
          token: "subtitle-translation-target-rotated",
          displayLabel: "second",
        },
      },
    });

    service.releaseOwner({ senderId: 31, ownerSessionId: OWNER_SESSION_A });
    expect(capabilities.isGeneratedTask("subtitle-task-ipc-owner")).toBe(false);
  });

  it("adapts path-free generated execution only for its sender", async () => {
    const output = await outputDirectory("generated");
    const capabilities = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("draft", "target"),
    });
    const draft = await capabilities.authorizeDraft(
      { webContentsId: 41, ownerSessionId: OWNER_SESSION_A },
      output,
    );
    const reference = await capabilities.registerGeneratedTask({
      owner: { webContentsId: 41, ownerSessionId: OWNER_SESSION_A },
      taskId: "subtitle-task-main-adapter",
      sourceDisplayName: "generated.srt",
      outputFileName: "generated.srt",
      directoryToken: draft.directoryToken,
    });
    const { SubtitleTranslationIpcService } = await import(
      "../../electron/main/translation/ipc"
    );
    const service = new SubtitleTranslationIpcService({
      ownerSessions: fakeOwnerSessions() as never,
      directoryCapabilities: capabilities,
    });
    const task = {
      taskId: "subtitle-task-main-adapter",
      fileName: "generated.srt",
      fileContent: "generated subtitle content",
      sliceType: "NORMAL",
      status: "NotStarted",
      executionBinding: { status: "needs_configuration" },
    };

    await expect(service.resolveExecutionTaskForSender(42, {
      task,
      reference,
    })).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(service.resolveExecutionTaskForSender(41, {
      task: { ...task, targetFileURL: "/forged/path" },
      reference,
    })).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(service.resolveExecutionTaskForSender(41, {
      task,
      reference,
    })).resolves.toMatchObject({
      generated: true,
      task: {
        taskId: "subtitle-task-main-adapter",
        originFileURL: "",
        targetFileURL: output,
      },
    });
    await expect(service.resolveExecutionTaskForSender(41, {
      ...task,
      originFileURL: path.join(output, "generated.srt"),
      targetFileURL: output,
    })).rejects.toMatchObject({ code: "task_reference_conflict" });
  });
});

function fakeOwnerSessions() {
  return {
    register: vi.fn(),
    authorize(event: { sender: { id: number } }, value: unknown) {
      const request = value as {
        ownerSessionId: string;
        payload: unknown;
      };
      return subtitleTranslationIpcSuccess({
        ownerSessionId: request.ownerSessionId,
        senderId: event.sender.id,
        processId: 1,
        frameId: 1,
        payload: request.payload,
        signal: new AbortController().signal,
      });
    },
    isCurrent: () => true,
    onOwnerReleased: vi.fn(),
  };
}

function fakeEvent(senderId: number) {
  return { sender: { id: senderId } };
}

function envelope(ownerSessionId: string, payload: unknown) {
  return { ownerSessionId, payload };
}

async function outputDirectory(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-translation-ipc-"));
  tempRoots.push(root);
  const output = path.join(root, name);
  await mkdir(output);
  return realpath(output);
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `token-${index}`;
}
