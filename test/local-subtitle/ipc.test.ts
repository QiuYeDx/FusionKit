import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
  createLocalSubtitleError,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcFailure,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleIpcService } from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleOwnerSessionRegistry } from "../../electron/main/local-subtitle/ipc-security";
import { LocalSubtitleMediaError } from "../../electron/main/local-subtitle/media-normalizer";
import { LocalSubtitleResourceError } from "../../electron/main/local-subtitle/resource-manifest";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";
import {
  localSubtitleFilesystemObjectIdentityForPath,
} from "../../electron/main/local-subtitle/filesystem-object-identity";

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
      fixture.envelope({
        source: "picker",
        files: [{ filePath: inputPath }],
      }),
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

  it("authorizes the original path returned for an Explorer drop proxy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-local-ipc-drop-"));
    tempRoots.push(root);
    const proxyPath = path.join(root, "sample (1).wav");
    const originalPath = path.join(root, "sample.wav");
    await Promise.all([
      writeFile(proxyPath, "proxy-wave-bytes"),
      writeFile(originalPath, "original-wave-bytes"),
    ]);
    const resolveInputPaths = vi.fn(async () => [originalPath]);
    const fixture = createService({}, undefined, { resolveInputPaths });

    const result = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({
        source: "drop",
        files: [{ filePath: proxyPath }],
      }),
    );

    expect(resolveInputPaths).toHaveBeenCalledWith([proxyPath], "drop");
    expect(result).toMatchObject({
      ok: true,
      data: [{ displayName: "sample.wav", byteSize: 19 }],
    });
    expect(JSON.stringify(result)).not.toContain(originalPath);
    expect(JSON.stringify(result)).not.toContain(proxyPath);
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
          modelId: "large-v3-q5_0",
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
          modelId: "large-v3-q5_0",
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
      fixture.envelope({
        filePath: "/private/model.bin",
        mode: "copy",
        modelId: "large-v3-q5_0",
      }),
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

  it("passes the private owner abort signal into handler context", async () => {
    let handlerSignal: AbortSignal | undefined;
    const fixture = createService({
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: (_request, context) => {
          handlerSignal = context.signal;
          return localSubtitleIpcSuccess({ cancelled: true });
        },
      },
    });
    const authorization = fixture.registry.authorize(
      fixture.event,
      fixture.envelope({ taskId: "task-1" }),
    );
    if (!authorization.ok) throw new Error("Expected owner authorization.");

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
        fixture.event,
        fixture.envelope({ taskId: "task-1" }),
      ),
    ).resolves.toEqual({ ok: true, data: { cancelled: true } });
    expect(handlerSignal).toBe(authorization.data.signal);
    expect(handlerSignal?.aborted).toBe(false);

    fixture.registry.release(fixture.ownerSessionId);
    expect(handlerSignal?.aborted).toBe(true);
  });

  it("returns owner_released when a late public handler rejects", async () => {
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
    deferred.reject(new Error("late private failure"));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
  });

  it("reads and reveals app-scoped artifacts without exposing their paths", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fusionkit-local-artifact-ipc-")),
    );
    tempRoots.push(root);
    const artifactPath = path.join(root, "result.srt");
    const rawText = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";
    await writeFile(artifactPath, rawText, "utf8");
    const revealFile = vi.fn();
    const artifacts = new LocalSubtitleArtifactRegistry({ revealFile });
    const fixture = createService({}, { artifacts });
    const owner = {
      webContentsId: 10,
      ownerSessionId: fixture.ownerSessionId,
    };
    const reserved = artifacts.reserve({
      owner,
      taskId: "task-artifact-ipc",
      generation: 1,
      format: "SRT",
      displayName: "result.srt",
    });
    const expectedIdentities = await captureExpectedIdentities(artifactPath);
    artifacts.activate(reserved.reservation, {
      filePath: artifactPath,
      format: "SRT",
      displayName: "result.srt",
      byteSize: Buffer.byteLength(rawText),
      sha256: createHash("sha256").update(rawText).digest("hex"),
      ...expectedIdentities,
    });

    const readResult = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText,
      fixture.event,
      fixture.envelope({ artifactRef: reserved.artifactRef }),
    );
    expect(readResult).toEqual({
      ok: true,
      data: {
        format: "SRT",
        rawText,
        plainText: "Hello",
        cueCount: 1,
      },
    });
    expect(JSON.stringify(readResult)).not.toContain(root);

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact,
        fixture.event,
        fixture.envelope({ artifactRef: reserved.artifactRef }),
      ),
    ).resolves.toEqual({ ok: true, data: { revealed: true } });
    expect(revealFile).toHaveBeenCalledWith(artifactPath);

    const storedContentBuffers: Buffer[] = [];
    const importTokens = fixture.service.capabilities.importTokens;
    const mintImportToken = importTokens.mint.bind(importTokens);
    vi.spyOn(importTokens, "mint").mockImplementation(
      (tokenOwner, value, bytes, dispose) => {
        storedContentBuffers.push(value.contentBytes);
        return mintImportToken(tokenOwner, value, bytes, dispose);
      },
    );
    const handoff = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact,
      fixture.event,
      fixture.envelope({ artifactRef: reserved.artifactRef }),
    );
    expect(handoff).toMatchObject({
      ok: true,
      data: {
        translationImportToken: expect.stringMatching(/^ls-import-/u),
        expiresAt: expect.any(Number),
      },
    });
    expect(JSON.stringify(handoff)).not.toContain(root);
    expect(JSON.stringify(handoff)).not.toContain(rawText);
    expect(JSON.stringify(handoff)).not.toContain(
      createHash("sha256").update(rawText).digest("hex"),
    );
    if (!handoff.ok) throw new Error("Expected a handoff token.");
    const { translationImportToken } = handoff.data as {
      readonly translationImportToken: string;
    };
    const secondHandoff = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact,
      fixture.event,
      fixture.envelope({ artifactRef: reserved.artifactRef }),
    );
    if (!secondHandoff.ok) throw new Error("Expected a second handoff token.");
    const secondTranslationImportToken = (secondHandoff.data as {
      readonly translationImportToken: string;
    }).translationImportToken;
    expect(storedContentBuffers).toHaveLength(2);
    expect(storedContentBuffers[0]?.toString("utf8")).toBe(rawText);
    expect(storedContentBuffers[1]?.toString("utf8")).toBe(rawText);
    await writeFile(
      artifactPath,
      "1\n00:00:00,000 --> 00:00:01,000\nChanged\n",
      "utf8",
    );
    await expect(
      fixture.service.capabilities.handoffs.consume(
        owner,
        translationImportToken,
        (snapshot) => snapshot,
      ),
    ).resolves.toMatchObject({
      content: rawText,
      format: "SRT",
      displayName: "result.srt",
      cueCount: 1,
      artifactIdentity: {
        artifactRef: reserved.artifactRef,
        taskId: "task-artifact-ipc",
        generation: 1,
        format: "SRT",
        byteSize: Buffer.byteLength(rawText),
      },
    });
    expect(storedContentBuffers[0]?.every((byte) => byte === 0)).toBe(true);
    await expect(
      fixture.service.capabilities.handoffs.consume(
        owner,
        translationImportToken,
        (snapshot) => snapshot,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    expect(
      fixture.service.capabilities.handoffs.revokeTask(
        owner,
        "task-artifact-ipc",
      ),
    ).toBe(1);
    expect(storedContentBuffers[1]?.every((byte) => byte === 0)).toBe(true);
    await expect(
      fixture.service.capabilities.handoffs.consume(
        owner,
        secondTranslationImportToken,
        (snapshot) => snapshot,
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      fixture.service.capabilities.artifacts.readText(
        owner,
        reserved.artifactRef,
      ),
    ).rejects.toMatchObject({ code: "artifact_expired" });
  });

  it("maps stable artifact validation failures through the IPC envelope", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fusionkit-local-artifact-error-")),
    );
    tempRoots.push(root);
    const artifactPath = path.join(root, "changed.lrc");
    const rawText = "[00:00.00]Before\n";
    await writeFile(artifactPath, rawText, "utf8");
    const artifacts = new LocalSubtitleArtifactRegistry();
    const fixture = createService({}, { artifacts });
    const owner = {
      webContentsId: 10,
      ownerSessionId: fixture.ownerSessionId,
    };
    const reserved = artifacts.reserve({
      owner,
      taskId: "task-artifact-error",
      generation: 1,
      format: "LRC",
      displayName: "changed.lrc",
    });
    const expectedIdentities = await captureExpectedIdentities(artifactPath);
    artifacts.activate(reserved.reservation, {
      filePath: artifactPath,
      format: "LRC",
      displayName: "changed.lrc",
      byteSize: Buffer.byteLength(rawText),
      sha256: createHash("sha256").update(rawText).digest("hex"),
      ...expectedIdentities,
    });
    await writeFile(artifactPath, "[00:00.00]After!\n", "utf8");

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText,
        fixture.event,
        fixture.envelope({ artifactRef: reserved.artifactRef }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "artifact_changed",
        stage: "artifact",
        field: "artifactRef",
      },
    });
  });

  it("returns owner_released when a late internal handler rejects", async () => {
    const deferred = createDeferred<ReturnType<typeof localSubtitleIpcSuccess>>();
    const fixture = createService({ importModel: () => deferred.promise });
    const pending = fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
      fixture.event,
      fixture.envelope({
        filePath: path.resolve("model.bin"),
        mode: "copy",
        modelId: "large-v3-q5_0",
      }),
    );
    fixture.registry.release(fixture.ownerSessionId);
    deferred.reject(new Error("late private import failure"));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
  });

  it("maps media and resource failures without exposing private diagnostics", async () => {
    const privatePath = "/Users/private-owner/secret/input.mov";
    const privateCause = "ffmpeg stderr included a private token";
    const mediaFixture = createService({
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: () => {
          throw new LocalSubtitleMediaError(
            "decode_failed",
            "media_decode_failed",
            "preparing_media",
            `Could not decode ${privatePath}`,
            { cause: new Error(privateCause) },
          );
        },
      },
    });
    const mediaResult = await mediaFixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
      mediaFixture.event,
      mediaFixture.envelope({ taskId: "task-1" }),
    );
    expect(mediaResult).toEqual({
      ok: false,
      error: {
        code: "media_decode_failed",
        message: "Local subtitle media operation failed.",
        stage: "preparing_media",
        retryable: true,
      },
    });
    expect(JSON.stringify(mediaResult)).not.toContain(privatePath);
    expect(JSON.stringify(mediaResult)).not.toContain(privateCause);

    const resourceFailure = new LocalSubtitleResourceError(
      "media_runtime_invalid",
      "static_verification",
      `Runtime verification failed at ${privatePath}`,
    );
    Object.defineProperty(resourceFailure, "cause", {
      value: new Error(privateCause),
    });
    const resourceFixture = createService({
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: () => {
          throw resourceFailure;
        },
      },
    });
    const resourceResult = await resourceFixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
      resourceFixture.event,
      resourceFixture.envelope({ taskId: "task-1" }),
    );
    expect(resourceResult).toEqual({
      ok: false,
      error: {
        code: "media_runtime_invalid",
        message: "Local subtitle runtime resource is unavailable.",
        stage: "preflight",
        retryable: true,
      },
    });
    expect(JSON.stringify(resourceResult)).not.toContain(privatePath);
    expect(JSON.stringify(resourceResult)).not.toContain(privateCause);
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
      data: {
        ownerSessionId: expect.any(String),
        bridgeVersion: LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
      },
    });
  });
});

function createService(
  handlers: ConstructorParameters<typeof LocalSubtitleIpcService>[0]["handlers"] = {},
  capabilities?: ConstructorParameters<
    typeof LocalSubtitleIpcService
  >[0]["capabilities"],
  overrides: Pick<
    ConstructorParameters<typeof LocalSubtitleIpcService>[0],
    "resolveInputPaths"
  > = {},
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
    capabilities,
    ...overrides,
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

async function captureExpectedIdentities(filePath: string) {
  const [expectedFileIdentity, expectedDirectoryIdentity] = await Promise.all([
    localSubtitleFilesystemObjectIdentityForPath(filePath),
    localSubtitleFilesystemObjectIdentityForPath(path.dirname(filePath)),
  ]);
  return {
    expectedFileIdentity,
    expectedDirectoryIdentity,
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
