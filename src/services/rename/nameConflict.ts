import type {
  NameCollisionPolicy,
  NameTranslationOptions,
  NameTranslationPlanItem,
} from "./nameTypes";
import {
  joinPath,
  normalizePathKey,
  pathExtension,
  pathStem,
  samePath,
} from "./namePath";

export interface PlanValidationContext {
  existingTargetPaths?: Iterable<string>;
  maxPathLength?: number;
}

const DEFAULT_MAX_PATH_LENGTH = 1024;

export function validatePlanItems(
  items: NameTranslationPlanItem[],
  options: NameTranslationOptions,
  context: PlanValidationContext = {}
): NameTranslationPlanItem[] {
  const existingTargetKeys = new Set(
    [...(context.existingTargetPaths ?? [])].map(normalizePathKey)
  );
  const sourceKeys = new Set(items.map((item) => normalizePathKey(item.sourcePath)));
  const maxPathLength = context.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;
  const preparedItems =
    options.collisionPolicy === "append_index"
      ? applyStableIndexes(items, options.collisionPolicy, existingTargetKeys, sourceKeys)
      : cloneItems(items);

  const targetGroups = groupByTarget(preparedItems);

  return preparedItems.map((item) => {
    const next: NameTranslationPlanItem = {
      ...item,
      warnings: [...item.warnings],
    };

    if (
      next.status === "blocked" ||
      next.status === "skipped" ||
      next.status === "applied" ||
      next.status === "failed" ||
      next.status === "rolled_back"
    ) {
      return next;
    }

    if (!next.newName.trim()) {
      return blockItem(next, "invalid_name");
    }

    if (next.targetPath.length > maxPathLength) {
      return blockItem(next, "path_too_long");
    }

    if (samePath(next.sourcePath, next.targetPath)) {
      return {
        ...next,
        status:
          next.sourcePath === next.targetPath && next.originalName === next.newName
            ? "unchanged"
            : "ready",
        warnings:
          next.sourcePath !== next.targetPath || next.originalName !== next.newName
            ? addWarning(next.warnings, "case_only")
            : next.warnings,
      };
    }

    const targetKey = normalizePathKey(next.targetPath);
    const duplicateCount = targetGroups.get(targetKey)?.length ?? 0;
    if (duplicateCount > 1) {
      return blockItem(next, "duplicate_target");
    }

    if (existingTargetKeys.has(targetKey) && !sourceKeys.has(targetKey)) {
      return blockItem(next, "target_exists");
    }

    if (isSwapItem(next, preparedItems)) {
      return {
        ...next,
        status: "ready",
        warnings: addWarning(next.warnings, "swap"),
      };
    }

    return {
      ...next,
      status: "ready",
    };
  });
}

function applyStableIndexes(
  items: NameTranslationPlanItem[],
  _policy: NameCollisionPolicy,
  existingTargetKeys: Set<string>,
  sourceKeys: Set<string>
): NameTranslationPlanItem[] {
  const sorted = cloneItems(items).sort((a, b) =>
    a.sourcePath.localeCompare(b.sourcePath)
  );
  const reservedKeys = new Set(
    [...existingTargetKeys].filter((targetKey) => !sourceKeys.has(targetKey))
  );
  const byId = new Map<string, NameTranslationPlanItem>();

  for (const item of sorted) {
    if (item.status === "blocked" || item.status === "skipped") {
      byId.set(item.id, item);
      continue;
    }

    let candidate = item;
    let candidateKey = normalizePathKey(candidate.targetPath);

    if (reservedKeys.has(candidateKey)) {
      candidate = createIndexedCandidate(item, reservedKeys);
      candidateKey = normalizePathKey(candidate.targetPath);
    }

    reservedKeys.add(candidateKey);
    byId.set(item.id, candidate);
  }

  return items.map((item) => byId.get(item.id) ?? item);
}

function createIndexedCandidate(
  item: NameTranslationPlanItem,
  reservedKeys: Set<string>
): NameTranslationPlanItem {
  const extension = pathExtension(item.newName);
  const stem = extension ? pathStem(item.newName) : item.newName;

  for (let index = 1; index < 10000; index++) {
    const newName = `${stem}${getIndexSuffix(item, index)}${extension}`;
    const targetPath = joinPath(item.sourceParentPath, newName);
    if (!reservedKeys.has(normalizePathKey(targetPath))) {
      return {
        ...item,
        newName,
        targetPath,
        warnings: addWarning(item.warnings, "auto_index_added"),
      };
    }
  }

  return blockItem(item, "duplicate_target");
}

function getIndexSuffix(
  item: NameTranslationPlanItem,
  index: number
): string {
  if (item.newName.includes("_")) return `_${index}`;
  if (item.newName.includes("-")) return `-${index}`;
  return ` (${index})`;
}

function groupByTarget(
  items: NameTranslationPlanItem[]
): Map<string, NameTranslationPlanItem[]> {
  const groups = new Map<string, NameTranslationPlanItem[]>();
  for (const item of items) {
    const key = normalizePathKey(item.targetPath);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function isSwapItem(
  item: NameTranslationPlanItem,
  items: NameTranslationPlanItem[]
): boolean {
  return items.some(
    (other) =>
      other.id !== item.id &&
      samePath(item.targetPath, other.sourcePath) &&
      samePath(other.targetPath, item.sourcePath)
  );
}

function cloneItems(items: NameTranslationPlanItem[]): NameTranslationPlanItem[] {
  return items.map((item) => ({ ...item, warnings: [...item.warnings] }));
}

function blockItem(
  item: NameTranslationPlanItem,
  reason: string
): NameTranslationPlanItem {
  return {
    ...item,
    status: "blocked",
    reason,
    warnings: addWarning(item.warnings, reason),
  };
}

function addWarning(warnings: string[], warning: string): string[] {
  return warnings.includes(warning) ? warnings : [...warnings, warning];
}
