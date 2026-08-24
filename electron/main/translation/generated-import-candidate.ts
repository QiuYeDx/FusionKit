import { createHash } from "node:crypto";
import type {
  SubtitleTranslationGeneratedImportCandidate,
  SubtitleTranslationGeneratedImportCandidateControl,
  SubtitleTranslationGeneratedImportCandidateRequest,
  SubtitleTranslationGeneratedTaskReference,
} from "@/type/subtitleTranslationIpc";
import type {
  LocalSubtitleOwnerKey,
} from "../local-subtitle/authorizations";
import type {
  LocalSubtitleArtifactHandoffService,
  LocalSubtitleTranslationImportSnapshot,
} from "../local-subtitle/artifact-handoff";
import {
  SubtitleTranslationCapabilityError,
  SubtitleTranslationDirectoryCapabilityRegistry,
  type SubtitleTranslationOwnerKey,
} from "./directory-capability";

interface StoredGeneratedImportCandidate {
  readonly owner: SubtitleTranslationOwnerKey;
  readonly snapshotId: string;
  readonly taskId: string;
  readonly handoffKey: string;
  readonly candidateBinding: string;
  readonly displayName: string;
  readonly format: "SRT" | "LRC";
  readonly reference: SubtitleTranslationGeneratedTaskReference;
  state: "candidate" | "committed";
}

export interface GeneratedSubtitleImportCandidateServiceOptions {
  readonly handoffs: Pick<LocalSubtitleArtifactHandoffService, "consume">;
  readonly directoryCapabilities: SubtitleTranslationDirectoryCapabilityRegistry;
}

export class GeneratedSubtitleImportCandidateService {
  readonly #handoffs: Pick<LocalSubtitleArtifactHandoffService, "consume">;
  readonly #directoryCapabilities: SubtitleTranslationDirectoryCapabilityRegistry;
  readonly #byHandoffKey = new Map<string, StoredGeneratedImportCandidate>();
  readonly #byTaskId = new Map<string, StoredGeneratedImportCandidate>();

  constructor(options: GeneratedSubtitleImportCandidateServiceOptions) {
    if (
      !options ||
      !options.handoffs ||
      typeof options.handoffs.consume !== "function" ||
      !(options.directoryCapabilities instanceof
        SubtitleTranslationDirectoryCapabilityRegistry)
    ) {
      throw new TypeError("Generated subtitle import candidate services are invalid.");
    }
    this.#handoffs = options.handoffs;
    this.#directoryCapabilities = options.directoryCapabilities;
  }

  create(
    localOwner: LocalSubtitleOwnerKey,
    translationOwner: SubtitleTranslationOwnerKey,
    request: SubtitleTranslationGeneratedImportCandidateRequest,
  ): Promise<SubtitleTranslationGeneratedImportCandidate> {
    return this.#handoffs.consume(
      localOwner,
      request.translationImportToken,
      (snapshot) => this.#createFromSnapshot(
        translationOwner,
        request,
        snapshot,
      ),
    );
  }

  commit(
    owner: SubtitleTranslationOwnerKey,
    request: SubtitleTranslationGeneratedImportCandidateControl,
  ): boolean {
    const stored = this.#requireControl(owner, request);
    const committed = this.#directoryCapabilities.commitGeneratedTaskCandidate(
      owner,
      stored.taskId,
      stored.candidateBinding,
    );
    if (committed) stored.state = "committed";
    return committed;
  }

  release(
    owner: SubtitleTranslationOwnerKey,
    request: SubtitleTranslationGeneratedImportCandidateControl,
  ): boolean {
    const stored = this.#requireControl(owner, request);
    if (stored.state === "committed") return false;
    const released =
      this.#directoryCapabilities.releaseGeneratedTaskCandidate(
        owner,
        stored.taskId,
        stored.candidateBinding,
      );
    if (released) {
      this.#byHandoffKey.delete(stored.handoffKey);
      this.#byTaskId.delete(stored.taskId);
    }
    return released;
  }

  releaseOwner(owner: SubtitleTranslationOwnerKey): void {
    for (const stored of this.#byTaskId.values()) {
      if (!sameOwner(stored.owner, owner)) continue;
      this.#byTaskId.delete(stored.taskId);
      this.#byHandoffKey.delete(stored.handoffKey);
    }
  }

  releaseTask(owner: SubtitleTranslationOwnerKey, taskId: string): boolean {
    const stored = this.#byTaskId.get(taskId);
    if (stored && !sameOwner(stored.owner, owner)) throw conflict();
    const released = this.#directoryCapabilities.releaseGeneratedTask(
      owner,
      taskId,
    );
    if (stored && released) {
      this.#byTaskId.delete(stored.taskId);
      this.#byHandoffKey.delete(stored.handoffKey);
    }
    return released;
  }

  async #createFromSnapshot(
    owner: SubtitleTranslationOwnerKey,
    request: SubtitleTranslationGeneratedImportCandidateRequest,
    snapshot: LocalSubtitleTranslationImportSnapshot,
  ): Promise<SubtitleTranslationGeneratedImportCandidate> {
    const identity = Object.freeze({
      owner: [owner.webContentsId, owner.ownerSessionId],
      snapshotId: request.snapshotId,
      artifact: {
        taskId: snapshot.artifactIdentity.taskId,
        generation: snapshot.artifactIdentity.generation,
        format: snapshot.artifactIdentity.format,
        byteSize: snapshot.artifactIdentity.byteSize,
        sha256: snapshot.artifactIdentity.sha256,
      },
    });
    const handoffDigest = digest(identity);
    const handoffKey = `subtitle-handoff-${handoffDigest}`;
    const taskId = `subtitle-task-${handoffDigest}`;
    const candidateBinding = `subtitle-candidate-${digest({
      identity,
      outputMode: request.outputMode,
      directoryLeaseToken: request.directoryLeaseToken ?? null,
    })}`;
    const existing = this.#byHandoffKey.get(handoffKey);
    if (existing) {
      if (
        !sameOwner(existing.owner, owner) ||
        existing.snapshotId !== request.snapshotId ||
        existing.taskId !== taskId ||
        existing.candidateBinding !== candidateBinding ||
        existing.displayName !== snapshot.displayName ||
        existing.format !== snapshot.format
      ) {
        throw conflict();
      }
      return candidateResponse(existing, snapshot.content);
    }
    if (this.#byTaskId.has(taskId)) throw conflict();

    const common = {
      owner,
      taskId,
      handoffKey,
      candidateBinding,
      sourceDisplayName: snapshot.displayName,
      outputFileName: snapshot.displayName,
    };
    const reference = request.outputMode === "custom"
      ? await this.#directoryCapabilities
        .registerGeneratedTaskCandidateFromLease({
          ...common,
          snapshotId: request.snapshotId,
          directoryLeaseToken: request.directoryLeaseToken!,
        })
      : await this.#directoryCapabilities
        .registerGeneratedTaskCandidateFromAuthority({
          ...common,
          directory: {
            directoryPath: snapshot.sourceDirectoryProof.directoryPath,
            displayLabel: "Source directory",
            identity: snapshot.sourceDirectoryProof.directoryIdentity,
          },
        });
    const stored: StoredGeneratedImportCandidate = {
      owner: Object.freeze({ ...owner }),
      snapshotId: request.snapshotId,
      taskId,
      handoffKey,
      candidateBinding,
      displayName: snapshot.displayName,
      format: snapshot.format,
      reference,
      state: "candidate",
    };
    this.#byHandoffKey.set(handoffKey, stored);
    this.#byTaskId.set(taskId, stored);
    return candidateResponse(stored, snapshot.content);
  }

  #requireControl(
    owner: SubtitleTranslationOwnerKey,
    request: SubtitleTranslationGeneratedImportCandidateControl,
  ): StoredGeneratedImportCandidate {
    const stored = this.#byTaskId.get(request.taskId);
    if (
      !stored ||
      !sameOwner(stored.owner, owner) ||
      stored.handoffKey !== request.handoffKey ||
      stored.candidateBinding !== request.candidateBinding
    ) {
      throw conflict();
    }
    return stored;
  }
}

function candidateResponse(
  stored: StoredGeneratedImportCandidate,
  content: string,
): SubtitleTranslationGeneratedImportCandidate {
  return Object.freeze({
    taskId: stored.taskId,
    handoffKey: stored.handoffKey,
    candidateBinding: stored.candidateBinding,
    displayName: stored.displayName,
    format: stored.format,
    content,
    reference: stored.reference,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameOwner(
  left: SubtitleTranslationOwnerKey,
  right: SubtitleTranslationOwnerKey,
): boolean {
  return left.webContentsId === right.webContentsId &&
    left.ownerSessionId === right.ownerSessionId;
}

function conflict(): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "task_reference_conflict",
    "The generated subtitle import candidate conflicts with existing authority.",
    "handoffKey",
  );
}
