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
import { LocalSubtitleSessionIpcBridge } from "./session-ipc";

export class LocalSubtitleModelIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #manager: LocalSubtitleModelManager;
  readonly #session: LocalSubtitleSessionIpcBridge;

  constructor(
    manager: LocalSubtitleModelManager,
    session: LocalSubtitleSessionIpcBridge,
  ) {
    if (
      !(manager instanceof LocalSubtitleModelManager) ||
      !(session instanceof LocalSubtitleSessionIpcBridge)
    ) {
      throw new TypeError("The local subtitle model IPC manager is invalid.");
    }
    this.#manager = manager;
    this.#session = session;
    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources]: async (
          _request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          return localSubtitleIpcSuccess(
            await this.#manager.listManagedResources(
              context.owner,
              context.signal,
            ),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall]: (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { resourceId } = request as { readonly resourceId: string };
          return localSubtitleIpcSuccess(
            this.#manager.startResourceInstall(context.owner, resourceId),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob]: (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { jobId } = request as { readonly jobId: string };
          return localSubtitleIpcSuccess(
            this.#manager.cancelResourceJob(context.owner, jobId),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource]: async (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { resourceId } = request as { readonly resourceId: string };
          return localSubtitleIpcSuccess(
            await this.#manager.deleteManagedResource(
              context.owner,
              resourceId,
            ),
          );
        },
      }),
      importModel: (
        request: { readonly filePath: string; readonly mode: "copy" | "move" },
        context: LocalSubtitleIpcHandlerContext,
      ) => {
        this.#session.ensureEvents(context);
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
    this.#session.attach(service);
  }

  releaseOwner(owner: LocalSubtitleOwnerIdentity): void {
    this.#session.releaseOwner(owner);
  }
}
