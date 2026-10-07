import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  NameEntryKind,
  NameIssueCode,
  NamePreflightItem,
  NamePreflightResult,
  NameRenameItem,
} from "@/name-translation/contract";
import { getNameIssue, nameKey } from "@/name-translation/naming-rules";
import {
  defaultPlatformContext,
  identityOf,
  isProtectedPath,
  pathKey,
  type PlatformContext,
} from "./fs-listing";

/**
 * Authoritative validation shared by preflight and apply. Every target path is
 * derived here from the source path plus a validated basename; nothing the
 * renderer computed about destinations is trusted.
 */

export interface PlannedRename {
  readonly index: number;
  readonly path: string;
  readonly parentPath: string;
  readonly originalName: string;
  readonly newName: string;
  readonly kind: NameEntryKind;
}

export interface RenameGroup {
  readonly parentPath: string;
  readonly depth: number;
  readonly items: readonly PlannedRename[];
  /** True when a target reuses a name currently held by a source in this group. */
  readonly needsStaging: boolean;
}

export interface RenamePlan {
  readonly preflight: NamePreflightResult;
  /** Groups ordered deepest parent first: the execution order. */
  readonly groups: readonly RenameGroup[];
}

export interface PlannerDeps {
  readonly context?: PlatformContext;
  readonly readDirectoryNames?: (directory: string) => Promise<string[]>;
}

export function pathDepth(target: string): number {
  return path.resolve(target).split(/[\\/]+/).filter(Boolean).length;
}

interface WorkingItem {
  index: number;
  path: string;
  parentPath: string;
  originalName: string;
  newName: string;
  kind: NameEntryKind;
  status: NamePreflightItem["status"];
  issue?: NameIssueCode;
}

export async function planRename(
  items: readonly NameRenameItem[],
  deps: PlannerDeps = {},
): Promise<RenamePlan> {
  const context = deps.context ?? defaultPlatformContext();
  const platform = context.platform;
  const readNames =
    deps.readDirectoryNames ?? ((directory: string) => fs.readdir(directory));
  const seenSources = new Set<string>();
  const working: WorkingItem[] = [];

  for (const [index, item] of items.entries()) {
    const absolutePath = path.resolve(item.path);
    const entry: WorkingItem = {
      index,
      path: absolutePath,
      parentPath: path.dirname(absolutePath),
      originalName: path.basename(absolutePath),
      newName: item.newName,
      kind: item.kind,
      status: "ready",
    };
    working.push(entry);
    const fail = (issue: NameIssueCode) => {
      entry.status = "issue";
      entry.issue = issue;
    };

    const sourceKey = pathKey(absolutePath, platform);
    if (seenSources.has(sourceKey)) {
      fail("duplicate_source");
      continue;
    }
    seenSources.add(sourceKey);

    if (item.newName === entry.originalName) {
      entry.status = "unchanged";
      continue;
    }
    const nameIssue = getNameIssue(item.newName);
    if (nameIssue) {
      fail(nameIssue);
      continue;
    }
    if (isProtectedPath(absolutePath, context)) {
      fail("protected_path");
      continue;
    }
    try {
      const stat = await fs.lstat(absolutePath, { bigint: true });
      const isDirectory = stat.isDirectory() || (stat.isSymbolicLink() && item.kind === "directory");
      const kindMatches = item.kind === "directory" ? isDirectory : stat.isFile() || stat.isSymbolicLink();
      if (!kindMatches || identityOf(stat) !== item.identity) fail("source_changed");
    } catch {
      fail("source_missing");
    }
  }

  // Group the remaining candidates per real parent directory.
  const byParent = new Map<string, WorkingItem[]>();
  for (const entry of working) {
    if (entry.status !== "ready") continue;
    const key = pathKey(entry.parentPath, platform);
    const group = byParent.get(key) ?? [];
    group.push(entry);
    byParent.set(key, group);
  }

  const groups: RenameGroup[] = [];
  for (const groupItems of byParent.values()) {
    const parentPath = groupItems[0]!.parentPath;
    let existingNames: string[] = [];
    try {
      existingNames = await readNames(parentPath);
    } catch {
      for (const entry of groupItems) {
        entry.status = "issue";
        entry.issue = "source_missing";
      }
      continue;
    }
    resolveGroupConflicts(groupItems, existingNames, platform);
    const ready = groupItems.filter((entry) => entry.status === "ready");
    if (ready.length === 0) continue;
    const sourceKeys = new Set(ready.map((entry) => nameKey(entry.originalName, platform)));
    groups.push({
      parentPath,
      depth: pathDepth(parentPath),
      items: ready.map(toPlanned),
      needsStaging: ready.some((entry) => sourceKeys.has(nameKey(entry.newName, platform))),
    });
  }
  groups.sort((left, right) => right.depth - left.depth);

  const preflightItems: NamePreflightItem[] = working.map((entry) => ({
    path: entry.path,
    status: entry.status,
    ...(entry.issue ? { issue: entry.issue } : {}),
  }));
  return {
    preflight: {
      items: preflightItems,
      readyCount: preflightItems.filter((item) => item.status === "ready").length,
      issueCount: preflightItems.filter((item) => item.status === "issue").length,
    },
    groups,
  };
}

/**
 * Marks duplicate targets and collisions with entries that stay in place.
 * Repeats until stable because an item that drops out keeps its old name,
 * which can in turn block another item that wanted that name.
 */
function resolveGroupConflicts(
  groupItems: WorkingItem[],
  existingNames: readonly string[],
  platform: string,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const ready = groupItems.filter((entry) => entry.status === "ready");
    const leaving = new Set(ready.map((entry) => nameKey(entry.originalName, platform)));
    const staying = new Set(
      existingNames
        .map((name) => nameKey(name, platform))
        .filter((key) => !leaving.has(key)),
    );
    const targetCounts = new Map<string, number>();
    for (const entry of ready) {
      const key = nameKey(entry.newName, platform);
      targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
    }
    for (const entry of ready) {
      const key = nameKey(entry.newName, platform);
      if ((targetCounts.get(key) ?? 0) > 1) {
        entry.status = "issue";
        entry.issue = "duplicate_target";
        changed = true;
      } else if (staying.has(key)) {
        entry.status = "issue";
        entry.issue = "target_exists";
        changed = true;
      }
    }
  }
}

function toPlanned(entry: WorkingItem): PlannedRename {
  return {
    index: entry.index,
    path: entry.path,
    parentPath: entry.parentPath,
    originalName: entry.originalName,
    newName: entry.newName,
    kind: entry.kind,
  };
}

/**
 * Computes where each original path ends up once every rename in the plan has
 * been applied (ancestors included).
 */
export function computeFinalPaths(
  groups: readonly RenameGroup[],
  platform: NodeJS.Platform,
): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) renamed.set(pathKey(item.path, platform), item.newName);
  }
  const finals = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      finals.set(item.path, rewritePath(item.path, renamed, platform));
    }
  }
  return finals;
}

export function rewritePath(
  original: string,
  renamed: ReadonlyMap<string, string>,
  platform: NodeJS.Platform,
): string {
  const resolved = path.resolve(original);
  const root = path.parse(resolved).root;
  const segments = resolved.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let originalPrefix = root;
  let nextPath = root;
  for (const segment of segments) {
    originalPrefix = path.join(originalPrefix, segment);
    nextPath = path.join(nextPath, renamed.get(pathKey(originalPrefix, platform)) ?? segment);
  }
  return nextPath;
}
