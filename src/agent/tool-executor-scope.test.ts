import { beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore, { executeTasksInStores } from "@/store/agent/useAgentStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import { executeQueueConvert, executeApplyNameTranslationPlan, executeScan } from "./tool-executor";
import { TaskStatus, SubtitleConvertFormat } from "@/type/subtitle";
import { planningAgentTools } from "./planning-tools";

vi.mock("@/utils/toast", () => ({ showToast: vi.fn() }));
const invoke = vi.fn();
const args = { filePaths: ["C:/new.srt"], to: "LRC", outputMode: "source", conflictPolicy: "index", batchStart: 0, batchSize: 100 } as const;
const task = (name: string) => ({ fileName: name, fileContent: "test", from: SubtitleConvertFormat.SRT, to: SubtitleConvertFormat.LRC, originFileURL: `C:/${name}`, targetFileURL: "C:/", status: TaskStatus.NOT_STARTED, progress: 0 });
beforeEach(() => {
  vi.restoreAllMocks(); invoke.mockReset().mockResolvedValue("1\n00:00:00,000 --> 00:00:01,000\nhello");
  vi.stubGlobal("window", { ipcRenderer: { invoke } });
  useAgentStore.getState().resetSession();
  useAgentStore.setState({ executionMode: "queue_only" });
  useSubtitleConverterStore.setState({ notStartedTasks: [task("old.srt")], pendingTasks: [], resolvedTasks: [], failedTasks: [] });
});

describe("Agent exact queue receipts", () => {
  it("reports bounded queue metadata without subtitle bodies or source paths", async () => {
    const result = await planningAgentTools.get_classic_subtitle_tasks.execute!({ store: "convert", offset: 0, limit: 1 }, { toolCallId: "read", messages: [] });
    expect(result).toMatchObject({ success: true, data: { total: 1, hasMore: false, items: [{ fileName: "old.srt", status: "queued" }] } });
    expect(JSON.stringify(result)).not.toContain("fileContent");
    expect(JSON.stringify(result)).not.toContain("C:/");
  });
  it.each(["auto_execute", "ask_before_execute"] as const)("%s starts only the newly admitted task", async mode => {
    useAgentStore.setState({ executionMode: mode });
    const start = vi.spyOn(useSubtitleConverterStore.getState(), "startTask").mockImplementation(() => {});
    const all = vi.spyOn(useSubtitleConverterStore.getState(), "startAllTasks").mockImplementation(() => {});
    const result = await executeQueueConvert({ ...args, filePaths: [...args.filePaths] });
    expect(result.data.queuedCount).toBe(1);
    if (mode === "ask_before_execute") {
      useSubtitleConverterStore.getState().addTask(task("later.srt"));
      expect(start).not.toHaveBeenCalled();
      useAgentStore.getState().confirmExecution();
      useAgentStore.getState().confirmExecution();
    }
    expect(start.mock.calls).toEqual([["new.srt"]]);
    expect(all).not.toHaveBeenCalled();
  });
  it("does not count duplicate filenames or reuse an old resolved confirmation", async () => {
    useAgentStore.setState({ executionMode: "ask_before_execute", pendingExecution: { stores: ["convert"], taskCounts: { convert: 9 }, taskRefs: [], timestamp: 1, resolvedAction: "dismiss" } });
    const result = await executeQueueConvert({ ...args, filePaths: ["C:/old.srt", "C:/new.srt"] });
    expect(result.data.queuedCount).toBe(1);
    expect(useAgentStore.getState().pendingExecution?.taskCounts.convert).toBe(1);
  });
  it("cannot start a removed and recreated same-name task using an old receipt", async () => {
    const result = await executeQueueConvert({ ...args, filePaths: [...args.filePaths] });
    useSubtitleConverterStore.setState({ notStartedTasks: [task("new.srt")] });
    const start = vi.spyOn(useSubtitleConverterStore.getState(), "startTask");
    expect(executeTasksInStores(["convert"], result.data.taskRefs)).toEqual({ startedCount: 0, skippedCount: 1 });
    expect(start).not.toHaveBeenCalled();
  });
  it("stops admission after asynchronous file read returns", async () => {
    const abort = new AbortController(); invoke.mockImplementation(async () => { abort.abort(); return "content"; });
    const result = await executeQueueConvert({ ...args, filePaths: [...args.filePaths] }, abort.signal);
    expect(result).toMatchObject({ success: false, data: { queuedCount: 0 } });
    expect(useSubtitleConverterStore.getState().notStartedTasks).toHaveLength(1);
  });
  it("does not scan subsequent directories after stopping", async () => {
    const abort = new AbortController();
    invoke.mockImplementation(async () => { abort.abort(); return { files: [] }; });
    expect(await executeScan({ directories: ["C:/one", "C:/two"], extensions: ["SRT"], recursive: true }, abort.signal)).toMatchObject({ success: false });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("retains sequential conversion scheduling without starting unrelated queued files", async () => {
    const first = await executeQueueConvert({ ...args, filePaths: ["C:/one.srt", "C:/two.srt"] });
    const start = vi.spyOn(useSubtitleConverterStore.getState(), "startTask").mockImplementation(name => {
      const state = useSubtitleConverterStore.getState();
      const selected = state.notStartedTasks.find(item => item.fileName === name)!;
      useSubtitleConverterStore.setState({ notStartedTasks: state.notStartedTasks.filter(item => item !== selected), pendingTasks: [selected] });
    });
    executeTasksInStores(["convert"], first.data.taskRefs);
    expect(start.mock.calls).toEqual([["one.srt"]]);
    useSubtitleConverterStore.setState({ pendingTasks: [] });
    expect(start.mock.calls).toEqual([["one.srt"], ["two.srt"]]);
    expect(useSubtitleConverterStore.getState().notStartedTasks.map(item => item.fileName)).toEqual(["old.srt"]);
  });
  it("does not accept a rename confirmation in the preview's creating turn", async () => {
    useAgentStore.setState({ pendingNameTranslationPlan: { planId: "p", createdAt: 1, createdByUserMessageId: "u", summary: {} as never }, session: { ...useAgentStore.getState().session, messages: [{ id: "u", role: "user", content: "确认执行", timestamp: 1 }] } });
    const confirm = vi.spyOn(useAgentStore.getState(), "confirmNameTranslationPlan");
    expect(await executeApplyNameTranslationPlan({ planId: "p" })).toMatchObject({ success: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});
