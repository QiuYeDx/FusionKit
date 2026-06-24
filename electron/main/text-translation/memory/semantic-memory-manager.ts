import { TextTranslationWorkspaceRepository } from "../persistence/workspace-repository";
import {
  estimateSemanticMemoryTokens,
  type CountSemanticMemoryTokens,
} from "./memory-budget";
import {
  applySemanticMemoryPatch,
  createCompressionFailureFallbackMemory,
  parseSemanticMemoryPatch,
  type SemanticMemoryPatch,
  type SemanticMemoryWarning,
} from "./memory-patch";
import {
  cloneSemanticMemory,
  createInitialSemanticMemory,
  normalizeSemanticMemory,
  type CreateSemanticMemoryOptions,
  type SemanticMemory,
} from "./semantic-memory";

export type SemanticMemorySnapshotKind =
  | "periodic"
  | "file_end"
  | "pre_compression";

export interface CommitSemanticMemoryOptions {
  updatedAfterSegmentId?: string;
  snapshot?: {
    kind: SemanticMemorySnapshotKind;
    segmentId?: string;
  };
}

export type SemanticMemoryCompressor = (
  memory: SemanticMemory,
) => Promise<SemanticMemory>;

export interface ApplySemanticMemoryPatchOptions {
  updatedAfterSegmentId?: string;
  budget?: number;
  compressionThresholdRatio?: number;
  countTokens?: CountSemanticMemoryTokens;
  compressor?: SemanticMemoryCompressor;
  snapshot?: {
    kind: SemanticMemorySnapshotKind;
    segmentId?: string;
  };
}

export interface ApplySemanticMemoryPatchAndCommitResult {
  memory: SemanticMemory;
  updated: boolean;
  warnings: SemanticMemoryWarning[];
  compressionStatus?: "not_needed" | "compressed" | "failed";
  preCompressionSnapshotId?: string;
  fallbackMemory?: SemanticMemory;
}

export interface SemanticMemoryCompressionPlan {
  needed: boolean;
  estimatedTokens: number;
  thresholdTokens: number;
  budget: number;
}

export class SemanticMemoryManager {
  constructor(
    private readonly repository = new TextTranslationWorkspaceRepository(),
  ) {}

  async initialize(
    taskId: string,
    options: CreateSemanticMemoryOptions = {},
  ): Promise<SemanticMemory> {
    const memory = createInitialSemanticMemory(options);
    await this.repository.writeMemoryLatest(taskId, memory);
    return memory;
  }

  async loadLatest(taskId: string): Promise<SemanticMemory | null> {
    return this.repository.readMemoryLatest<SemanticMemory>(taskId);
  }

  async commit(
    taskId: string,
    nextMemory: SemanticMemory,
    options: CommitSemanticMemoryOptions = {},
  ): Promise<SemanticMemory> {
    const latest = await this.loadLatest(taskId);
    const latestVersion = Number.isFinite(latest?.version)
      ? Math.max(0, Math.trunc(latest!.version))
      : -1;
    const committed = normalizeSemanticMemory({
      ...nextMemory,
      version: latestVersion + 1,
      updatedAfterSegmentId: options.updatedAfterSegmentId,
    });

    await this.repository.writeMemoryLatest(taskId, committed);
    if (options.snapshot) {
      await this.repository.writeMemorySnapshot(
        taskId,
        createSemanticMemorySnapshotId({
          kind: options.snapshot.kind,
          segmentId: options.snapshot.segmentId,
          version: committed.version,
        }),
        committed,
      );
    }

    return committed;
  }

  async applyPatch(
    taskId: string,
    patchInput: string | SemanticMemoryPatch | unknown,
    options: ApplySemanticMemoryPatchOptions = {},
  ): Promise<ApplySemanticMemoryPatchAndCommitResult> {
    const latest = await this.loadLatest(taskId);
    if (!latest) {
      throw new Error(`Semantic memory latest does not exist for task ${taskId}.`);
    }

    const parsed = parseSemanticMemoryPatch(patchInput);
    if (!parsed.success || !parsed.patch) {
      return {
        memory: latest,
        updated: false,
        warnings: parsed.warning ? [parsed.warning] : [],
      };
    }

    const applied = applySemanticMemoryPatch(latest, parsed.patch);
    const compression = await this.prepareCompressionIfNeeded(taskId, applied.memory, {
      budget: options.budget,
      compressionThresholdRatio: options.compressionThresholdRatio,
      countTokens: options.countTokens,
      compressor: options.compressor,
      updatedAfterSegmentId: options.updatedAfterSegmentId,
    });

    if (compression.status === "failed") {
      return {
        memory: latest,
        updated: false,
        warnings: [...applied.warnings, compression.warning],
        compressionStatus: "failed",
        preCompressionSnapshotId: compression.snapshotId,
        fallbackMemory: compression.fallbackMemory,
      };
    }

    const committed = await this.commit(taskId, compression.memory, {
      updatedAfterSegmentId: options.updatedAfterSegmentId,
      snapshot: options.snapshot,
    });

    return {
      memory: committed,
      updated: true,
      warnings: applied.warnings,
      compressionStatus: compression.status,
      preCompressionSnapshotId: compression.snapshotId,
    };
  }

  private async prepareCompressionIfNeeded(
    taskId: string,
    memory: SemanticMemory,
    options: {
      budget?: number;
      compressionThresholdRatio?: number;
      countTokens?: CountSemanticMemoryTokens;
      compressor?: SemanticMemoryCompressor;
      updatedAfterSegmentId?: string;
    },
  ): Promise<
    | {
        status: "not_needed";
        memory: SemanticMemory;
        snapshotId?: undefined;
      }
    | {
        status: "compressed";
        memory: SemanticMemory;
        snapshotId: string;
      }
    | {
        status: "failed";
        memory: SemanticMemory;
        snapshotId: string;
        fallbackMemory: SemanticMemory;
        warning: SemanticMemoryWarning;
      }
  > {
    const plan = analyzeSemanticMemoryCompression(memory, {
      budget: options.budget,
      thresholdRatio: options.compressionThresholdRatio,
      countTokens: options.countTokens,
    });
    if (!plan.needed) {
      return {
        status: "not_needed",
        memory,
      };
    }

    const snapshotId = createSemanticMemorySnapshotId({
      kind: "pre_compression",
      segmentId: options.updatedAfterSegmentId,
      version: memory.version,
    });
    await this.repository.writeMemorySnapshot(taskId, snapshotId, memory);

    if (!options.compressor) {
      return {
        status: "failed",
        memory,
        snapshotId,
        fallbackMemory: createCompressionFailureFallbackMemory(memory),
        warning: {
          code: "compression_failed",
          message: "Semantic memory exceeded the compression threshold, but no compressor was configured.",
        },
      };
    }

    try {
      const compressed = normalizeSemanticMemory({
        ...(await options.compressor(cloneSemanticMemory(memory))),
        version: memory.version,
        updatedAfterSegmentId: memory.updatedAfterSegmentId,
      });
      return {
        status: "compressed",
        memory: compressed,
        snapshotId,
      };
    } catch (error) {
      return {
        status: "failed",
        memory,
        snapshotId,
        fallbackMemory: createCompressionFailureFallbackMemory(memory),
        warning: {
          code: "compression_failed",
          message:
            error instanceof Error
              ? error.message
              : "Semantic memory compression failed.",
        },
      };
    }
  }
}

export function analyzeSemanticMemoryCompression(
  memory: SemanticMemory,
  options: {
    budget?: number;
    thresholdRatio?: number;
    countTokens?: CountSemanticMemoryTokens;
  },
): SemanticMemoryCompressionPlan {
  const budget = Math.max(0, Math.trunc(options.budget ?? 0));
  const thresholdRatio = options.thresholdRatio ?? 0.9;
  const thresholdTokens = Math.floor(budget * thresholdRatio);
  const estimatedTokens = estimateSemanticMemoryTokens(
    memory,
    options.countTokens,
  );

  return {
    needed: budget > 0 && estimatedTokens >= thresholdTokens,
    estimatedTokens,
    thresholdTokens,
    budget,
  };
}

export function createSemanticMemorySnapshotId(options: {
  kind: SemanticMemorySnapshotKind;
  version: number;
  segmentId?: string;
}): string {
  const segmentPart = options.segmentId
    ? `_${sanitizeSnapshotIdPart(options.segmentId)}`
    : "";
  return `${options.kind}${segmentPart}_v${String(options.version).padStart(6, "0")}`;
}

function sanitizeSnapshotIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72);
}
