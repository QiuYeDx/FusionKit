import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";
import type { LocalSubtitleInputSelectionSource } from "@/type/localSubtitleIpc";
import { LocalSubtitleAuthorizationError } from "./authorizations";

const execFileAsync = promisify(execFile);
const MAX_EXPLORER_WINDOWS = 64;
const MAX_SELECTED_ITEMS = LOCAL_SUBTITLE_LIMITS.maxBatchFiles;
const MAX_EXPLORER_QUERY_BYTES = 4 * 1024 * 1024;
const EXPLORER_QUERY_TIMEOUT_MS = 5_000;

const POWERSHELL_SELECTION_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$shell = New-Object -ComObject Shell.Application
$groups = @()
foreach ($window in @($shell.Windows())) {
  try {
    $fullName = [string]$window.FullName
    if ([IO.Path]::GetFileName($fullName) -ine 'explorer.exe') { continue }
    $items = @()
    foreach ($item in @($window.Document.SelectedItems())) {
      $itemPath = [string]$item.Path
      if ([string]::IsNullOrWhiteSpace($itemPath)) { continue }
      $items += [ordered]@{
        path = $itemPath
        name = [string]$item.Name
      }
    }
    if ($items.Count -gt 0) {
      $groups += [ordered]@{
        windowHandle = [string]$window.HWND
        items = @($items)
      }
    }
  } catch {
    # Explorer can close a tab while the ShellWindows collection is read.
  }
}
ConvertTo-Json -InputObject @($groups) -Depth 4 -Compress
`;

export interface WindowsExplorerSelectionItem {
  readonly path: string;
  readonly name: string;
}

export interface WindowsExplorerSelectionGroup {
  readonly windowHandle: string;
  readonly items: readonly WindowsExplorerSelectionItem[];
}

export type WindowsExplorerSelectionQuery = () => Promise<
  readonly WindowsExplorerSelectionGroup[]
>;

export interface WindowsExplorerDropResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly tempDirectory?: string;
  readonly querySelections?: WindowsExplorerSelectionQuery;
}

interface InspectedPath {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly byteSize: number;
}

/**
 * Chromium 140 (Electron 41) materializes some Windows Explorer drops into
 * %TEMP%, notably long-path Shell items. webUtils.getPathForFile() correctly
 * reports that backing file, but it is not the user's source identity or
 * source output directory. Recover only a unique, still-selected Explorer
 * source set; otherwise fail closed instead of publishing subtitles to Temp.
 */
export async function resolveLocalSubtitleInputPaths(
  paths: readonly string[],
  source: LocalSubtitleInputSelectionSource,
  options: WindowsExplorerDropResolverOptions = {},
): Promise<readonly string[]> {
  if (
    source !== "drop" ||
    (options.platform ?? process.platform) !== "win32" ||
    paths.length === 0
  ) {
    return Object.freeze([...paths]);
  }

  const inspected = await inspectPaths(paths);
  const tempDirectory = await realpath(options.tempDirectory ?? os.tmpdir());
  if (!inspected.some((entry) => isInside(tempDirectory, entry.canonicalPath))) {
    return Object.freeze([...paths]);
  }

  let groups: readonly WindowsExplorerSelectionGroup[];
  try {
    groups = await (options.querySelections ?? queryWindowsExplorerSelections)();
  } catch {
    throw unresolvedExplorerDrop();
  }

  const matches: string[][] = [];
  for (const group of groups) {
    if (group.items.length !== inspected.length) continue;
    const selected = await inspectSelectionGroup(group).catch(() => undefined);
    if (!selected) continue;
    const match = uniqueMatchingSelection(inspected, selected);
    if (match) matches.push(match);
    if (matches.length > 1) break;
  }

  if (matches.length !== 1) throw unresolvedExplorerDrop();
  return Object.freeze(matches[0]!);
}

export async function queryWindowsExplorerSelections(): Promise<
  readonly WindowsExplorerSelectionGroup[]
> {
  if (process.platform !== "win32") return Object.freeze([]);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("The Windows system root is unavailable.");
  }
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await execFileAsync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      POWERSHELL_SELECTION_QUERY,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: EXPLORER_QUERY_TIMEOUT_MS,
      maxBuffer: MAX_EXPLORER_QUERY_BYTES,
    },
  );
  return parseExplorerSelectionGroups(result.stdout);
}

export function parseExplorerSelectionGroups(
  serialized: string,
): readonly WindowsExplorerSelectionGroup[] {
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXPLORER_QUERY_BYTES) {
    throw new TypeError("The Explorer selection response is too large.");
  }
  const text = serialized.replace(/^\uFEFF/u, "").trim();
  if (!text) return Object.freeze([]);
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > MAX_EXPLORER_WINDOWS) {
    throw new TypeError("The Explorer selection response is invalid.");
  }
  return Object.freeze(parsed.map((group) => {
    if (!isRecord(group) || Reflect.ownKeys(group).length !== 2) {
      throw new TypeError("The Explorer selection group is invalid.");
    }
    const { windowHandle, items } = group;
    if (
      typeof windowHandle !== "string" ||
      windowHandle.length === 0 ||
      windowHandle.length > 32 ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > MAX_SELECTED_ITEMS
    ) {
      throw new TypeError("The Explorer selection group is invalid.");
    }
    return Object.freeze({
      windowHandle,
      items: Object.freeze(items.map((item) => {
        if (!isRecord(item) || Reflect.ownKeys(item).length !== 2) {
          throw new TypeError("The Explorer selection item is invalid.");
        }
        if (
          typeof item.path !== "string" ||
          item.path.length === 0 ||
          item.path.length > 32_768 ||
          typeof item.name !== "string" ||
          item.name.length === 0 ||
          item.name.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars
        ) {
          throw new TypeError("The Explorer selection item is invalid.");
        }
        return Object.freeze({ path: item.path, name: item.name });
      })),
    });
  }));
}

async function inspectPaths(paths: readonly string[]): Promise<readonly InspectedPath[]> {
  const inspected = await Promise.all(paths.map(async (requestedPath) => {
    if (
      typeof requestedPath !== "string" ||
      requestedPath.length === 0 ||
      requestedPath.length > 32_768 ||
      !path.win32.isAbsolute(requestedPath)
    ) {
      throw unresolvedExplorerDrop();
    }
    const before = await lstat(requestedPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw unresolvedExplorerDrop();
    }
    const canonicalPath = await realpath(requestedPath);
    const after = await lstat(canonicalPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.size !== after.size
    ) {
      throw unresolvedExplorerDrop();
    }
    return Object.freeze({
      requestedPath,
      canonicalPath,
      displayName: path.win32.basename(requestedPath),
      byteSize: after.size,
    });
  }));
  if (new Set(inspected.map((entry) => pathIdentity(entry.canonicalPath))).size !==
      inspected.length) {
    throw unresolvedExplorerDrop();
  }
  return Object.freeze(inspected);
}

async function inspectSelectionGroup(
  group: WindowsExplorerSelectionGroup,
): Promise<readonly InspectedPath[]> {
  return inspectPaths(group.items.map((item) => item.path));
}

function uniqueMatchingSelection(
  proxies: readonly InspectedPath[],
  selected: readonly InspectedPath[],
): string[] | undefined {
  const candidateIndexes = proxies.map((proxy) => selected.flatMap(
    (source, index) => sourceMatchesProxy(source, proxy) ? [index] : [],
  ));
  if (candidateIndexes.some((indexes) => indexes.length === 0)) return undefined;

  const order = proxies.map((_, index) => index).sort(
    (left, right) => candidateIndexes[left]!.length - candidateIndexes[right]!.length,
  );
  const assignments = new Array<number>(proxies.length).fill(-1);
  const used = new Set<number>();
  const solutions: number[][] = [];
  const visit = (depth: number): void => {
    if (solutions.length > 1) return;
    if (depth === order.length) {
      solutions.push([...assignments]);
      return;
    }
    const proxyIndex = order[depth]!;
    for (const sourceIndex of candidateIndexes[proxyIndex]!) {
      if (used.has(sourceIndex)) continue;
      used.add(sourceIndex);
      assignments[proxyIndex] = sourceIndex;
      visit(depth + 1);
      assignments[proxyIndex] = -1;
      used.delete(sourceIndex);
    }
  };
  visit(0);
  if (solutions.length !== 1) return undefined;
  return solutions[0]!.map((sourceIndex) => selected[sourceIndex]!.canonicalPath);
}

function sourceMatchesProxy(source: InspectedPath, proxy: InspectedPath): boolean {
  if (source.byteSize !== proxy.byteSize) return false;
  if (pathIdentity(source.canonicalPath) === pathIdentity(proxy.canonicalPath)) {
    return true;
  }
  const sourceName = path.win32.parse(source.displayName);
  const proxyName = path.win32.parse(proxy.displayName);
  if (sourceName.ext.toLocaleLowerCase("en-US") !==
      proxyName.ext.toLocaleLowerCase("en-US")) {
    return false;
  }
  const sourceStem = sourceName.name.toLocaleLowerCase("en-US");
  const proxyStem = proxyName.name.toLocaleLowerCase("en-US");
  if (sourceStem === proxyStem) return true;
  if (!proxyStem.startsWith(`${sourceStem} (`) || !proxyStem.endsWith(")")) {
    return false;
  }
  const suffix = proxyStem.slice(sourceStem.length + 2, -1);
  return /^[1-9]\d*$/u.test(suffix);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.win32.relative(parent, candidate);
  return relative === "" || (
    !path.win32.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.win32.sep}`)
  );
}

function pathIdentity(value: string): string {
  return path.win32.normalize(value).toLocaleLowerCase("en-US");
}

function unresolvedExplorerDrop(): LocalSubtitleAuthorizationError {
  return new LocalSubtitleAuthorizationError(
    "authorization_expired",
    "Windows Explorer supplied temporary drag copies, but the original " +
      "selection could not be proven. Drop the files again without changing " +
      "the Explorer selection, or use Select files.",
    "files",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
