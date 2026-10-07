import type {
  ScanSubtitleFilesArgs,
  QueueTranslateArgs,
  QueueConvertArgs,
  QueueExtractArgs,
  InspectRenamePathsArgs,
  CreateNameTranslationPlanArgs,
  ApplyNameTranslationPlanArgs,
  ScanSubtitleRecoveryTasksArgs,
  QueueRecoveredSubtitleTranslateArgs,
} from "./tool-schemas";
import type { TaskStoreType, AgentTaskReference } from "./types";
import {
  TaskStatus,
  type SubtitleConverterTask,
  type SubtitleExtractorTask,
  type SubtitleTranslatorTask,
} from "@/type/subtitle";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useModelStore from "@/store/useModelStore";
import useAgentStore, { executeTasksInStores } from "@/store/agent/useAgentStore";
import {
  estimateSubtitleTokensFast,
  estimateSubtitleTokens,
} from "@/utils/tokenEstimate";
import {
  createScanResultPayload,
  resolveQueueFileSelection,
  type QueueFileSelection,
} from "./queue-batch";
import { resolveTranslationSliceConfig } from "./translation-slice-config";
import type {
  SubtitleSliceType,
  TranslationLanguage,
  TranslationOutputMode,
} from "@/type/subtitle";
import { createAgentNamePlan } from "@/services/name-translation/agentPlan";
import { getNameTranslationApi, unwrap as unwrapNameTranslation } from "@/services/name-translation/api";
import type { NameEntry } from "@/name-translation/contract";
import { isExplicitRenameConfirmation } from "./name-plan-confirmation";
import {
  prepareRecoveredSubtitleTasks,
  revokeTranslationRecoveryScan,
  selectTranslationRecoveryDirectory,
  selectTranslationRecoveryManifest,
} from "@/services/subtitle/translatorRecoveryService";
import { createSubtitleTaskExecutionBinding } from "./task-model-config";
import { createSubtitleTranslatorTask } from "@/services/subtitle/subtitleTranslatorTaskFactory";
import { releaseSubtitleTranslationTaskAuthority } from "@/services/subtitle/translatorExecutionService";

// ---------------------------------------------------------------------------
// Tool Executor — 工具执行函数（由 AI SDK tool() 的 execute 调用）
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
}

// ---------------------------------------------------------------------------
// 执行模式处理 — 入队后根据模式决定是否立即执行
// ---------------------------------------------------------------------------

function handlePostQueue(
  storeType: TaskStoreType,
  taskIds: string[],
  result: ToolExecutionResult,
  cancelled = false,
): ToolExecutionResult {
  const refs: AgentTaskReference[] = taskIds.map((taskId) => ({ store: storeType, taskId }));
  result.data = { ...result.data, taskRefs: refs, ...(cancelled ? { cancelled: true } : {}) };
  if (!taskIds.length) return result;
  const { executionMode, pendingExecution } = useAgentStore.getState();
  if (cancelled) {
    result.data = { ...result.data, executionMode, executionStatus: "queued_only" };
    return result;
  }
  if (executionMode === "auto_execute") {
    const receipt = executeTasksInStores([storeType], refs);
    result.data = { ...result.data, ...receipt, executionMode, executionStatus: receipt.startedCount === taskIds.length ? "started" : "partially_started" };
  } else if (executionMode === "ask_before_execute") {
    const previous = pendingExecution?.resolvedAction ? null : pendingExecution;
    const taskRefs = [...(previous?.taskRefs ?? []), ...refs];
    const stores = [...new Set(taskRefs.map((ref) => ref.store))];
    const taskCounts = Object.fromEntries(stores.map((store) => [store, taskRefs.filter((ref) => ref.store === store).length]));
    useAgentStore.getState().setPendingExecution({ stores, taskCounts, taskRefs, timestamp: Date.now() });
    result.data = { ...result.data, executionMode, executionStatus: "pending_confirmation" };
  } else {
    result.data = { ...result.data, executionMode, executionStatus: "queued_only" };
  }
  return result;
}

function executionFence(signal?: AbortSignal) {
  const sessionId = useAgentStore.getState().session.id;
  return () => {
    signal?.throwIfAborted();
    if (useAgentStore.getState().session.id !== sessionId) {
      throw new DOMException("Agent session changed.", "AbortError");
    }
  };
}

// ---------------------------------------------------------------------------
// scan_subtitle_files
// ---------------------------------------------------------------------------

export async function executeScan(
  args: ScanSubtitleFilesArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  const allFiles: Array<{
    absolutePath: string;
    fileName: string;
    extension: string;
    size: number;
    sourceDirectory: string;
  }> = [];

  for (const dir of args.directories) {
    try {
      check();
      const result = await window.ipcRenderer.invoke("scan-directory", {
        directory: dir,
        extensions: args.extensions,
        recursive: args.recursive,
        maxFiles: 10000,
      });
      check();
      if (result?.files) {
        for (const f of result.files) {
          allFiles.push({
            absolutePath: f.absolutePath,
            fileName: f.fileName,
            extension: f.extension,
            size: f.size,
            sourceDirectory: f.sourceDirectory ?? dir,
          });
        }
      }
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to scan directory "${dir}": ${err?.message || err}`,
      };
    }
  }

  check();
  const deduped = deduplicateByPath(allFiles);

  return {
    success: true,
    data: createScanResultPayload(deduped, args.directories),
  };
}

// ---------------------------------------------------------------------------
// inspect_rename_paths
// ---------------------------------------------------------------------------

export async function executeInspectRenamePaths(
  args: InspectRenamePathsArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  try {
    const result = await unwrapNameTranslation(
      getNameTranslationApi().inspectPaths({ paths: args.paths, source: "agent" }),
    );
    check();

    return {
      success: true,
      data: {
        paths: [
          ...result.entries.map(enrichInspectedNameEntry),
          ...result.rejected.map((rejection) => ({
            path: rejection.path,
            exists: rejection.reason !== "missing",
            rejected: rejection.reason,
            suggestedScopes: [],
          })),
        ],
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to inspect rename paths: ${err?.message || err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// create_name_translation_plan
// ---------------------------------------------------------------------------

export async function executeCreateNameTranslationPlan(
  args: CreateNameTranslationPlanArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  try {
    const summary = await createAgentNamePlan(
      {
        roots: args.roots,
        scope: args.scope,
        targetKind: args.targetKind,
        includeRoots: args.includeRoots,
        includeHidden: args.includeHidden,
        sourceLang: args.sourceLang,
        targetLang: args.targetLang,
        nameFormat: args.nameFormat,
        instructions: args.instructions,
      },
      signal,
    );
    check();
    const requiresConfirmation = summary.applyable;
    const executionStatus = summary.applyable ? "preview_created" : "nothing_to_apply";

    const store = useAgentStore.getState();
    if (requiresConfirmation) {
      check();
      store.setPendingNameTranslationPlan({
        planId: summary.planId,
        createdAt: Date.now(),
        createdByUserMessageId: [...store.session.messages].reverse().find((message) => message.role === "user")?.id,
        summary,
        resolvedAction: null,
      });
    }
    store.appendLog(
      "name_translation_plan",
      `Created rename plan ${summary.planId}`,
      {
        planId: summary.planId,
        readyCount: summary.readyCount,
        blockedCount: summary.blockedCount,
        skippedCount: summary.skippedCount,
        unchangedCount: summary.unchangedCount,
        applyable: summary.applyable,
        executionStatus,
      }
    );

    return {
      success: true,
      data: {
        ...summary,
        requiresConfirmation,
        executionStatus,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to create name translation plan: ${err?.message || err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// apply_name_translation_plan
// ---------------------------------------------------------------------------

export async function executeApplyNameTranslationPlan(
  args: ApplyNameTranslationPlanArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  const store = useAgentStore.getState();
  const pending = store.pendingNameTranslationPlan;
  const latestUser = [...store.session.messages].reverse().find((message) => message.role === "user");
  if (!pending || pending.planId !== args.planId || pending.resolvedAction || pending.isApplying ||
      !pending.createdByUserMessageId || !latestUser || latestUser.id === pending.createdByUserMessageId ||
      !isExplicitRenameConfirmation(latestUser.content, args.planId)) {
    return { success: false, error: "请在预览后的新一轮消息中明确确认当前重命名计划，或使用预览中的确认按钮。", data: { planId: args.planId, executionStatus: "confirmation_required" } };
  }
  const result = await store.confirmNameTranslationPlan(args.planId, signal);
  if (result) return { success: true, data: { ...result, executionStatus: "applied" } };
  return { success: false, error: useAgentStore.getState().pendingNameTranslationPlan?.error ?? "重命名计划未执行。", data: { planId: args.planId, executionStatus: "not_applied" } };
}

// ---------------------------------------------------------------------------
// queue_subtitle_translate
// ---------------------------------------------------------------------------

export async function executeQueueTranslate(
  args: QueueTranslateArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  if (containsLegacyAgentTranslateAuthority(args)) {
    return { success: false, error: "字幕翻译不接受 filePaths、scanId 或 outputDir。请通过 FusionKit 文件选择器重新授权。" };
  }
  const store = useSubtitleTranslatorStore.getState();
  const taskProfile = useModelStore.getState().getTaskProfile();
  if (!taskProfile?.apiKey) return { success: false, error: "未配置任务执行模型，请在设置页面配置。" };
  const api = getSubtitleTranslationApi();
  const taskIds: string[] = [];
  const errors: string[] = [];
  let directoryToken: string | undefined;
  let selectionRef: string | undefined;
  let totalFiles = 0;
  let cancelled = false;
  try {
    await flushPendingAgentTranslationRevocations();
    check();
    if (args.outputMode === "custom") {
      const directory = await api.selectOutputDirectory();
      if (directory.ok) directoryToken = directory.data.directoryToken;
      check();
      if (!directory.ok) return { success: false, error: `无法授权字幕输出目录：${directory.error.code}` };
      if (directory.data.cancelled) return { success: false, error: "已取消字幕输出目录选择，未创建翻译任务。" };
    }
    const selected = await api.selectAgentInputFiles();
    if (selected.ok && !selected.data.cancelled) selectionRef = selected.data.selectionRef;
    check();
    if (!selected.ok) return { success: false, error: `无法授权字幕输入文件：${selected.error.code}` };
    if (selected.data.cancelled) return { success: false, error: "已取消字幕文件选择，未创建翻译任务。" };
    const selection = selected.data;
    totalFiles = selection.files.length;
    const sliceConfig = resolveTranslationSliceConfig(args, getLatestUserMessageContent());
    const sourceLang = (args.sourceLang || "JA") as TranslationLanguage;
    const targetLang = (args.targetLang || "ZH") as TranslationLanguage;
    const translationOutputMode = (args.translationOutputMode || "bilingual") as TranslationOutputMode;
    for (const selectedFile of selection.files) {
      check();
      const input = await api.readAgentInputFile({ selectionRef: selection.selectionRef, itemRef: selectedFile.itemRef });
      check();
      if (!input.ok || input.data.displayName !== selectedFile.displayName) {
        errors.push(`Cannot read ${selectedFile.displayName}: ${input.ok ? "selection_changed" : input.error.code}`);
        continue;
      }
      const fileContent = input.data.content;
      const fileName = input.data.displayName;
      const fastEstimate = estimateSubtitleTokensFast(fileContent, sliceConfig.sliceType as SubtitleSliceType,
        sliceConfig.customSliceLength, taskProfile.provider, taskProfile.tokenPricing, { sourceLang, targetLang, translationOutputMode });
      const task = createSubtitleTranslatorTask({
        fileName, fileContent, sliceType: sliceConfig.sliceType as any, customSliceLength: sliceConfig.customSliceLength,
        status: TaskStatus.NOT_STARTED, progress: 0, costEstimate: fastEstimate,
        executionBinding: createSubtitleTaskExecutionBinding(taskProfile), sourceLang, targetLang, translationOutputMode,
        conflictPolicy: args.conflictPolicy ?? "index", concurrentSlices: args.concurrentSlices ?? true,
      });
      check();
      const registration = await api.registerAgentAuthorizedTask({
        selectionRef: selection.selectionRef, itemRef: selectedFile.itemRef, taskId: task.taskId,
        outputMode: args.outputMode, outputFileName: fileName, ...(directoryToken ? { directoryToken } : {}),
      });
      if (!registration.ok) { check(); errors.push(`Cannot authorize ${fileName}: ${registration.error.code}`); continue; }
      try { check(); } catch (error) { releaseSubtitleTranslationTaskAuthority(task.taskId); throw error; }
      const receipt = store.addTask({ ...task, taskReference: registration.data });
      if (!receipt.added) { releaseSubtitleTranslationTaskAuthority(task.taskId); continue; }
      taskIds.push(task.taskId);
      void estimateSubtitleTokens(fileContent, sliceConfig.sliceType as SubtitleSliceType, sliceConfig.customSliceLength,
        taskProfile.provider, taskProfile.tokenPricing, { sourceLang, targetLang, translationOutputMode })
        .then((estimate) => store.updateTaskCostEstimate(task.taskId, estimate)).catch(() => {});
    }
  } catch (error) {
    cancelled = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
    if (!cancelled && !taskIds.length) throw error;
    if (!cancelled) errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (selectionRef) await scheduleAgentSelectionRevocation(selectionRef);
    if (directoryToken) await scheduleAgentOutputDirectoryRevocation(directoryToken);
  }
  try { check(); } catch { cancelled = true; }
  return handlePostQueue("translate", taskIds, {
    success: taskIds.length > 0 || (!cancelled && errors.length === 0),
    ...(cancelled && !taskIds.length ? { error: "已停止，未创建翻译任务。" } : {}),
    data: { queuedCount: taskIds.length, totalFiles, ...(errors.length ? { errors } : {}) },
  }, cancelled || signal?.aborted === true);
}

// ---------------------------------------------------------------------------
// queue_subtitle_convert
// ---------------------------------------------------------------------------

export async function executeQueueConvert(
  args: QueueConvertArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  const store = useSubtitleConverterStore.getState();
  const selection = resolveQueueFileSelection(args);
  if (!selection.ok) return { success: false, error: selection.error };
  const taskIds: string[] = [];
  const errors: string[] = [];
  let cancelled = false;
  try {
    for (const filePath of selection.filePaths) {
      check();
      const fileContent = await readFileContent(filePath);
      check();
      if (fileContent === null) { errors.push(`Cannot read: ${filePath}`); continue; }
      const fileName = extractFileName(filePath);
      const ext = extractExtension(filePath);
      const task: SubtitleConverterTask & { agentTaskId: string } = {
        agentTaskId: crypto.randomUUID(), fileName, fileContent, from: ext as any, to: args.to as any,
        originFileURL: filePath, targetFileURL: resolveOutputDir(args.outputMode, args.outputDir, filePath),
        status: TaskStatus.NOT_STARTED, progress: 0, conflictPolicy: args.conflictPolicy ?? "index",
      };
      store.addTask(task);
      if (useSubtitleConverterStore.getState().notStartedTasks.includes(task)) taskIds.push(task.agentTaskId);
      else errors.push(`Not queued (duplicate): ${fileName}`);
    }
  } catch (error) {
    cancelled = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
    if (!cancelled) throw error;
  }
  return handlePostQueue("convert", taskIds, {
    success: taskIds.length > 0 || (!cancelled && errors.length === 0),
    ...(cancelled && !taskIds.length ? { error: "Agent stopped before creating tasks." } : {}),
    data: createQueueResultData(selection, taskIds.length, errors),
  }, cancelled);
}

// ---------------------------------------------------------------------------
// queue_subtitle_extract
// ---------------------------------------------------------------------------

export async function executeQueueExtract(
  args: QueueExtractArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  const store = useSubtitleExtractorStore.getState();
  const selection = resolveQueueFileSelection(args);
  if (!selection.ok) return { success: false, error: selection.error };
  const taskIds: string[] = [];
  const errors: string[] = [];
  let cancelled = false;
  try {
    for (const filePath of selection.filePaths) {
      check();
      const fileContent = await readFileContent(filePath);
      check();
      if (fileContent === null) { errors.push(`Cannot read: ${filePath}`); continue; }
      const fileName = extractFileName(filePath);
      const ext = extractExtension(filePath);
      const task: SubtitleExtractorTask & { agentTaskId: string } = {
        agentTaskId: crypto.randomUUID(), fileName, fileContent, fileType: ext as any, keep: args.keep,
        originFileURL: filePath, targetFileURL: resolveOutputDir(args.outputMode, args.outputDir, filePath),
        status: TaskStatus.NOT_STARTED, progress: 0, conflictPolicy: args.conflictPolicy ?? "index",
      };
      store.addTask(task);
      if (useSubtitleExtractorStore.getState().notStartedTasks.includes(task)) taskIds.push(task.agentTaskId);
      else errors.push(`Not queued (duplicate): ${fileName}`);
    }
  } catch (error) {
    cancelled = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
    if (!cancelled) throw error;
  }
  return handlePostQueue("extract", taskIds, {
    success: taskIds.length > 0 || (!cancelled && errors.length === 0),
    ...(cancelled && !taskIds.length ? { error: "Agent stopped before creating tasks." } : {}),
    data: createQueueResultData(selection, taskIds.length, errors),
  }, cancelled);
}

// ---------------------------------------------------------------------------
// scan_subtitle_recovery_tasks
// ---------------------------------------------------------------------------

export async function executeScanSubtitleRecoveryTasks(
  args: ScanSubtitleRecoveryTasksArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  let payload;
  try {
    payload = args.selectionMode === "manifest"
      ? await selectTranslationRecoveryManifest()
      : await selectTranslationRecoveryDirectory(args.includeCompleted);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try { check(); } catch (error) {
    if (!payload.cancelled && payload.recoveryScanId) {
      await revokeTranslationRecoveryScan(payload.recoveryScanId).catch(() => {});
    }
    throw error;
  }
  if (payload.cancelled) {
    return { success: false, error: "Recovery selection was cancelled." };
  }

  useAgentStore.getState().appendLog(
    "subtitle_recovery_scan",
    `Scanned ${payload.totalCount} candidates, ${payload.recoverableCount} recoverable`,
    {
      recoveryScanId: payload.recoveryScanId,
      totalCount: payload.totalCount,
      recoverableCount: payload.recoverableCount,
      ...(payload.errors.length > 0 ? { errors: payload.errors } : {}),
    },
  );

  return {
    success: true,
    data: payload,
  };
}

// ---------------------------------------------------------------------------
// queue_recovered_subtitle_translate
// ---------------------------------------------------------------------------

export async function executeQueueRecoveredSubtitleTranslate(
  args: QueueRecoveredSubtitleTranslateArgs,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const check = executionFence(signal);
  check();
  const modelStore = useModelStore.getState();
  const taskProfile = modelStore.getTaskProfile();

  if (!taskProfile || !taskProfile.apiKey) {
    return {
      success: false,
      error: "未配置任务执行模型，请在设置页面配置。",
    };
  }

  await flushPendingAgentTranslationRevocations();
  check();
  let queuedCount = 0;
  let skippedCount = 0;
  const directory = await getSubtitleTranslationApi().selectOutputDirectory();
  if (!directory.ok) { check(); return { success: false, error: directory.error.message }; }
  try { check(); } catch (error) {
    if (directory.data.directoryToken) await scheduleAgentOutputDirectoryRevocation(directory.data.directoryToken);
    throw error;
  }
  if (directory.data.cancelled) {
    return { success: false, error: "Recovery output selection was cancelled." };
  }
  const recoveryDirectoryToken = directory.data.directoryToken;
  if (!recoveryDirectoryToken) {
    return { success: false, error: "Recovery output authorization is unavailable." };
  }
  let prepared;
  try {
    prepared = await prepareRecoveredSubtitleTasks({
      recoveryScanId: args.recoveryScanId,
      directoryToken: recoveryDirectoryToken,
      ...(args.candidateIds ? { candidateIds: args.candidateIds } : {}),
      batchStart: args.batchStart,
      batchSize: args.batchSize,
    });
  } catch (error) {
    await scheduleAgentOutputDirectoryRevocation(
      recoveryDirectoryToken,
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await scheduleAgentOutputDirectoryRevocation(recoveryDirectoryToken);
  try { check(); } catch (error) {
    for (const draft of prepared.tasks) releaseSubtitleTranslationTaskAuthority(draft.taskId);
    throw error;
  }
  const tasks: SubtitleTranslatorTask[] = prepared.tasks.map((draft) => ({
    taskId: draft.taskId,
    fileName: draft.fileName,
    fileContent: "",
    sliceType: draft.sliceType as SubtitleTranslatorTask["sliceType"],
    ...(draft.customSliceLength === undefined
      ? {}
      : { customSliceLength: draft.customSliceLength }),
    status: TaskStatus.NOT_STARTED,
    executionBinding: createSubtitleTaskExecutionBinding(taskProfile, {
      thinkingEnabled: draft.thinkingEnabled,
    }),
    sourceLang: draft.sourceLang as SubtitleTranslatorTask["sourceLang"],
    targetLang: draft.targetLang as SubtitleTranslatorTask["targetLang"],
    translationOutputMode: draft.translationOutputMode,
    resolvedFragments: draft.resolvedFragments,
    totalFragments: draft.totalFragments,
    progress: draft.progress,
    ...(draft.actualUsage ? { actualUsage: draft.actualUsage } : {}),
    conflictPolicy: args.conflictPolicy ?? "index",
    concurrentSlices: args.concurrentSlices ?? true,
    recoveryMode: "resume",
    recoveryInputMode: "manifest_fragments",
    checkpointRef: draft.checkpointRef,
    recovery: {
      checkpointRef: draft.checkpointRef,
      resumable: true,
      failedFragmentIndexes: draft.failedFragmentIndexes
        ? [...draft.failedFragmentIndexes]
        : undefined,
      resolvedFragments: draft.resolvedFragments,
      totalFragments: draft.totalFragments,
    },
    taskReference: draft.reference,
  }));
  const addResult = useSubtitleTranslatorStore.getState().addRecoveredTasks(tasks);
  queuedCount = addResult.addedCount;
  skippedCount = addResult.skippedCount;
  const added = new Set(addResult.addedTaskIds);
  for (const task of tasks) {
    if (!added.has(task.taskId)) {
      releaseSubtitleTranslationTaskAuthority(task.taskId);
    }
  }
  if (!prepared.hasMore) {
    try {
      await revokeTranslationRecoveryScan(args.recoveryScanId);
    } catch {
      // Scan authority is short-lived and task authority has already transferred.
    }
  }

  const resultData: Record<string, unknown> = {
    queuedCount,
    skippedCount,
    totalCandidates: prepared.totalCandidates,
    readyCount: 0,
    readyFromManifestCount: prepared.tasks.length,
    invalidCount: skippedCount,
    sourceFileCount: 0,
    manifestFragmentCount: prepared.tasks.length,
    batch: {
      recoveryScanId: args.recoveryScanId,
      batchStart: prepared.batchStart,
      batchEnd: prepared.batchEnd,
      totalCandidates: prepared.totalCandidates,
      hasMore: prepared.hasMore,
      nextBatchStart: prepared.nextBatchStart,
      queuedCount,
    },
  };

  const result: ToolExecutionResult = {
    success: true,
    data: resultData,
  };

  let cancelled = false;
  try { check(); } catch { cancelled = true; }
  if (!cancelled) useAgentStore.getState().appendLog(
    "subtitle_recovery_queue",
    `Queued ${queuedCount} recovered tasks, skipped ${skippedCount}`,
    {
      queuedCount,
      skippedCount,
      readyCount: 0,
      readyFromManifestCount: prepared.tasks.length,
      recoveryScanId: args.recoveryScanId,
    },
  );

  return handlePostQueue("translate", [...addResult.addedTaskIds], result, cancelled);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

async function readFileContent(absolutePath: string): Promise<string | null> {
  try {
    return await getIpcRenderer().invoke("read-file-head", {
      filePath: absolutePath,
      lines: 999999,
    });
  } catch {
    return null;
  }
}

function extractFileName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() || filePath;
}

function extractExtension(filePath: string): string {
  const parts = filePath.split(".");
  return (parts.pop() || "").toUpperCase();
}

function resolveOutputDir(
  mode: string | undefined,
  customDir: string | undefined,
  filePath: string
): string {
  if (mode === "custom" && customDir) return customDir;
  return filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

function getLatestUserMessageContent(): string {
  const messages = useAgentStore.getState().session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function deduplicateByPath<T extends { absolutePath: string }>(
  files: T[]
): T[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    const key = f.absolutePath.replace(/\\/g, "/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createQueueResultData(
  selection: Extract<QueueFileSelection, { ok: true }>,
  queuedCount: number,
  errors: string[],
) {
  return {
    queuedCount,
    totalFiles: selection.totalFiles,
    ...(selection.source === "scan"
      ? {
          batch: {
            ...selection.batch,
            queuedCount,
          },
        }
      : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function getIpcRenderer(): Window["ipcRenderer"] {
  if (typeof window === "undefined" || !window.ipcRenderer) {
    throw new Error("Electron IPC is not available in this environment.");
  }
  return window.ipcRenderer;
}

const pendingAgentSelectionRevocations = new Set<string>();
const pendingAgentOutputDirectoryRevocations = new Set<string>();

function containsLegacyAgentTranslateAuthority(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return true;
  }
  return ["filePaths", "scanId", "outputDir"].some((field) =>
    Object.prototype.hasOwnProperty.call(value, field));
}

function getSubtitleTranslationApi(): Window["subtitleTranslationApi"] {
  if (typeof window === "undefined" || !window.subtitleTranslationApi) {
    throw new Error("Subtitle translation authorization is unavailable.");
  }
  return window.subtitleTranslationApi;
}

async function scheduleAgentSelectionRevocation(
  selectionRef: string,
): Promise<void> {
  pendingAgentSelectionRevocations.add(selectionRef);
  await flushPendingAgentTranslationRevocations();
}

async function scheduleAgentOutputDirectoryRevocation(
  directoryToken: string,
): Promise<void> {
  pendingAgentOutputDirectoryRevocations.add(directoryToken);
  await flushPendingAgentTranslationRevocations();
}

async function flushPendingAgentTranslationRevocations(): Promise<void> {
  const api = getSubtitleTranslationApi();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const selectionRef of [...pendingAgentSelectionRevocations]) {
      try {
        const result = await api.revokeAgentInputSelection(selectionRef);
        if (result.ok) pendingAgentSelectionRevocations.delete(selectionRef);
      } catch {
        // Retain the opaque ref for the next bounded flush.
      }
    }
    for (const directoryToken of [...pendingAgentOutputDirectoryRevocations]) {
      try {
        const result = await api.revokeOutputDirectory(directoryToken);
        if (result.ok) {
          pendingAgentOutputDirectoryRevocations.delete(directoryToken);
        }
      } catch {
        // Retain the opaque token for the next bounded flush.
      }
    }
    if (
      pendingAgentSelectionRevocations.size === 0 &&
      pendingAgentOutputDirectoryRevocations.size === 0
    ) {
      return;
    }
    await Promise.resolve();
  }
}

function enrichInspectedNameEntry(entry: NameEntry) {
  return {
    ...entry,
    exists: true,
    suggestedScopes: entry.kind === "directory" && !entry.symlink ? ["self", "children", "descendants"] : ["self"],
  };
}
