import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRenameJournal,
  finishRenameJournal,
  readRenameJournal,
  updateJournalOperation,
} from "../../electron/main/rename/journal";
import type { NameTranslationPlan } from "../../electron/main/rename/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("rename journal", () => {
  it("creates, updates, reads, and finishes a journal on disk", async () => {
    const journalDir = await createTempRoot();
    const plan = createPlan();

    const journal = await createRenameJournal(
      plan,
      [
        {
          itemId: "item_1",
          kind: "file",
          originalPath: "/tmp/a.srt",
          finalPath: "/tmp/b.srt",
        },
      ],
      { journalDir }
    );

    await updateJournalOperation(
      journal.journalId,
      "item_1",
      {
        tempPath: "/tmp/.fusionkit.tmp",
        status: "temp_done",
      },
      { journalDir }
    );
    await finishRenameJournal(journal.journalId, "completed", { journalDir });

    const stored = await readRenameJournal(journal.journalId, { journalDir });

    expect(stored).toMatchObject({
      journalId: journal.journalId,
      planId: plan.planId,
      status: "completed",
    });
    expect(stored?.operations[0]).toMatchObject({
      itemId: "item_1",
      tempPath: "/tmp/.fusionkit.tmp",
      status: "temp_done",
    });
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fusionkit-journal-"));
  tempRoots.push(root);
  return root;
}

function createPlan(): NameTranslationPlan {
  return {
    planId: "rename_plan_test",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    options: {
      roots: ["/tmp"],
      scope: "children",
      targetKind: "files",
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
    roots: ["/tmp"],
    totalTargets: 1,
    previewLimit: 30,
    itemsPreview: [],
    itemsStored: false,
    readyCount: 1,
    blockedCount: 0,
    skippedCount: 0,
    unchangedCount: 0,
    warnings: [],
    applyable: true,
  };
}
