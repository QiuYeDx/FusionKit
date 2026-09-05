import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SRTTranslator } from "../../electron/main/translation/class/srt-translator";
import { LRCTranslator } from "../../electron/main/translation/class/lrc-translator";
import { sendModelRuntimeText } from "../../electron/main/ai/model-runtime-client";
import { buildCheckpointPaths, createManifest, markFragmentResolved } from "../../electron/main/translation/checkpoint";
import { SubtitleSliceType, TaskStatus, type SubtitleTranslatorTask } from "../../electron/main/translation/typing";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock("../../electron/main/ai/model-runtime-client", () => ({ sendModelRuntimeText: vi.fn() }));

const config = { apiKey: "test-key", endpoint: "https://example.test", apiModel: "test-model" };
const dirs: string[] = [];
function cue(format: "srt" | "lrc", index: number, text: string) {
  return format === "srt"
    ? `${index}\n00:00:0${index},000 --> 00:00:0${index + 1},000\n${text}`
    : `[00:0${index}.00]${text}`;
}
function translator(format: "srt" | "lrc") {
  const Parent = format === "srt" ? SRTTranslator : LRCTranslator;
  return new (class extends Parent {
    constructor() {
      super(config);
      this.retryPolicy = { ...this.retryPolicy, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
      this.maxSliceConcurrency = 2;
    }
  })();
}
async function taskFor(format: "srt" | "lrc", count = 2): Promise<SubtitleTranslatorTask> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-context-"));
  dirs.push(dir);
  return {
    taskId: "subtitle-task-context", fileName: `sample.${format}`,
    fileContent: Array.from({length: count}, (_, i) => cue(format, i + 1, `SOURCE_${i + 1}`)).join(format === "srt" ? "\n\n" : "\n"),
    sliceType: SubtitleSliceType.CUSTOM, customSliceLength: 1,
    originFileURL: "/input/sample", targetFileURL: dir, status: TaskStatus.PENDING,
    executionBinding: {status: "ready", profileId: "profile-test", profileLabel: "Test", apiKey: "test-key", apiModel: "test-model", endPoint: "https://example.test/chat/completions"},
    concurrentSlices: false, translationOutputMode: "target_only",
  };
}
const reply = (content: string) => ({content: content.trim() ? JSON.stringify({cues: [{id: "cue-1", lines: [content.split("\n").at(-1)!.replace(/^\[[^\]]+\]/, "")]}]}) : content, apiFormat: "chat_completions" as const});
function translatedCue(format: "srt" | "lrc", index: number, text: string, mode: string) {
  if (mode !== "bilingual") return cue(format, index, text);
  return format === "srt" ? cue(format, index, `SOURCE_${index}\n${text}`) : `${cue(format, index, `SOURCE_${index}`)}\n${cue(format, index, text)}`;
}
const prompts = () => vi.mocked(sendModelRuntimeText).mock.calls.map(([request]) => request.messages[0].content as string);

beforeEach(() => {
  vi.mocked(sendModelRuntimeText).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    const relative = path.relative(os.tmpdir(), dir);
    if (!relative.startsWith("fusionkit-context-") || relative.includes(path.sep)) throw Error("Unexpected cleanup path");
    await rm(dir, { recursive: true, force: true });
  }
});

describe.each(["srt", "lrc"] as const)("%s context provenance", (format) => {
  it.each(["bilingual", "target_only"] as const)("passes committed translation separately in %s mode", async (mode) => {
    const task = await taskFor(format);
    task.translationOutputMode = mode;
    vi.mocked(sendModelRuntimeText)
      .mockResolvedValueOnce(reply(cue(format, 1, "译文一")))
      .mockResolvedValueOnce(reply(cue(format, 2, "译文二")));
    await translator(format).translate(task);
    const [first, second] = prompts();
    expect(first).not.toContain("Previous source content");
    expect(first).not.toContain("Previous committed model translation");
    expect(second).toContain(`Previous source content (reference only):\n${cue(format, 1, "SOURCE_1")}`);
    expect(second).toContain(`Previous committed model translation (reference only; not human-verified):\n${translatedCue(format, 1, "译文一", mode)}`);
    expect(second).toContain("Do not translate it again or include its cues in the output");
    expect(second).not.toContain("Previous translated content");
    const output = await readFile(path.join(task.targetFileURL, task.fileName), "utf8");
    expect(output).toBe([translatedCue(format, 1, "译文一", mode), translatedCue(format, 2, "译文二", mode)].join(format === "srt" ? "\n\n" : "\n"));
  });

  it("keeps retry context stable and restores the committed predecessor after failure", async () => {
    const task = await taskFor(format);
    vi.mocked(sendModelRuntimeText)
      .mockResolvedValueOnce(reply(cue(format, 1, "已提交译文")))
      .mockResolvedValueOnce(reply(" "))
      .mockResolvedValueOnce(reply(" "));
    await expect(translator(format).translate(task)).rejects.toThrow();
    const failedPrompts = prompts();
    expect(failedPrompts).toHaveLength(3);
    expect(failedPrompts[1]).toBe(failedPrompts[2]);
    task.checkpointPath = buildCheckpointPaths(task.targetFileURL, task.fileName, task.taskId).manifestPath;
    task.recoveryMode = "resume";
    vi.mocked(sendModelRuntimeText).mockResolvedValueOnce(reply(cue(format, 2, "恢复译文")));
    await translator(format).translate(task);
    expect(prompts()).toHaveLength(4);
    expect(prompts()[3]).toBe(failedPrompts[1]);
    expect(prompts()[3]).toContain("已提交译文");
  });

  it("does not pass a failed predecessor or start the following fragment", async () => {
    const task = await taskFor(format);
    vi.mocked(sendModelRuntimeText).mockResolvedValue(reply(" "));
    await expect(translator(format).translate(task)).rejects.toThrow();
    expect(prompts()).toHaveLength(2);
    for (const prompt of prompts()) {
      expect(prompt).not.toContain("SOURCE_2");
      expect(prompt).not.toContain("Previous committed model translation");
    }
  });

  it("keeps parallel requests source-only even after a preceding request finishes", async () => {
    const task = await taskFor(format, 3);
    task.concurrentSlices = true;
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>(resolve => { releaseSecond = resolve; });
    vi.mocked(sendModelRuntimeText).mockImplementation(async request => {
      const prompt = request.messages[0].content as string;
      const current = prompt.split("Translate only the following current subtitle content.")[1];
      if (current.includes("SOURCE_2")) await secondBlocked;
      if (current.includes("SOURCE_3")) releaseSecond();
      return reply(cue(format, 1, "MODEL_RESULT"));
    });
    await translator(format).translate(task);
    expect(prompts()).toHaveLength(3);
    expect(prompts()[2]).toContain("SOURCE_2");
    for (const prompt of prompts()) {
      expect(prompt).not.toContain("MODEL_RESULT");
      expect(prompt).not.toContain("Previous committed model translation");
    }
  });

  it("keeps parallel resume source-only even when checkpoint has a resolved predecessor", async () => {
    const task = await taskFor(format);
    const fragments = [cue(format, 1, "SOURCE_1"), cue(format, 2, "SOURCE_2")];
    const manifest = createManifest(task, fragments);
    markFragmentResolved(manifest.fragments[0], cue(format, 1, "OLD_TRANSLATION"));
    task.checkpointPath = buildCheckpointPaths(task.targetFileURL, task.fileName, task.taskId).manifestPath;
    await writeFile(task.checkpointPath, JSON.stringify(manifest));
    task.concurrentSlices = true;
    task.recoveryMode = "resume";
    vi.mocked(sendModelRuntimeText).mockResolvedValue(reply(cue(format, 2, "NEW_TRANSLATION")));
    await translator(format).translate(task);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain("SOURCE_1");
    expect(prompts()[0]).not.toContain("OLD_TRANSLATION");
  });

  it("retries invalid cue coverage without committing it and accounts for both requests", async () => {
    const task = await taskFor(format, 1);
    vi.mocked(sendModelRuntimeText)
      .mockResolvedValueOnce({ content: '{"cues":[{"id":"cue-9","lines":["WRONG"]}]}', apiFormat: "chat_completions", usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15} })
      .mockResolvedValueOnce({...reply(cue(format, 1, "正确译文")), usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}});
    await translator(format).translate(task);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[0]).toBe(prompts()[1]);
    expect(await readFile(path.join(task.targetFileURL, task.fileName), "utf8")).toBe(cue(format, 1, "正确译文"));
    expect(task.actualUsage).toMatchObject({requestCount: 2, inputTokens: 20, outputTokens: 10});
  });

  it("requeues invalid legacy timing and preserves the old result when replacement fails", async () => {
    const task = await taskFor(format);
    const fragments = [cue(format, 1, "SOURCE_1"), cue(format, 2, "SOURCE_2")];
    const manifest = createManifest(task, fragments);
    const old = cue(format, 9, "BAD_LEGACY");
    markFragmentResolved(manifest.fragments[0], old);
    task.checkpointPath = buildCheckpointPaths(task.targetFileURL, task.fileName, task.taskId).manifestPath;
    await writeFile(task.checkpointPath, JSON.stringify(manifest));
    task.recoveryMode = "resume";
    vi.mocked(sendModelRuntimeText).mockResolvedValue(reply(" "));
    await expect(translator(format).translate(task)).rejects.toThrow();
    const saved = JSON.parse(await readFile(task.checkpointPath, "utf8"));
    expect(saved.fragments[0]).toMatchObject({status: "failed", translatedContent: old});
    expect(prompts()).toHaveLength(2);
    vi.mocked(sendModelRuntimeText)
      .mockResolvedValueOnce(reply(cue(format, 1, "替换译文")))
      .mockResolvedValueOnce(reply(cue(format, 2, "后续译文")));
    await translator(format).translate(task);
    expect(prompts()).toHaveLength(4);
    expect(prompts()[3]).toContain("替换译文");
    for (const prompt of prompts()) expect(prompt).not.toContain("BAD_LEGACY");
    expect(await readFile(path.join(task.targetFileURL, task.fileName), "utf8")).not.toContain("BAD_LEGACY");
  });
});

it.each(["[ar:Artist]\n\n[00:01.00]", "\n[ar:Artist]\n\n[00:01.00]原文\n\n"])("preserves metadata and blank lines through tiny LRC fragments: %j", async content => {
  const task = await taskFor("lrc");
  task.fileContent = content;
  vi.mocked(sendModelRuntimeText).mockResolvedValue(reply("译文"));
  await translator("lrc").translate(task);
  expect(prompts()).toHaveLength(content.includes("原文") ? 1 : 0);
  expect(await readFile(path.join(task.targetFileURL, task.fileName), "utf8")).toBe(content.replace("原文", "译文"));
});

it("splits Windows SRT blocks at the same boundaries used by cue translation", async () => {
  const task = await taskFor("srt");
  task.fileContent = task.fileContent.replace(/\n/g, "\r\n");
  vi.mocked(sendModelRuntimeText)
    .mockResolvedValueOnce(reply("第一句"))
    .mockResolvedValueOnce(reply("第二句"));
  await translator("srt").translate(task);
  expect(prompts()).toHaveLength(2);
  expect(await readFile(path.join(task.targetFileURL, task.fileName), "utf8")).toBe(`${cue("srt", 1, "第一句")}\n\n${cue("srt", 2, "第二句")}`);
});
