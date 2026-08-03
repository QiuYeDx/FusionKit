import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleIpcService } from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleOwnerSessionRegistry } from "../../electron/main/local-subtitle/ipc-security";
import { LocalSubtitleModelIpcBridge } from "../../electron/main/local-subtitle/model-ipc";
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST,
  type LocalSubtitleModelManifestEntry,
} from "../../electron/main/local-subtitle/model-manifest";
import { LocalSubtitleModelManager } from "../../electron/main/local-subtitle/model-manager";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleSessionIpcBridge } from "../../electron/main/local-subtitle/session-ipc";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";
import {
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const DEV_SERVER_URL = "http://127.0.0.1:7777/";
const tempRoots: string[] = [];
let runtimeFixture: LocalSubtitleRuntimeFixture;
let verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;

beforeAll(async () => {
  runtimeFixture = await createRuntimeFixture();
  verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
    environment: runtimeFixture.environment,
    scope: "server",
    signatureVerifier: async () => true,
  });
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await runtimeFixture.cleanup();
});

describe("local subtitle model manager IPC integration", () => {
  it("keeps paths private while import progress, snapshot and managed state round-trip", async () => {
    const fixture = await createFixture();

    const imported = await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
      fixture.event,
      fixture.envelope({ filePath: fixture.sourcePath, mode: "copy" }),
    );
    expect(imported).toMatchObject({
      ok: true,
      data: {
        resourceId: fixture.model.id,
        status: "queued",
      },
    });
    expect(JSON.stringify(imported)).not.toContain(fixture.sourcePath);
    await fixture.manager.waitForIdle();

    const snapshot = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
      fixture.event,
      fixture.envelope({}),
    );
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        batches: [],
        resourceJobs: [{ status: "completed", progress: 100 }],
      },
    });
    const listed = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources,
      fixture.event,
      fixture.envelope({}),
    );
    expect(listed).toMatchObject({
      ok: true,
      data: [{ resourceId: fixture.model.id, status: "ready" }],
    });

    const serialized = JSON.stringify({ imported, snapshot, listed });
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain("filePath");
    const resourceEvents = fixture.frame.send.mock.calls.filter(
      ([channel]) => channel === LOCAL_SUBTITLE_EVENT_CHANNELS.resourceEvent,
    );
    expect(resourceEvents.length).toBeGreaterThan(5);
    expect(resourceEvents.map(([, event]) => event.revision)).toEqual(
      Array.from({ length: resourceEvents.length }, (_, index) => index + 1),
    );
  });

  it("installs and deletes through fixed public handlers while cancel stays owner-scoped", async () => {
    const fixture = await createFixture();

    const started = await fixture.service.handlePublic(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall,
      fixture.event,
      fixture.envelope({ resourceId: fixture.model.id }),
    );
    expect(started).toMatchObject({
      ok: true,
      data: { resourceId: fixture.model.id, status: "queued" },
    });
    expect(JSON.stringify(started)).not.toContain(fixture.root);
    await fixture.manager.waitForIdle();

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource,
        fixture.event,
        fixture.envelope({ resourceId: fixture.model.id }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { deleted: true },
    });
    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob,
        fixture.event,
        fixture.envelope({ jobId: "resource-job-not-owned" }),
      ),
    ).resolves.toEqual({ ok: true, data: { cancelled: false } });
  });

  it("releases the bridge and model owner when the document session ends", async () => {
    let smokeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      smokeStarted = resolve;
    });
    const fixture = await createFixture({
      smoke: vi.fn((_owner, _options, signal) => {
        smokeStarted();
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    });
    await fixture.service.handleInternal(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
      fixture.event,
      fixture.envelope({ filePath: fixture.sourcePath, mode: "copy" }),
    );
    await started;

    expect(fixture.ownerSessions.release(fixture.ownerSessionId)).toBe(true);
    await fixture.manager.waitForIdle();

    await expect(
      fixture.service.handlePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
        fixture.event,
        fixture.envelope({}),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
  });
});

async function createFixture(options: { readonly smoke?: ReturnType<typeof vi.fn> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-model-ipc-"));
  tempRoots.push(root);
  const bytes = createGgmlModel();
  const sourcePath = path.join(root, "private-selected-model.bin");
  await writeFile(sourcePath, bytes);
  const model: LocalSubtitleModelManifestEntry = {
    ...LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!,
    id: "ipc-test-large-v3-q5_0",
    fileName: "ggml-ipc-test-large-v3-q5_0.bin",
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const sessionRegistry = new LocalSubtitleSessionRegistry();
  const manager = new LocalSubtitleModelManager({
    managedResourceRoot: path.join(root, "managed"),
    runtimeEnvironment: {
      mode: "development",
      appRoot: root,
      platform: "darwin",
      arch: "arm64",
    },
    supervisor: {
      smokeModelLoad: options.smoke ?? vi.fn(async () => undefined),
    },
    modelCatalog: [model],
    verifyServerRuntime: async () => fakeRuntime(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    downloadResource: async (options) => {
      await writeFile(options.destinationPath, bytes);
      options.onProgress?.(bytes.length, bytes.length);
      return {};
    },
    sessionRegistry,
  });
  const sessionBridge = new LocalSubtitleSessionIpcBridge(sessionRegistry);
  const bridge = new LocalSubtitleModelIpcBridge(manager, sessionBridge);
  const ownerSessions = new LocalSubtitleOwnerSessionRegistry({
    trustedSender: { devServerUrl: DEV_SERVER_URL },
  });
  const frame = new FakeFrame();
  const sender = new FakeSender(73, frame);
  frame.sender = sender;
  const event = createEvent(sender, frame);
  const service = new LocalSubtitleIpcService({
    ownerSessions,
    handlers: {
      public: {
        ...sessionBridge.handlers.public,
        ...bridge.handlers.public,
      },
      importModel: bridge.handlers.importModel,
      onOwnerReleased: (owner) => {
        bridge.releaseOwner(owner);
        manager.releaseOwner({
          webContentsId: owner.senderId,
          ownerSessionId: owner.ownerSessionId,
        });
        sessionRegistry.releaseOwner({
          webContentsId: owner.senderId,
          ownerSessionId: owner.ownerSessionId,
        });
      },
    },
  });
  bridge.attach(service);
  ownerSessions.onOwnerReleased((owner) => service.releaseOwner(owner));
  const registration = service.registerOwnerSession(event, {});
  if (!registration.ok) throw new Error("Could not register model IPC owner.");
  const ownerSessionId = (registration.data as { ownerSessionId: string })
    .ownerSessionId;
  return {
    root,
    sourcePath,
    model,
    manager,
    service,
    ownerSessions,
    ownerSessionId,
    frame,
    event,
    envelope: (payload: unknown) => ({ ownerSessionId, payload }),
  };
}

function createGgmlModel(): Buffer {
  const entry = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;
  const bytes = Buffer.alloc(1024, 0x41);
  Buffer.from(entry.ggml.magicHex, "hex").copy(bytes, 0);
  entry.ggml.headerInt32Le.forEach((value, index) => {
    bytes.writeInt32LE(value, 4 + index * 4);
  });
  return bytes;
}

function fakeRuntime(): LocalSubtitleVerifiedRuntimeBundle {
  return verifiedRuntime;
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
