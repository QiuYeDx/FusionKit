import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
} from "./ipc";
import { LocalSubtitleJobManager } from "./job-manager";
import { LocalSubtitleSessionIpcBridge } from "./session-ipc";

export class LocalSubtitleJobIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #manager: LocalSubtitleJobManager;
  readonly #session: LocalSubtitleSessionIpcBridge;

  constructor(
    manager: LocalSubtitleJobManager,
    session: LocalSubtitleSessionIpcBridge,
  ) {
    if (
      !(manager instanceof LocalSubtitleJobManager) ||
      !(session instanceof LocalSubtitleSessionIpcBridge)
    ) {
      throw new TypeError("The local subtitle job IPC bridge options are invalid.");
    }
    this.#manager = manager;
    this.#session = session;
    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend]: async (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          return localSubtitleIpcSuccess(
            await this.#manager.previewBackend(
              context.owner,
              request as never,
              context.signal,
            ),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue]: async (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          return localSubtitleIpcSuccess(
            await this.#manager.enqueue(
              context.owner,
              request as never,
              context.signal,
            ),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask]: async (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { taskId } = request as { readonly taskId: string };
          return localSubtitleIpcSuccess(
            await this.#manager.retryTask(context.owner, taskId),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTaskOnCpu]: async (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          return localSubtitleIpcSuccess(
            await this.#manager.retryTaskOnCpu(
              context.owner,
              request as never,
              context.signal,
            ),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch]: (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { batchId } = request as { readonly batchId: string };
          return localSubtitleIpcSuccess(
            this.#manager.cancelBatch(context.owner, batchId),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { taskId } = request as { readonly taskId: string };
          return localSubtitleIpcSuccess(
            this.#manager.cancelTask(context.owner, taskId),
          );
        },
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask]: (
          request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.#session.ensureEvents(context);
          const { taskId } = request as { readonly taskId: string };
          return localSubtitleIpcSuccess(
            this.#manager.removeTask(context.owner, taskId),
          );
        },
      }),
    });
  }
}
