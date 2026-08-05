/**
 * 字幕翻译模块 - 翻译器抽象基类
 *
 * 采用模板方法模式，定义翻译的完整流程，子类只需实现格式相关的差异部分：
 *
 *   translate()                  ← 入口（本类实现）
 *     ├─ splitContent()          ← 抽象：按格式拆分字幕为 fragment
 *     ├─ translateFragment()     ← 本类实现：单片翻译（含重试）
 *     │   ├─ formatPrompt()      ← 抽象：构建 LLM prompt
 *     │   └─ parseResponse()     ← 抽象：后处理统一模型文本结果
 *     ├─ writeFile()             ← 本类实现：写入结果文件
 *     └─ updateProgress()        ← 本类实现：通过 IPC 推送进度
 *
 * 子类：LRCTranslator（.lrc 歌词）、SRTTranslator（.srt 字幕）
 */

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SLICE_LENGTH_MAP } from "../constants";
import {
  SubtitleFileType,
  SubtitleSliceType,
  SubtitleTranslatorTask,
  type SubtitleTaskReadyExecutionBinding,
  type TranslationCheckpointManifest,
  type SubtitleTranslationRecovery,
  type SubtitleTranslationRuntimeAuthorization,
} from "../typing";
import { ipcMain, BrowserWindow } from "electron";
import {
  ModelRuntimeClientError,
} from "../../ai/model-runtime-errors";
import {
  sendModelRuntimeText,
  type ModelRuntimeConfig,
  type ModelRuntimeTextResult,
} from "../../ai/model-runtime-client";
import {
  createManifest,
  loadManifest,
  validateManifest,
  validateManifestSelfContained,
  getManifestFragments,
  toCurrentManifest,
  CheckpointWriter,
  buildCheckpointPaths,
  type CheckpointArtifactPaths,
  getIncompleteIndexes,
  getResolvedCount,
  allFragmentsResolved,
  markFragmentRunning,
  markFragmentResolved,
  markFragmentFailed,
  buildRecoverySummary,
  saveCompletionSummary,
} from "../checkpoint";
import {
  flushRecoveryArtifacts,
  buildFinalContent,
  cleanupOnSuccess,
} from "../recovery-artifacts";

/**
 * 当 execution binding 未设置 maxOutputTokens 时的默认最大输出 token 数。
 * 8192 对大多数翻译场景足够；带有 inferMaxOutputTokens 推断的任务不会命中此值。
 */
const DEFAULT_MAX_RESPONSE_TOKENS = 8192;

/** length_truncated 重试时 maxResponseTokens 翻倍的上限天花板 */
const MAX_RESPONSE_TOKEN_CEILING = 128_000;

type OutputConflictPolicy = "overwrite" | "index";
type TranslationFragmentMeta = {
  index: number;
  total: number;
};

function readyExecution(
  task: SubtitleTranslatorTask,
): SubtitleTaskReadyExecutionBinding {
  if (task.executionBinding.status !== "ready") {
    throw new Error("configuration_required");
  }
  return task.executionBinding;
}

export abstract class BaseTranslator {
  /** 子类实现：将字幕文本按 token 上限拆分为多个 fragment */
  protected abstract splitContent(content: string, maxTokens: number): string[];
  /** 子类实现：根据当前 fragment 和上文 context 构建发给 LLM 的 prompt */
  protected abstract formatPrompt(
    partialContent: string,
    context: string,
  ): string;

  protected maxRetries = 5;
  /** 基础重试延迟（实际延迟 = retryDelay × 已尝试次数，线性退避） */
  protected retryDelay = 1000;
  /** 并发模式下同时翻译的最大分片数 */
  protected maxSliceConcurrency = 5;

  protected sourceLang: string = "JA";
  protected targetLang: string = "ZH";
  protected bilingualOutput: boolean = true;
  private maxResponseTokens: number = 4096;
  protected fragmentSeparator: string = "\n\n";

  /**
   * 翻译主流程（模板方法）。
   *
   * 执行步骤：
   *   1. 初始化语言设置
   *   2. 将字幕内容拆分为多个 fragment（由子类 splitContent 实现）
   *   3. 创建或加载 checkpoint manifest
   *   4. 跳过 checkpoint 中已成功的分片，只翻译 pending/failed 分片
   *   5. 每个分片成功后更新 checkpoint 并刷新 completed/remaining
   *   6. 全部分片完成后合并最终文件
   *   7. 通过 IPC 通知渲染进程翻译结果（成功/失败）
   */
  async translate(
    task: SubtitleTranslatorTask,
    signal?: AbortSignal,
    runtimeAuthorization?: SubtitleTranslationRuntimeAuthorization,
  ) {
    this.sourceLang = task.sourceLang || "JA";
    this.targetLang = task.targetLang || "ZH";
    this.bilingualOutput = task.translationOutputMode !== "target_only";

    const errorLogs: string[] = [];
    const startTime = new Date().toISOString();
    const outputDir = path.resolve(task.targetFileURL);

    let manifest: TranslationCheckpointManifest | undefined;
    let manifestPath: string | undefined;
    let artifactPaths: CheckpointArtifactPaths | undefined;
    let checkpointRef: string | undefined;
    let cpWriter: CheckpointWriter | undefined;

    try {
      console.log("[01] start process file:", task.fileName);
      errorLogs.push(
        `[${new Date().toISOString()}] 开始处理文件: ${task.fileName}`,
      );

      const content = task.fileContent;
      console.log("[02] content length:", content.length);
      errorLogs.push(
        `[${new Date().toISOString()}] 文件内容长度: ${content.length}`,
      );

      const maxTokens = this.getMaxTokens(task);
      this.maxResponseTokens = this.resolveMaxResponseTokens(task);
      console.log("[03] max token num:", maxTokens, "response max:", this.maxResponseTokens);
      errorLogs.push(`[${new Date().toISOString()}] 最大Token数: ${maxTokens}, 响应Token上限: ${this.maxResponseTokens}`);

      let fragments: string[];

      // ── checkpoint 加载或创建 ─────────────────────────────────────────
      await runtimeAuthorization?.revalidateTarget();
      await fs.mkdir(outputDir, { recursive: true });
      const paths = buildCheckpointPaths(outputDir, task.fileName, task.taskId);
      artifactPaths = paths;
      manifestPath = paths.manifestPath;

      const recoveryMode = task.recoveryMode || "auto";
      const recoveryInputMode = (task as any).recoveryInputMode;

      if (
        recoveryMode !== "restart" &&
        task.checkpointPath &&
        recoveryInputMode === "manifest_fragments"
      ) {
        // manifest_fragments 模式：直接使用 manifest 中的分片，不依赖源文件
        try {
          const loaded = await loadManifest(task.checkpointPath);
          const selfValidation = validateManifestSelfContained(loaded);
          if (selfValidation.valid) {
            manifest = toCurrentManifest(loaded);
            manifest.status = "running";
            manifest.updatedAt = new Date().toISOString();
            fragments = getManifestFragments(manifest);
            errorLogs.push(
              `[${new Date().toISOString()}] manifest_fragments 模式续跑，已完成 ${getResolvedCount(manifest)}/${manifest.fragments.length} 个分片`,
            );
          } else {
            throw new Error(`Manifest 自校验失败: ${selfValidation.reason}`);
          }
        } catch (e) {
          if (recoveryMode === "resume") throw e;
          errorLogs.push(
            `[${new Date().toISOString()}] manifest_fragments 加载失败，回退到常规分片`,
          );
          fragments = this.splitContent(content, maxTokens);
        }
      } else {
        fragments = this.splitContent(content, maxTokens);

        if (recoveryMode !== "restart" && task.checkpointPath) {
          try {
            const loaded = await loadManifest(task.checkpointPath);
            const validation = validateManifest(loaded, task, fragments);
            if (validation.valid) {
              manifest = toCurrentManifest(loaded);
              manifest.status = "running";
              manifest.updatedAt = new Date().toISOString();
              errorLogs.push(
                `[${new Date().toISOString()}] 从 checkpoint 续跑，已完成 ${getResolvedCount(manifest)}/${manifest.fragments.length} 个分片`,
              );
            } else {
              const reason = validation.reason;
              errorLogs.push(
                `[${new Date().toISOString()}] Checkpoint 校验失败: ${reason}`,
              );
              if (recoveryMode === "resume") {
                throw new Error(`续跑文件与当前任务不匹配: ${reason}`);
              }
            }
          } catch (e) {
            if (recoveryMode === "resume") throw e;
            errorLogs.push(
              `[${new Date().toISOString()}] 加载 checkpoint 失败，将重新开始`,
            );
          }
        }
      }

      console.log("[04] fragments num:", fragments.length);
      errorLogs.push(
        `[${new Date().toISOString()}] 分片数量: ${fragments.length}`,
      );

      if (!manifest) {
        manifest = createManifest(task, fragments);
      }

      cpWriter = new CheckpointWriter(manifestPath);
      await cpWriter.write(manifest);
      checkpointRef = await runtimeAuthorization?.authorizeCheckpoint(
        manifestPath,
      );
      await flushRecoveryArtifacts(manifest, paths);

      const resolvedBefore = getResolvedCount(manifest);
      this.updateProgress(
        task,
        resolvedBefore,
        fragments.length,
        manifest,
        checkpointRef,
        runtimeAuthorization,
      );

      // ── 翻译分片 ─────────────────────────────────────────────────────
      if (task.concurrentSlices && fragments.length > 1) {
        errorLogs.push(
          `[${new Date().toISOString()}] 并发模式，最大并发数: ${this.maxSliceConcurrency}`,
        );
        await this.translateFragmentsConcurrently(
          fragments,
          task,
          signal,
          errorLogs,
          manifest,
          cpWriter,
          paths,
          checkpointRef,
          runtimeAuthorization,
        );
      } else {
        await this.translateFragmentsSequentially(
          fragments,
          task,
          signal,
          errorLogs,
          manifest,
          cpWriter,
          paths,
          checkpointRef,
          runtimeAuthorization,
        );
      }

      // ── 合并最终文件 ──────────────────────────────────────────────────
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      if (!allFragmentsResolved(manifest)) {
        throw new Error("存在未完成的分片，无法生成最终文件");
      }

      const translatedContent = buildFinalContent(manifest, this.fragmentSeparator);

      errorLogs.push(
        `[${new Date().toISOString()}] 开始写入最终字幕文件`,
      );
      await runtimeAuthorization?.revalidateTarget();
      const finalPath = await this.writeFile(
        task.targetFileURL,
        translatedContent,
        task.fileName,
        task.conflictPolicy,
        runtimeAuthorization,
      );
      errorLogs.push(
        `[${new Date().toISOString()}] 最终字幕文件写入完成: ${path.basename(finalPath)}`,
      );

      manifest.status = "completed";
      manifest.updatedAt = new Date().toISOString();
      await cpWriter.write(manifest);

      await runtimeAuthorization?.recordFinalOutput(finalPath);
      await saveCompletionSummary(
        paths.completionSummaryPath,
        manifest,
        path.basename(finalPath),
      );
      const cleanupFailures = await cleanupOnSuccess(paths);
      for (const failure of cleanupFailures) {
        const warning = `Recovery ${failure.artifact} cleanup failed after bounded retries: ${failure.reason}`;
        console.warn(`[base-translator] ${warning}`);
        errorLogs.push(`[${new Date().toISOString()}] ${warning}`);
      }
      runtimeAuthorization?.releaseCheckpoint();
      checkpointRef = undefined;

      this.emit(runtimeAuthorization, "task-resolved", {
        taskId: task.taskId,
        fileName: task.fileName,
        outputFileName: path.basename(finalPath),
      });

      this.updateProgress(
        task,
        fragments.length,
        fragments.length,
        undefined,
        undefined,
        runtimeAuthorization,
      );
      errorLogs.push(`[${new Date().toISOString()}] 任务完成`);
    } catch (error) {
      const errorDetails =
        error instanceof Error ? error.message : String(error);
      const stackTrace = error instanceof Error ? error.stack : "无堆栈信息";

      errorLogs.push(`[${new Date().toISOString()}] 任务失败: ${errorDetails}`);
      if (stackTrace) {
        errorLogs.push(`[${new Date().toISOString()}] 堆栈跟踪: ${stackTrace}`);
      }

      // flush checkpoint & recovery artifacts on failure
      let recovery: SubtitleTranslationRecovery | undefined;
      if (manifest && cpWriter && manifestPath && artifactPaths) {
        try {
          manifest.status = error instanceof Error && error.name === "AbortError"
            ? "cancelled"
            : "failed";
          manifest.updatedAt = new Date().toISOString();
          await cpWriter.write(manifest);
          if (runtimeAuthorization) {
            checkpointRef = await runtimeAuthorization.authorizeCheckpoint(
              manifestPath,
            );
          }
          await flushRecoveryArtifacts(manifest, artifactPaths, errorLogs);
          recovery = checkpointRef
            ? buildRecoverySummary(manifest, checkpointRef)
            : undefined;
        } catch (flushErr) {
          console.error("[base-translator] flush checkpoint failed:", flushErr);
        }
      }

      this.emit(runtimeAuthorization, "task-failed", {
        taskId: task.taskId,
        fileName: task.fileName,
        error: errorDetails,
        message: "请求接口失败",
        errorLogs: errorLogs,
        timestamp: startTime,
        stackTrace: stackTrace,
        recovery,
      });

      console.error("[base-translator] error in translating:", error);
      throw error;
    }
  }

  /**
   * 顺序翻译：逐片调用 LLM，前一片的原文作为 context 传入下一片的 prompt。
   * 已在 checkpoint 中标记为 resolved 的分片会被跳过。
   */
  private async translateFragmentsSequentially(
    fragments: string[],
    task: SubtitleTranslatorTask,
    signal: AbortSignal | undefined,
    errorLogs: string[],
    manifest: TranslationCheckpointManifest,
    cpWriter: CheckpointWriter,
    artifactPaths: CheckpointArtifactPaths,
    checkpointRef: string | undefined,
    runtimeAuthorization: SubtitleTranslationRuntimeAuthorization | undefined,
  ): Promise<void> {
    const incompleteSet = new Set(getIncompleteIndexes(manifest));

    for (const [index, fragment] of fragments.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      if (!incompleteSet.has(index)) {
        continue;
      }

      const cpFragment = manifest.fragments[index];
      markFragmentRunning(cpFragment, readyExecution(task).apiModel);

      try {
        errorLogs.push(
          `[${new Date().toISOString()}] 开始翻译第 ${index + 1}/${fragments.length} 个分片`,
        );

        const result = await this.translateFragment(
          fragment,
          index > 0 ? fragments[index - 1] : "",
          task,
          errorLogs,
          signal,
          { index: index + 1, total: fragments.length },
        );

        markFragmentResolved(cpFragment, result);
        manifest.updatedAt = new Date().toISOString();
        await cpWriter.write(manifest);
        await flushRecoveryArtifacts(manifest, artifactPaths);

        const resolved = getResolvedCount(manifest);
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${index + 1} 个分片翻译完成 (${resolved}/${fragments.length})`,
        );
        this.updateProgress(
          task,
          resolved,
          fragments.length,
          manifest,
          checkpointRef,
          runtimeAuthorization,
        );
      } catch (fragmentError) {
        markFragmentFailed(
          cpFragment,
          fragmentError instanceof Error
            ? fragmentError.message
            : String(fragmentError),
        );
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${index + 1} 个分片翻译失败: ${fragmentError instanceof Error ? fragmentError.message : String(fragmentError)}`,
        );
        throw fragmentError;
      }
    }
  }

  /**
   * 并发翻译：启动 N 个 worker 竞争消费未完成的 fragment 队列。
   * checkpoint 写入通过 CheckpointWriter 串行化，避免竞态。
   */
  private async translateFragmentsConcurrently(
    fragments: string[],
    task: SubtitleTranslatorTask,
    signal: AbortSignal | undefined,
    errorLogs: string[],
    manifest: TranslationCheckpointManifest,
    cpWriter: CheckpointWriter,
    artifactPaths: CheckpointArtifactPaths,
    checkpointRef: string | undefined,
    runtimeAuthorization: SubtitleTranslationRuntimeAuthorization | undefined,
  ): Promise<void> {
    const pendingIndexes = getIncompleteIndexes(manifest);
    if (pendingIndexes.length === 0) return;

    let cursor = 0;
    let failed = false;

    const worker = async (): Promise<void> => {
      while (!failed) {
        const pos = cursor++;
        if (pos >= pendingIndexes.length) break;
        const index = pendingIndexes[pos];
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const fragment = fragments[index];
        const context = index > 0 ? fragments[index - 1] : "";
        const cpFragment = manifest.fragments[index];
        markFragmentRunning(cpFragment, readyExecution(task).apiModel);

        try {
          errorLogs.push(
            `[${new Date().toISOString()}] [并发] 开始翻译第 ${index + 1}/${fragments.length} 个分片`,
          );

          const result = await this.translateFragment(
            fragment,
            context,
            task,
            errorLogs,
            signal,
            { index: index + 1, total: fragments.length },
          );

          markFragmentResolved(cpFragment, result);
          manifest.updatedAt = new Date().toISOString();
          await cpWriter.write(manifest);
          await flushRecoveryArtifacts(manifest, artifactPaths);

          const resolved = getResolvedCount(manifest);
          errorLogs.push(
            `[${new Date().toISOString()}] [并发] 第 ${index + 1} 个分片翻译完成 (${resolved}/${fragments.length})`,
          );
          this.updateProgress(
            task,
            resolved,
            fragments.length,
            manifest,
            checkpointRef,
            runtimeAuthorization,
          );
        } catch (err) {
          failed = true;
          markFragmentFailed(
            cpFragment,
            err instanceof Error ? err.message : String(err),
          );
          errorLogs.push(
            `[${new Date().toISOString()}] [并发] 第 ${index + 1} 个分片翻译失败: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      }
    };

    const workerCount = Math.min(this.maxSliceConcurrency, pendingIndexes.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  /** 更新任务进度并通过 IPC "update-progress" 事件推送给渲染进程 */
  private updateProgress(
    task: SubtitleTranslatorTask,
    current: number,
    total: number,
    manifest?: TranslationCheckpointManifest,
    checkpointRef?: string,
    runtimeAuthorization?: SubtitleTranslationRuntimeAuthorization,
  ) {
    task.resolvedFragments = current;
    task.totalFragments = total;
    task.progress = Math.round((current / total) * 100);

    const payload: Record<string, unknown> = {
      taskId: task.taskId,
      fileName: task.fileName,
      resolvedFragments: current,
      totalFragments: total,
      progress: task.progress,
    };

    if (manifest && checkpointRef) {
      payload.recovery = {
        checkpointRef,
        resumable: true,
        resolvedFragments: getResolvedCount(manifest),
        totalFragments: manifest.fragments.length,
      } satisfies Pick<
        SubtitleTranslationRecovery,
        "checkpointRef" | "resumable" | "resolvedFragments" | "totalFragments"
      >;
    }

    this.emit(runtimeAuthorization, "update-progress", payload);
  }

  private emit(
    runtimeAuthorization: SubtitleTranslationRuntimeAuthorization | undefined,
    channel: string,
    payload: unknown,
  ): void {
    if (runtimeAuthorization) {
      runtimeAuthorization.emit(channel, payload);
      return;
    }
    const mainWindow = BrowserWindow.getAllWindows()[0];
    mainWindow?.webContents.send(channel, payload);
  }

  /**
   * 将翻译结果写入目标文件。
   * 当 conflictPolicy 为 "index" 时，若文件已存在则自动追加序号：
   *   output.srt → output (1).srt → output (2).srt → ...
   */
  private async writeFile(
    fileURL: string,
    content: string,
    fileName: string,
    conflictPolicy: OutputConflictPolicy = "index",
    runtimeAuthorization?: SubtitleTranslationRuntimeAuthorization,
  ) {
    try {
      const absoluteOutputDir = path.resolve(fileURL);
      await fs.mkdir(absoluteOutputDir, { recursive: true });

      const parsed = path.parse(fileName);
      let finalPath = path.join(absoluteOutputDir, parsed.base);
      if (conflictPolicy !== "overwrite") {
        let index = 1;
        while (true) {
          try {
            await fs.access(finalPath);
            finalPath = path.join(
              absoluteOutputDir,
              `${parsed.name} (${index})${parsed.ext}`,
            );
            index++;
          } catch {
            break;
          }
        }
      }

      await runtimeAuthorization?.validateOutputPath(finalPath);
      const temporaryLeaf = buildTemporaryOutputLeaf(parsed.ext);
      const temporaryPath = path.join(absoluteOutputDir, temporaryLeaf);
      await runtimeAuthorization?.validateOutputPath(temporaryPath);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(content, "utf-8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await runtimeAuthorization?.revalidateTarget();
        await fs.rename(temporaryPath, finalPath);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      console.log("文件已成功写入:", path.basename(finalPath));
      return finalPath;
    } catch (error) {
      console.error("写入文件时出错:", error);
      throw new Error("无法写入文件");
    }
  }

  /**
   * 确定 API 请求的 max_tokens：
   *   1. 优先使用任务级别的 maxOutputTokens（由模型配置传入，反映模型的真实能力上限）
   *   2. 兜底使用 DEFAULT_MAX_RESPONSE_TOKENS
   *
   * 不再按分片大小做比例计算——max_tokens 是上限而非目标，模型不会因为上限高就多输出；
   * 但上限设得太低会导致 finish_reason=length 截断错误。
   */
  private resolveMaxResponseTokens(task: SubtitleTranslatorTask): number {
    if (
      typeof readyExecution(task).maxOutputTokens === "number" &&
      Number.isFinite(readyExecution(task).maxOutputTokens) &&
      readyExecution(task).maxOutputTokens! > 0
    ) {
      return readyExecution(task).maxOutputTokens!;
    }
    return DEFAULT_MAX_RESPONSE_TOKENS;
  }

  private getMaxTokens(task: SubtitleTranslatorTask) {
    if (
      task.sliceType === SubtitleSliceType.CUSTOM &&
      Number.isFinite(task.customSliceLength) &&
      task.customSliceLength &&
      task.customSliceLength > 0
    ) {
      return Math.floor(task.customSliceLength);
    }

    return DEFAULT_SLICE_LENGTH_MAP[task.sliceType];
  }

  private logEmptyTranslationResult(
    responseData: ModelRuntimeTextResult,
    parsedResult: unknown,
    errorLogs: string[],
    fragmentMeta?: TranslationFragmentMeta,
  ) {
    const rawContent = responseData.content;
    const rawLength = typeof rawContent === "string" ? rawContent.length : 0;
    const parsedLength =
      typeof parsedResult === "string" ? parsedResult.length : 0;
    const hasMessageContent = typeof rawContent === "string";
    const fragmentLabel = fragmentMeta
      ? `第 ${fragmentMeta.index}/${fragmentMeta.total} 个分片`
      : "未知分片";

    errorLogs.push(
      `[${new Date().toISOString()}] 翻译结果为空 (${fragmentLabel})，模型文本长度: ${rawLength}，清洗后长度: ${parsedLength}，content存在: ${hasMessageContent ? "是" : "否"}`,
    );

    const preview = this.createLogPreview(rawContent);
    if (preview) {
      errorLogs.push(
        `[${new Date().toISOString()}] 原始返回预览: ${preview}`,
      );
    }
  }

  private createLogPreview(value: unknown, maxLength = 500): string {
    if (typeof value !== "string") return "";

    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) return "";

    return compact.length > maxLength
      ? `${compact.slice(0, maxLength)}...`
      : compact;
  }

  /**
   * 翻译单个 fragment：构建 prompt → 调用 LLM API → 解析返回。
   * 内置线性退避重试机制（最多 maxRetries 次），每次失败后延迟递增。
   *
   * 模型请求由 ModelRuntimeClient 负责 endpoint、API 格式、错误分类与 think 标签清理。
   */
  private async translateFragment(
    content: string,
    context: string,
    task: SubtitleTranslatorTask,
    errorLogs: string[],
    signal?: AbortSignal,
    fragmentMeta?: TranslationFragmentMeta,
  ): Promise<string> {
    const prompt = this.formatPrompt(content, context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      try {
        errorLogs.push(
          `[${new Date().toISOString()}] 尝试第 ${attempt}/${this.maxRetries} 次翻译请求`,
        );

        const response = await sendModelRuntimeText({
          model: this.createRuntimeModelConfig(task),
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          maxOutputTokens: this.maxResponseTokens,
          signal,
          retry: { maxRetries: 0 },
        });

        console.log("翻译响应数据:", response);
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${attempt} 次翻译请求成功`,
        );

        const finishReason = response.finishReason;
        if (finishReason === "length") {
          errorLogs.push(
            `[${new Date().toISOString()}] 警告: 翻译结果可能因达到token上限被截断 (finish_reason=length, max_tokens=${this.maxResponseTokens})`,
          );
        }

        const parsedResult = await this.parseResponse(response);
        if (
          typeof parsedResult !== "string" ||
          parsedResult.trim().length === 0
        ) {
          this.logEmptyTranslationResult(
            response,
            parsedResult,
            errorLogs,
            fragmentMeta,
          );
          throw new Error("Translation result is empty after parsing");
        }

        return parsedResult;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${attempt} 次翻译尝试失败: ${errorMessage}`,
        );

        if (error instanceof ModelRuntimeClientError) {
          errorLogs.push(
            `[${new Date().toISOString()}] 模型错误码: ${error.code}`,
          );
          if (error.details.status !== undefined) {
            errorLogs.push(
              `[${new Date().toISOString()}] HTTP状态码: ${error.details.status}`,
            );
          }
        }

        console.error(`第 ${attempt} 次翻译尝试失败:`, error);

        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        if (error instanceof ModelRuntimeClientError && !error.retryable) {
          if (
            error.code === "length_truncated" &&
            attempt < this.maxRetries
          ) {
            const increased = Math.min(
              this.maxResponseTokens * 2,
              MAX_RESPONSE_TOKEN_CEILING,
            );
            if (increased > this.maxResponseTokens) {
              this.maxResponseTokens = increased;
              errorLogs.push(
                `[${new Date().toISOString()}] 输出被截断，自动提升输出token上限至 ${this.maxResponseTokens} 后重试`,
              );
            } else {
              errorLogs.push(
                `[${new Date().toISOString()}] 输出被截断且已达最大token上限 ${MAX_RESPONSE_TOKEN_CEILING}，无法继续`,
              );
              throw this.normalizeError(error);
            }
          } else {
            throw this.normalizeError(error);
          }
        }

        if (attempt === this.maxRetries) {
          errorLogs.push(
            `[${new Date().toISOString()}] 已达到最大重试次数，翻译失败`,
          );
          throw this.normalizeError(error);
        }

        const delay = this.resolveRetryDelay(error, attempt);
        errorLogs.push(`[${new Date().toISOString()}] 等待 ${delay}ms 后重试`);
        await this.abortableDelay(delay, signal);
      }
    }

    throw new Error("所有翻译尝试都失败了");
  }

  private createRuntimeModelConfig(
    task: SubtitleTranslatorTask,
  ): ModelRuntimeConfig {
    return {
      apiKey: readyExecution(task).apiKey,
      modelKey: readyExecution(task).apiModel,
      endpoint: readyExecution(task).endPoint,
      apiFormat: readyExecution(task).apiFormat ?? "chat_completions",
      outputTokenParameter: readyExecution(task).outputTokenParameter,
    };
  }

  private resolveRetryDelay(error: unknown, attempt: number): number {
    if (
      error instanceof ModelRuntimeClientError &&
      error.details.retryAfterMs !== undefined
    ) {
      return Math.max(0, error.details.retryAfterMs);
    }
    return this.retryDelay * attempt;
  }

  /** 子类实现：从统一模型文本结果中后处理翻译文本 */
  protected abstract parseResponse(
    responseData: ModelRuntimeTextResult,
  ): Promise<string>;
  /** 子类实现：将未知错误标准化为 Error 对象 */
  protected abstract normalizeError(error: unknown): Error;

  private abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 处理 429 速率限制：读取 Retry-After 头并等待对应时间（预留扩展，当前未被调用） */
  private async handleRateLimit(response: Response) {
    const retryAfter = response.headers.get("Retry-After") || "5";
    const delay = parseInt(retryAfter) * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
}

function buildTemporaryOutputLeaf(extension: string): string {
  const safeExtension = extension.length <= 16 ? extension : "";
  return `.fusionkit-${randomUUID()}${safeExtension}.tmp`;
}
