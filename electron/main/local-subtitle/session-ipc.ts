import type {
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleArtifactResult,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
  LocalSubtitleIpcService,
} from "./ipc";
import type { LocalSubtitleOwnerIdentity } from "./ipc-security";
import { LocalSubtitleArtifactRegistry } from "./subtitle-artifact-registry";
import { LocalSubtitleSessionRegistry } from "./session-registry";

interface OwnerEventSubscriptions {
  readonly unsubscribeTask: () => void;
  readonly unsubscribeResource: () => void;
}

export class LocalSubtitleSessionIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #registry: LocalSubtitleSessionRegistry;
  readonly #artifacts: LocalSubtitleArtifactRegistry | undefined;
  readonly #subscriptions = new Map<string, OwnerEventSubscriptions>();
  #service: LocalSubtitleIpcService | undefined;

  constructor(
    registry: LocalSubtitleSessionRegistry,
    artifacts?: LocalSubtitleArtifactRegistry,
  ) {
    if (!(registry instanceof LocalSubtitleSessionRegistry)) {
      throw new TypeError("The local subtitle session IPC registry is invalid.");
    }
    if (
      artifacts !== undefined &&
      !(artifacts instanceof LocalSubtitleArtifactRegistry)
    ) {
      throw new TypeError("The local subtitle artifact registry is invalid.");
    }
    this.#registry = registry;
    this.#artifacts = artifacts;
    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot]: async (
          _request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => {
          this.ensureEvents(context);
          await this.refreshExpiredArtifactRefs(context);
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

  private async refreshExpiredArtifactRefs(
    context: LocalSubtitleIpcHandlerContext,
  ): Promise<void> {
    if (!this.#artifacts) return;
    const snapshot = this.#registry.getSnapshot(context.owner);
    for (const batch of snapshot.batches) {
      for (const task of batch.tasks) {
        if (task.status !== "completed") continue;
        const replacements = new Map<
          string,
          GeneratedSubtitleArtifactSummary
        >();
        for (const result of task.artifactResults) {
          if (result.status !== "committed" || !result.artifact) continue;
          try {
            const refreshed = await this.#artifacts.refreshSummary(
              context.owner,
              result.artifact,
            );
            if (refreshed.artifactRef !== result.artifact.artifactRef) {
              replacements.set(result.artifact.artifactRef, refreshed);
            }
          } catch {
            // A stale or changed artifact must not make the session unavailable.
          }
        }
        if (replacements.size === 0) continue;
        const current = this.#registry.getTask(context.owner, task.taskId);
        if (
          !current ||
          current.generation !== task.generation ||
          current.status !== "completed"
        ) {
          continue;
        }
        const artifactResults = replaceArtifactSummaries(
          current.artifactResults,
          replacements,
        );
        if (artifactResults === current.artifactResults) continue;
        const completion = current.completion;
        if (!completion) continue;
        this.#registry.upsertTask(context.owner, {
          ...current,
          artifactResults,
          completion: {
            ...completion,
            artifacts: replaceArtifactSummaries(
              completion.artifacts,
              replacements,
            ),
          },
        });
      }
    }
  }
}

function replaceArtifactSummaries(
  results: readonly LocalSubtitleArtifactResult[],
  replacements: ReadonlyMap<string, GeneratedSubtitleArtifactSummary>,
): readonly LocalSubtitleArtifactResult[] {
  let changed = false;
  const next = results.map((result) => {
    if (result.status !== "committed" || !result.artifact) return result;
    const replacement = replacements.get(result.artifact.artifactRef);
    if (!replacement) return result;
    changed = true;
    return { ...result, artifact: replacement };
  });
  return changed ? Object.freeze(next) : results;
}

function ownerKey(webContentsId: number, ownerSessionId: string): string {
  return JSON.stringify([webContentsId, ownerSessionId]);
}
