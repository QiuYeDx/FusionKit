import { promises as fs } from "fs";
import path from "path";
import { isBlockedPath } from "./scanner";
import {
  isPathInside,
  isValidBasename,
  normalizePathKey,
  samePath,
} from "./path-utils";
import type {
  NameTranslationPlanItem,
  ValidateRenamePlanParams,
  ValidateRenamePlanResult,
} from "./types";

const MAX_PATH_LENGTH = 1024;

export async function validateRenamePlan(
  params: ValidateRenamePlanParams
): Promise<ValidateRenamePlanResult> {
  const errors: ValidateRenamePlanResult["errors"] = [];
  const warnings: string[] = [];
  const { plan, items } = params;

  if (!plan) {
    errors.push({ code: "missing_plan", message: "Rename plan is required." });
    return { valid: false, errors, warnings };
  }

  if (plan.expiresAt && plan.expiresAt <= Date.now()) {
    errors.push({
      code: "plan_expired",
      message: "Rename plan has expired. Please generate a new preview.",
    });
  }

  if (!plan.applyable) {
    errors.push({
      code: "plan_not_applyable",
      message: "Rename plan is not marked applyable.",
    });
  }

  if (plan.clarificationRequired) {
    errors.push({
      code: "clarification_required",
      message: plan.clarificationRequired.message,
    });
  }

  const readyItems = items.filter((item) => item.status === "ready");
  const blockedItems = items.filter((item) => item.status === "blocked");
  for (const item of blockedItems) {
    errors.push({
      itemId: item.id,
      code: item.reason ?? "blocked_item",
      message: `Plan item is blocked: ${item.sourcePath}`,
    });
  }

  if (readyItems.length === 0) {
    errors.push({
      code: "no_ready_items",
      message: "Rename plan does not contain ready items.",
    });
  }

  const targetKeys = new Map<string, NameTranslationPlanItem[]>();
  const sourceKeys = new Set(
    readyItems.map((item) => normalizePathKey(item.sourcePath))
  );

  for (const item of readyItems) {
    const targetKey = normalizePathKey(item.targetPath);
    targetKeys.set(targetKey, [...(targetKeys.get(targetKey) ?? []), item]);
  }

  for (const [targetKey, group] of targetKeys) {
    if (group.length > 1) {
      for (const item of group) {
        errors.push({
          itemId: item.id,
          code: "duplicate_target",
          message: `Multiple items target the same path: ${targetKey}`,
        });
      }
    }
  }

  await Promise.all(
    readyItems.map(async (item) => {
      const itemErrors = await validateReadyItem(item, sourceKeys);
      errors.push(...itemErrors);
    })
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

async function validateReadyItem(
  item: NameTranslationPlanItem,
  sourceKeys: Set<string>
): Promise<ValidateRenamePlanResult["errors"]> {
  const errors: ValidateRenamePlanResult["errors"] = [];

  if (!isValidBasename(item.newName)) {
    errors.push({
      itemId: item.id,
      code: "invalid_name",
      message: `Invalid target name: ${item.newName}`,
    });
  }

  if (item.targetPath.length > MAX_PATH_LENGTH) {
    errors.push({
      itemId: item.id,
      code: "path_too_long",
      message: `Target path is too long: ${item.targetPath}`,
    });
  }

  if (isBlockedPath(item.sourcePath) || isBlockedPath(item.targetPath)) {
    errors.push({
      itemId: item.id,
      code: "protected_path",
      message: `Protected path cannot be renamed: ${item.sourcePath}`,
    });
  }

  let sourceStat;
  try {
    sourceStat = await fs.lstat(item.sourcePath);
  } catch {
    errors.push({
      itemId: item.id,
      code: "source_missing",
      message: `Source path does not exist: ${item.sourcePath}`,
    });
    return errors;
  }

  if (sourceStat.isSymbolicLink()) {
    errors.push({
      itemId: item.id,
      code: "source_symlink",
      message: `Symbolic links are not rename targets: ${item.sourcePath}`,
    });
  }

  if (item.kind === "file" && !sourceStat.isFile()) {
    errors.push({
      itemId: item.id,
      code: "source_kind_changed",
      message: `Source is no longer a file: ${item.sourcePath}`,
    });
  }
  if (item.kind === "directory" && !sourceStat.isDirectory()) {
    errors.push({
      itemId: item.id,
      code: "source_kind_changed",
      message: `Source is no longer a directory: ${item.sourcePath}`,
    });
  }

  try {
    const parentStat = await fs.stat(path.dirname(item.targetPath));
    if (!parentStat.isDirectory()) {
      errors.push({
        itemId: item.id,
        code: "target_parent_not_directory",
        message: `Target parent is not a directory: ${path.dirname(item.targetPath)}`,
      });
    }
  } catch {
    errors.push({
      itemId: item.id,
      code: "target_parent_missing",
      message: `Target parent does not exist: ${path.dirname(item.targetPath)}`,
    });
  }

  if (!samePath(item.sourcePath, item.targetPath)) {
    try {
      await fs.lstat(item.targetPath);
      const targetKey = normalizePathKey(item.targetPath);
      if (!sourceKeys.has(targetKey) && !isPlannedDescendant(item, sourceKeys)) {
        errors.push({
          itemId: item.id,
          code: "target_exists",
          message: `Target path already exists: ${item.targetPath}`,
        });
      }
    } catch {
      // Missing target is expected.
    }
  }

  return errors;
}

function isPlannedDescendant(
  item: NameTranslationPlanItem,
  sourceKeys: Set<string>
): boolean {
  for (const sourceKey of sourceKeys) {
    if (sourceKey === normalizePathKey(item.sourcePath)) continue;
    if (isPathInside(item.targetPath, sourceKey)) return true;
  }
  return false;
}
