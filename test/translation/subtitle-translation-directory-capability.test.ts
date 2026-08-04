import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SubtitleTranslationDirectoryCapabilityRegistry,
  createLegacySubtitleTranslationTaskReference,
  type SubtitleTranslationOwnerKey,
} from "../../electron/main/translation/directory-capability";

const OWNER_A = Object.freeze({
  webContentsId: 11,
  ownerSessionId: "owner-session-a",
}) satisfies SubtitleTranslationOwnerKey;
const OWNER_B = Object.freeze({
  webContentsId: 12,
  ownerSessionId: "owner-session-b",
}) satisfies SubtitleTranslationOwnerKey;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("subtitle translation directory capability registry", () => {
  it("promotes a selected input into a path-free source-mode task", async () => {
    const root = await tempRoot();
    const input = path.join(root, "selected.srt");
    await writeFile(input, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    const canonicalInput = await realpath(input);
    const canonicalRoot = await realpath(root);
    const registry = registryWithTokens("input", "source", "target");
    const authorized = await registry.authorizeInputFile(OWNER_A, input);
    expect(authorized).toEqual({
      inputToken: "subtitle-translation-input-input",
      displayName: "selected.srt",
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(authorized)).not.toContain(root);
    await expect(registry.readInputFile(
      OWNER_A,
      authorized.inputToken,
    )).resolves.toEqual({
      displayName: "selected.srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    });

    const reference = await registry.registerAuthorizedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-selected-source",
      inputToken: authorized.inputToken,
      outputMode: "source",
      outputFileName: "selected.srt",
    });
    expect(reference).toEqual({
      kind: "authorized_task_v1",
      source: {
        kind: "authorized_file",
        token: "subtitle-translation-source-source",
        displayName: "selected.srt",
      },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-target",
        displayLabel: path.basename(root),
      },
    });
    expect(JSON.stringify(reference)).not.toContain(root);
    expect(registry.revokeInputFile(OWNER_A, authorized.inputToken)).toBe(false);
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-selected-source",
      reference,
    )).resolves.toMatchObject({
      kind: "authorized_task_v1",
      originFilePath: canonicalInput,
      targetDirectoryPath: canonicalRoot,
      outputFileName: "selected.srt",
    });
    await expect(registry.resolveAuthorizedTaskSourceForSender(
      OWNER_A.webContentsId,
      "subtitle-task-selected-source",
    )).resolves.toBe(canonicalInput);
  });

  it("reuses a custom directory draft without sharing task handles", async () => {
    const root = await tempRoot();
    const firstInput = path.join(root, "first.srt");
    const secondInput = path.join(root, "second.srt");
    await writeFile(firstInput, "first");
    await writeFile(secondInput, "second");
    const output = await outputDirectory("manual-output");
    const registry = registryWithTokens(
      "directory",
      "first-input",
      "second-input",
      "first-source",
      "first-target",
      "second-source",
      "second-target",
    );
    const directory = await registry.authorizeDraft(OWNER_A, output);
    const first = await registry.authorizeInputFile(OWNER_A, firstInput);
    const second = await registry.authorizeInputFile(OWNER_A, secondInput);
    const firstReference = await registry.registerAuthorizedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-manual-first",
      inputToken: first.inputToken,
      outputMode: "custom",
      outputFileName: "first.srt",
      directoryToken: directory.directoryToken,
    });
    const secondReference = await registry.registerAuthorizedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-manual-second",
      inputToken: second.inputToken,
      outputMode: "custom",
      outputFileName: "second.srt",
      directoryToken: directory.directoryToken,
    });

    expect(firstReference.target.token).not.toBe(secondReference.target.token);
    expect(registry.revokeDraft(OWNER_A, directory.directoryToken)).toBe(true);
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-manual-first",
      firstReference,
    )).resolves.toMatchObject({ targetDirectoryPath: output });
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-manual-second",
      secondReference,
    )).resolves.toMatchObject({ targetDirectoryPath: output });
  });

  it("promotes a path-free draft into independent task authority", async () => {
    const output = await outputDirectory("primary");
    const registry = registryWithTokens("one", "two");
    const draft = await registry.authorizeDraft(OWNER_A, output);

    expect(draft).toEqual({
      directoryToken: "subtitle-translation-draft-one",
      displayLabel: "primary",
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(draft)).not.toContain(output);

    const reference = await registry.registerGeneratedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-generated-one",
      handoffKey: "handoff-one",
      sourceDisplayName: "generated.srt",
      outputFileName: "generated.srt",
      directoryToken: draft.directoryToken,
    });
    expect(reference).toEqual({
      kind: "generated_task_v1",
      source: { kind: "generated_content", displayName: "generated.srt" },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-two",
        displayLabel: "primary",
      },
    });
    expect(JSON.stringify(reference)).not.toContain(output);
    expect(registry.revokeDraft(OWNER_A, draft.directoryToken)).toBe(false);

    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-generated-one",
      reference,
    )).resolves.toEqual({
      kind: "generated_task_v1",
      targetDirectoryPath: output,
      outputFilePath: path.join(output, "generated.srt"),
      outputFileName: "generated.srt",
      expiresAt: expect.any(Number),
    });
  });

  it("keeps batch leases separate from candidate ownership transfer", async () => {
    const output = await outputDirectory("batch-output");
    const registry = registryWithTokens(
      "draft",
      "lease",
      "first-target",
      "second-target",
    );
    const draft = await registry.authorizeDraft(OWNER_A, output);
    const lease = await registry.acquireImportLease(
      OWNER_A,
      "snapshot-one",
      draft.directoryToken,
      draft.expiresAt,
    );
    const first = await registry.registerGeneratedTaskCandidateFromLease({
      owner: OWNER_A,
      snapshotId: "snapshot-one",
      directoryLeaseToken: lease.directoryLeaseToken,
      taskId: "subtitle-task-candidate-one",
      handoffKey: "handoff-candidate-one",
      candidateBinding: "binding-candidate-one",
      sourceDisplayName: "one.srt",
      outputFileName: "one.srt",
    });
    await registry.registerGeneratedTaskCandidateFromLease({
      owner: OWNER_A,
      snapshotId: "snapshot-one",
      directoryLeaseToken: lease.directoryLeaseToken,
      taskId: "subtitle-task-candidate-two",
      handoffKey: "handoff-candidate-two",
      candidateBinding: "binding-candidate-two",
      sourceDisplayName: "two.srt",
      outputFileName: "two.srt",
    });

    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-candidate-one",
      first,
    )).rejects.toMatchObject({ code: "task_not_active" });
    expect(registry.commitGeneratedTaskCandidate(
      OWNER_A,
      "subtitle-task-candidate-one",
      "binding-candidate-one",
    )).toBe(true);
    expect(registry.releaseGeneratedTaskCandidate(
      OWNER_A,
      "subtitle-task-candidate-two",
      "binding-candidate-two",
    )).toBe(true);
    expect(registry.isGeneratedTask("subtitle-task-candidate-two")).toBe(false);
    expect(registry.releaseImportLease(OWNER_A, lease.directoryLeaseToken))
      .toBe(true);
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-candidate-one",
      first,
    )).resolves.toMatchObject({ targetDirectoryPath: output });
    expect(registry.releaseGeneratedTask(
      OWNER_A,
      "subtitle-task-candidate-one",
    )).toBe(true);
    expect(registry.isGeneratedTask("subtitle-task-candidate-one")).toBe(false);
  });

  it("enforces owner isolation, exact expiry, and owner release", async () => {
    const output = await outputDirectory("owner-output");
    const reauthorizedOutput = await outputDirectory("reauthorized-output");
    let now = 1_000;
    const registry = new SubtitleTranslationDirectoryCapabilityRegistry({
      draftTtlMs: 100,
      targetTtlMs: 200,
      now: () => now,
      tokenFactory: sequence("draft", "target", "reauthorized"),
    });
    const draft = await registry.authorizeDraft(OWNER_A, output);
    await expect(registry.registerGeneratedTask({
      owner: OWNER_B,
      taskId: "subtitle-task-cross-owner",
      sourceDisplayName: "owner.srt",
      outputFileName: "owner.srt",
      directoryToken: draft.directoryToken,
    })).rejects.toMatchObject({ code: "invalid_ipc_request" });

    now = 1_099;
    const reference = await registry.registerGeneratedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-owned",
      sourceDisplayName: "owner.srt",
      outputFileName: "owner.srt",
      directoryToken: draft.directoryToken,
    });
    now = 1_298;
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-owned",
      reference,
    )).resolves.toMatchObject({ kind: "generated_task_v1" });
    now = 1_299;
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-owned",
      reference,
    )).rejects.toMatchObject({ code: "authorization_expired" });
    await expect(registry.rotateTaskTarget(
      OWNER_A,
      "subtitle-task-owned",
      reauthorizedOutput,
    )).resolves.toMatchObject({
      cancelled: false,
      target: { token: "subtitle-translation-target-reauthorized" },
    });

    registry.releaseOwner(OWNER_A);
    await expect(registry.authorizeDraft(OWNER_A, output)).rejects.toMatchObject({
      code: "owner_released",
    });
  });

  it("detects replacement and symlinked directories", async () => {
    const root = await tempRoot();
    const output = path.join(root, "replaceable");
    const moved = path.join(root, "original");
    await mkdir(output);
    const registry = registryWithTokens("draft", "target");
    const draft = await registry.authorizeDraft(OWNER_A, output);
    const reference = await registry.registerGeneratedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-replaced",
      sourceDisplayName: "changed.srt",
      outputFileName: "changed.srt",
      directoryToken: draft.directoryToken,
    });
    await rename(output, moved);
    await mkdir(output);
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-replaced",
      reference,
    )).rejects.toMatchObject({ code: "output_write_failed" });

    const linked = path.join(root, "linked");
    await symlink(
      output,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(registry.authorizeDraft(OWNER_A, linked)).rejects.toMatchObject({
      code: "output_write_failed",
    });
  });

  it("rotates one active task atomically and revokes the old handle", async () => {
    const first = await outputDirectory("first");
    const second = await outputDirectory("second");
    const missing = path.join(await tempRoot(), "missing");
    const registry = registryWithTokens("draft", "old", "new");
    const draft = await registry.authorizeDraft(OWNER_A, first);
    const oldReference = await registry.registerGeneratedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-rotate",
      sourceDisplayName: "rotate.srt",
      outputFileName: "rotate.srt",
      directoryToken: draft.directoryToken,
    });

    await expect(registry.rotateTaskTarget(
      OWNER_A,
      "subtitle-task-rotate",
      missing,
    )).rejects.toMatchObject({ code: "output_write_failed" });
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-rotate",
      oldReference,
    )).resolves.toMatchObject({ targetDirectoryPath: first });

    const rotated = await registry.rotateTaskTarget(
      OWNER_A,
      "subtitle-task-rotate",
      second,
    );
    expect(rotated.target.token).toBe("subtitle-translation-target-new");
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-rotate",
      oldReference,
    )).rejects.toMatchObject({ code: "task_reference_conflict" });
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-rotate",
      {
        ...oldReference,
        target: rotated.target,
      },
    )).resolves.toMatchObject({ targetDirectoryPath: second });
    await expect(registry.rotateTaskTarget(
      OWNER_B,
      "subtitle-task-rotate",
      first,
    )).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("rejects a symlink at the final generated output leaf", async () => {
    if (process.platform === "win32") return;
    const output = await outputDirectory("leaf-output");
    const outsideRoot = await tempRoot();
    const outside = path.join(outsideRoot, "outside.srt");
    await writeFile(outside, "outside");
    const registry = registryWithTokens("draft", "target");
    const draft = await registry.authorizeDraft(OWNER_A, output);
    await registry.registerGeneratedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-symlink-leaf",
      sourceDisplayName: "linked.srt",
      outputFileName: "linked.srt",
      directoryToken: draft.directoryToken,
    });
    const linked = path.join(output, "linked.srt");
    await symlink(outside, linked, "file");

    await expect(registry.validateTaskOutputPath(
      OWNER_A,
      "subtitle-task-symlink-leaf",
      linked,
    )).rejects.toMatchObject({ code: "output_write_failed" });
  });

  it("rejects unsafe leaves and keeps generated ids out of legacy fallback", async () => {
    const output = await outputDirectory("safe");
    for (const outputFileName of [
      "../escape.srt",
      "nested/file.srt",
      "NUL.srt",
      "trailing. ",
      `x${"y".repeat(255)}.srt`,
      "control\u0000.srt",
    ]) {
      const registry = registryWithTokens("draft", "target");
      const draft = await registry.authorizeDraft(OWNER_A, output);
      await expect(registry.registerGeneratedTask({
        owner: OWNER_A,
        taskId: "subtitle-task-unsafe",
        sourceDisplayName: "safe.srt",
        outputFileName,
        directoryToken: draft.directoryToken,
      })).rejects.toMatchObject({ code: "invalid_content" });
    }

    const registry = registryWithTokens("draft", "target");
    const draft = await registry.authorizeDraft(OWNER_A, output);
    const reference = await registry.registerGeneratedTask({
      owner: OWNER_A,
      taskId: "subtitle-task-terminal",
      sourceDisplayName: "terminal.srt",
      outputFileName: "terminal.srt",
      directoryToken: draft.directoryToken,
    });
    expect(registry.markTaskTerminal("subtitle-task-terminal")).toBe(true);
    await expect(registry.resolveTaskReference(
      OWNER_A,
      "subtitle-task-terminal",
      reference,
    )).rejects.toMatchObject({ code: "task_not_active" });
    expect(() => registry.resolveLegacyTaskReference(
      "subtitle-task-terminal",
      createLegacySubtitleTranslationTaskReference({
        originFileURL: path.join(output, "terminal.srt"),
        targetFileURL: output,
      }),
    )).toThrowError(expect.objectContaining({ code: "task_reference_conflict" }));
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-translation-cap-"));
  tempRoots.push(root);
  return root;
}

async function outputDirectory(name: string): Promise<string> {
  const root = await tempRoot();
  const output = path.join(root, name);
  await mkdir(output);
  return realpath(output);
}

function registryWithTokens(...tokens: string[]) {
  return new SubtitleTranslationDirectoryCapabilityRegistry({
    tokenFactory: sequence(...tokens),
  });
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `token-${index}`;
}
