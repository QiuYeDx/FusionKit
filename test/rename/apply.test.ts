import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRenamePlan,
  RenamePlanValidationError,
  rollbackRenameJournal,
} from "../../electron/main/rename/apply";
import { readRenameJournal } from "../../electron/main/rename/journal";
import type {
  ApplyRenamePlanParams,
  NameTranslationPlan,
  NameTranslationPlanItem,
} from "../../electron/main/rename/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("applyRenamePlan", () => {
  it("renames a file through a journal and rolls it back", async () => {
    const { root, journalDir } = await createWorkspace();
    const sourcePath = path.join(root, "第01話.srt");
    const targetPath = path.join(root, "Episode 01.srt");
    await fs.writeFile(sourcePath, "subtitle");

    const result = await applyRenamePlan(
      createParams(root, [createItem("item_1", "file", sourcePath, targetPath)]),
      { journalDir }
    );

    expect(result).toMatchObject({
      successCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("subtitle");
    await expect(fs.lstat(sourcePath)).rejects.toThrow();

    const rollback = await rollbackRenameJournal(
      { journalId: result.journalId },
      { journalDir }
    );

    expect(rollback).toMatchObject({ successCount: 1, failedCount: 0 });
    await expect(fs.readFile(sourcePath, "utf-8")).resolves.toBe("subtitle");
    await expect(fs.lstat(targetPath)).rejects.toThrow();
  });

  it("supports A/B swaps", async () => {
    const { root, journalDir } = await createWorkspace();
    const aPath = path.join(root, "A.srt");
    const bPath = path.join(root, "B.srt");
    await fs.writeFile(aPath, "A");
    await fs.writeFile(bPath, "B");

    const result = await applyRenamePlan(
      createParams(root, [
        createItem("item_a", "file", aPath, bPath),
        createItem("item_b", "file", bPath, aPath),
      ]),
      { journalDir }
    );

    expect(result.failedCount).toBe(0);
    await expect(fs.readFile(aPath, "utf-8")).resolves.toBe("B");
    await expect(fs.readFile(bPath, "utf-8")).resolves.toBe("A");
  });

  it("renames a directory through the journal", async () => {
    const { root, journalDir } = await createWorkspace();
    const sourcePath = path.join(root, "第一季");
    const targetPath = path.join(root, "Season One");
    await fs.mkdir(sourcePath);
    await fs.writeFile(path.join(sourcePath, "第01話.srt"), "episode");

    const result = await applyRenamePlan(
      createParams(root, [
        createItem("item_dir_only", "directory", sourcePath, targetPath),
      ]),
      { journalDir }
    );

    expect(result).toMatchObject({
      successCount: 1,
      failedCount: 0,
    });
    await expect(
      fs.readFile(path.join(targetPath, "第01話.srt"), "utf-8")
    ).resolves.toBe("episode");
    await expect(fs.lstat(sourcePath)).rejects.toThrow();

    const rollback = await rollbackRenameJournal(
      { journalId: result.journalId },
      { journalDir }
    );

    expect(rollback.failedCount).toBe(0);
    await expect(
      fs.readFile(path.join(sourcePath, "第01話.srt"), "utf-8")
    ).resolves.toBe("episode");
    await expect(fs.lstat(targetPath)).rejects.toThrow();
  });

  it("supports case-only renames through the temp phase", async () => {
    const { root, journalDir } = await createWorkspace();
    const sourcePath = path.join(root, "Episode.srt");
    const targetPath = path.join(root, "episode.srt");
    await fs.writeFile(sourcePath, "case");

    const result = await applyRenamePlan(
      createParams(root, [createItem("item_case", "file", sourcePath, targetPath)]),
      { journalDir }
    );

    const names = await fs.readdir(root);

    expect(result.failedCount).toBe(0);
    expect(names).toContain("episode.srt");
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("case");
  });

  it("rewrites descendant paths when a directory and child file are renamed together", async () => {
    const { root, journalDir } = await createWorkspace();
    const sourceDir = path.join(root, "Season 01");
    const targetDir = path.join(root, "Season One");
    const sourceFile = path.join(sourceDir, "第02話.srt");
    const plannedFileTarget = path.join(sourceDir, "Episode 02.srt");
    const finalFileTarget = path.join(targetDir, "Episode 02.srt");

    await fs.mkdir(sourceDir);
    await fs.writeFile(sourceFile, "episode");

    const result = await applyRenamePlan(
      createParams(root, [
        createItem("item_dir", "directory", sourceDir, targetDir),
        createItem("item_file", "file", sourceFile, plannedFileTarget),
      ]),
      { journalDir }
    );

    expect(result.failedCount).toBe(0);
    await expect(fs.readFile(finalFileTarget, "utf-8")).resolves.toBe("episode");
    await expect(fs.lstat(sourceDir)).rejects.toThrow();

    const rollback = await rollbackRenameJournal(
      { journalId: result.journalId },
      { journalDir }
    );

    expect(rollback.failedCount).toBe(0);
    await expect(fs.readFile(sourceFile, "utf-8")).resolves.toBe("episode");
    await expect(fs.lstat(targetDir)).rejects.toThrow();
  });

  it("rejects validation failures before renaming anything", async () => {
    const { root, journalDir } = await createWorkspace();
    const sourcePath = path.join(root, "A.srt");
    const existingTargetPath = path.join(root, "B.srt");
    await fs.writeFile(sourcePath, "A");
    await fs.writeFile(existingTargetPath, "B");

    await expect(
      applyRenamePlan(
        createParams(root, [
          createItem("item_a", "file", sourcePath, existingTargetPath),
        ]),
        { journalDir }
      )
    ).rejects.toBeInstanceOf(RenamePlanValidationError);

    await expect(fs.readFile(sourcePath, "utf-8")).resolves.toBe("A");
    await expect(fs.readFile(existingTargetPath, "utf-8")).resolves.toBe("B");
  });

  it("keeps a readable failed journal when a rename operation fails mid-apply", async () => {
    const { root, journalDir } = await createWorkspace();
    const firstSource = path.join(root, "A.srt");
    const secondSource = path.join(root, "B.srt");
    await fs.writeFile(firstSource, "A");
    await fs.writeFile(secondSource, "B");

    let renameCalls = 0;
    const result = await applyRenamePlan(
      createParams(root, [
        createItem("item_a", "file", firstSource, path.join(root, "AA.srt")),
        createItem("item_b", "file", secondSource, path.join(root, "BB.srt")),
      ]),
      {
        journalDir,
        rename: async (from, to) => {
          renameCalls++;
          if (renameCalls === 2) throw new Error("simulated failure");
          await fs.rename(from, to);
        },
      }
    );

    expect(result.failedCount).toBe(1);
    const journal = await readRenameJournal(result.journalId, { journalDir });
    expect(journal?.status).toBe("failed");
    expect(journal?.operations.some((op) => op.status === "temp_done")).toBe(
      true
    );
    expect(journal?.operations.some((op) => op.status === "failed")).toBe(true);
  });
});

async function createWorkspace(): Promise<{ root: string; journalDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fusionkit-apply-"));
  const journalDir = path.join(root, "journals");
  tempRoots.push(root);
  return { root, journalDir };
}

function createParams(
  root: string,
  items: NameTranslationPlanItem[]
): ApplyRenamePlanParams {
  const plan = createPlan(root, items);
  return { plan, items };
}

function createPlan(
  root: string,
  items: NameTranslationPlanItem[]
): NameTranslationPlan {
  return {
    planId: `rename_plan_${path.basename(root)}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    options: {
      roots: [root],
      scope: "children",
      targetKind: "both",
      recursive: false,
      maxDepth: 1,
      includeHidden: false,
      includeRoot: true,
      sourceLang: "auto",
      targetLang: "ZH",
      namingStyle: "preserve",
      preserveExtension: true,
      preserveLeadingDot: true,
      preserveTechnicalTokens: true,
      collisionPolicy: "fail",
    },
    roots: [root],
    totalTargets: items.length,
    previewLimit: 30,
    itemsPreview: items,
    itemsStored: false,
    readyCount: items.filter((item) => item.status === "ready").length,
    blockedCount: items.filter((item) => item.status === "blocked").length,
    skippedCount: 0,
    unchangedCount: 0,
    warnings: [],
    applyable: true,
  };
}

function createItem(
  id: string,
  kind: "file" | "directory",
  sourcePath: string,
  targetPath: string
): NameTranslationPlanItem {
  return {
    id,
    targetId: `target_${id}`,
    kind,
    sourcePath,
    sourceParentPath: path.dirname(sourcePath),
    originalName: path.basename(sourcePath),
    translatedStem: path.parse(targetPath).name,
    newName: path.basename(targetPath),
    targetPath,
    status: "ready",
    warnings: [],
  };
}
