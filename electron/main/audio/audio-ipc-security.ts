import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";
import {
  audioIpcFailure,
  audioIpcSuccess,
  type AudioIpcResult,
  type AudioSecureIpcEnvelope,
} from "@/type/audioIpc";

type AudioIpcEvent = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;

export interface TrustedAudioSenderOptions {
  devServerUrl?: string;
  appRoot?: string;
}

export interface AuthorizedAudioIpcRequest<TPayload> {
  payload: TPayload;
  senderId: number;
  configRevision?: string;
}

export class AudioPreloadCapabilityRegistry {
  private readonly capabilities = new Map<number, string>();
  private readonly boundSenders = new Set<number>();
  private readonly ownerReleaseListeners = new Set<(senderId: number) => void>();

  register(event: AudioIpcEvent, capability: unknown): boolean {
    if (!isTrustedAudioSender(event)) return false;
    if (!isCapability(capability)) return false;

    const senderId = event.sender.id;
    this.capabilities.set(senderId, capability);
    this.bindSenderLifecycle(event.sender);
    return true;
  }

  authorize<TPayload>(
    event: AudioIpcEvent,
    envelope: unknown,
  ): AudioIpcResult<AuthorizedAudioIpcRequest<TPayload>> {
    if (!isTrustedAudioSender(event)) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Audio IPC sender is not trusted.",
      });
    }
    if (!isSecureEnvelope(envelope)) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Audio IPC request is missing its preload authorization envelope.",
      });
    }

    const expectedCapability = this.capabilities.get(event.sender.id);
    if (!expectedCapability || envelope.capability !== expectedCapability) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Audio IPC preload authorization is invalid or expired.",
      });
    }

    return audioIpcSuccess({
      payload: envelope.payload as TPayload,
      senderId: event.sender.id,
      ...(envelope.configRevision
        ? { configRevision: envelope.configRevision }
        : {}),
    });
  }

  onOwnerReleased(listener: (senderId: number) => void): () => void {
    this.ownerReleaseListeners.add(listener);
    return () => this.ownerReleaseListeners.delete(listener);
  }

  release(senderId: number): void {
    this.capabilities.delete(senderId);
    this.boundSenders.delete(senderId);
    for (const listener of this.ownerReleaseListeners) {
      listener(senderId);
    }
  }

  private bindSenderLifecycle(sender: WebContents): void {
    if (this.boundSenders.has(sender.id)) return;
    this.boundSenders.add(sender.id);

    sender.once("destroyed", () => this.release(sender.id));
    sender.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          this.release(sender.id);
        }
      },
    );
    sender.on("render-process-gone", () => this.release(sender.id));
  }
}

export const sharedAudioPreloadCapabilityRegistry =
  new AudioPreloadCapabilityRegistry();

export function registerAudioPreloadCapability(
  event: IpcMainEvent,
  capability: unknown,
): boolean {
  return sharedAudioPreloadCapabilityRegistry.register(event, capability);
}

export function isTrustedAudioSender(
  event: AudioIpcEvent,
  options: TrustedAudioSenderOptions = {},
): boolean {
  if (event.sender.isDestroyed()) return false;
  if (event.senderFrame?.parent) return false;

  const sourceUrl = event.senderFrame?.url || event.sender.getURL();
  if (!sourceUrl) return false;

  const devServerUrl = options.devServerUrl ?? process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      return new URL(sourceUrl).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }

  const appRoot = options.appRoot ?? process.env.APP_ROOT;
  if (!appRoot) return false;
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== "file:") return false;
    const expectedPath = path.resolve(appRoot, "dist", "index.html");
    const sourcePath = path.resolve(fileURLToPath(source));
    return normalizePathForComparison(sourcePath) ===
      normalizePathForComparison(expectedPath);
  } catch {
    return false;
  }
}

function isSecureEnvelope(
  value: unknown,
): value is AudioSecureIpcEnvelope<unknown> {
  if (!isRecord(value) || !isCapability(value.capability)) return false;
  if (
    value.configRevision !== undefined &&
    !isCapability(value.configRevision)
  ) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(value, "payload");
}

function isCapability(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
