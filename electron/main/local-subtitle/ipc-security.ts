import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { z } from "zod";
import {
  LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
  createLocalSubtitleError,
} from "@/type/localSubtitle";
import {
  localSubtitleSecureIpcEnvelopeSchema,
  localSubtitleIpcFailure,
  localSubtitleIpcSuccess,
  type LocalSubtitleIpcResult,
  type LocalSubtitleSecureIpcEnvelope,
} from "@/type/localSubtitleIpc";

export type LocalSubtitleIpcEvent = Pick<
  IpcMainEvent | IpcMainInvokeEvent,
  "frameId" | "processId" | "sender" | "senderFrame"
>;

export interface TrustedLocalSubtitleSenderOptions {
  readonly devServerUrl?: string;
  readonly appRoot?: string;
}

export interface LocalSubtitleOwnerSessionRegistration {
  readonly ownerSessionId: string;
  readonly bridgeVersion: typeof LOCAL_SUBTITLE_IPC_BRIDGE_VERSION;
}

export interface LocalSubtitleOwnerIdentity {
  readonly ownerSessionId: string;
  readonly senderId: number;
  readonly processId: number;
  readonly frameId: number;
}

export interface AuthorizedLocalSubtitleIpcRequest<TPayload>
  extends LocalSubtitleOwnerIdentity {
  readonly payload: TPayload;
  readonly signal: AbortSignal;
}

export type LocalSubtitleOwnerReleasedListener = (
  owner: LocalSubtitleOwnerIdentity,
) => void;

export interface LocalSubtitleOwnerSessionRegistryOptions {
  readonly createOwnerSessionId?: () => string;
  readonly trustedSender?: TrustedLocalSubtitleSenderOptions;
}

interface LocalSubtitleOwnerSessionRecord
  extends LocalSubtitleOwnerIdentity {
  readonly sender: WebContents;
  readonly frame: WebFrameMain;
  readonly abortController: AbortController;
  disposeLifecycle?: () => void;
}

interface FrameLifecycleEmitter {
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

const OWNER_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SESSION_ID_GENERATION_ATTEMPTS = 8;
const SECURE_ENVELOPE_SCHEMA = localSubtitleSecureIpcEnvelopeSchema(z.unknown());

export class LocalSubtitleOwnerSessionRegistry {
  private readonly sessions = new Map<
    string,
    LocalSubtitleOwnerSessionRecord
  >();
  private readonly currentSessionBySender = new Map<number, string>();
  private readonly ownerReleaseListeners =
    new Set<LocalSubtitleOwnerReleasedListener>();
  private readonly createOwnerSessionId: () => string;
  private readonly trustedSenderOptions: TrustedLocalSubtitleSenderOptions;

  constructor(options: LocalSubtitleOwnerSessionRegistryOptions = {}) {
    this.createOwnerSessionId = options.createOwnerSessionId ?? randomUUID;
    this.trustedSenderOptions = options.trustedSender ?? {};
  }

  register(
    event: LocalSubtitleIpcEvent,
  ): LocalSubtitleIpcResult<LocalSubtitleOwnerSessionRegistration> {
    if (!isTrustedLocalSubtitleSender(event, this.trustedSenderOptions)) {
      return invalidRequest("Local subtitle IPC sender is not trusted.");
    }

    const ownerSessionId = this.generateUniqueOwnerSessionId();
    if (!ownerSessionId) {
      return invalidRequest("Local subtitle owner session could not be created.");
    }

    const previousSessionId = this.currentSessionBySender.get(event.sender.id);
    if (previousSessionId) {
      this.release(previousSessionId);
    }

    const frame = event.senderFrame;
    if (!frame) {
      return invalidRequest("Local subtitle IPC sender frame is unavailable.");
    }
    const record: LocalSubtitleOwnerSessionRecord = {
      ownerSessionId,
      senderId: event.sender.id,
      processId: event.processId,
      frameId: event.frameId,
      sender: event.sender,
      frame,
      abortController: new AbortController(),
    };
    this.sessions.set(ownerSessionId, record);
    this.currentSessionBySender.set(record.senderId, ownerSessionId);
    record.disposeLifecycle = this.bindLifecycle(record);

    return localSubtitleIpcSuccess({
      ownerSessionId,
      bridgeVersion: LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
    });
  }

  authorize<TPayload>(
    event: LocalSubtitleIpcEvent,
    envelope: unknown,
  ): LocalSubtitleIpcResult<AuthorizedLocalSubtitleIpcRequest<TPayload>> {
    if (!isTrustedLocalSubtitleSender(event, this.trustedSenderOptions)) {
      return invalidRequest("Local subtitle IPC sender is not trusted.");
    }

    const parsedEnvelope = parseSecureEnvelope(envelope);
    if (!parsedEnvelope) {
      return invalidRequest(
        "Local subtitle IPC request is missing its owner session envelope.",
      );
    }

    const record = this.sessions.get(parsedEnvelope.ownerSessionId);
    if (!record) return ownerReleased();
    if (
      this.currentSessionBySender.get(record.senderId) !== record.ownerSessionId ||
      event.sender !== record.sender ||
      event.senderFrame !== record.frame ||
      event.sender.id !== record.senderId ||
      event.processId !== record.processId ||
      event.frameId !== record.frameId
    ) {
      return ownerReleased();
    }

    return localSubtitleIpcSuccess({
      ownerSessionId: record.ownerSessionId,
      senderId: record.senderId,
      processId: record.processId,
      frameId: record.frameId,
      payload: parsedEnvelope.payload as TPayload,
      signal: record.abortController.signal,
    });
  }

  authorizeCurrent<TPayload>(
    event: LocalSubtitleIpcEvent,
    payload: TPayload,
  ): LocalSubtitleIpcResult<AuthorizedLocalSubtitleIpcRequest<TPayload>> {
    const ownerSessionId = this.currentSessionBySender.get(event.sender.id);
    if (!ownerSessionId) return ownerReleased();
    return this.authorize<TPayload>(event, { ownerSessionId, payload });
  }

  onOwnerReleased(listener: LocalSubtitleOwnerReleasedListener): () => void {
    this.ownerReleaseListeners.add(listener);
    return () => this.ownerReleaseListeners.delete(listener);
  }

  isCurrent(owner: LocalSubtitleOwnerIdentity): boolean {
    const record = this.sessions.get(owner.ownerSessionId);
    if (!record || !hasSameOwnerIdentity(record, owner)) return false;
    if (
      this.currentSessionBySender.get(record.senderId) !==
      record.ownerSessionId
    ) {
      return false;
    }
    return isTrustedLocalSubtitleSender(
      {
        sender: record.sender,
        senderFrame: record.frame,
        processId: record.processId,
        frameId: record.frameId,
      },
      this.trustedSenderOptions,
    );
  }

  sendToOwner(
    owner: LocalSubtitleOwnerIdentity,
    channel: string,
    payload: unknown,
  ): boolean {
    if (!this.isCurrent(owner)) return false;
    const record = this.sessions.get(owner.ownerSessionId);
    if (!record) return false;

    try {
      record.frame.send(channel, payload);
      return true;
    } catch {
      return false;
    }
  }

  release(ownerSessionId: string): boolean {
    const record = this.sessions.get(ownerSessionId);
    if (!record) return false;

    this.sessions.delete(ownerSessionId);
    if (
      this.currentSessionBySender.get(record.senderId) === record.ownerSessionId
    ) {
      this.currentSessionBySender.delete(record.senderId);
    }
    record.abortController.abort();
    try {
      record.disposeLifecycle?.();
    } catch {
      // Session authority is already removed; cleanup must keep releasing owners.
    }
    record.disposeLifecycle = undefined;

    const releasedOwner: LocalSubtitleOwnerIdentity = {
      ownerSessionId: record.ownerSessionId,
      senderId: record.senderId,
      processId: record.processId,
      frameId: record.frameId,
    };
    for (const listener of this.ownerReleaseListeners) {
      try {
        listener(releasedOwner);
      } catch {
        // One subsystem cannot prevent the remaining owner cleanup listeners.
      }
    }
    return true;
  }

  private generateUniqueOwnerSessionId(): string | undefined {
    for (
      let attempt = 0;
      attempt < MAX_SESSION_ID_GENERATION_ATTEMPTS;
      attempt += 1
    ) {
      const ownerSessionId = this.createOwnerSessionId();
      if (
        isOwnerSessionId(ownerSessionId) &&
        !this.sessions.has(ownerSessionId)
      ) {
        return ownerSessionId;
      }
    }
    return undefined;
  }

  private bindLifecycle(record: LocalSubtitleOwnerSessionRecord): () => void {
    const releaseThisSession = () => {
      this.release(record.ownerSessionId);
    };
    const handleNavigation = (
      _event: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && !isInPlace) releaseThisSession();
    };

    // WebFrameMain is an EventEmitter at runtime, but Electron 33 omits its
    // destruction event from the public TypeScript overloads.
    const frameLifecycle = record.frame as unknown as FrameLifecycleEmitter;
    record.sender.once("destroyed", releaseThisSession);
    record.sender.on("render-process-gone", releaseThisSession);
    record.sender.on("did-start-navigation", handleNavigation);
    frameLifecycle.once("destroyed", releaseThisSession);

    return () => {
      record.sender.removeListener("destroyed", releaseThisSession);
      record.sender.removeListener("render-process-gone", releaseThisSession);
      record.sender.removeListener("did-start-navigation", handleNavigation);
      frameLifecycle.removeListener("destroyed", releaseThisSession);
    };
  }
}

export const sharedLocalSubtitleOwnerSessionRegistry =
  new LocalSubtitleOwnerSessionRegistry();

export function registerLocalSubtitleOwnerSession(
  event: IpcMainEvent,
): LocalSubtitleIpcResult<LocalSubtitleOwnerSessionRegistration> {
  return sharedLocalSubtitleOwnerSessionRegistry.register(event);
}

export function isTrustedLocalSubtitleSender(
  event: LocalSubtitleIpcEvent,
  options: TrustedLocalSubtitleSenderOptions = {},
): boolean {
  if (event.sender.isDestroyed()) return false;

  const frame = event.senderFrame;
  if (
    !frame ||
    frame.isDestroyed() ||
    frame.detached ||
    frame.parent !== null ||
    event.sender.mainFrame !== frame ||
    event.processId !== frame.processId ||
    event.frameId !== frame.routingId
  ) {
    return false;
  }

  const sourceUrl = frame.url;
  if (!sourceUrl) return false;

  const devServerUrl = options.devServerUrl ?? process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) return isExpectedDevelopmentUrl(sourceUrl, devServerUrl);

  const appRoot = options.appRoot ?? process.env.APP_ROOT;
  if (!appRoot) return false;
  return isExpectedPackagedUrl(sourceUrl, appRoot);
}

function parseSecureEnvelope(
  value: unknown,
): LocalSubtitleSecureIpcEnvelope<unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes("ownerSessionId") ||
      !keys.includes("payload")
    ) {
      return undefined;
    }
    const parsed = SECURE_ENVELOPE_SCHEMA.safeParse(value);
    if (!parsed.success || !isOwnerSessionId(parsed.data.ownerSessionId)) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

function isOwnerSessionId(value: unknown): value is string {
  return typeof value === "string" && OWNER_SESSION_ID_PATTERN.test(value);
}

function hasSameOwnerIdentity(
  left: LocalSubtitleOwnerIdentity,
  right: LocalSubtitleOwnerIdentity,
): boolean {
  return (
    left.ownerSessionId === right.ownerSessionId &&
    left.senderId === right.senderId &&
    left.processId === right.processId &&
    left.frameId === right.frameId
  );
}

function isExpectedDevelopmentUrl(
  sourceUrl: string,
  devServerUrl: string,
): boolean {
  try {
    const source = new URL(sourceUrl);
    const expected = new URL(devServerUrl);
    return (
      source.origin === expected.origin &&
      source.pathname === expected.pathname &&
      source.search === expected.search
    );
  } catch {
    return false;
  }
}

function isExpectedPackagedUrl(sourceUrl: string, appRoot: string): boolean {
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== "file:" || source.search) return false;
    const expectedPath = path.resolve(appRoot, "dist", "index.html");
    const sourcePath = path.resolve(fileURLToPath(source));
    return normalizePathForComparison(sourcePath) ===
      normalizePathForComparison(expectedPath);
  } catch {
    return false;
  }
}

function invalidRequest<T = never>(
  message: string,
): LocalSubtitleIpcResult<T> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError("invalid_ipc_request", message),
  );
}

function ownerReleased<T = never>(): LocalSubtitleIpcResult<T> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "owner_released",
      "Local subtitle IPC owner session is unavailable.",
    ),
  );
}

function normalizePathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
