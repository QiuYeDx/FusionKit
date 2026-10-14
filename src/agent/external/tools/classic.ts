import type { z } from "zod";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import type { NameEntry, NameRenameItem, NameTranslationIpcResult } from "@/name-translation/contract";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed, pathItem } from "../confirmations";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";

type ConvertInput = z.output<typeof EXTERNAL_TOOLS.convert_subtitle_files.inputSchema>;
type ExtractInput = z.output<typeof EXTERNAL_TOOLS.extract_subtitle_language.inputSchema>;
type TasksInput = z.output<typeof EXTERNAL_TOOLS.get_classic_tasks.inputSchema>;
type InspectInput = z.output<typeof EXTERNAL_TOOLS.inspect_name_paths.inputSchema>;
type RenameInput = z.output<typeof EXTERNAL_TOOLS.rename_paths.inputSchema>;
type UndoInput = z.output<typeof EXTERNAL_TOOLS.undo_name_changes.inputSchema>;

/** Files one conversion or extraction call handles at most. */
export const CLASSIC_FILE_LIMIT = 200;
const SUBTITLE_EXTENSIONS = ["SRT", "VTT", "LRC", "ASS", "SSA", "SBV"] as const;
type SubtitleFormat = typeof SUBTITLE_EXTENSIONS[number];
type FileMetadata = { absolutePath: string; fileName: string; extension: string; sourceDirectory: string };

function ipc() {
  if (typeof window === "undefined" || !window.ipcRenderer) throw new ExternalToolError("fusionkit_window_unavailable");
  return window.ipcRenderer;
}
const extensionOf = (name: string) => name.includes(".") ? name.split(".").pop()!.toUpperCase() : "";
const isSubtitle = (extension: string): extension is SubtitleFormat => (SUBTITLE_EXTENSIONS as readonly string[]).includes(extension);
const directoryOf = (filePath: string) => filePath.replace(/[\\/][^\\/]*$/, "");
const baseName = (filePath: string) => filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? filePath;

/**
 * The subtitle files the paths name: files as given, folders scanned (with their subfolders when
 * asked), each file once. A path that does not exist stops the call; more than the limit too.
 */
export async function collectSubtitleFiles(paths: readonly string[], recursive: boolean, ctx: ExternalToolContext): Promise<FileMetadata[]> {
  const found = new Map<string, FileMetadata>();
  for (const value of paths) {
    const meta = await ipc().invoke("get-file-metadata", value) as FileMetadata | null;
    checkActive(ctx);
    if (!meta) throw new ExternalToolError("path_not_found", { path: value });
    if (isSubtitle(extensionOf(meta.fileName))) {
      found.set(meta.absolutePath.toLowerCase(), meta);
    } else {
      const scanned = await ipc().invoke("scan-directory", { directory: value, extensions: [...SUBTITLE_EXTENSIONS], recursive, maxFiles: CLASSIC_FILE_LIMIT + 1 }) as { files?: FileMetadata[] } | undefined;
      checkActive(ctx);
      for (const file of scanned?.files ?? []) found.set(file.absolutePath.toLowerCase(), { ...file, sourceDirectory: file.sourceDirectory ?? directoryOf(file.absolutePath) });
    }
    if (found.size > CLASSIC_FILE_LIMIT) throw new ExternalToolError("too_many_files", { limit: CLASSIC_FILE_LIMIT });
  }
  if (!found.size) throw new ExternalToolError("no_subtitles_found");
  return [...found.values()];
}

type FileResult = { source: string; ok: true; output: string } | { source: string; ok: false; skipped?: true; error: string };

/** Runs one file at a time through the classic page's own main-process handler. */
async function processFiles(files: FileMetadata[], ctx: ExternalToolContext, run: (file: FileMetadata, content: string) => Promise<{ outputFilePath?: string }>) {
  const results: FileResult[] = [];
  for (const file of files) {
    checkActive(ctx);
    try {
      const content = await ipc().invoke("read-file-head", { filePath: file.absolutePath, lines: 100_000 }) as string;
      const written = await run(file, content);
      results.push({ source: file.absolutePath, ok: true, output: written?.outputFilePath ?? "" });
    } catch (error) {
      results.push({ source: file.absolutePath, ok: false, error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").slice(0, 300) });
    }
  }
  return { written: results.filter(item => item.ok).length, total: results.length, files: results };
}

export async function convertSubtitleFiles(input: ConvertInput, ctx: ExternalToolContext) {
  const to = input.to.toUpperCase() as SubtitleFormat;
  const collected = await collectSubtitleFiles(input.paths, input.recursive, ctx);
  // Files already in the target format are reported as skipped and never shown for confirmation.
  const skipped: FileResult[] = collected.filter(file => extensionOf(file.fileName) === to)
    .map(file => ({ source: file.absolutePath, ok: false, skipped: true, error: `already_${to.toLowerCase()}` }));
  const files = collected.filter(file => extensionOf(file.fileName) !== to);
  if (!files.length) return { written: 0, total: skipped.length, files: skipped };
  const overwrite = input.conflict === "overwrite";
  return confirmed(ctx, "convert_subtitle_files", {
    action: "files", summary: input.outputDirectory ? "convert_directory" : "convert_source",
    values: { count: files.length, format: to, ...(input.outputDirectory ? { directory: input.outputDirectory } : {}) },
    items: files.map(file => pathItem(file.absolutePath)), ...(overwrite ? { warning: "overwrite" as const } : {}),
  }, async () => {
    const done = await processFiles(files, ctx, (file, content) => ipc().invoke("convert-subtitle", {
      fileName: file.fileName, fileContent: content, from: extensionOf(file.fileName), to, outputDir: input.outputDirectory ?? file.sourceDirectory,
      defaultDurationMs: input.lrcLastDurationMs, stripMediaExt: true, conflictPolicy: overwrite ? "overwrite" : "index",
    }));
    return { written: done.written, total: done.total + skipped.length, files: [...done.files, ...skipped] };
  }, { destructive: overwrite });
}

export async function extractSubtitleLanguage(input: ExtractInput, ctx: ExternalToolContext) {
  const files = await collectSubtitleFiles(input.paths, input.recursive, ctx);
  const keep = input.keep.toUpperCase();
  const overwrite = input.conflict === "overwrite";
  return confirmed(ctx, "extract_subtitle_language", {
    action: "files", summary: input.outputDirectory ? "extract_directory" : "extract_source",
    values: { count: files.length, language: keep, ...(input.outputDirectory ? { directory: input.outputDirectory } : {}) },
    items: files.map(file => pathItem(file.absolutePath)), ...(overwrite ? { warning: "overwrite" as const } : {}),
  }, () => processFiles(files, ctx, (file, content) => ipc().invoke("extract-subtitle-language", {
    fileName: file.fileName, fileContent: content, fileType: extensionOf(file.fileName), keep,
    outputDir: input.outputDirectory ?? file.sourceDirectory, conflictPolicy: overwrite ? "overwrite" : "index",
  })), { destructive: overwrite });
}

type QueueTask = { fileName: string; progress?: number; outputFilePath?: string; errorLog?: string[] };
/** The tasks the user queued in the classic pages; never file contents. */
export function getClassicTasks(input: TasksInput) {
  const map = (tool: string, status: string, tasks: readonly QueueTask[]) => tasks.slice(0, 50).map(task => ({
    tool, fileName: task.fileName.slice(0, 255), status, progress: Math.round(task.progress ?? 0),
    ...(task.outputFilePath ? { outputPath: task.outputFilePath } : {}), ...(status === "failed" && task.errorLog?.length ? { error: task.errorLog.at(-1)!.slice(0, 300) } : {}),
  }));
  const items: ReturnType<typeof map> = [];
  if (input.tool === "all" || input.tool === "subtitle_translator") {
    const state = useSubtitleTranslatorStore.getState();
    items.push(...map("subtitle_translator", "queued", [...state.notStartedTaskQueue, ...state.waitingTaskQueue]), ...map("subtitle_translator", "running", state.pendingTaskQueue),
      ...map("subtitle_translator", "completed", state.resolvedTaskQueue), ...map("subtitle_translator", "failed", state.failedTaskQueue));
  }
  for (const [tool, state] of [["subtitle_converter", useSubtitleConverterStore.getState()], ["subtitle_extractor", useSubtitleExtractorStore.getState()]] as const) {
    if (input.tool !== "all" && input.tool !== tool) continue;
    items.push(...map(tool, "queued", state.notStartedTasks), ...map(tool, "running", state.pendingTasks), ...map(tool, "completed", state.resolvedTasks), ...map(tool, "failed", state.failedTasks));
  }
  return { total: items.length, items };
}

// ---------------------------------------------------------------------------
// File and folder names
// ---------------------------------------------------------------------------

function names() {
  if (typeof window === "undefined" || !window.nameTranslation) throw new ExternalToolError("fusionkit_window_unavailable");
  return window.nameTranslation;
}
function unwrapNames<T>(result: NameTranslationIpcResult<T>): T {
  if (!result.ok) throw new ExternalToolError(result.error.code === "invalid_request" ? "invalid_arguments" : result.error.code);
  return result.data;
}
/** Children listed at most by one inspection. */
export const NAME_CHILDREN_LIMIT = 2000;
const entryOf = (entry: NameEntry) => ({ path: entry.path, name: entry.name, kind: entry.kind, identity: entry.identity });

export async function inspectNamePaths(input: InspectInput, ctx: ExternalToolContext) {
  const inspected = unwrapNames(await names().inspectPaths({ paths: input.paths, source: "agent" }));
  checkActive(ctx);
  const children: ReturnType<typeof entryOf>[] = [];
  let truncated = false;
  if (input.includeChildren) {
    for (const entry of inspected.entries) {
      if (entry.kind !== "directory") continue;
      const found = unwrapNames(await names().collectDescendants({ path: entry.path, includeHidden: input.includeHidden }));
      checkActive(ctx);
      for (const listing of found.directories) for (const child of listing.entries) {
        if (!input.includeHidden && child.hidden) continue;
        if (children.length >= NAME_CHILDREN_LIMIT) { truncated = true; break; }
        children.push(entryOf(child));
      }
      truncated ||= found.truncated;
    }
  }
  return { entries: inspected.entries.map(entryOf), children, ...(truncated ? { truncated: true } : {}), rejected: inspected.rejected };
}

/** A new name is a name only: it cannot move the entry. */
function nameProblem(value: string): string | null {
  if (!value.trim()) return "empty_name";
  if (/[\\/]/.test(value) || value === "." || value === "..") return "not_a_name";
  return null;
}

export async function renamePaths(input: RenameInput, ctx: ExternalToolContext) {
  const problems = input.items.flatMap(item => { const problem = nameProblem(item.newName); return problem ? [{ path: item.path, issue: problem }] : []; });
  if (problems.length) throw new ExternalToolError("rename_issues", { issues: problems.slice(0, 50), hint: "Nothing was renamed." });
  // Entries keeping their name are left out.
  const items: NameRenameItem[] = input.items.filter(item => baseName(item.path) !== item.newName)
    .map(item => ({ path: item.path, kind: item.kind, identity: item.identity, newName: item.newName }));
  if (!items.length) throw new ExternalToolError("nothing_to_rename");
  const checked = unwrapNames(await names().preflight({ items }));
  checkActive(ctx);
  if (checked.issueCount) {
    throw new ExternalToolError("rename_issues", { issues: checked.items.filter(item => item.status === "issue").slice(0, 50).map(item => ({ path: item.path, issue: item.issue })),
      hint: "Fix these names (or inspect_name_paths again when an entry changed). Nothing was renamed." });
  }
  return confirmed(ctx, "rename_paths", {
    action: "rename", summary: "rename_paths", values: { count: items.length },
    items: items.map(item => ({ from: baseName(item.path), text: item.newName, detail: directoryOf(item.path) })),
  }, async () => {
    const applied = unwrapNames(await names().apply({ items }));
    if (applied.status === "rejected") {
      throw new ExternalToolError("rename_issues", { issues: applied.preflight.items.filter(item => item.status === "issue").slice(0, 50).map(item => ({ path: item.path, issue: item.issue })) });
    }
    if (applied.status === "failed") {
      throw new ExternalToolError("rename_failed", { failedPath: applied.failedPath, reason: applied.message.slice(0, 300), rollback: applied.rollback, ...(applied.journalId ? { journalId: applied.journalId } : {}) });
    }
    return { renamed: applied.renamed.length, journalId: applied.journalId, items: applied.renamed.slice(0, 50).map(item => ({ from: item.from, to: item.to })) };
  });
}

export async function undoNameChanges(input: UndoInput, ctx: ExternalToolContext) {
  return confirmed(ctx, "undo_name_changes", { action: "rename", summary: "undo_rename", values: {}, items: [] }, async () => {
    const undone = unwrapNames(await names().undo({ journalId: input.journalId }));
    return { status: undone.status, restored: undone.restoredCount, failures: undone.failures.slice(0, 20) };
  });
}
