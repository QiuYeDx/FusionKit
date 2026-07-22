import { LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS, localSubtitleIpcSuccess } from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
  LocalSubtitleIpcService,
} from "./ipc";
import type { LocalSubtitleOwnerIdentity } from "./ipc-security";
import { LocalSubtitleSessionRegistry } from "./session-registry";

interface OwnerEventSubscriptions {
  readonly unsubscribeTask: () => void;
  readonly unsubscribeResource: () => void;
}

export class LocalSubtitleSessionIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #registry: LocalSubtitleSessionRegistry;
  readonly #subscriptions = new Map<string, OwnerEventSubscriptions>();
  #service: LocalSubtitleIpcService | undefined;

  constructor(registry: LocalSubtitleSessionRegistry) {
    if (!(registry instanceof LocalSubtitleSessionRegistry)) {
      throw new TypeError("The local subtitle session IPC registry is invalid.");
    }
    this.#registry = registry;
    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot]: (
          _request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.ensureEvents(context);
          return localSubtitleIpcSuccess(
            this.#registry.getSnapshot(context.owner),
          );
        },
      }),
    });
  }

  attach(service: LocalSubtitleIpcService): void {
    if (
      !service ||
      typeof service.emitTaskEvent !== "function" ||
      typeof service.emitResourceEvent !== "function"
    ) {
      throw new TypeError("The local subtitle session IPC service is invalid.");
    }
    if (this.#service && this.#service !== service) {
      throw new TypeError("The local subtitle session IPC bridge is already attached.");
    }
    this.#service = service;
  }

  ensureEvents(context: LocalSubtitleIpcHandlerContext): void {
    const service = this.#service;
    if (!service) {
      throw new TypeError("The local subtitle session IPC bridge is not attached.");
    }
    const key = ownerKey(
      context.owner.webContentsId,
      context.owner.ownerSessionId,
    );
    if (this.#subscriptions.has(key)) return;

    const unsubscribeTask = this.#registry.onTaskEvent(
      context.owner,
      (event) => {
        service.emitTaskEvent(context.ownerIdentity, event);
      },
    );
    try {
      const unsubscribeResource = this.#registry.onResourceEvent(
        context.owner,
        (event) => {
          service.emitResourceEvent(context.ownerIdentity, event);
        },
      );
      this.#subscriptions.set(key, {
        unsubscribeTask,
        unsubscribeResource,
      });
    } catch (error) {
      unsubscribeTask();
      throw error;
    }
  }

  releaseOwner(owner: LocalSubtitleOwnerIdentity): void {
    const key = ownerKey(owner.senderId, owner.ownerSessionId);
    const subscriptions = this.#subscriptions.get(key);
    subscriptions?.unsubscribeTask();
    subscriptions?.unsubscribeResource();
    this.#subscriptions.delete(key);
  }
}

function ownerKey(webContentsId: number, ownerSessionId: string): string {
  return JSON.stringify([webContentsId, ownerSessionId]);
}
