import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
  LocalSubtitleIpcService,
} from "./ipc";
import type { LocalSubtitleModelManager } from "./model-manager";
import type { LocalSubtitleOwnerIdentity } from "./ipc-security";
import { LocalSubtitleSessionIpcBridge } from "./session-ipc";

export class LocalSubtitleModelIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #manager: LocalSubtitleModelIpcClient;
  readonly #session: LocalSubtitleSessionIpcBridge;

  constructor(
    manager: LocalSubtitleModelIpcClient,
    session: LocalSubtitleSessionIpcBridge,
  ) {
    if (
      !manager || ['listManagedResources', 'startResourceInstall', 'cancelResourceJob', 'deleteManagedResource', 'importModel']
        .some(method => typeof manager[method as keyof LocalSubtitleModelIpcClient] !== 'function') ||
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
        request: {
          readonly filePath: string;
          readonly mode: "copy" | "move";
          readonly modelId: string;
        },
        context: LocalSubtitleIpcHandlerContext,
      ) => {
        this.#session.ensureEvents(context);
        return localSubtitleIpcSuccess(
          this.#manager.importModel({
            owner: context.owner,
            filePath: request.filePath,
            mode: request.mode,
            modelId: request.modelId,
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

/** App-created resource clients preserve the existing validated IPC surface. */
export type LocalSubtitleModelIpcClient = Pick<LocalSubtitleModelManager,
  'listManagedResources' | 'startResourceInstall' | 'cancelResourceJob' | 'deleteManagedResource' | 'importModel'>;
