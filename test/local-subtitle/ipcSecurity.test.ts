import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  WebContents,
  WebFrameMain,
} from "electron";
import {
  LocalSubtitleOwnerSessionRegistry,
  isTrustedLocalSubtitleSender,
  type LocalSubtitleIpcEvent,
  type LocalSubtitleOwnerIdentity,
} from "../../electron/main/local-subtitle/ipc-security";
import {
  LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
  LOCAL_SUBTITLE_LIMITS,
} from "@/type/localSubtitle";

const DEV_SERVER_URL = "http://127.0.0.1:5173/";
const SESSION_ONE = "00000000-0000-4000-8000-000000000001";
const SESSION_TWO = "00000000-0000-4000-8000-000000000002";

describe("local subtitle trusted IPC sender", () => {
  it("accepts only the exact trusted top frame and its event identity", () => {
    const trusted = createIpcFixture();
    expect(isTrustedLocalSubtitleSender(trusted.event, trustedOptions())).toBe(
      true,
    );

    expect(
      isTrustedLocalSubtitleSender(
        { ...trusted.event, senderFrame: null },
        trustedOptions(),
      ),
    ).toBe(false);

    const subframe = createIpcFixture({ parent: new FakeFrame() });
    subframe.sender.mainFrame = trusted.frame;
    expect(isTrustedLocalSubtitleSender(subframe.event, trustedOptions())).toBe(
      false,
    );

    const wrongProcess = createIpcFixture();
    wrongProcess.event.processId += 1;
    expect(
      isTrustedLocalSubtitleSender(wrongProcess.event, trustedOptions()),
    ).toBe(false);

    const wrongFrame = createIpcFixture();
    wrongFrame.event.frameId += 1;
    expect(
      isTrustedLocalSubtitleSender(wrongFrame.event, trustedOptions()),
    ).toBe(false);

    const detached = createIpcFixture();
    detached.frame.detached = true;
    expect(isTrustedLocalSubtitleSender(detached.event, trustedOptions())).toBe(
      false,
    );

    const wrongPath = createIpcFixture({ url: `${DEV_SERVER_URL}other` });
    expect(isTrustedLocalSubtitleSender(wrongPath.event, trustedOptions())).toBe(
      false,
    );
  });

  it("accepts the exact packaged entry file while ignoring hash routing", () => {
    const appRoot = path.join(process.cwd(), "local-subtitle-app-fixture");
    const entryUrl = pathToFileURL(
      path.join(appRoot, "dist", "index.html"),
    );
    entryUrl.hash = "/tools/subtitle/local-transcriber";
    const fixture = createIpcFixture({ url: entryUrl.href });

    expect(
      isTrustedLocalSubtitleSender(fixture.event, { appRoot }),
    ).toBe(true);

    fixture.frame.url = pathToFileURL(
      path.join(appRoot, "dist", "other.html"),
    ).href;
    expect(
      isTrustedLocalSubtitleSender(fixture.event, { appRoot }),
    ).toBe(false);
  });
});

describe("local subtitle owner session registry", () => {
  it("issues a main-owned session and accepts only a strict secure envelope", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE]);
    const registration = registry.register(fixture.event);
    expect(registration).toEqual({
      ok: true,
      data: {
        ownerSessionId: SESSION_ONE,
        bridgeVersion: LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
      },
    });

    const authorization = registry.authorize<{ action: string }>(
      fixture.event,
      {
        ownerSessionId: SESSION_ONE,
        payload: { action: "probe" },
      },
    );
    expect(authorization).toMatchObject({
      ok: true,
      data: {
        ownerSessionId: SESSION_ONE,
        senderId: fixture.sender.id,
        processId: fixture.frame.processId,
        frameId: fixture.frame.routingId,
        payload: { action: "probe" },
      },
    });
    if (!authorization.ok) throw new Error("Expected owner authorization.");
    expect(authorization.data.signal).toBeInstanceOf(AbortSignal);
    expect(authorization.data.signal.aborted).toBe(false);

    for (const envelope of [
      null,
      [],
      { ownerSessionId: SESSION_ONE },
      { ownerSessionId: "renderer-selected", payload: {} },
      { ownerSessionId: SESSION_ONE, payload: {}, extra: true },
      {
        ownerSessionId: SESSION_ONE,
        payload: { padding: "x".repeat(LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes) },
      },
    ]) {
      expect(registry.authorize(fixture.event, envelope)).toMatchObject({
        ok: false,
        error: { code: "invalid_ipc_request" },
      });
    }
  });

  it("rejects cross-window, cross-frame, cross-session, and released-session replay", () => {
    const owner = createIpcFixture({ senderId: 11, processId: 21, frameId: 31 });
    const registry = createRegistry([SESSION_ONE]);
    expect(registry.register(owner.event).ok).toBe(true);
    const envelope = { ownerSessionId: SESSION_ONE, payload: {} };

    const otherWindow = createIpcFixture({
      senderId: 12,
      processId: 21,
      frameId: 31,
    });
    expect(registry.authorize(otherWindow.event, envelope)).toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });

    const otherFrame = createIpcFixture({
      senderId: 11,
      processId: 21,
      frameId: 32,
    });
    expect(registry.authorize(otherFrame.event, envelope)).toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });

    expect(
      registry.authorize(owner.event, {
        ownerSessionId: SESSION_TWO,
        payload: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "owner_released" } });

    expect(registry.release(SESSION_ONE)).toBe(true);
    expect(registry.release(SESSION_ONE)).toBe(false);
    expect(registry.authorize(owner.event, envelope)).toMatchObject({
      ok: false,
      error: { code: "owner_released" },
    });
  });

  it("replaces a same-sender handshake and old callbacks cannot release the new session", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE, SESSION_TWO]);
    const released: LocalSubtitleOwnerIdentity[] = [];
    registry.onOwnerReleased((owner) => released.push(owner));

    expect(registry.register(fixture.event).ok).toBe(true);
    const oldAuthorization = registry.authorize(fixture.event, {
      ownerSessionId: SESSION_ONE,
      payload: {},
    });
    if (!oldAuthorization.ok) throw new Error("Expected old authorization.");
    const staleNavigation = fixture.sender.listeners(
      "did-start-navigation",
    )[0] as (...args: unknown[]) => void;
    expect(registry.register(fixture.event)).toEqual({
      ok: true,
      data: {
        ownerSessionId: SESSION_TWO,
        bridgeVersion: LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
      },
    });
    expect(oldAuthorization.data.signal.aborted).toBe(true);
    expect(released.map((owner) => owner.ownerSessionId)).toEqual([SESSION_ONE]);

    const currentAuthorization = registry.authorize(fixture.event, {
      ownerSessionId: SESSION_TWO,
      payload: { current: true },
    });
    if (!currentAuthorization.ok) {
      throw new Error("Expected current authorization.");
    }
    expect(currentAuthorization.data.signal.aborted).toBe(false);
    staleNavigation({}, DEV_SERVER_URL, false, true);
    expect(
      registry.authorize(fixture.event, {
        ownerSessionId: SESSION_TWO,
        payload: { current: true },
      }),
    ).toMatchObject({ ok: true, data: { payload: { current: true } } });
    expect(released.map((owner) => owner.ownerSessionId)).toEqual([SESSION_ONE]);
    expect(currentAuthorization.data.signal.aborted).toBe(false);
    expect(registry.release(SESSION_ONE)).toBe(false);
    expect(currentAuthorization.data.signal.aborted).toBe(false);
    expect(registry.release(SESSION_TWO)).toBe(true);
    expect(currentAuthorization.data.signal.aborted).toBe(true);
  });

  it("aborts the owner signal before release listeners run", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE]);
    expect(registry.register(fixture.event).ok).toBe(true);
    const authorization = registry.authorize(fixture.event, {
      ownerSessionId: SESSION_ONE,
      payload: {},
    });
    if (!authorization.ok) throw new Error("Expected owner authorization.");

    const order: string[] = [];
    authorization.data.signal.addEventListener("abort", () => {
      order.push("signal");
    });
    registry.onOwnerReleased(() => {
      expect(authorization.data.signal.aborted).toBe(true);
      order.push("listener");
    });

    expect(authorization.data.signal.aborted).toBe(false);
    expect(registry.release(SESSION_ONE)).toBe(true);
    expect(order).toEqual(["signal", "listener"]);
    expect(registry.release(SESSION_ONE)).toBe(false);
    expect(order).toEqual(["signal", "listener"]);
  });

  it("revalidates exact owner identity across awaits", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE]);
    registry.register(fixture.event);
    const owner = ownerIdentity(fixture, SESSION_ONE);

    expect(registry.isCurrent(owner)).toBe(true);
    expect(registry.isCurrent({ ...owner, senderId: owner.senderId + 1 })).toBe(
      false,
    );
    expect(registry.isCurrent({ ...owner, processId: owner.processId + 1 })).toBe(
      false,
    );
    expect(registry.isCurrent({ ...owner, frameId: owner.frameId + 1 })).toBe(
      false,
    );

    fixture.frame.detached = true;
    expect(registry.isCurrent(owner)).toBe(false);
    fixture.frame.detached = false;
    expect(registry.release(SESSION_ONE)).toBe(true);
    expect(registry.isCurrent(owner)).toBe(false);
  });

  it("sends only through the current owner frame and contains send failures", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE]);
    registry.register(fixture.event);
    const owner = ownerIdentity(fixture, SESSION_ONE);

    expect(
      registry.sendToOwner(owner, "local-subtitle:task-event", {
        revision: 1,
      }),
    ).toBe(true);
    expect(fixture.frame.send).toHaveBeenCalledWith(
      "local-subtitle:task-event",
      { revision: 1 },
    );

    fixture.frame.send.mockImplementationOnce(() => {
      throw new Error("frame detached during send");
    });
    expect(
      registry.sendToOwner(owner, "local-subtitle:task-event", {
        revision: 2,
      }),
    ).toBe(false);

    fixture.frame.destroyed = true;
    expect(
      registry.sendToOwner(owner, "local-subtitle:task-event", {
        revision: 3,
      }),
    ).toBe(false);
    expect(fixture.frame.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["webContents destroyed", "sender-destroyed"],
    ["renderer gone", "render-process-gone"],
    ["top-frame destroyed", "frame-destroyed"],
    ["reload", "reload"],
  ])("releases once when %s", (_name, trigger) => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE]);
    const listener = vi.fn();
    registry.onOwnerReleased(listener);
    expect(registry.register(fixture.event).ok).toBe(true);

    const staleSenderDestroyed = fixture.sender.listeners(
      "destroyed",
    )[0] as () => void;
    const staleRendererGone = fixture.sender.listeners(
      "render-process-gone",
    )[0] as () => void;
    const staleNavigation = fixture.sender.listeners(
      "did-start-navigation",
    )[0] as (...args: unknown[]) => void;
    const staleFrameDestroyed = fixture.frame.listeners(
      "destroyed",
    )[0] as () => void;

    if (trigger === "sender-destroyed") staleSenderDestroyed();
    if (trigger === "render-process-gone") staleRendererGone();
    if (trigger === "frame-destroyed") staleFrameDestroyed();
    if (trigger === "reload") {
      staleNavigation({}, DEV_SERVER_URL, false, true);
    }

    staleSenderDestroyed();
    staleRendererGone();
    staleFrameDestroyed();
    staleNavigation({}, DEV_SERVER_URL, false, true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      ownerSessionId: SESSION_ONE,
      senderId: fixture.sender.id,
      processId: fixture.frame.processId,
      frameId: fixture.frame.routingId,
    });
    expect(
      registry.authorize(fixture.event, {
        ownerSessionId: SESSION_ONE,
        payload: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "owner_released" } });
  });

  it("ignores in-place and subframe navigation but releases on main navigation", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE]);
    const listener = vi.fn();
    registry.onOwnerReleased(listener);
    registry.register(fixture.event);
    const navigation = fixture.sender.listeners(
      "did-start-navigation",
    )[0] as (...args: unknown[]) => void;

    navigation({}, `${DEV_SERVER_URL}#/route`, true, true);
    navigation({}, `${DEV_SERVER_URL}frame`, false, false);
    expect(listener).not.toHaveBeenCalled();
    expect(
      registry.authorize(fixture.event, {
        ownerSessionId: SESSION_ONE,
        payload: {},
      }).ok,
    ).toBe(true);

    navigation({}, DEV_SERVER_URL, false, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects an untrusted handshake without replacing the current session", () => {
    const fixture = createIpcFixture();
    const registry = createRegistry([SESSION_ONE, SESSION_TWO]);
    registry.register(fixture.event);

    const untrusted = createIpcFixture({
      senderId: fixture.sender.id,
      url: "https://example.test/",
    });
    expect(registry.register(untrusted.event)).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(
      registry.authorize(fixture.event, {
        ownerSessionId: SESSION_ONE,
        payload: {},
      }).ok,
    ).toBe(true);
  });
});

function trustedOptions() {
  return { devServerUrl: DEV_SERVER_URL };
}

function createRegistry(sessionIds: string[]) {
  let index = 0;
  return new LocalSubtitleOwnerSessionRegistry({
    createOwnerSessionId: () => sessionIds[index++] ?? "invalid-session-id",
    trustedSender: trustedOptions(),
  });
}

function ownerIdentity(
  fixture: ReturnType<typeof createIpcFixture>,
  ownerSessionId: string,
): LocalSubtitleOwnerIdentity {
  return {
    ownerSessionId,
    senderId: fixture.sender.id,
    processId: fixture.frame.processId,
    frameId: fixture.frame.routingId,
  };
}

function createIpcFixture(
  options: {
    senderId?: number;
    processId?: number;
    frameId?: number;
    url?: string;
    parent?: FakeFrame | null;
  } = {},
) {
  const frame = new FakeFrame({
    processId: options.processId,
    routingId: options.frameId,
    url: options.url,
    parent: options.parent,
  });
  const sender = new FakeSender(options.senderId ?? 10, frame);
  const event = {
    sender: sender as unknown as WebContents,
    senderFrame: frame as unknown as WebFrameMain,
    processId: frame.processId,
    frameId: frame.routingId,
  } as LocalSubtitleIpcEvent & { processId: number; frameId: number };
  return { sender, frame, event };
}

class FakeFrame extends EventEmitter {
  processId: number;
  routingId: number;
  url: string;
  parent: FakeFrame | null;
  detached = false;
  destroyed = false;
  send = vi.fn();

  constructor(
    options: {
      processId?: number;
      routingId?: number;
      url?: string;
      parent?: FakeFrame | null;
    } = {},
  ) {
    super();
    this.processId = options.processId ?? 20;
    this.routingId = options.routingId ?? 30;
    this.url = options.url ?? `${DEV_SERVER_URL}#/tools/subtitle/local-transcriber`;
    this.parent = options.parent ?? null;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

class FakeSender extends EventEmitter {
  destroyed = false;
  mainFrame: FakeFrame;

  constructor(
    readonly id: number,
    frame: FakeFrame,
  ) {
    super();
    this.mainFrame = frame;
  }

  isDestroyed() {
    return this.destroyed;
  }

  getURL() {
    return this.mainFrame.url;
  }
}
