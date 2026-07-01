import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySemanticMemoryPatch,
  parseSemanticMemoryPatch,
} from "../../../electron/main/text-translation/memory/memory-patch";
import {
  analyzeSemanticMemoryCompression,
  createSemanticMemorySnapshotId,
  SemanticMemoryManager,
} from "../../../electron/main/text-translation/memory/semantic-memory-manager";
import type { SemanticMemory } from "../../../electron/main/text-translation/memory/semantic-memory";
import { TextTranslationWorkspaceRepository } from "../../../electron/main/text-translation/persistence/workspace-repository";

describe("semantic memory patch merge and compression", () => {
  let tempRoot: string;
  let repository: TextTranslationWorkspaceRepository;
  let manager: SemanticMemoryManager;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-memory-patch-"));
    repository = new TextTranslationWorkspaceRepository({ tasksRoot: tempRoot });
    manager = new SemanticMemoryManager(repository);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects unrestricted patch fields before they can update latest", async () => {
    const taskId = "task_001";
    const initial = await manager.initialize(taskId, {
      glossary: [{ source: "Azure Hall", target: "青岚殿" }],
    });

    const result = await manager.applyPatch(taskId, {
      schemaVersion: 999,
      terminologyUpserts: [
        {
          source: "Azure Hall",
          target: "苍蓝厅",
          origin: "model",
        },
      ],
    });

    expect(result.updated).toBe(false);
    expect(result.warnings).toMatchObject([
      { code: "invalid_memory_patch" },
    ]);
    await expect(manager.loadLatest(taskId)).resolves.toEqual(initial);
  });

  it("merges allowed patch operations without overwriting user terminology", () => {
    const memory = createMemory();
    const patch = parseSemanticMemoryPatch({
      currentSceneSummary: "The envoy enters Azure Hall.",
      characterUpserts: [
        {
          sourceName: "Li An",
          translatedName: "李安",
          aliases: ["Envoy", "Envoy"],
          description: "Envoy from the northern court.",
        },
      ],
      terminologyUpserts: [
        {
          source: "Azure Hall",
          target: "苍蓝厅",
          note: "Conflicts with user glossary.",
        },
        {
          source: "Northern Court",
          target: "北廷",
        },
      ],
      styleRulesToAdd: ["Use concise literary Chinese."],
      unresolvedContextToAdd: ["The sealed letter is unopened."],
      unresolvedContextToResolve: ["The old route is unknown."],
      recentContinuityNotesToAdd: ["The chancellor noticed the seal."],
    });

    expect(patch.success).toBe(true);
    const merged = applySemanticMemoryPatch(memory, patch.patch!);

    expect(merged.warnings).toMatchObject([
      {
        code: "user_terminology_conflict",
        source: "Azure Hall",
      },
    ]);
    expect(merged.memory.terminology).toEqual([
      {
        source: "Azure Hall",
        target: "青岚殿",
        origin: "user",
      },
      {
        source: "Northern Court",
        target: "北廷",
        origin: "model",
      },
    ]);
    expect(merged.memory.characters[0]).toMatchObject({
      sourceName: "Li An",
      translatedName: "李安",
      aliases: ["Envoy"],
    });
    expect(merged.memory.unresolvedContext).toEqual([
      "The sealed letter is unopened.",
    ]);
    expect(merged.memory.currentSceneSummary).toBe(
      "The envoy enters Azure Hall.",
    );
  });

  it("writes a pre-compression snapshot and commits compressed memory", async () => {
    const taskId = "task_001";
    await manager.initialize(taskId);

    const result = await manager.applyPatch(
      taskId,
      {
        documentSummary: "D".repeat(2_000),
        recentContinuityNotesToAdd: ["note 1", "note 2", "note 3"],
      },
      {
        updatedAfterSegmentId: "seg_1",
        budget: 600,
        countTokens: countCharacters,
        compressor: async (memory) => ({
          ...memory,
          documentSummary: "Compressed summary.",
          recentContinuityNotes: ["note 3"],
        }),
      },
    );

    expect(result).toMatchObject({
      updated: true,
      compressionStatus: "compressed",
      preCompressionSnapshotId: "pre_compression_seg_1_v000000",
    });
    expect(result.memory).toMatchObject({
      version: 1,
      updatedAfterSegmentId: "seg_1",
      documentSummary: "Compressed summary.",
      recentContinuityNotes: ["note 3"],
    });

    await expect(
      repository.readMemorySnapshot<SemanticMemory>(
        taskId,
        result.preCompressionSnapshotId!,
      ),
    ).resolves.toMatchObject({
      version: 0,
      documentSummary: "D".repeat(2_000),
    });
  });

  it("keeps latest stable when compression fails and returns a shortened fallback", async () => {
    const taskId = "task_001";
    const initial = await manager.initialize(taskId);

    const result = await manager.applyPatch(
      taskId,
      {
        documentSummary: "D".repeat(2_000),
        recentContinuityNotesToAdd: ["note 1", "note 2", "note 3", "note 4"],
      },
      {
        updatedAfterSegmentId: "seg_2",
        budget: 600,
        countTokens: countCharacters,
        compressor: async () => {
          throw new Error("compressor unavailable");
        },
      },
    );

    expect(result).toMatchObject({
      updated: false,
      compressionStatus: "failed",
      preCompressionSnapshotId: "pre_compression_seg_2_v000000",
    });
    expect(result.warnings).toMatchObject([
      {
        code: "compression_failed",
        message: "compressor unavailable",
      },
    ]);
    expect(result.fallbackMemory?.recentContinuityNotes).toEqual([
      "note 3",
      "note 4",
    ]);
    await expect(manager.loadLatest(taskId)).resolves.toEqual(initial);
    await expect(
      repository.readMemorySnapshot<SemanticMemory>(
        taskId,
        result.preCompressionSnapshotId!,
      ),
    ).resolves.toMatchObject({
      documentSummary: "D".repeat(2_000),
    });
  });

  it("uses the 90 percent threshold by default", () => {
    const memory = createMemory({ documentSummary: "D".repeat(900) });
    const plan = analyzeSemanticMemoryCompression(memory, {
      budget: 1_000,
      countTokens: countCharacters,
    });

    expect(plan.thresholdTokens).toBe(900);
    expect(plan.needed).toBe(true);
    expect(
      createSemanticMemorySnapshotId({
        kind: "pre_compression",
        version: 0,
      }),
    ).toBe("pre_compression_v000000");
  });
});

function createMemory(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  return {
    schemaVersion: 1,
    version: 0,
    documentSummary: "A court intrigue.",
    currentChapterSummary: "",
    currentSceneSummary: "",
    characters: [],
    terminology: [
      {
        source: "Azure Hall",
        target: "青岚殿",
        origin: "user",
      },
    ],
    styleRules: [],
    unresolvedContext: ["The old route is unknown."],
    recentContinuityNotes: [],
    ...overrides,
  };
}

function countCharacters(text: string): number {
  return text.length;
}
