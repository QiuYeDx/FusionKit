import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
  LocalSubtitleIpcService,
} from "./ipc";
import { LocalSubtitleModelManager } from "./model-manager";
import type { LocalSubtitleOwnerIdentity } from "./ipc-security";

export class LocalSubtitleModelIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #manager: LocalSubtitleModelManager;
  readonly #resourceEventUnsubscribers = new Map<string, () => void>();
  #service: LocalSubtitleIpcService | undefined;

  constructor(manager: LocalSubtitleModelManager) {
    if (!(manager instanceof LocalSubtitleModelManager)) {
      throw new TypeError("The local subtitle model IPC manager is invalid.");
    }
    this.#manager = manager;
    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources]: async (
          _request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#ensureResourceEvents(context);
          return localSubtitleIpcSuccess(
            await this.#manager.listManagedResources(
              context.owner,
              context.signal,
            ),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob]: (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#ensureResourceEvents(context);
          const { jobId } = request as { readonly jobId: string };
          return localSubtitleIpcSuccess(
            this.#manager.cancelResourceJob(context.owner, jobId),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot]: (
          _request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#ensureResourceEvents(context);
          return localSubtitleIpcSuccess(
            this.#manager.getSessionSnapshot(context.owner),
          );
        },
      }),
      importModel: (
        request: { readonly filePath: string; readonly mode: "copy" | "move" },
        context: LocalSubtitleIpcHandlerContext,
      ) => {
        this.#ensureResourceEvents(context);
        return localSubtitleIpcSuccess(
          this.#manager.importModel({
            owner: context.owner,
            filePath: request.filePath,
            mode: request.mode,
          }),
        );
      },
    });
  }

  attach(service: LocalSubtitleIpcService): void {
    if (!service || typeof service.emitResourceEvent !== "function") {
      throw new TypeError("The local subtitle IPC service is invalid.");
    }
    if (this.#service && this.#service !== service) {
      throw new TypeError("The local subtitle model IPC bridge is already attached.");
    }
    this.#service = service;
  }

  releaseOwner(owner: LocalSubtitleOwnerIdentity): void {
    const key = ownerKey(owner.senderId, owner.ownerSessionId);
    this.#resourceEventUnsubscribers.get(key)?.();
    this.#resourceEventUnsubscribers.delete(key);
  }

  #ensureResourceEvents(context: LocalSubtitleIpcHandlerContext): void {
    const service = this.#service;
    if (!service) {
      throw new TypeError("The local subtitle model IPC bridge is not attached.");
    }
    const key = ownerKey(
      context.owner.webContentsId,
      context.owner.ownerSessionId,
    );
    if (this.#resourceEventUnsubscribers.has(key)) return;
    this.#resourceEventUnsubscribers.set(
      key,
      this.#manager.onResourceEvent(context.owner, (event) => {
        service.emitResourceEvent(context.ownerIdentity, event);
      }),
    );
  }
}

function ownerKey(webContentsId: number, ownerSessionId: string): string {
  return JSON.stringify([webContentsId, ownerSessionId]);
}
