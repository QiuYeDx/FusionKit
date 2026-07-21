import type { LocalSubtitleOwnerKey } from "./authorizations";

export type LocalSubtitleMainRuntimeShutdownReason =
  | "app_quit"
  | "update"
  | "fatal";

export interface LocalSubtitleMainRuntimeMediaTarget {
  releaseOwner(owner: LocalSubtitleOwnerKey): void;
  shutdown(reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void>;
}

export interface LocalSubtitleMainRuntimeServerTarget {
  releaseOwner(owner: LocalSubtitleOwnerKey): void;
  shutdown(reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void>;
}

export class LocalSubtitleMainRuntime {
  readonly #media: LocalSubtitleMainRuntimeMediaTarget;
  readonly #server: LocalSubtitleMainRuntimeServerTarget;
  #shutdownOperation: Promise<void> | undefined;
  #shutdownSucceeded = false;

  constructor(
    media: LocalSubtitleMainRuntimeMediaTarget,
    server: LocalSubtitleMainRuntimeServerTarget,
  ) {
    if (
      !media ||
      typeof media.releaseOwner !== "function" ||
      typeof media.shutdown !== "function" ||
      !server ||
      typeof server.releaseOwner !== "function" ||
      typeof server.shutdown !== "function"
    ) {
      throw new TypeError("The local subtitle main runtime targets are invalid.");
    }
    this.#media = media;
    this.#server = server;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    try {
      this.#media.releaseOwner(owner);
    } finally {
      this.#server.releaseOwner(owner);
    }
  }

  shutdown(reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void> {
    if (this.#shutdownSucceeded) return Promise.resolve();
    if (this.#shutdownOperation) return this.#shutdownOperation;

    let operation: Promise<void>;
    operation = Promise.allSettled([
      invokeShutdown(this.#media, reason),
      invokeShutdown(this.#server, reason),
    ])
      .then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) throw failure.reason;
        this.#shutdownSucceeded = true;
      })
      .catch((error: unknown) => {
        if (this.#shutdownOperation === operation) {
          this.#shutdownOperation = undefined;
        }
        throw error;
      });
    this.#shutdownOperation = operation;
    return operation;
  }
}

function invokeShutdown(
  target: Pick<LocalSubtitleMainRuntimeMediaTarget, "shutdown">,
  reason: LocalSubtitleMainRuntimeShutdownReason,
): Promise<void> {
  try {
    return target.shutdown(reason);
  } catch (error) {
    return Promise.reject(error);
  }
}
