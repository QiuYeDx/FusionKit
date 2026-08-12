import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
} from "../../src/type/localSubtitle";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  type EnqueueLocalSubtitleBatchRequest,
} from "../../src/type/localSubtitleIpc";
import {
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
} from "../../electron/main/local-subtitle/authorizations";
import { LocalSubtitleBackendResolver } from "../../electron/main/local-subtitle/backend-resolver";
import { LocalSubtitleIpcService } from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleOwnerSessionRegistry } from "../../electron/main/local-subtitle/ipc-security";
import { LocalSubtitleJobIpcBridge } from "../../electron/main/local-subtitle/job-ipc";
import {
  LocalSubtitleJobManager,
  type LocalSubtitleJobBatchRuntime,
} from "../../electron/main/local-subtitle/job-manager";
import type { LocalSubtitleVerifiedRuntimeBundle } from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleSessionIpcBridge } from "../../electron/main/local-subtitle/session-ipc";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";

const DEV_SERVER_URL = "http://127.0.0.1:7777/";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local subtitle Job Manager IPC integration", () => {
  it("previews the main-resolved backend without publishing a batch or leaking proof", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-preview-"));
    tempRoots.push(root);
    const fixture = createFixture(root);

    const preview = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend,
      fixture.event,
      fixture.envelope({
        modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
        devicePreference: "auto",
      }),
    );
    expect(preview).toEqual({
      ok: true,
      data: {
        devicePreference: "auto",
        resolvedBackend: "cpu",
        modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
        serverArtifactId: "whisper-server-cpu",
        serverVersion: "1.9.1+b1ade71",
      },
    });
    const publicPreview = JSON.stringify(preview);
    expect(publicPreview).not.toContain(root);
    expect(publicPreview).not.toContain("runtimeGeneration");
    expect(publicPreview).not.toContain("sha256");

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
        fixture.event,
        fixture.envelope({}),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { revision: 0, batches: [], resourceJobs: [] },
    });

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend,
        fixture.event,
        fixture.envelope({
          modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
          devicePreference: "metal",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "backend_unverified", stage: "preflight" },
    });
  });

  it("replaces task placeholders and forwards task events before snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-ipc-"));
    tempRoots.push(root);
    const sourcePath = path.join(root, "private-source.wav");
    await writeFile(sourcePath, "private media bytes");
    const fixture = createFixture(root);

    const authorized = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({ files: [{ filePath: sourcePath }] }),
    );
    if (!authorized.ok) throw new Error("Expected input authorization.");
    const fileToken = (
      authorized.data as Array<{ readonly fileToken: string }>
    )[0]!.fileToken;
    const output = await fixture.outputs.authorize(fixture.owner, root);

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
        fixture.event,
        fixture.envelope({}),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { revision: 0, batches: [], resourceJobs: [] },
    });
    const request = enqueueRequest(fileToken, output.outputDirToken);
    request.config.taskMode = "translate_to_english";
    const enqueued = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
      fixture.event,
      fixture.envelope(request),
    );
    expect(enqueued).toMatchObject({
      ok: true,
      data: {
        batchId: "batch-ipc",
        status: "queued",
        config: { taskMode: "translate_to_english" },
        tasks: [{ taskId: "task-ipc", status: "queued" }],
      },
    });
    expect(JSON.stringify(enqueued)).not.toContain(root);
    await fixture.manager.waitForIdle();

    const snapshot = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
      fixture.event,
      fixture.envelope({}),
    );
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        revision: 7,
        batches: [
          {
            status: "completed",
            tasks: [{ status: "completed", generation: 1 }],
          },
        ],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(root);
    const taskEvents = fixture.frame.send.mock.calls.filter(
      ([channel]) => channel === LOCAL_SUBTITLE_EVENT_CHANNELS.taskEvent,
    );
    expect(taskEvents.map(([, event]) => event.revision)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
    ]);
    expect(JSON.stringify(taskEvents)).not.toContain(root);

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask,
        fixture.event,
        fixture.envelope({ taskId: "not-owned" }),
      ),
    ).resolves.toEqual({ ok: true, data: { cancelled: false } });
    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask,
        fixture.event,
        fixture.envelope({ taskId: "task-ipc" }),
      ),
    ).resolves.toEqual({ ok: true, data: { removed: true } });
  });

  it("keeps source output capabilities and raw paths out of IPC state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-ipc-source-"));
    tempRoots.push(root);
    const sourcePath = path.join(root, "private-source.wav");
    await writeFile(sourcePath, "private media bytes");
    const fixture = createFixture(root);
    const outputResolve = vi.spyOn(fixture.outputs, "resolveBatchLease");
    const outputRenew = vi.spyOn(fixture.outputs, "renewBatchLease");
    const outputRelease = vi.spyOn(fixture.outputs, "releaseBatchLease");
    const authorized = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({ files: [{ filePath: sourcePath }] }),
    );
    if (!authorized.ok) throw new Error("Expected input authorization.");
    const fileToken = (
      authorized.data as Array<{ readonly fileToken: string }>
    )[0]!.fileToken;

    const enqueued = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
      fixture.event,
      fixture.envelope(sourceEnqueueRequest(fileToken)),
    );
    expect(enqueued).toMatchObject({
      ok: true,
      data: {
        batchId: "batch-ipc",
        config: { outputMode: "source" },
        tasks: [{ taskId: "task-ipc", status: "queued" }],
      },
    });
    await fixture.manager.waitForIdle();

    const snapshot = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
      fixture.event,
      fixture.envelope({}),
    );
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        batches: [
          {
            config: { outputMode: "source" },
            tasks: [{ taskId: "task-ipc", status: "completed" }],
          },
        ],
      },
    });
    const taskEvents = fixture.frame.send.mock.calls.filter(
      ([channel]) => channel === LOCAL_SUBTITLE_EVENT_CHANNELS.taskEvent,
    );
    const publicState = JSON.stringify({ enqueued, snapshot, taskEvents });
    expect(publicState).not.toContain(fileToken);
    expect(publicState).not.toContain(sourcePath);
    expect(publicState).not.toContain(root);
    expect(publicState).not.toContain("outputDirToken");
    expect(outputResolve).not.toHaveBeenCalled();
    expect(outputRenew).not.toHaveBeenCalled();
    expect(outputRelease).not.toHaveBeenCalled();
  });

  it("rejects source overwrite over IPC without consuming the input capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-ipc-overwrite-"));
    tempRoots.push(root);
    const sourcePath = path.join(root, "private-source.wav");
    await writeFile(sourcePath, "private media bytes");
    const fixture = createFixture(root);
    const authorized = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({ files: [{ filePath: sourcePath }] }),
    );
    if (!authorized.ok) throw new Error("Expected input authorization.");
    const fileToken = (
      authorized.data as Array<{ readonly fileToken: string }>
    )[0]!.fileToken;
    const request = sourceEnqueueRequest(fileToken);
    request.config.output.conflictPolicy = "overwrite";

    const rejected = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
      fixture.event,
      fixture.envelope(request),
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "invalid_ipc_request",
        stage: "preflight",
        field: "config",
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(fileToken);
    expect(JSON.stringify(rejected)).not.toContain(sourcePath);
    expect(JSON.stringify(rejected)).not.toContain(root);
    await expect(
      fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile,
        fixture.event,
        fixture.envelope({ fileToken }),
      ),
    ).resolves.toEqual({ ok: true, data: { revoked: true } });
  });

  it("admits source overwrite over IPC when production commit authority is available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-ipc-overwrite-ready-"));
    tempRoots.push(root);
    const sourcePath = path.join(root, "private-source.wav");
    await writeFile(sourcePath, "private media bytes");
    const fixture = createFixture(root, true);
    const authorized = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({ files: [{ filePath: sourcePath }] }),
    );
    if (!authorized.ok) throw new Error("Expected input authorization.");
    const fileToken = (
      authorized.data as Array<{ readonly fileToken: string }>
    )[0]!.fileToken;
    const request = sourceEnqueueRequest(fileToken);
    request.config.output.conflictPolicy = "overwrite";

    const enqueued = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
      fixture.event,
      fixture.envelope(request),
    );

    expect(enqueued).toMatchObject({
      ok: true,
      data: { config: { conflictPolicy: "overwrite", outputMode: "source" } },
    });
    expect(JSON.stringify(enqueued)).not.toContain(fileToken);
    expect(JSON.stringify(enqueued)).not.toContain(sourcePath);
    expect(JSON.stringify(enqueued)).not.toContain(root);
  });

  it("maps first-slice rejections without consuming input capabilities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-ipc-error-"));
    tempRoots.push(root);
    const sourcePath = path.join(root, "vad-source.wav");
    await writeFile(sourcePath, "private media bytes");
    const fixture = createFixture(root);
    const authorized = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      fixture.event,
      fixture.envelope({ files: [{ filePath: sourcePath }] }),
    );
    if (!authorized.ok) throw new Error("Expected input authorization.");
    const fileToken = (
      authorized.data as Array<{ readonly fileToken: string }>
    )[0]!.fileToken;
    const output = await fixture.outputs.authorize(fixture.owner, root);
    const request = enqueueRequest(fileToken, output.outputDirToken);
    request.config.output.conflictPolicy = "overwrite";

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
        fixture.event,
        fixture.envelope(request),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_ipc_request",
        stage: "preflight",
        field: "config",
      },
    });
    await expect(
      fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile,
        fixture.event,
        fixture.envelope({ fileToken }),
      ),
    ).resolves.toEqual({ ok: true, data: { revoked: true } });
    await expect(
      fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory,
        fixture.event,
        fixture.envelope({ outputDirToken: output.outputDirToken }),
      ),
    ).resolves.toEqual({ ok: true, data: { revoked: true } });
  });

  it.each(["cuda", "metal"] as const)(
    "returns backend_unverified for explicit %s without consuming drafts",
    async (devicePreference) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-ipc-gpu-"));
      tempRoots.push(root);
      const sourcePath = path.join(root, "gpu-source.wav");
      await writeFile(sourcePath, "private media bytes");
      const fixture = createFixture(root);
      const authorized = await fixture.service.handleInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
        fixture.event,
        fixture.envelope({ files: [{ filePath: sourcePath }] }),
      );
      if (!authorized.ok) throw new Error("Expected input authorization.");
      const fileToken = (
        authorized.data as Array<{ readonly fileToken: string }>
      )[0]!.fileToken;
      const output = await fixture.outputs.authorize(fixture.owner, root);
      const request = enqueueRequest(fileToken, output.outputDirToken);
      request.config.devicePreference = devicePreference;

      await expect(
        fixture.service.handlePublic(
          LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
          fixture.event,
          fixture.envelope(request),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "backend_unverified", stage: "preflight" },
      });
      await expect(
        fixture.service.handleInternal(
          LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile,
          fixture.event,
          fixture.envelope({ fileToken }),
        ),
      ).resolves.toEqual({ ok: true, data: { revoked: true } });
      await expect(
        fixture.service.handleInternal(
          LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory,
          fixture.event,
          fixture.envelope({ outputDirToken: output.outputDirToken }),
        ),
      ).resolves.toEqual({ ok: true, data: { revoked: true } });
    },
  );
});

function createFixture(root: string, supportsOverwrite = false) {
  const ownerSessions = new LocalSubtitleOwnerSessionRegistry({
    trustedSender: { devServerUrl: DEV_SERVER_URL },
  });
  const frame = new FakeFrame();
  const sender = new FakeSender(81, frame);
  frame.sender = sender;
  const event = createEvent(sender, frame);
  const inputs = new LocalSubtitleInputAuthorizationRegistry({
    tokenFactory: () => "job-ipc-input",
  });
  const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
  const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs, {
    reservationIdFactory: () => "job-ipc-reservation",
  });
  const registry = new LocalSubtitleSessionRegistry();
  const managedModel = Object.freeze({
    storage: "managed" as const,
    id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    absolutePath: path.join(root, "private-managed-model.bin"),
    byteSize: 1024,
    sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
  });
  const runtime = fakeVerifiedServerRuntime(root);
  const manager = new LocalSubtitleJobManager({
    registry,
    inputs,
    outputs,
    leases,
    runtimeVerifier: {
      verifyRuntime: async () => ({ runtimeGeneration: "a".repeat(64) }),
    },
    backendResolver: new LocalSubtitleBackendResolver({
      verifyServerRuntime: async () => runtime,
      selectCpuServerArtifact: (verified) =>
        verified.artifactPaths["whisper-server-cpu"]!,
    }),
    modelResolver: {
      resolveManagedModel: async () => managedModel,
      resolveManagedVad: async () => Object.freeze({
        storage: "managed" as const,
        id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        absolutePath: path.join(root, "private-managed-vad.bin"),
        byteSize: 885_098,
        sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
      }),
    },
    mediaSelections: {
      bindTaskMediaSelection: () => undefined,
      releaseTaskMediaSelection: () => undefined,
    },
    executor: {
      supportsOutputConflictPolicy: (policy) =>
        policy === "index" || (policy === "overwrite" && supportsOverwrite),
      beginBatchSlice: () => Object.freeze({}) as LocalSubtitleJobBatchRuntime,
      execute: async (context) => {
        context.update({
          status: "loading_model",
          progress: {
            stage: "loading_model",
            stageProgress: 100,
            overallProgress: 10,
          },
        });
        context.update({
          status: "transcribing",
          progress: {
            stage: "transcribing",
            stageProgress: 100,
            overallProgress: 80,
          },
        });
        context.update({
          status: "post_processing",
          progress: {
            stage: "post_processing",
            stageProgress: 100,
            overallProgress: 90,
          },
        });
        context.update({
          status: "exporting",
          progress: {
            stage: "exporting",
            stageProgress: 50,
            overallProgress: 95,
          },
        });
        return {
          status: "completed",
          artifactResults: [
            {
              format: "SRT",
              status: "committed",
              artifact: {
                artifactRef: "job-ipc-artifact",
                displayName: "private-source.srt",
                format: "SRT",
                expiresAt: Date.parse("2026-07-23T00:00:00.000Z"),
              },
            },
          ],
        };
      },
      endBatchSlice: () => undefined,
    },
    now: () => Date.parse("2026-07-22T00:00:00.000Z"),
    batchIdFactory: () => "batch-ipc",
    taskIdFactory: () => "task-ipc",
    snapshotIdFactory: () => "snapshot-ipc",
  });
  const sessionBridge = new LocalSubtitleSessionIpcBridge(registry);
  const jobBridge = new LocalSubtitleJobIpcBridge(manager, sessionBridge);
  const service = new LocalSubtitleIpcService({
    ownerSessions,
    capabilities: { inputs, outputs, leases },
    handlers: {
      public: {
        ...sessionBridge.handlers.public,
        ...jobBridge.handlers.public,
      },
      onOwnerReleased: (owner) => {
        sessionBridge.releaseOwner(owner);
        const ownerKey = {
          webContentsId: owner.senderId,
          ownerSessionId: owner.ownerSessionId,
        };
        manager.releaseOwner(ownerKey);
        registry.releaseOwner(ownerKey);
      },
    },
  });
  sessionBridge.attach(service);
  ownerSessions.onOwnerReleased((owner) => service.releaseOwner(owner));
  const registration = service.registerOwnerSession(event, {});
  if (!registration.ok) throw new Error("Could not register Job Manager owner.");
  const ownerSessionId = (registration.data as { readonly ownerSessionId: string })
    .ownerSessionId;
  const owner = Object.freeze({
    webContentsId: sender.id,
    ownerSessionId,
  });
  return {
    manager,
    service,
    outputs,
    owner,
    frame,
    event,
    envelope: (payload: unknown) => ({ ownerSessionId, payload }),
  };
}

function enqueueRequest(
  fileToken: string,
  outputDirToken: string,
): EnqueueLocalSubtitleBatchRequest {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    files: [{ fileToken }],
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "auto" as const,
      language: "auto",
      taskMode: "transcribe" as const,
      vadEnabled: false,
      advanced: {
        beamSize: 5,
        temperature: 0,
        vadMinSilenceMs: 500,
        maxCueDurationMs: 7_000,
        maxCueChars: 84,
        maxLineChars: 42,
      },
      output: {
        mode: "custom" as const,
        outputDirToken,
        formats: ["SRT" as const],
        conflictPolicy: "index" as const,
      },
      postAction: { mode: "export_only" as const },
    },
  };
}

function fakeVerifiedServerRuntime(root: string): LocalSubtitleVerifiedRuntimeBundle {
  const runtimeGeneration = "a".repeat(64);
  return Object.freeze({
    schemaVersion: 1 as const,
    target: Object.freeze({ platform: "darwin" as const, arch: "arm64" as const }),
    scope: "server" as const,
    root: path.join(root, "runtime"),
    manifestPath: path.join(root, "runtime", "manifest.json"),
    manifestSha256: runtimeGeneration,
    runtimeGeneration,
    integrityProfile: "development" as const,
    artifactPaths: Object.freeze({
      "whisper-server-cpu": Object.freeze({
        id: "whisper-server-cpu",
        kind: "server" as const,
        backend: "cpu" as const,
        absolutePath: path.join(root, "runtime", "whisper-server"),
        byteSize: 1024,
        sha256: "d".repeat(64),
        version: "1.9.1+b1ade71",
        signatureKind: "unsigned" as const,
      }),
    }),
    evidenceFileCount: 1,
    noPathFallback: true as const,
    ready: true as const,
  }) as LocalSubtitleVerifiedRuntimeBundle;
}

function sourceEnqueueRequest(
  fileToken: string,
): EnqueueLocalSubtitleBatchRequest {
  const request = enqueueRequest(fileToken, "unused-output-token");
  request.config.output = {
    mode: "source",
    formats: ["SRT"],
    conflictPolicy: "index",
  };
  return request;
}

function createEvent(sender: FakeSender, frame: FakeFrame) {
  return {
    sender,
    senderFrame: frame,
    processId: frame.processId,
    frameId: frame.routingId,
  } as never;
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
