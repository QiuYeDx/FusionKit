import type { LocalSubtitleOwnerKey } from "./authorizations";

export type LocalSubtitleMainRuntimeShutdownReason =
  | "app_quit"
  | "update"
  | "fatal";

export interface LocalSubtitleMainRuntimeTarget {
  releaseOwner(owner: LocalSubtitleOwnerKey): void;
  shutdown(reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void>;
}

export type LocalSubtitleMainRuntimeMediaTarget = LocalSubtitleMainRuntimeTarget;
export type LocalSubtitleMainRuntimeServerTarget = LocalSubtitleMainRuntimeTarget;

export class LocalSubtitleMainRuntime {
  readonly #targets: readonly LocalSubtitleMainRuntimeTarget[];
  #shutdownOperation: Promise<void> | undefined;
  #shutdownSucceeded = false;

  constructor(
    media: LocalSubtitleMainRuntimeMediaTarget,
    server: LocalSubtitleMainRuntimeServerTarget,
    ...additionalTargets: readonly LocalSubtitleMainRuntimeTarget[]
  ) {
    const targets = [media, server, ...additionalTargets];
    if (targets.some((target) => !isRuntimeTarget(target))) {
      throw new TypeError("The local subtitle main runtime targets are invalid.");
    }
    this.#targets = Object.freeze([...targets]);
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    let firstFailure: unknown;
    let failed = false;
    for (const target of this.#targets) {
      try {
        target.releaseOwner(owner);
      } catch (error) {
        if (!failed) firstFailure = error;
        failed = true;
      }
    }
    if (failed) throw firstFailure;
  }

  shutdown(reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void> {
    if (this.#shutdownSucceeded) return Promise.resolve();
    if (this.#shutdownOperation) return this.#shutdownOperation;

    let operation: Promise<void>;
    operation = Promise.allSettled(
      this.#targets.map((target) => invokeShutdown(target, reason)),
    )
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
  target: Pick<LocalSubtitleMainRuntimeTarget, "shutdown">,
  reason: LocalSubtitleMainRuntimeShutdownReason,
): Promise<void> {
  try {
    return target.shutdown(reason);
  } catch (error) {
    return Promise.reject(error);
  }
}

function isRuntimeTarget(value: unknown): value is LocalSubtitleMainRuntimeTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LocalSubtitleMainRuntimeTarget).releaseOwner === "function" &&
    typeof (value as LocalSubtitleMainRuntimeTarget).shutdown === "function"
  );
}
