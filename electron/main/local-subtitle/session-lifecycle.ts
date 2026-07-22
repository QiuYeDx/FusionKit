import type { LocalSubtitleOwnerKey } from "./authorizations";
import type {
  LocalSubtitleMainRuntimeShutdownReason,
  LocalSubtitleMainRuntimeTarget,
} from "./main-runtime";

export class LocalSubtitleSessionLifecycle
  implements LocalSubtitleMainRuntimeTarget
{
  readonly #quiesceTargets: readonly LocalSubtitleMainRuntimeTarget[];
  readonly #cleanupTargets: readonly LocalSubtitleMainRuntimeTarget[];
  readonly #releaseTargets: readonly LocalSubtitleMainRuntimeTarget[];
  readonly #registry: LocalSubtitleMainRuntimeTarget;
  #shutdownOperation: Promise<void> | undefined;
  #shutdownSucceeded = false;

  constructor(
    jobManager: LocalSubtitleMainRuntimeTarget,
    modelManager: LocalSubtitleMainRuntimeTarget,
    media: LocalSubtitleMainRuntimeTarget,
    server: LocalSubtitleMainRuntimeTarget,
    sessionRegistry: LocalSubtitleMainRuntimeTarget,
  ) {
    const targets = [jobManager, modelManager, media, server, sessionRegistry];
    if (targets.some((target) => !isRuntimeTarget(target))) {
      throw new TypeError("The local subtitle session lifecycle targets are invalid.");
    }
    this.#quiesceTargets = Object.freeze([jobManager, modelManager]);
    this.#cleanupTargets = Object.freeze([media, server]);
    this.#releaseTargets = Object.freeze([
      jobManager,
      media,
      server,
      modelManager,
      sessionRegistry,
    ]);
    this.#registry = sessionRegistry;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    let firstFailure: unknown;
    let failed = false;
    for (const target of this.#releaseTargets) {
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

    let resolveOperation!: () => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#shutdownOperation = operation;

    void (async () => {
      let firstFailure = await settlePhase(this.#quiesceTargets, reason);
      const cleanupFailure = await settlePhase(this.#cleanupTargets, reason);
      firstFailure ??= cleanupFailure;
      try {
        await invokeShutdown(this.#registry, reason);
      } catch (error) {
        firstFailure ??= error;
      }
      if (firstFailure !== undefined) throw firstFailure;
      this.#shutdownSucceeded = true;
    })()
      .then(resolveOperation, (error: unknown) => {
        if (this.#shutdownOperation === operation) {
          this.#shutdownOperation = undefined;
        }
        rejectOperation(error);
      });
    return operation;
  }
}

async function settlePhase(
  targets: readonly LocalSubtitleMainRuntimeTarget[],
  reason: LocalSubtitleMainRuntimeShutdownReason,
): Promise<unknown | undefined> {
  const results = await Promise.allSettled(
    targets.map((target) => invokeShutdown(target, reason)),
  );
  return results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )?.reason;
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
