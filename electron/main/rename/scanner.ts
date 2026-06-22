import crypto from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Dirent, Stats } from "fs";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type InspectedRenamePath,
  type InspectRenamePathsParams,
  type InspectRenamePathsResult,
  type NameTranslationOptions,
  type NameTranslationTarget,
  type RenamePathKind,
  type ScanRenameTargetsParams,
  type ScanRenameTargetsResult,
} from "./types";

export const BLOCKED_BASENAMES = new Set([".git", "node_modules"]);
export const BLOCKED_ABSOLUTE_PATHS_DARWIN = [
  "/",
  "/System",
  "/Library",
  "/Applications",
  "/Users",
];
export const BLOCKED_ABSOLUTE_PATHS_WIN32 = [
  "C:\\",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Users",
];

const DEFAULT_MAX_TARGETS = 5000;
const MAX_SCAN_DEPTH = 20;
const MAX_WARNINGS = 100;
const DEFAULT_SCAN_CONCURRENCY = 32;

interface PathInfo {
  absolutePath: string;
  basename: string;
  parentPath: string;
  exists: boolean;
  kind: RenamePathKind;
  hidden: boolean;
  symlink: boolean;
  stat?: Stats;
}

interface ScanContext {
  options: NameTranslationOptions;
  maxTargets: number;
  homeDir: string;
  seen: Set<string>;
  targets: NameTranslationTarget[];
  warnings: string[];
  totalCount: number;
  truncated: boolean;
}

interface DirectoryTask {
  directoryPath: string;
  anchorRoot: string;
  depthFromRoot: number;
}

interface DirectoryEntryInfo {
  absolutePath: string;
  info: PathInfo;
}

interface DirectorySnapshot {
  task: DirectoryTask;
  entries: DirectoryEntryInfo[];
}

export function splitNameParts(
  name: string,
  kind: "file" | "directory"
): { stem: string; extension: string } {
  if (kind === "directory") {
    return { stem: name, extension: "" };
  }

  const parsed = path.parse(name);
  return {
    stem: parsed.ext ? parsed.name : name,
    extension: parsed.ext,
  };
}

export function isHiddenPathSegment(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

export function isBlockedPath(
  targetPath: string,
  homeDir = os.homedir()
): boolean {
  const absolutePath = path.resolve(targetPath);
  const parsedRoot = path.parse(absolutePath).root;

  if (absolutePath === parsedRoot) return true;
  if (BLOCKED_BASENAMES.has(path.basename(absolutePath))) return true;
  if (homeDir && samePath(absolutePath, path.resolve(homeDir))) return true;

  const blockedPaths =
    process.platform === "win32"
      ? BLOCKED_ABSOLUTE_PATHS_WIN32
      : BLOCKED_ABSOLUTE_PATHS_DARWIN;

  return blockedPaths.some((blockedPath) => {
    const resolvedBlockedPath = path.resolve(blockedPath);

    if (samePath(absolutePath, resolvedBlockedPath)) return true;
    if (samePath(resolvedBlockedPath, path.parse(resolvedBlockedPath).root)) {
      return false;
    }
    if (path.basename(resolvedBlockedPath) === "Users") return false;

    return isDescendantOf(absolutePath, resolvedBlockedPath);
  });
}

export async function inspectRenamePaths(
  params: InspectRenamePathsParams
): Promise<InspectRenamePathsResult> {
  const paths = Array.isArray(params.paths) ? params.paths : [];
  const inspectedPaths = await Promise.all(paths.map(inspectOnePath));
  return { paths: inspectedPaths };
}

export async function scanRenameTargets(
  params: ScanRenameTargetsParams
): Promise<ScanRenameTargetsResult> {
  const options = normalizeOptions(params.options);
  const context: ScanContext = {
    options,
    maxTargets: normalizeMaxTargets(params.maxTargets),
    homeDir: os.homedir(),
    seen: new Set(),
    targets: [],
    warnings: [],
    totalCount: 0,
    truncated: false,
  };

  if (options.roots.length === 0) {
    pushWarning(context.warnings, "No rename roots were provided.");
    return buildScanResult(context);
  }

  if (options.scope === "path_segments") {
    if (!options.pathSegmentRange) {
      pushWarning(
        context.warnings,
        "path_segments scope requires explicit startPath and endPath before targets can be expanded."
      );
    } else {
      pushWarning(
        context.warnings,
        "path_segments scope is only inspected in RN-001; full expansion belongs to the planner work package."
      );
    }
    return buildScanResult(context);
  }

  for (const root of options.roots) {
    if (context.truncated) break;

    const anchorRoot = path.resolve(root);

    if (options.scope === "self") {
      await addTarget(context, anchorRoot, anchorRoot, 0);
      continue;
    }

    const rootInfo = await getPathInfo(anchorRoot);
    if (!rootInfo.exists) {
      pushWarning(context.warnings, `Path does not exist: ${anchorRoot}`);
      continue;
    }
    if (rootInfo.kind !== "directory") {
      pushWarning(
        context.warnings,
        `Scope ${options.scope} requires a directory root: ${anchorRoot}`
      );
      continue;
    }
    if (shouldSkipDirectoryTraversal(context, rootInfo)) {
      continue;
    }

    if (options.scope === "children") {
      await scanDirectoryLevel(context, anchorRoot, anchorRoot, 1, false);
    } else {
      await scanDirectoryTree(context, anchorRoot, anchorRoot, 1);
    }
  }

  return buildScanResult(context);
}

async function inspectOnePath(inputPath: string): Promise<InspectedRenamePath> {
  const absolutePath = path.resolve(inputPath);
  const info = await getPathInfo(absolutePath);
  const warnings: string[] = [];

  if (!info.exists) {
    return {
      path: absolutePath,
      exists: false,
      kind: "missing",
      basename: info.basename,
      parentPath: info.parentPath,
      hidden: info.hidden,
      symlink: false,
      riskLevel: "blocked",
      warnings: ["Path does not exist."],
    };
  }

  let directFileCount: number | undefined;
  let directDirectoryCount: number | undefined;

  if (info.kind === "directory") {
    try {
      const entries = await readDirectoryEntries(absolutePath);
      directFileCount = entries.filter((entry) => entry.isFile()).length;
      directDirectoryCount = entries.filter((entry) =>
        entry.isDirectory()
      ).length;
    } catch {
      warnings.push("Directory entries could not be read.");
    }
  }

  if (info.hidden) warnings.push("Path is hidden.");
  if (info.symlink) warnings.push("Path is a symbolic link.");
  if (info.kind === "other") warnings.push("Path is not a regular file or directory.");
  if (isBlockedPath(absolutePath)) warnings.push("Path is protected by the rename safety rules.");

  const riskLevel = warnings.some((warning) =>
    warning.includes("not a regular") ||
    warning.includes("protected")
  )
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "normal";

  return {
    path: absolutePath,
    exists: true,
    kind: info.kind,
    basename: info.basename,
    parentPath: info.parentPath,
    directFileCount,
    directDirectoryCount,
    hidden: info.hidden,
    symlink: info.symlink,
    riskLevel,
    warnings,
  };
}

async function scanDirectoryLevel(
  context: ScanContext,
  directoryPath: string,
  anchorRoot: string,
  depthFromRoot: number,
  recursive: boolean
): Promise<void> {
  if (context.truncated) return;
  if (depthFromRoot > clampMaxDepth(context.options.maxDepth)) return;

  const snapshot = await readDirectorySnapshot({
    directoryPath,
    anchorRoot,
    depthFromRoot,
  });
  if (!snapshot) {
    pushWarning(context.warnings, `Directory could not be read: ${directoryPath}`);
    return;
  }

  for (const entry of snapshot.entries) {
    if (context.truncated) break;

    const { absolutePath, info } = entry;

    await addTarget(context, absolutePath, anchorRoot, depthFromRoot, info);

    if (
      recursive &&
      info.kind === "directory" &&
      depthFromRoot < clampMaxDepth(context.options.maxDepth) &&
      !shouldSkipDirectoryTraversal(context, info)
    ) {
      await scanDirectoryLevel(
        context,
        absolutePath,
        anchorRoot,
        depthFromRoot + 1,
        recursive
      );
    }
  }
}

async function scanDirectoryTree(
  context: ScanContext,
  directoryPath: string,
  anchorRoot: string,
  depthFromRoot: number
): Promise<void> {
  let queue: DirectoryTask[] = [
    {
      directoryPath,
      anchorRoot,
      depthFromRoot,
    },
  ];

  while (queue.length > 0 && !context.truncated) {
    const batch = queue.splice(0, DEFAULT_SCAN_CONCURRENCY);
    const snapshots = await Promise.all(
      batch.map(async (task) => ({
        task,
        snapshot: await readDirectorySnapshot(task),
      }))
    );
    const nextQueue: DirectoryTask[] = [];

    for (const { task, snapshot } of snapshots) {
      if (!snapshot) {
        pushWarning(
          context.warnings,
          `Directory could not be read: ${task.directoryPath}`
        );
        continue;
      }

      const nextDepth = snapshot.task.depthFromRoot + 1;
      const canDescend = nextDepth <= clampMaxDepth(context.options.maxDepth);

      for (const entry of snapshot.entries) {
        if (context.truncated) break;

        await addTarget(
          context,
          entry.absolutePath,
          snapshot.task.anchorRoot,
          snapshot.task.depthFromRoot,
          entry.info
        );

        if (
          canDescend &&
          entry.info.kind === "directory" &&
          !shouldSkipDirectoryTraversal(context, entry.info)
        ) {
          nextQueue.push({
            directoryPath: entry.absolutePath,
            anchorRoot: snapshot.task.anchorRoot,
            depthFromRoot: nextDepth,
          });
        }
      }
    }

    queue = nextQueue;
  }
}

async function readDirectorySnapshot(
  task: DirectoryTask
): Promise<DirectorySnapshot | null> {
  let entries: Dirent[];
  try {
    entries = await readDirectoryEntries(task.directoryPath);
  } catch {
    return null;
  }

  const entryInfos = await mapWithConcurrency(
    entries,
    DEFAULT_SCAN_CONCURRENCY,
    async (entry): Promise<DirectoryEntryInfo> => {
      const absolutePath = path.join(task.directoryPath, entry.name);
      return {
        absolutePath,
        info: await getPathInfoFromDirent(absolutePath, entry),
      };
    }
  );

  return {
    task,
    entries: entryInfos,
  };
}

async function addTarget(
  context: ScanContext,
  absolutePath: string,
  anchorRoot: string,
  depthFromRoot: number,
  preloadedInfo?: PathInfo
): Promise<void> {
  if (context.truncated) return;

  const info = preloadedInfo ?? (await getPathInfo(absolutePath));
  const skipReason = getTargetSkipReason(context, info);
  if (skipReason) {
    pushWarning(context.warnings, `${skipReason}: ${info.absolutePath}`);
    return;
  }

  if (!targetKindMatches(context.options.targetKind, info.kind)) return;

  const key = compareKey(info.absolutePath);
  if (context.seen.has(key)) return;
  context.seen.add(key);
  context.totalCount += 1;

  if (context.targets.length >= context.maxTargets) {
    context.truncated = true;
    pushWarning(
      context.warnings,
      `Scan target limit reached (${context.maxTargets}). Narrow the scope or raise maxTargets.`
    );
    return;
  }

  const { stem, extension } = splitNameParts(info.basename, info.kind);
  const size =
    info.kind === "file" && typeof info.stat?.size === "number"
      ? info.stat.size
      : undefined;

  context.targets.push({
    id: createTargetId(info.absolutePath, anchorRoot),
    kind: info.kind,
    absolutePath: info.absolutePath,
    parentPath: info.parentPath,
    originalName: info.basename,
    stem,
    extension,
    depthFromRoot,
    anchorRoot,
    size,
    modifiedAt: info.stat?.mtimeMs,
  });
}

function getTargetSkipReason(
  context: ScanContext,
  info: PathInfo
): string | null {
  if (!info.exists) return "Path does not exist";
  if (info.kind !== "file" && info.kind !== "directory") {
    return "Path is not a regular file or directory";
  }
  if (!context.options.includeHidden && info.hidden) return "Hidden path skipped";
  if (info.symlink && info.kind === "directory") {
    return "Symbolic link directory skipped";
  }
  if (isBlockedPath(info.absolutePath, context.homeDir)) {
    return "Protected path skipped";
  }
  return null;
}

function shouldSkipDirectoryTraversal(
  context: ScanContext,
  info: PathInfo
): boolean {
  if (!info.exists) {
    pushWarning(context.warnings, `Path does not exist: ${info.absolutePath}`);
    return true;
  }
  if (info.kind !== "directory") return true;
  if (!context.options.includeHidden && info.hidden) {
    pushWarning(context.warnings, `Hidden directory skipped: ${info.absolutePath}`);
    return true;
  }
  if (info.symlink) {
    pushWarning(
      context.warnings,
      `Symbolic link directory skipped: ${info.absolutePath}`
    );
    return true;
  }
  if (isBlockedPath(info.absolutePath, context.homeDir)) {
    pushWarning(context.warnings, `Protected directory skipped: ${info.absolutePath}`);
    return true;
  }
  return false;
}

async function getPathInfo(targetPath: string): Promise<PathInfo> {
  const absolutePath = path.resolve(targetPath);
  const basename = path.basename(absolutePath);
  const parentPath = path.dirname(absolutePath);

  try {
    const lstat = await fs.lstat(absolutePath);
    const symlink = lstat.isSymbolicLink();
    let stat: Stats;

    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return {
        absolutePath,
        basename,
        parentPath,
        exists: true,
        kind: "other",
        hidden: isHiddenPathSegment(basename),
        symlink,
      };
    }

    return {
      absolutePath,
      basename,
      parentPath,
      exists: true,
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      hidden: isHiddenPathSegment(basename),
      symlink,
      stat,
    };
  } catch {
    return {
      absolutePath,
      basename,
      parentPath,
      exists: false,
      kind: "missing",
      hidden: isHiddenPathSegment(basename),
      symlink: false,
    };
  }
}

async function getPathInfoFromDirent(
  targetPath: string,
  entry: Dirent
): Promise<PathInfo> {
  if (entry.isSymbolicLink()) {
    return getPathInfo(targetPath);
  }

  const absolutePath = path.resolve(targetPath);
  const basename = path.basename(absolutePath);
  const parentPath = path.dirname(absolutePath);
  const hidden = isHiddenPathSegment(basename);

  if (entry.isFile()) {
    return {
      absolutePath,
      basename,
      parentPath,
      exists: true,
      kind: "file",
      hidden,
      symlink: false,
    };
  }

  if (entry.isDirectory()) {
    return {
      absolutePath,
      basename,
      parentPath,
      exists: true,
      kind: "directory",
      hidden,
      symlink: false,
    };
  }

  return getPathInfo(absolutePath);
}

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, concurrency));

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeOptions(input: NameTranslationOptions): NameTranslationOptions {
  const roots = Array.isArray(input?.roots)
    ? input.roots.filter((root) => typeof root === "string" && root.length > 0)
    : [];
  const options = {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    ...input,
    roots,
  };

  return {
    ...options,
    maxDepth: clampMaxDepth(options.maxDepth),
  };
}

function normalizeMaxTargets(maxTargets: number | undefined): number {
  if (!Number.isFinite(maxTargets)) return DEFAULT_MAX_TARGETS;
  return Math.max(1, Math.floor(maxTargets ?? DEFAULT_MAX_TARGETS));
}

function clampMaxDepth(maxDepth: number): number {
  if (!Number.isFinite(maxDepth)) return DEFAULT_NAME_TRANSLATION_OPTIONS.maxDepth;
  return Math.max(0, Math.min(MAX_SCAN_DEPTH, Math.floor(maxDepth)));
}

function targetKindMatches(
  targetKind: NameTranslationOptions["targetKind"],
  kind: RenamePathKind
): kind is "file" | "directory" {
  if (kind !== "file" && kind !== "directory") return false;
  if (targetKind === "both") return true;
  if (targetKind === "files") return kind === "file";
  return kind === "directory";
}

function buildScanResult(context: ScanContext): ScanRenameTargetsResult {
  return {
    targets: [...context.targets].sort(compareTargets),
    totalCount: context.totalCount,
    truncated: context.truncated,
    warnings: context.warnings,
  };
}

function compareTargets(
  left: NameTranslationTarget,
  right: NameTranslationTarget
): number {
  return (
    compareKey(left.anchorRoot).localeCompare(compareKey(right.anchorRoot)) ||
    left.depthFromRoot - right.depthFromRoot ||
    compareKey(left.absolutePath).localeCompare(compareKey(right.absolutePath))
  );
}

function createTargetId(absolutePath: string, anchorRoot: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(`${anchorRoot}\0${absolutePath}`)
    .digest("hex")
    .slice(0, 16);
  return `rename_target_${hash}`;
}

function pushWarning(warnings: string[], warning: string): void {
  if (warnings.includes(warning)) return;
  if (warnings.length >= MAX_WARNINGS) return;
  warnings.push(warning);
}

function samePath(left: string, right: string): boolean {
  return compareKey(left) === compareKey(right);
}

function isDescendantOf(candidatePath: string, parentPath: string): boolean {
  if (samePath(candidatePath, parentPath)) return false;
  const relative = path.relative(parentPath, candidatePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function compareKey(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}
