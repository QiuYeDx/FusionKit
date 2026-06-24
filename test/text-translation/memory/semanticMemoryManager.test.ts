import { mkdtemp, readdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  estimateSemanticMemoryTokens,
  resolveSemanticMemoryBudget,
  trimSemanticMemoryToBudget,
} from "../../../electron/main/text-translation/memory/memory-budget";
import {
  createInitialSemanticMemory,
  type SemanticMemory,
} from "../../../electron/main/text-translation/memory/semantic-memory";
import {
  createSemanticMemorySnapshotId,
  SemanticMemoryManager,
} from "../../../electron/main/text-translation/memory/semantic-memory-manager";
import { TextTranslationWorkspaceRepository } from "../../../electron/main/text-translation/persistence/workspace-repository";

describe("semantic memory budget and persistence", () => {
  let tempRoot: string;
  let repository: TextTranslationWorkspaceRepository;
  let manager: SemanticMemoryManager;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-memory-"));
    repository = new TextTranslationWorkspaceRepository({ tasksRoot: tempRoot });
    manager = new SemanticMemoryManager(repository);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates initial memory from user context and resolves default effective budget", () => {
    const memory = createInitialSemanticMemory({
      documentBackground: "  A dynastic fantasy novel.  ",
      styleInstructions: "  Keep honorifics consistent.  ",
      glossary: [
        {
          source: "Azure Hall",
          target: "青岚殿",
          note: "Place name",
        },
      ],
    });

    expect(memory).toMatchObject({
      schemaVersion: 1,
      version: 0,
      documentSummary: "A dynastic fantasy novel.",
      styleRules: ["Keep honorifics consistent."],
      terminology: [
        {
          source: "Azure Hall",
          target: "青岚殿",
          note: "Place name",
          origin: "user",
        },
      ],
    });

    const budget = resolveSemanticMemoryBudget({
      modelContextTokenLimit: 32_768,
      systemAndInstructionsTokens: 2_048,
      glossaryTokens: 512,
      currentSegmentTokens: 3_000,
      recentWindowTokens: 1_024,
      outputTokenReserve: 6_000,
    });

    expect(budget).toMatchObject({
      configuredLimit: 8_192,
      effectiveBudget: 8_192,
      safetyMarginTokens: 1_639,
      fixedContextTokens: 14_223,
      availableForMemory: 18_545,
    });

    expect(
      resolveSemanticMemoryBudget({
        semanticMemoryTokenLimit: 8_192,
        modelContextTokenLimit: 16_000,
        currentSegmentTokens: 12_000,
        outputTokenReserve: 4_096,
      }).effectiveBudget,
    ).toBe(0);
  });

  it("preserves user terminology and explicit style rules when trimming over budget", () => {
    const memory = createRichMemory();

    const result = trimSemanticMemoryToBudget(memory, 1, countCharacters);

    expect(result.overBudget).toBe(true);
    expect(result.dropped.modelTerminology).toBe(2);
    expect(result.dropped.styleRules).toBe(0);
    expect(result.memory.terminology).toEqual([
      {
        source: "Azure Hall",
        target: "青岚殿",
        origin: "user",
      },
    ]);
    expect(result.memory.styleRules).toEqual(["Use concise literary Chinese."]);
  });

  it("drops model terminology before compressing stable summaries", () => {
    const memory = createRichMemory({
      documentSummary: "D".repeat(500),
      currentChapterSummary: "Chapter one remains unchanged.",
      currentSceneSummary: "Scene remains unchanged.",
    });
    const withoutModelTerminology: SemanticMemory = {
      ...memory,
      terminology: memory.terminology.filter((entry) => entry.origin === "user"),
    };
    const budget = estimateSemanticMemoryTokens(
      withoutModelTerminology,
      countCharacters,
    );

    const result = trimSemanticMemoryToBudget(
      memory,
      budget,
      countCharacters,
    );

    expect(result.overBudget).toBe(false);
    expect(result.dropped.modelTerminology).toBe(2);
    expect(result.memory.documentSummary).toBe(memory.documentSummary);
    expect(result.memory.currentChapterSummary).toBe(
      memory.currentChapterSummary,
    );
  });

  it("commits latest memory with monotonic versions and recoverable snapshots", async () => {
    const taskId = "task_001";
    const initial = await manager.initialize(taskId, {
      glossary: [{ source: "Azure Hall", target: "青岚殿" }],
    });

    expect(initial.version).toBe(0);
    expect(await manager.loadLatest(taskId)).toMatchObject({ version: 0 });

    const committed = await manager.commit(
      taskId,
      {
        ...initial,
        version: 99,
        currentSceneSummary: "The envoy enters Azure Hall.",
      },
      {
        updatedAfterSegmentId: "seg_1",
        snapshot: {
          kind: "periodic",
          segmentId: "seg_1",
        },
      },
    );

    expect(committed).toMatchObject({
      version: 1,
      updatedAfterSegmentId: "seg_1",
      currentSceneSummary: "The envoy enters Azure Hall.",
    });

    const snapshotId = createSemanticMemorySnapshotId({
      kind: "periodic",
      segmentId: "seg_1",
      version: 1,
    });
    expect(snapshotId).toBe("periodic_seg_1_v000001");
    await expect(
      repository.readMemorySnapshot<SemanticMemory>(taskId, snapshotId),
    ).resolves.toMatchObject({ version: 1, updatedAfterSegmentId: "seg_1" });

    const second = await manager.commit(taskId, {
      ...committed,
      version: 1,
      currentSceneSummary: "The envoy leaves Azure Hall.",
    });
    expect(second.version).toBe(2);
    await expect(manager.loadLatest(taskId)).resolves.toMatchObject({
      version: 2,
      currentSceneSummary: "The envoy leaves Azure Hall.",
    });

    const paths = repository.getPaths(taskId);
    expect(await readdir(paths.memoryDir)).toEqual(
      expect.arrayContaining(["latest.json", "snapshots"]),
    );
    expect(await readdir(paths.memorySnapshotsDir)).not.toContain(
      expect.stringContaining(".tmp-"),
    );
  });

  it("sanitizes snapshot ids for workspace-safe filenames", () => {
    expect(
      createSemanticMemorySnapshotId({
        kind: "file_end",
        segmentId: "chapter/01:seg 2",
        version: 12,
      }),
    ).toBe("file_end_chapter_01_seg_2_v000012");
  });
});

function createRichMemory(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  return {
    schemaVersion: 1,
    version: 3,
    updatedAfterSegmentId: "seg_3",
    documentSummary: "A long-running court intrigue.",
    currentChapterSummary: "The first chapter introduces the envoy.",
    currentSceneSummary: "The envoy meets the chancellor.",
    characters: [
      {
        sourceName: "Li An",
        translatedName: "李安",
        description: "Envoy from the northern court.",
      },
    ],
    terminology: [
      {
        source: "Azure Hall",
        target: "青岚殿",
        origin: "user",
      },
      {
        source: "Chancellor",
        target: "宰辅",
        origin: "model",
      },
      {
        source: "Northern Court",
        target: "北廷",
        origin: "model",
      },
    ],
    styleRules: ["Use concise literary Chinese."],
    unresolvedContext: ["The envoy's sealed letter is unopened."],
    recentContinuityNotes: ["The chancellor noticed the broken seal."],
    ...overrides,
  };
}

function countCharacters(text: string): number {
  return text.length;
}
