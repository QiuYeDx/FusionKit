import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalSubtitleTranslationImportSnapshot } from "../../electron/main/local-subtitle/artifact-handoff";
import { localSubtitleFilesystemObjectIdentityForPath } from "../../electron/main/local-subtitle/filesystem-object-identity";
import { SubtitleTranslationDirectoryCapabilityRegistry } from "../../electron/main/translation/directory-capability";
import { GeneratedSubtitleImportCandidateService } from "../../electron/main/translation/generated-import-candidate";

const LOCAL_OWNER = Object.freeze({
  webContentsId: 21,
  ownerSessionId: "local-owner",
});
const TRANSLATION_OWNER = Object.freeze({
  webContentsId: 21,
  ownerSessionId: "translation-owner",
});
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("generated subtitle import candidate service", () => {
  it("consumes one-shot content and replays stable artifact identity", async () => {
    const output = await outputDirectory();
    const proof = Object.freeze({
      directoryPath: output,
      directoryIdentity: Object.freeze(
        await localSubtitleFilesystemObjectIdentityForPath(output),
      ),
    });
    const snapshots = new Map<string, LocalSubtitleTranslationImportSnapshot>([
      ["ls-import-first", snapshot("ls-artifact-old", proof)],
      ["ls-import-second", snapshot("ls-artifact-rotated", proof)],
    ]);
    const directories = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("target-one"),
    });
    const service = new GeneratedSubtitleImportCandidateService({
      handoffs: {
        async consume(owner, token, consumer) {
          expect(owner).toEqual(LOCAL_OWNER);
          const value = snapshots.get(token);
          if (!value) throw new Error("invalid import token");
          snapshots.delete(token);
          return consumer(value);
        },
      },
      directoryCapabilities: directories,
    });
    const request = {
      translationImportToken: "ls-import-first",
      snapshotId: "snapshot-one",
      outputMode: "source" as const,
    };
    const first = await service.create(LOCAL_OWNER, TRANSLATION_OWNER, request);
    expect(first).toMatchObject({
      displayName: "generated.srt",
      format: "SRT",
      content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
      reference: {
        kind: "generated_task_v1",
        target: { displayLabel: "Source directory" },
      },
    });
    expect(JSON.stringify(first)).not.toContain(output);
    expect(service.commit(TRANSLATION_OWNER, control(first))).toBe(true);

    const replay = await service.create(LOCAL_OWNER, TRANSLATION_OWNER, {
      ...request,
      translationImportToken: "ls-import-second",
    });
    expect(replay.taskId).toBe(first.taskId);
    expect(replay.handoffKey).toBe(first.handoffKey);
    expect(replay.candidateBinding).toBe(first.candidateBinding);
    expect(replay.reference).toBe(first.reference);
    expect(service.release(TRANSLATION_OWNER, control(replay))).toBe(false);
    await expect(directories.resolveTaskReference(
      TRANSLATION_OWNER,
      first.taskId,
      first.reference,
    )).resolves.toMatchObject({ targetDirectoryPath: output });
  });

  it("releases candidates that never transfer to the queue", async () => {
    const output = await outputDirectory();
    const proof = Object.freeze({
      directoryPath: output,
      directoryIdentity: Object.freeze(
        await localSubtitleFilesystemObjectIdentityForPath(output),
      ),
    });
    const directories = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("target-pending"),
    });
    const service = new GeneratedSubtitleImportCandidateService({
      handoffs: {
        consume: (_owner, _token, consumer) =>
          Promise.resolve(consumer(snapshot("ls-artifact-pending", proof))),
      },
      directoryCapabilities: directories,
    });
    const candidate = await service.create(LOCAL_OWNER, TRANSLATION_OWNER, {
      translationImportToken: "ls-import-pending",
      snapshotId: "snapshot-pending",
      outputMode: "source",
    });
    expect(service.release(TRANSLATION_OWNER, control(candidate))).toBe(true);
    expect(directories.isGeneratedTask(candidate.taskId)).toBe(false);
  });

  it("uses a snapshot-bound custom lease without transferring the lease itself", async () => {
    const output = await outputDirectory();
    const proof = Object.freeze({
      directoryPath: output,
      directoryIdentity: Object.freeze(
        await localSubtitleFilesystemObjectIdentityForPath(output),
      ),
    });
    const directories = new SubtitleTranslationDirectoryCapabilityRegistry({
      tokenFactory: sequence("draft", "lease", "target"),
    });
    const draft = await directories.authorizeDraft(TRANSLATION_OWNER, output);
    const lease = await directories.acquireImportLease(
      TRANSLATION_OWNER,
      "snapshot-custom",
      draft.directoryToken,
      draft.expiresAt,
    );
    const service = new GeneratedSubtitleImportCandidateService({
      handoffs: {
        consume: (_owner, _token, consumer) =>
          Promise.resolve(consumer(snapshot("ls-artifact-custom", proof))),
      },
      directoryCapabilities: directories,
    });
    const candidate = await service.create(LOCAL_OWNER, TRANSLATION_OWNER, {
      translationImportToken: "ls-import-custom",
      snapshotId: "snapshot-custom",
      outputMode: "custom",
      directoryLeaseToken: lease.directoryLeaseToken,
    });
    expect(service.commit(TRANSLATION_OWNER, control(candidate))).toBe(true);
    expect(directories.releaseImportLease(
      TRANSLATION_OWNER,
      lease.directoryLeaseToken,
    )).toBe(true);
    await expect(directories.resolveTaskReference(
      TRANSLATION_OWNER,
      candidate.taskId,
      candidate.reference,
    )).resolves.toMatchObject({ targetDirectoryPath: output });
  });
});

function snapshot(
  artifactRef: string,
  sourceDirectoryProof: LocalSubtitleTranslationImportSnapshot["sourceDirectoryProof"],
): LocalSubtitleTranslationImportSnapshot {
  const content = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";
  return Object.freeze({
    content,
    format: "SRT",
    displayName: "generated.srt",
    cueCount: 1,
    artifactIdentity: Object.freeze({
      artifactRef,
      taskId: "local-task-one",
      generation: 1,
      format: "SRT",
      byteSize: Buffer.byteLength(content),
      sha256: "a".repeat(64),
    }),
    sourceDirectoryProof,
  });
}

function control(candidate: {
  readonly taskId: string;
  readonly handoffKey: string;
  readonly candidateBinding: string;
}) {
  return {
    taskId: candidate.taskId,
    handoffKey: candidate.handoffKey,
    candidateBinding: candidate.candidateBinding,
  };
}

async function outputDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-import-candidate-"));
  tempRoots.push(root);
  const output = path.join(root, "output");
  await mkdir(output);
  return realpath(output);
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `token-${index}`;
}
