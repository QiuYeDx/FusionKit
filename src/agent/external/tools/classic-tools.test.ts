import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import { EXTERNAL_TOOLS } from "../catalog";
import { resetExternalConfirmations, useExternalConfirmationsStore } from "../confirmations";
import { useExternalAgentStore } from "../store";
import { CLASSIC_FILE_LIMIT, convertSubtitleFiles, extractSubtitleLanguage, getClassicTasks, inspectNamePaths, renamePaths, undoNameChanges } from "./classic";

const file = (absolutePath: string) => ({ absolutePath, fileName: absolutePath.split("/").pop()!, extension: absolutePath.split(".").pop()!.toUpperCase(), sourceDirectory: absolutePath.replace(/\/[^/]*$/, "") });
const handlers: Record<string, (payload: any) => unknown> = {};
const invoke = vi.fn(async (channel: string, payload: unknown) => {
  const handler = handlers[channel];
  if (!handler) throw new Error(`unexpected ${channel}`);
  return handler(payload);
});
const names = { inspectPaths: vi.fn(), collectDescendants: vi.fn(), preflight: vi.fn(), apply: vi.fn(), undo: vi.fn() };
const originalWindow = globalThis.window;
const ctx = () => ({ sessionId: "s1", client: { name: "claude-code", version: "2" }, signal: new AbortController().signal });
const input = <K extends keyof typeof EXTERNAL_TOOLS>(name: K, value: object) => EXTERNAL_TOOLS[name].inputSchema.parse(value) as never;
const trust = (value: "auto" | "confirm_writes" | "read_only") => useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: value, sessions: [] }, activity: {} });
const requests = () => useExternalConfirmationsStore.getState().requests;

beforeEach(() => {
  vi.clearAllMocks(); resetExternalConfirmations(); trust("auto");
  for (const key of Object.keys(handlers)) delete handlers[key];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ipcRenderer: { invoke }, nameTranslation: names, externalAgent: { requestAttention: vi.fn() } } });
  handlers["get-file-metadata"] = (path: string) => path === "D:/subs" ? { absolutePath: "D:/subs", fileName: "subs", extension: "", sourceDirectory: "D:/" }
    : ["D:/subs/a.ass", "D:/subs/b.ass", "D:/subs/c.srt"].includes(path) ? file(path) : null;
  handlers["scan-directory"] = () => ({ files: [file("D:/subs/a.ass"), file("D:/subs/b.ass"), file("D:/subs/c.srt")] });
  handlers["read-file-head"] = ({ filePath }) => `content of ${filePath}`;
  handlers["convert-subtitle"] = ({ fileName, outputDir }) => fileName === "b.ass" ? Promise.reject(new Error("Error invoking remote method 'convert-subtitle': Error: No subtitle entries were found in the ASS file."))
    : { ok: true, outputFilePath: `${outputDir}/${fileName.replace(/\.ass$/, ".srt")}` };
  handlers["extract-subtitle-language"] = ({ fileName, outputDir }) => ({ ok: true, outputFilePath: `${outputDir}/${fileName}.zh` });
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("convert_subtitle_files", () => {
  it("converts every subtitle file of a folder next to it, skips files already in the format and reports each file", async () => {
    const result = await convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs"], to: "srt" }), ctx());
    expect(invoke).toHaveBeenCalledWith("scan-directory", { directory: "D:/subs", extensions: ["SRT", "VTT", "LRC", "ASS", "SSA", "SBV"], recursive: false, maxFiles: CLASSIC_FILE_LIMIT + 1 });
    expect(invoke).toHaveBeenCalledWith("convert-subtitle", { fileName: "a.ass", fileContent: "content of D:/subs/a.ass", from: "ASS", to: "SRT", outputDir: "D:/subs", defaultDurationMs: 2000, stripMediaExt: true, conflictPolicy: "index" });
    expect(result).toEqual({ written: 1, total: 3, files: [
      { source: "D:/subs/a.ass", ok: true, output: "D:/subs/a.srt" },
      { source: "D:/subs/b.ass", ok: false, error: "No subtitle entries were found in the ASS file." },
      { source: "D:/subs/c.srt", ok: false, skipped: true, error: "already_srt" },
    ] });
    // Files already in the target format never reach the dialog; with nothing to convert there is nothing to confirm.
    trust("confirm_writes");
    await expect(convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs/c.srt"], to: "srt" }), ctx()))
      .resolves.toEqual({ written: 0, total: 1, files: [{ source: "D:/subs/c.srt", ok: false, skipped: true, error: "already_srt" }] });
    expect(requests()).toHaveLength(0);
  });

  it("asks in confirm_writes, may be allowed for the connection, and always asks before overwriting", async () => {
    trust("confirm_writes");
    const call = convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs/a.ass"], to: "vtt", outputDirectory: "E:/out" }), ctx());
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({ action: "files", summary: "convert_directory", group: "classic_files", sessionGrant: true, destructive: false,
      values: { count: 1, format: "VTT", directory: "E:/out" }, items: [{ text: "a.ass", detail: "D:/subs/a.ass" }] });
    useExternalConfirmationsStore.getState().decide(requests()[0].id, true, { allowSession: true });
    await expect(call).resolves.toMatchObject({ written: 1 });
    await convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs/a.ass"], to: "vtt" }), ctx());
    expect(requests()).toHaveLength(1);
    trust("auto");
    const overwriting = convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs/a.ass"], to: "vtt", conflict: "overwrite" }), ctx());
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toMatchObject({ warning: "overwrite", destructive: true, sessionGrant: false });
    useExternalConfirmationsStore.getState().decide(requests()[1].id, false);
    await expect(overwriting).rejects.toMatchObject({ code: "declined_by_user" });
  });

  it("refuses missing paths, too many files, folders without subtitles and read-only trust before writing", async () => {
    await expect(convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/missing.ass"], to: "srt" }), ctx())).rejects.toMatchObject({ code: "path_not_found" });
    handlers["scan-directory"] = () => ({ files: Array.from({ length: CLASSIC_FILE_LIMIT + 1 }, (_, index) => file(`D:/subs/${index}.ass`)) });
    await expect(convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs"], to: "srt" }), ctx())).rejects.toMatchObject({ code: "too_many_files" });
    handlers["scan-directory"] = () => ({ files: [] });
    await expect(convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs"], to: "srt" }), ctx())).rejects.toMatchObject({ code: "no_subtitles_found" });
    trust("read_only");
    await expect(convertSubtitleFiles(input("convert_subtitle_files", { paths: ["D:/subs/a.ass"], to: "srt" }), ctx())).rejects.toMatchObject({ code: "read_only" });
    expect(invoke.mock.calls.some(([channel]) => channel === "convert-subtitle")).toBe(false);
  });
});

describe("extract_subtitle_language", () => {
  it("keeps one language through the extractor's own handler", async () => {
    const result = await extractSubtitleLanguage(input("extract_subtitle_language", { paths: ["D:/subs/c.srt"], keep: "zh" }), ctx());
    expect(invoke).toHaveBeenCalledWith("extract-subtitle-language", { fileName: "c.srt", fileContent: "content of D:/subs/c.srt", fileType: "SRT", keep: "ZH", outputDir: "D:/subs", conflictPolicy: "index" });
    expect(result).toEqual({ written: 1, total: 1, files: [{ source: "D:/subs/c.srt", ok: true, output: "D:/subs/c.srt.zh" }] });
  });
});

describe("get_classic_tasks", () => {
  it("lists the user's queued, finished and failed classic tasks without contents", () => {
    useSubtitleConverterStore.setState({ notStartedTasks: [{ fileName: "a.ass", fileContent: "secret", progress: 0 }], pendingTasks: [],
      resolvedTasks: [{ fileName: "b.ass", fileContent: "secret", progress: 100, outputFilePath: "D:/b.srt" }], failedTasks: [{ fileName: "c.ass", fileContent: "x", progress: 0, errorLog: ["bad file"] }] } as never);
    const result = getClassicTasks(input("get_classic_tasks", { tool: "subtitle_converter" }));
    expect(result).toEqual({ total: 3, items: [
      { tool: "subtitle_converter", fileName: "a.ass", status: "queued", progress: 0 },
      { tool: "subtitle_converter", fileName: "b.ass", status: "completed", progress: 100, outputPath: "D:/b.srt" },
      { tool: "subtitle_converter", fileName: "c.ass", status: "failed", progress: 0, error: "bad file" },
    ] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("renaming by the agent's names", () => {
  const entry = (path: string, kind: "file" | "directory") => ({ path, name: path.split("/").pop(), parentPath: path.replace(/\/[^/]*$/, ""), kind, hidden: false, symlink: false, identity: `id-${path}` });

  it("inspects paths and their children with identities", async () => {
    names.inspectPaths.mockResolvedValue({ ok: true, data: { entries: [entry("D:/アニメ", "directory")], rejected: [{ path: "C:/Windows", reason: "protected" }] } });
    names.collectDescendants.mockResolvedValue({ ok: true, data: { directories: [{ path: "D:/アニメ", entries: [entry("D:/アニメ/第1話.mp4", "file")], truncated: false }], total: 1, truncated: false } });
    const result = await inspectNamePaths(input("inspect_name_paths", { paths: ["D:/アニメ", "C:/Windows"], includeChildren: true }), ctx());
    expect(names.inspectPaths).toHaveBeenCalledWith({ paths: ["D:/アニメ", "C:/Windows"], source: "agent" });
    expect(result).toEqual({ entries: [{ path: "D:/アニメ", name: "アニメ", kind: "directory", identity: "id-D:/アニメ" }],
      children: [{ path: "D:/アニメ/第1話.mp4", name: "第1話.mp4", kind: "file", identity: "id-D:/アニメ/第1話.mp4" }], rejected: [{ path: "C:/Windows", reason: "protected" }] });
  });

  const items = [{ path: "D:/アニメ/第1話.mp4", kind: "file", identity: "i1", newName: "Episode 1.mp4" }, { path: "D:/アニメ", kind: "directory", identity: "i2", newName: "Anime" }];

  it("checks the names first, always asks, renames and returns the journal for undo", async () => {
    names.preflight.mockResolvedValue({ ok: true, data: { items: [{ path: items[0].path, status: "ready" }, { path: items[1].path, status: "ready" }], readyCount: 2, issueCount: 0 } });
    names.apply.mockResolvedValue({ ok: true, data: { status: "completed", journalId: "j1", renamed: [{ from: items[0].path, to: "D:/アニメ/Episode 1.mp4", kind: "file" }, { from: items[1].path, to: "D:/Anime", kind: "directory" }] } });
    const call = renamePaths(input("rename_paths", { items }), ctx());
    // Asked even in auto: it renames the user's own files.
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({ action: "rename", summary: "rename_paths", sessionGrant: false, values: { count: 2 },
      items: [{ from: "第1話.mp4", text: "Episode 1.mp4", detail: "D:/アニメ" }, { from: "アニメ", text: "Anime", detail: "D:" }] });
    expect(names.apply).not.toHaveBeenCalled();
    useExternalConfirmationsStore.getState().decide(requests()[0].id, true);
    await expect(call).resolves.toEqual({ renamed: 2, journalId: "j1", items: [{ from: items[0].path, to: "D:/アニメ/Episode 1.mp4" }, { from: items[1].path, to: "D:/Anime" }] });

    names.undo.mockResolvedValue({ ok: true, data: { status: "completed", restoredCount: 2, failures: [] } });
    const undoing = undoNameChanges(input("undo_name_changes", { journalId: "j1" }), ctx());
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    useExternalConfirmationsStore.getState().decide(requests()[1].id, true);
    await expect(undoing).resolves.toEqual({ status: "completed", restored: 2, failures: [] });
    expect(names.undo).toHaveBeenCalledWith({ journalId: "j1" });
  });

  it("returns name issues without asking or renaming", async () => {
    await expect(renamePaths(input("rename_paths", { items: [{ ...items[0], newName: "../escape.mp4" }] }), ctx())).rejects.toMatchObject({ code: "rename_issues" });
    await expect(renamePaths(input("rename_paths", { items: [{ ...items[0], newName: "第1話.mp4" }] }), ctx())).rejects.toMatchObject({ code: "nothing_to_rename" });
    names.preflight.mockResolvedValue({ ok: true, data: { items: [{ path: items[0].path, status: "issue", issue: "target_exists" }, { path: items[1].path, status: "ready" }], readyCount: 1, issueCount: 1 } });
    await expect(renamePaths(input("rename_paths", { items }), ctx())).rejects.toMatchObject({ code: "rename_issues", detail: { issues: [{ path: items[0].path, issue: "target_exists" }] } });
    names.preflight.mockResolvedValue({ ok: false, error: { code: "busy", message: "busy" } });
    await expect(renamePaths(input("rename_paths", { items }), ctx())).rejects.toMatchObject({ code: "busy" });
    expect(requests()).toHaveLength(0);
    expect(names.apply).not.toHaveBeenCalled();
  });
});
