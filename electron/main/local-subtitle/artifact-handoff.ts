import type {
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleFormat,
} from "@/type/localSubtitle";
import type { LocalSubtitleHandoffResult } from "@/type/localSubtitleIpc";
import {
  LocalSubtitleImportTokenRegistry,
  type LocalSubtitleOwnerKey,
} from "./authorizations";
import {
  LocalSubtitleArtifactRegistry,
  LocalSubtitleArtifactRegistryError,
  type LocalSubtitleArtifactDirectoryProof,
} from "./subtitle-artifact-registry";

export interface LocalSubtitleTranslationImportArtifactIdentity {
  readonly artifactRef: string;
  readonly taskId: string;
  readonly generation: number;
  readonly format: LocalSubtitleFormat;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface LocalSubtitleTranslationImportSnapshot {
  readonly content: string;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly cueCount: number;
  readonly artifactIdentity: LocalSubtitleTranslationImportArtifactIdentity;
  readonly sourceDirectoryProof: LocalSubtitleArtifactDirectoryProof;
}

export interface LocalSubtitleStoredTranslationImportSnapshot {
  readonly contentBytes: Buffer;
  readonly format: LocalSubtitleFormat;
  readonly displayName: string;
  readonly cueCount: number;
  readonly artifactIdentity: LocalSubtitleTranslationImportArtifactIdentity;
  readonly sourceDirectoryProof: LocalSubtitleArtifactDirectoryProof;
}

export type LocalSubtitleTranslationImportTokenRegistry =
  LocalSubtitleImportTokenRegistry<LocalSubtitleStoredTranslationImportSnapshot>;

interface TrackedTranslationImportToken {
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
}

export class LocalSubtitleArtifactHandoffService {
  readonly #trackedTokens = new Map<string, TrackedTranslationImportToken>();

  constructor(
    readonly artifacts: LocalSubtitleArtifactRegistry,
    readonly importTokens: LocalSubtitleTranslationImportTokenRegistry,
  ) {
    if (
      !(artifacts instanceof LocalSubtitleArtifactRegistry) ||
      !(importTokens instanceof LocalSubtitleImportTokenRegistry)
    ) {
      throw new TypeError("Local subtitle artifact handoff services are invalid.");
    }
  }

  async handoff(
    owner: LocalSubtitleOwnerKey,
    artifactRef: string,
  ): Promise<LocalSubtitleHandoffResult> {
    const snapshot = await this.artifacts.snapshotForHandoff(owner, artifactRef);
    const sourceDirectoryProof =
      await this.artifacts.resolveDirectoryForTranslationImport(
        owner,
        artifactRef,
      );
    const contentBytes = Buffer.from(snapshot.rawText, "utf8");
    if (contentBytes.byteLength !== snapshot.byteSize) {
      contentBytes.fill(0);
      throw new LocalSubtitleArtifactRegistryError(
        "artifact_changed",
        "Local subtitle artifact content changed before handoff.",
        "artifactRef",
      );
    }
    const stored: LocalSubtitleStoredTranslationImportSnapshot = Object.freeze({
      contentBytes,
      format: snapshot.format,
      displayName: snapshot.displayName,
      cueCount: snapshot.cueCount,
      artifactIdentity: Object.freeze({
        artifactRef,
        taskId: snapshot.taskId,
        generation: snapshot.generation,
        format: snapshot.format,
        byteSize: snapshot.byteSize,
        sha256: snapshot.sha256,
      }),
      sourceDirectoryProof,
    });
    let translationImportToken: string | undefined;
    try {
      const authorization = this.importTokens.mint(
        owner,
        stored,
        contentBytes.byteLength,
        (value) => {
          clearStoredSnapshot(value);
          if (translationImportToken) {
            this.#trackedTokens.delete(translationImportToken);
          }
        },
      );
      translationImportToken = authorization.translationImportToken;
      this.#trackedTokens.set(translationImportToken, Object.freeze({
        owner: Object.freeze({ ...owner }),
        taskId: snapshot.taskId,
      }));
      return authorization;
    } catch (error) {
      clearStoredSnapshot(stored);
      throw error;
    }
  }

  consume<R>(
    owner: LocalSubtitleOwnerKey,
    translationImportToken: string,
    consumer: (
      snapshot: LocalSubtitleTranslationImportSnapshot,
    ) => R | Promise<R>,
  ): Promise<R> {
    if (typeof consumer !== "function") {
      throw new TypeError("Local subtitle import token consumer is invalid.");
    }
    return this.importTokens.consume(
      owner,
      translationImportToken,
      (stored) => consumer(Object.freeze({
        content: stored.contentBytes.toString("utf8"),
        format: stored.format,
        displayName: stored.displayName,
        cueCount: stored.cueCount,
        artifactIdentity: stored.artifactIdentity,
        sourceDirectoryProof: stored.sourceDirectoryProof,
      })),
    );
  }

  revokeTask(owner: LocalSubtitleOwnerKey, taskId: string): number {
    for (const [translationImportToken, tracked] of this.#trackedTokens) {
      if (
        tracked.taskId !== taskId ||
        tracked.owner.webContentsId !== owner.webContentsId ||
        tracked.owner.ownerSessionId !== owner.ownerSessionId
      ) {
        continue;
      }
      this.importTokens.revoke(owner, translationImportToken);
    }
    return this.artifacts.revokeTask(owner, taskId);
  }

  refreshArtifactSummary(
    owner: LocalSubtitleOwnerKey,
    summary: GeneratedSubtitleArtifactSummary,
  ): Promise<GeneratedSubtitleArtifactSummary> {
    return this.artifacts.refreshSummary(owner, summary);
  }
}

function clearStoredSnapshot(
  snapshot: LocalSubtitleStoredTranslationImportSnapshot,
): void {
  snapshot.contentBytes.fill(0);
}
