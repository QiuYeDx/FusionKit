import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NAME_TRANSLATION_LIMITS,
  type CollectNameDescendantsResult,
  type InspectNamePathsResult,
  type NameDirectoryListing,
  type NameEntry,
  type NameInspectRejection,
} from "@/name-translation/contract";

/** Names that are never offered for renaming because tools depend on them. */
const PROTECTED_BASENAMES = new Set([".git", "node_modules"]);
const WINDOWS_HIDDEN_NAMES = new Set([
  "desktop.ini",
  "thumbs.db",
  "$recycle.bin",
  "system volume information",
]);

export interface PlatformContext {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly tempDir: string;
  readonly env: NodeJS.ProcessEnv;
}

export function defaultPlatformContext(): PlatformContext {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    tempDir: os.tmpdir(),
    env: process.env,
  };
}

export function pathKey(target: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(target).normalize("NFC");
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function isSameOrInside(
  candidate: string,
  parent: string,
  platform: NodeJS.Platform,
): boolean {
  const candidateKey = pathKey(candidate, platform);
  const parentKey = pathKey(parent, platform);
  if (candidateKey === parentKey) return true;
  const withSep = parentKey.endsWith(path.sep) ? parentKey : `${parentKey}${path.sep}`;
  return candidateKey.startsWith(withSep);
}

function protectedTrees(context: PlatformContext): string[] {
  if (context.platform === "win32") {
    const systemRoot = context.env.SystemRoot || context.env.windir || "C:\\Windows";
    return [
      systemRoot,
      context.env.ProgramFiles || "C:\\Program Files",
      context.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      context.env.ProgramData || "C:\\ProgramData",
    ];
  }
  if (context.platform === "darwin") {
    return ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/private", "/etc", "/var", "/opt"];
  }
  return ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/boot", "/proc", "/sys", "/dev", "/var", "/opt", "/snap"];
}

/**
 * True when renaming this exact path is refused: filesystem roots, the user
 * home directory itself, the parent of all home directories, tool-critical
 * folders, and anything inside operating-system trees.
 */
export function isProtectedPath(target: string, context: PlatformContext): boolean {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) return true;
  if (PROTECTED_BASENAMES.has(path.basename(resolved).toLowerCase())) return true;
  const key = pathKey(resolved, context.platform);
  if (context.homeDir) {
    const home = path.resolve(context.homeDir);
    if (key === pathKey(home, context.platform)) return true;
    if (key === pathKey(path.dirname(home), context.platform)) return true;
  }
  if (
    context.platform === "darwin" &&
    (resolved === "/Volumes" || path.dirname(resolved) === "/Volumes")
  ) {
    return true;
  }
  return protectedTrees(context).some((tree) =>
    isSameOrInside(resolved, tree, context.platform),
  );
}

/**
 * Windows Explorer can materialize long-path drags as copies under %TEMP%
 * (FK-PIT-0099). Renaming such a proxy would rename the wrong file.
 */
export function isTempProxyPath(target: string, context: PlatformContext): boolean {
  if (context.platform !== "win32" || !context.tempDir) return false;
  return isSameOrInside(target, context.tempDir, context.platform);
}

export function isHiddenName(name: string, platform: NodeJS.Platform): boolean {
  if (name.startsWith(".")) return true;
  return platform === "win32" && WINDOWS_HIDDEN_NAMES.has(name.toLowerCase());
}

export function identityOf(stat: { dev: bigint; ino: bigint }): string {
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

export async function readEntry(
  absolutePath: string,
  context: PlatformContext,
): Promise<NameEntry | null> {
  const stat = await fs.lstat(absolutePath, { bigint: true });
  let kind: NameEntry["kind"] | null = null;
  const symlink = stat.isSymbolicLink();
  if (stat.isDirectory()) kind = "directory";
  else if (stat.isFile()) kind = "file";
  else if (symlink) {
    // A link is renamed as a link and never expanded.
    const target = await fs.stat(absolutePath).catch(() => null);
    kind = target?.isDirectory() ? "directory" : "file";
  }
  if (!kind) return null;
  const name = path.basename(absolutePath);
  return {
    path: absolutePath,
    name,
    parentPath: path.dirname(absolutePath),
    kind,
    hidden: isHiddenName(name, context.platform),
    symlink,
    identity: identityOf(stat),
  };
}

export async function inspectPaths(
  paths: readonly string[],
  source: "picker" | "drop" | "agent",
  context: PlatformContext = defaultPlatformContext(),
): Promise<InspectNamePathsResult> {
  const entries: NameEntry[] = [];
  const rejected: NameInspectRejection[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const absolutePath = path.resolve(rawPath);
    const key = pathKey(absolutePath, context.platform);
    if (seen.has(key)) continue;
    seen.add(key);

    if (source === "drop" && isTempProxyPath(absolutePath, context)) {
      rejected.push({ path: absolutePath, reason: "temp_proxy" });
      continue;
    }
    if (isProtectedPath(absolutePath, context)) {
      rejected.push({ path: absolutePath, reason: "protected" });
      continue;
    }
    try {
      const entry = await readEntry(absolutePath, context);
      if (entry) entries.push(entry);
      else rejected.push({ path: absolutePath, reason: "unsupported" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      rejected.push({
        path: absolutePath,
        reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      });
    }
  }
  return { entries, rejected };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareEntries(left: NameEntry, right: NameEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return collator.compare(left.name, right.name) || left.name.localeCompare(right.name);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function listDirectory(
  directoryPath: string,
  includeHidden: boolean,
  context: PlatformContext = defaultPlatformContext(),
  limit: number = NAME_TRANSLATION_LIMITS.maxDirectoryEntries,
): Promise<NameDirectoryListing> {
  const absolutePath = path.resolve(directoryPath);
  let names: string[];
  try {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    names = dirents
      .map((dirent) => dirent.name)
      .filter((name) => includeHidden || !isHiddenName(name, context.platform));
  } catch (error) {
    return {
      path: absolutePath,
      entries: [],
      truncated: false,
      error: (error as NodeJS.ErrnoException)?.code ?? "unreadable",
    };
  }

  const read = await mapWithConcurrency(names, 32, async (name) => {
    try {
      return await readEntry(path.join(absolutePath, name), context);
    } catch {
      return null;
    }
  });
  const entries = read
    .filter((entry): entry is NameEntry => entry !== null)
    .sort(compareEntries);
  return {
    path: absolutePath,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

export async function collectDescendants(
  rootPath: string,
  includeHidden: boolean,
  context: PlatformContext = defaultPlatformContext(),
  limit: number = NAME_TRANSLATION_LIMITS.maxCollectedEntries,
): Promise<CollectNameDescendantsResult> {
  const directories: NameDirectoryListing[] = [];
  const queue = [path.resolve(rootPath)];
  let total = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const listing = await listDirectory(current, includeHidden, context);
    const remaining = limit - total;
    const entries = listing.entries.slice(0, Math.max(0, remaining));
    if (listing.truncated || entries.length < listing.entries.length) truncated = true;
    total += entries.length;
    directories.push({ ...listing, entries, truncated: listing.truncated || entries.length < listing.entries.length });
    if (total >= limit) {
      if (queue.length > 0 || entries.some((entry) => entry.kind === "directory" && !entry.symlink)) {
        truncated = true;
      }
      break;
    }
    for (const entry of entries) {
      if (entry.kind === "directory" && !entry.symlink) queue.push(entry.path);
    }
  }
  return { directories, total, truncated };
}
