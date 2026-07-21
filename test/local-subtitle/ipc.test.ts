import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSubtitleError } from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcFailure,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleIpcService } from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleOwnerSessionRegistry } from "../../electron/main/local-subtitle/ipc-security";

const DEV_SERVER_URL = "http://127.0.0.1:7777/";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local subtitle IPC service", () => {
  it("validates public requests before dispatch and validates handler results", async () => {
    const cancelTask = vi.fn(() =>
      localSubtitleIpcSuccess({ cancelled: true }),
    );
    const fixture = createService({
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: cancelTask,
      },
    });

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
        fixture.event,
        fixture.envelope({ taskId: "task-1", executable: "/tmp/run" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(cancelTask).not.toHaveBeenCalled();

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
        fixture.event,
        fixture.envelope({ taskId: "task-1" }),
      ),
    ).resolves.toEqual({ ok: true, data: { cancelled: true } });
    expect(cancelTask).toHaveBeenCalledOnce();

    const invalidFixture = createService({
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: () =>
          localSubtitleIpcSuccess({
            cancelled: true,
            outputPath: "/private/result.srt",
          }),
      },
    });
    await expect(
      invalidFixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
        invalidFixture.event,
        invalidFixture.envelope({ taskId: "task-1" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_content", stage: "ipc" },
    });
  });

  it("rejects unknown channels and returns stable unavailable errors", async () => {
    const fixture = createService();

    await expect(
      fixture.service.handlePublic(
        "local-subtitle:cancel-task:extra",
        fixture.event,
        fixture.envelope({ taskId: "task-1" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
        fixture.event,
        fixture.envelope({ taskId: "task-1" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_missing" },
    });
  });

  it("keeps selected input paths inside private authorization handling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-local-ipc-"));
    tempRoots.push(root);
    const inputPath = path.join(root, "sample.wav");
    await writeFile(inputPath, "wave-bytes");
    const fixture = createService();

    const result = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({ files: [{ filePath: inputPath }] }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          displayName: "sample.wav",
          byteSize: 10,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(inputPath);

    if (!result.ok) throw new Error("Expected input authorization.");
    const fileToken = (result.data as Array<{ fileToken: string }>)[0]!.fileToken;
    await expect(
      fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile,
        fixture.event,
        fixture.envelope({ fileToken }),
      ),
    ).resolves.toEqual({ ok: true, data: { revoked: true } });
  });

  it("rejects resource URL and path injection before private import handlers", async () => {
    const importModel = vi.fn(() =>
      localSubtitleIpcFailure(
        createLocalSubtitleError(
          "resource_not_allowed",
          "Model manager is unavailable.",
        ),
      ),
    );
    const fixture = createService({ importModel });

    await expect(
      fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
        fixture.event,
        fixture.envelope({
          filePath: "/private/model.bin",
          mode: "copy",
          url: "https://example.invalid/model.bin",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(importModel).not.toHaveBeenCalled();

    await expect(
      fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
        fixture.event,
        fixture.envelope({
          filePath: "https://example.invalid/model.bin",
          mode: "copy",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(importModel).not.toHaveBeenCalled();

    await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
      fixture.event,
      fixture.envelope({ filePath: "/private/model.bin", mode: "copy" }),
    );
    expect(importModel).toHaveBeenCalledOnce();
  });

  it("drops late handler results after the document owner is released", async () => {
    const deferred = createDeferred<ReturnType<typeof localSubtitleIpcSuccess>>();
    const fixture = createService({
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: () =>
          deferred.promise,
      },
    });

    const pending = fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
      fixture.event,
      fixture.envelope({ taskId: "task-1" }),
    );
    fixture.registry.release(fixture.ownerSessionId);
    deferred.resolve(localSubtitleIpcSuccess({ cancelled: true }));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
  });

  it("requires an empty strict payload for the sync owner handshake", () => {
    const registry = new LocalSubtitleOwnerSessionRegistry({
      trustedSender: { devServerUrl: DEV_SERVER_URL },
    });
    const frame = new FakeFrame();
    const sender = new FakeSender(10, frame);
    frame.sender = sender;
    const event = createEvent(sender, frame);
    const service = new LocalSubtitleIpcService({ ownerSessions: registry });

    expect(service.registerOwnerSession(event, { injected: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(service.registerOwnerSession(event, {})).toMatchObject({
      ok: true,
      data: { ownerSessionId: expect.any(String) },
    });
  });
});

function createService(
  handlers: ConstructorParameters<typeof LocalSubtitleIpcService>[0]["handlers"] = {},
) {
  const registry = new LocalSubtitleOwnerSessionRegistry({
    trustedSender: { devServerUrl: DEV_SERVER_URL },
  });
  const frame = new FakeFrame();
  const sender = new FakeSender(10, frame);
  frame.sender = sender;
  const event = createEvent(sender, frame);
  const service = new LocalSubtitleIpcService({
    ownerSessions: registry,
    handlers,
  });
  const registration = service.registerOwnerSession(event, {});
  if (!registration.ok) throw new Error("Could not register test owner.");
  const ownerSessionId = (registration.data as { ownerSessionId: string })
    .ownerSessionId;
  return {
    service,
    registry,
    event,
    ownerSessionId,
    envelope: (payload: unknown) => ({ ownerSessionId, payload }),
  };
}

function createEvent(sender: FakeSender, frame: FakeFrame) {
  return {
    sender,
    senderFrame: frame,
    processId: frame.processId,
    frameId: frame.routingId,
  } as never;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeFrame extends EventEmitter {
  readonly processId = 20;
  readonly routingId = 30;
  readonly url = `${DEV_SERVER_URL}#/tools/subtitle/local-transcriber`;
  readonly parent = null;
  readonly detached = false;
  destroyed = false;
  sender?: FakeSender;
  readonly send = vi.fn();

  isDestroyed() {
    return this.destroyed;
  }
}

class FakeSender extends EventEmitter {
  destroyed = false;

  constructor(
    readonly id: number,
    readonly mainFrame: FakeFrame,
  ) {
    super();
  }

  isDestroyed() {
    return this.destroyed;
  }
}
