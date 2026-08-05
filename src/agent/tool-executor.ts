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
import type { TaskStoreType } from "./types";
import {
  TaskStatus,
  type SubtitleConverterTask,
  type SubtitleExtractorTask,
  type SubtitleTranslatorTask,
  type TranslationRecoveryCandidate,
  type TranslationRecoveryInputMode,
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
import {
  createRecoveryScanResultPayload,
  resolveRecoveryCandidateSelection,
} from "./recovery-batch";
import { resolveTranslationSliceConfig } from "./translation-slice-config";
import type {
  SubtitleSliceType,
  TranslationLanguage,
  TranslationOutputMode,
} from "@/type/subtitle";
import { createNameTranslationPlan } from "@/services/rename/nameTranslationPlanner";
import { getNameTranslationPlan } from "@/services/rename/namePlanStore";
import {
  applyNameTranslationPlan as applyStoredNameTranslationPlan,
  validateNameTranslationPlan,
} from "@/services/rename/nameApplyService";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type InspectedRenamePath,
  type NameTranslationOptions,
} from "@/services/rename/nameTypes";
import { isExplicitRenameConfirmation } from "./name-plan-confirmation";
import {
  scanTranslationRecoveryArtifacts,
  inspectTranslationRecoveryArtifact,
  createRecoveredSubtitleTaskDraft,
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
  queuedCount: number,
  result: ToolExecutionResult
): ToolExecutionResult {
  if (queuedCount === 0) return result;

  const { executionMode, pendingExecution } = useAgentStore.getState();

  switch (executionMode) {
    case "auto_execute":
      executeTasksInStores([storeType]);
      result.data = {
        ...result.data,
        executionMode: "auto_execute",
        executionStatus: "started",
      };
      break;

    case "ask_before_execute": {
      const prevStores = pendingExecution?.stores ?? [];
      const prevCounts = pendingExecution?.taskCounts ?? {};
      useAgentStore.getState().setPendingExecution({
        stores: prevStores.includes(storeType) ? prevStores : [...prevStores, storeType],
        taskCounts: { ...prevCounts, [storeType]: (prevCounts[storeType] ?? 0) + queuedCount },
        timestamp: Date.now(),
      });
      result.data = {
        ...result.data,
        executionMode: "ask_before_execute",
        executionStatus: "pending_confirmation",
      };
      break;
    }

    case "queue_only":
    default:
      result.data = {
        ...result.data,
        executionMode: "queue_only",
        executionStatus: "queued_only",
      };
      break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// scan_subtitle_files
// ---------------------------------------------------------------------------

export async function executeScan(
  args: ScanSubtitleFilesArgs
): Promise<ToolExecutionResult> {
  const allFiles: Array<{
    absolutePath: string;
    fileName: string;
    extension: string;
    size: number;
    sourceDirectory: string;
  }> = [];

  for (const dir of args.directories) {
    try {
      const result = await window.ipcRenderer.invoke("scan-directory", {
        directory: dir,
        extensions: args.extensions,
        recursive: args.recursive,
        maxFiles: 10000,
      });
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
  args: InspectRenamePathsArgs
): Promise<ToolExecutionResult> {
  try {
    const result = await getIpcRenderer().invoke("inspect-rename-paths", {
      paths: args.paths,
    });

    return {
      success: true,
      data: {
        paths: ((result?.paths ?? []) as InspectedRenamePath[]).map(
          enrichInspectedRenamePath
        ),
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
  args: CreateNameTranslationPlanArgs
): Promise<ToolExecutionResult> {
  try {
    const options = toNameTranslationOptions(args);
    const summary = await createNameTranslationPlan(options);
    const requiresConfirmation = !summary.clarificationRequired;
    const executionStatus = summary.clarificationRequired
      ? "clarification_required"
      : "preview_created";

    const store = useAgentStore.getState();
    if (requiresConfirmation) {
      store.setPendingNameTranslationPlan({
        planId: summary.planId,
        createdAt: Date.now(),
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
  args: ApplyNameTranslationPlanArgs
): Promise<ToolExecutionResult> {
  const latestUserMessage = getLatestUserMessageContent();
  if (!isExplicitRenameConfirmation(latestUserMessage, args.planId)) {
    return {
      success: false,
      error:
        "应用重命名计划前需要用户明确确认，例如「确认执行刚才的重命名计划」。",
      data: {
        planId: args.planId,
        executionStatus: "confirmation_required",
      },
    };
  }

  const store = useAgentStore.getState();
  const pendingPlan = store.pendingNameTranslationPlan;
  if (
    !pendingPlan ||
    pendingPlan.planId !== args.planId ||
    pendingPlan.resolvedAction
  ) {
    return {
      success: false,
      error: "只能应用当前等待确认的最新重命名计划，请先重新生成预览。",
      data: {
        planId: args.planId,
        executionStatus: "no_pending_plan",
      },
    };
  }

  const plan = getNameTranslationPlan(args.planId);
  if (!plan) {
    return {
      success: false,
      error: "重命名计划已过期或不存在，请重新生成预览。",
      data: {
        planId: args.planId,
        executionStatus: "plan_missing",
      },
    };
  }

  if (!plan.applyable || plan.blockedCount > 0) {
    return {
      success: false,
      error: "当前重命名计划不可应用，请先处理冲突或重新生成预览。",
      data: {
        planId: args.planId,
        executionStatus: "plan_blocked",
        blockedCount: plan.blockedCount,
        applyable: plan.applyable,
      },
    };
  }

  try {
    const validation = await validateNameTranslationPlan(args.planId);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors[0]?.message ?? "重命名计划校验失败。",
        data: {
          planId: args.planId,
          executionStatus: "validation_failed",
          validation,
        },
      };
    }

    const result = await applyStoredNameTranslationPlan(args.planId);
    useAgentStore.getState().setPendingNameTranslationPlan({
      ...pendingPlan,
      resolvedAction: "confirm",
      applyResult: result,
      error: undefined,
    });
    useAgentStore.getState().appendLog(
      "name_translation_apply",
      `Applied rename plan ${args.planId}`,
      { planId: args.planId, result }
    );

    return {
      success: true,
      data: {
        ...result,
        executionStatus: "applied",
      },
    };
  } catch (err: any) {
    const error = `Failed to apply name translation plan: ${err?.message || err}`;
    useAgentStore.getState().setPendingNameTranslationPlan({
      ...pendingPlan,
      error,
    });
    useAgentStore.getState().appendLog("error", error, {
      planId: args.planId,
      source: "apply_name_translation_plan",
    });

    return {
      success: false,
      error,
      data: {
        planId: args.planId,
        executionStatus: "apply_failed",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// queue_subtitle_translate
// ---------------------------------------------------------------------------

export async function executeQueueTranslate(
  args: QueueTranslateArgs
): Promise<ToolExecutionResult> {
  if (containsLegacyAgentTranslateAuthority(args)) {
    return {
      success: false,
      error:
        "字幕翻译不接受 filePaths、scanId 或 outputDir。请通过 FusionKit 文件选择器重新授权。",
    };
  }
  const store = useSubtitleTranslatorStore.getState();
  const modelStore = useModelStore.getState();
  const taskProfile = modelStore.getTaskProfile();

  if (!taskProfile || !taskProfile.apiKey) {
    return {
      success: false,
      error: "未配置任务执行模型，请在设置页面配置。",
    };
  }

  await flushPendingAgentTranslationRevocations();
  const api = getSubtitleTranslationApi();
  let directoryToken: string | undefined;
  if (args.outputMode === "custom") {
    const directorySelection = await api.selectOutputDirectory();
    if (!directorySelection.ok) {
      return {
        success: false,
        error: `无法授权字幕输出目录：${directorySelection.error.code}`,
      };
    }
    if (directorySelection.data.cancelled) {
      return {
        success: false,
        error: "已取消字幕输出目录选择，未创建翻译任务。",
      };
    }
    directoryToken = directorySelection.data.directoryToken;
  }

  const selected = await api.selectAgentInputFiles();
  if (!selected.ok) {
    if (directoryToken) {
      await scheduleAgentOutputDirectoryRevocation(directoryToken);
    }
    return {
      success: false,
      error: `无法授权字幕输入文件：${selected.error.code}`,
    };
  }
  if (selected.data.cancelled) {
    if (directoryToken) {
      await scheduleAgentOutputDirectoryRevocation(directoryToken);
    }
    return {
      success: false,
      error: "已取消字幕文件选择，未创建翻译任务。",
    };
  }

  const selection = selected.data;
  let queued = 0;
  const errors: string[] = [];
  const sliceConfig = resolveTranslationSliceConfig(
    args,
    getLatestUserMessageContent(),
  );
  const sourceLang = (args.sourceLang || "JA") as TranslationLanguage;
  const targetLang = (args.targetLang || "ZH") as TranslationLanguage;
  const translationOutputMode = (args.translationOutputMode ||
    "bilingual") as TranslationOutputMode;

  try {
    for (let i = 0; i < selection.files.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 0));
      const selectedFile = selection.files[i];
      const inputContent = await api.readAgentInputFile({
        selectionRef: selection.selectionRef,
        itemRef: selectedFile.itemRef,
      });
      if (!inputContent.ok) {
        errors.push(`Cannot read ${selectedFile.displayName}: ${inputContent.error.code}`);
        continue;
      }
      if (inputContent.data.displayName !== selectedFile.displayName) {
        errors.push(`Cannot read ${selectedFile.displayName}: selection_changed`);
        continue;
      }
      const fileContent = inputContent.data.content;
      const fileName = inputContent.data.displayName;

      const fastEstimate = estimateSubtitleTokensFast(
        fileContent,
        sliceConfig.sliceType as SubtitleSliceType,
        sliceConfig.customSliceLength,
        taskProfile.provider,
        taskProfile.tokenPricing,
        { sourceLang, targetLang, translationOutputMode },
      );

      const task = createSubtitleTranslatorTask({
        fileName,
        fileContent,
        sliceType: sliceConfig.sliceType as any,
        customSliceLength: sliceConfig.customSliceLength,
        originFileURL: "",
        targetFileURL: "",
        status: TaskStatus.NOT_STARTED,
        progress: 0,
        costEstimate: fastEstimate,
        executionBinding: createSubtitleTaskExecutionBinding(taskProfile),
        sourceLang,
        targetLang,
        translationOutputMode,
        conflictPolicy: args.conflictPolicy ?? "index",
        concurrentSlices: args.concurrentSlices ?? true,
      });
      const registration = await api.registerAgentAuthorizedTask({
        selectionRef: selection.selectionRef,
        itemRef: selectedFile.itemRef,
        taskId: task.taskId,
        outputMode: args.outputMode,
        outputFileName: fileName,
        ...(directoryToken ? { directoryToken } : {}),
      });
      if (!registration.ok) {
        errors.push(`Cannot authorize ${fileName}: ${registration.error.code}`);
        continue;
      }
      const authorizedTask: SubtitleTranslatorTask = {
        ...task,
        taskReference: registration.data,
      };
      const addResult = store.addTask(authorizedTask);
      if (!addResult.added) {
        releaseSubtitleTranslationTaskAuthority(task.taskId);
        continue;
      }
      queued++;

      const capturedTaskId = task.taskId;
      estimateSubtitleTokens(
        fileContent,
        sliceConfig.sliceType as SubtitleSliceType,
        sliceConfig.customSliceLength,
        taskProfile.provider,
        taskProfile.tokenPricing,
        { sourceLang, targetLang, translationOutputMode },
      ).then((precise) => {
        store.updateTaskCostEstimate(capturedTaskId, precise);
      });
    }
  } finally {
    await scheduleAgentSelectionRevocation(selection.selectionRef);
    if (directoryToken) {
      await scheduleAgentOutputDirectoryRevocation(directoryToken);
    }
  }

  const result: ToolExecutionResult = {
    success: true,
    data: {
      queuedCount: queued,
      totalFiles: selection.files.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };

  return handlePostQueue("translate", queued, result);
}

// ---------------------------------------------------------------------------
// queue_subtitle_convert
// ---------------------------------------------------------------------------

export async function executeQueueConvert(
  args: QueueConvertArgs
): Promise<ToolExecutionResult> {
  const store = useSubtitleConverterStore.getState();

  let queued = 0;
  const errors: string[] = [];
  const selection = resolveQueueFileSelection(args);
  if (!selection.ok) {
    return {
      success: false,
      error: selection.error,
    };
  }

  for (let i = 0; i < selection.filePaths.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    const filePath = selection.filePaths[i];

    const fileContent = await readFileContent(filePath);
    if (fileContent === null) {
      errors.push(`Cannot read: ${filePath}`);
      continue;
    }
    const fileName = extractFileName(filePath);
    const ext = extractExtension(filePath);
    const outputDir = resolveOutputDir(args.outputMode, args.outputDir, filePath);

    const task: SubtitleConverterTask = {
      fileName,
      fileContent,
      from: ext as any,
      to: args.to as any,
      originFileURL: filePath,
      targetFileURL: outputDir,
      status: TaskStatus.NOT_STARTED,
      progress: 0,
      conflictPolicy: args.conflictPolicy ?? "index",
    };
    store.addTask(task);
    queued++;
  }

  const result: ToolExecutionResult = {
    success: true,
    data: createQueueResultData(selection, queued, errors),
  };

  return handlePostQueue("convert", queued, result);
}

// ---------------------------------------------------------------------------
// queue_subtitle_extract
// ---------------------------------------------------------------------------

export async function executeQueueExtract(
  args: QueueExtractArgs
): Promise<ToolExecutionResult> {
  const store = useSubtitleExtractorStore.getState();

  let queued = 0;
  const errors: string[] = [];
  const selection = resolveQueueFileSelection(args);
  if (!selection.ok) {
    return {
      success: false,
      error: selection.error,
    };
  }

  for (let i = 0; i < selection.filePaths.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    const filePath = selection.filePaths[i];

    const fileContent = await readFileContent(filePath);
    if (fileContent === null) {
      errors.push(`Cannot read: ${filePath}`);
      continue;
    }
    const fileName = extractFileName(filePath);
    const ext = extractExtension(filePath);
    const outputDir = resolveOutputDir(args.outputMode, args.outputDir, filePath);

    const task: SubtitleExtractorTask = {
      fileName,
      fileContent,
      fileType: ext as any,
      originFileURL: filePath,
      targetFileURL: outputDir,
      keep: args.keep,
      status: TaskStatus.NOT_STARTED,
      progress: 0,
      conflictPolicy: args.conflictPolicy ?? "index",
    };
    store.addTask(task);
    queued++;
  }

  const result: ToolExecutionResult = {
    success: true,
    data: createQueueResultData(selection, queued, errors),
  };

  return handlePostQueue("extract", queued, result);
}

// ---------------------------------------------------------------------------
// scan_subtitle_recovery_tasks
// ---------------------------------------------------------------------------

export async function executeScanSubtitleRecoveryTasks(
  args: ScanSubtitleRecoveryTasksArgs,
): Promise<ToolExecutionResult> {
  const roots: string[] = [...(args.roots ?? [])];

  if (args.useCurrentOutputDir) {
    const outputURL = useSubtitleTranslatorStore.getState().outputURL;
    if (outputURL) {
      roots.push(outputURL);
    } else if (roots.length === 0 && !args.checkpointPaths?.length) {
      return {
        success: false,
        error:
          "当前字幕翻译输出目录为空，请提供要扫描的目录路径。",
      };
    }
  }

  const allCandidates: TranslationRecoveryCandidate[] = [];
  const seenCheckpoints = new Set<string>();
  const errors: string[] = [];

  if (roots.length > 0) {
    try {
      const scanResult = await scanTranslationRecoveryArtifacts({
        roots,
        recursive: args.recursive,
        maxDepth: args.maxDepth,
        maxFiles: args.maxFiles,
        includeCompleted: args.includeCompleted,
      });
      for (const c of scanResult.candidates) {
        const key = c.checkpointPath.replace(/\\/g, "/");
        if (!seenCheckpoints.has(key)) {
          seenCheckpoints.add(key);
          allCandidates.push(c);
        }
      }
      for (const e of scanResult.errors) {
        errors.push(`${e.path}: ${e.reason}`);
      }
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to scan recovery artifacts: ${err?.message || err}`,
      };
    }
  }

  if (args.checkpointPaths && args.checkpointPaths.length > 0) {
    for (const cp of args.checkpointPaths) {
      const key = cp.replace(/\\/g, "/");
      if (seenCheckpoints.has(key)) continue;
      try {
        const candidate = await inspectTranslationRecoveryArtifact(cp);
        seenCheckpoints.add(key);
        allCandidates.push(candidate);
      } catch (err: any) {
        errors.push(`${cp}: ${err?.message || err}`);
      }
    }
  }

  if (roots.length === 0 && (!args.checkpointPaths || args.checkpointPaths.length === 0)) {
    return {
      success: false,
      error:
        "roots、checkpointPaths、useCurrentOutputDir 至少需要一个有效值。",
    };
  }

  const scannedRoots = roots.length > 0 ? roots : args.checkpointPaths?.map(
    (p) => p.replace(/\\/g, "/").split("/").slice(0, -1).join("/"),
  ) ?? [];

  const payload = createRecoveryScanResultPayload(allCandidates, scannedRoots);

  useAgentStore.getState().appendLog(
    "subtitle_recovery_scan",
    `Scanned ${allCandidates.length} candidates, ${payload.recoverableCount} recoverable`,
    {
      recoveryScanId: payload.recoveryScanId,
      totalCount: payload.totalCount,
      recoverableCount: payload.recoverableCount,
      readyCount: payload.readyCount,
      readyFromManifestCount: payload.readyFromManifestCount,
      completedCount: payload.completedCount,
      invalidCount: payload.invalidCount,
      scannedRoots,
      ...(errors.length > 0 ? { errors } : {}),
    },
  );

  return {
    success: true,
    data: {
      ...payload,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// queue_recovered_subtitle_translate
// ---------------------------------------------------------------------------

export async function executeQueueRecoveredSubtitleTranslate(
  args: QueueRecoveredSubtitleTranslateArgs,
): Promise<ToolExecutionResult> {
  const modelStore = useModelStore.getState();
  const taskProfile = modelStore.getTaskProfile();

  if (!taskProfile || !taskProfile.apiKey) {
    return {
      success: false,
      error: "未配置任务执行模型，请在设置页面配置。",
    };
  }

  const selection = resolveRecoveryCandidateSelection(args);

  let candidatesToProcess: TranslationRecoveryCandidate[];

  if (!selection.ok) {
    return { success: false, error: selection.error };
  }

  if (selection.source === "checkpointPaths") {
    candidatesToProcess = [];
    for (const cp of args.checkpointPaths!) {
      try {
        const candidate = await inspectTranslationRecoveryArtifact(cp);
        const recoverability = args.recoverability ?? "both";
        const isRecoverable =
          recoverability === "both"
            ? candidate.recoverability === "ready" ||
              candidate.recoverability === "ready_from_manifest"
            : candidate.recoverability === recoverability;
        if (isRecoverable) {
          candidatesToProcess.push(candidate);
        }
      } catch {
        /* skip unreadable checkpoints */
      }
    }
  } else {
    candidatesToProcess = selection.candidates;
  }

  let queuedCount = 0;
  let skippedCount = 0;
  let readyCount = 0;
  let readyFromManifestCount = 0;
  const errors: string[] = [];
  const tasks: SubtitleTranslatorTask[] = [];

  for (let i = 0; i < candidatesToProcess.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    const candidate = candidatesToProcess[i];

    let recoveryInputMode: TranslationRecoveryInputMode;
    if (candidate.recoverability === "ready") {
      recoveryInputMode = "source_file";
      readyCount++;
    } else if (candidate.recoverability === "ready_from_manifest") {
      recoveryInputMode = "manifest_fragments";
      readyFromManifestCount++;
    } else {
      skippedCount++;
      continue;
    }

    try {
      const draft = await createRecoveredSubtitleTaskDraft({
        checkpointPath: candidate.checkpointPath,
        recoveryInputMode,
      });

      const task = createSubtitleTranslatorTask({
        ...draft,
        fileContent: draft.fileContent || "",
        status: TaskStatus.NOT_STARTED,
        executionBinding: createSubtitleTaskExecutionBinding(taskProfile),
        conflictPolicy: args.conflictPolicy ?? "index",
        concurrentSlices: args.concurrentSlices ?? true,
      });
      tasks.push(task);
    } catch (err: any) {
      errors.push(`${candidate.checkpointPath}: ${err?.message || err}`);
      skippedCount++;
    }
  }

  if (tasks.length > 0) {
    const addResult = useSubtitleTranslatorStore.getState().addRecoveredTasks(tasks);
    queuedCount = addResult.addedCount;
    skippedCount += addResult.skippedCount;
  }

  const resultData: Record<string, unknown> = {
    queuedCount,
    skippedCount,
    totalCandidates: candidatesToProcess.length,
    readyCount,
    readyFromManifestCount,
    invalidCount: skippedCount,
    sourceFileCount: readyCount,
    manifestFragmentCount: readyFromManifestCount,
    ...(selection.source === "scan" ? { batch: { ...selection.batch, queuedCount } } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };

  const result: ToolExecutionResult = {
    success: true,
    data: resultData,
  };

  useAgentStore.getState().appendLog(
    "subtitle_recovery_queue",
    `Queued ${queuedCount} recovered tasks, skipped ${skippedCount}`,
    {
      queuedCount,
      skippedCount,
      readyCount,
      readyFromManifestCount,
      ...(selection.source === "scan"
        ? { recoveryScanId: selection.batch.recoveryScanId }
        : {}),
    },
  );

  return handlePostQueue("translate", queuedCount, result);
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

function enrichInspectedRenamePath(path: InspectedRenamePath) {
  return {
    ...path,
    suggestedScopes:
      path.exists && path.kind === "directory"
        ? ["self", "children", "descendants"]
        : path.exists && path.kind === "file"
          ? ["self"]
          : [],
  };
}

function toNameTranslationOptions(
  args: CreateNameTranslationPlanArgs
): NameTranslationOptions {
  const scoped = normalizeNameTranslationScope(args);
  return {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    ...scoped,
    roots: args.roots,
    sourceLang: args.sourceLang,
    targetLang: args.targetLang,
    namingStyle: args.namingStyle,
    outputMode: args.outputMode,
    bilingualSeparator: args.bilingualSeparator,
    collisionPolicy: args.collisionPolicy,
    includeHidden: args.includeHidden,
    preserveExtension: true,
    preserveLeadingDot: true,
    preserveTechnicalTokens: true,
    ...(args.pathSegmentStartPath && args.pathSegmentEndPath
      ? {
          pathSegmentRange: {
            startPath: args.pathSegmentStartPath,
            endPath: args.pathSegmentEndPath,
            includeEndFileName: args.includeEndFileName,
          },
        }
      : {}),
  };
}

function normalizeNameTranslationScope(args: CreateNameTranslationPlanArgs) {
  if (args.scope === "self") {
    return {
      scope: args.scope,
      targetKind: args.targetKind,
      recursive: false,
      maxDepth: 0,
      includeRoot: true,
    };
  }

  if (args.scope === "children") {
    return {
      scope: args.scope,
      targetKind: args.targetKind,
      recursive: false,
      maxDepth: 1,
      includeRoot: false,
    };
  }

  if (args.scope === "descendants") {
    return {
      scope: args.scope,
      targetKind: args.targetKind,
      recursive: true,
      maxDepth: Math.max(2, args.maxDepth || 5),
      includeRoot: false,
    };
  }

  return {
    scope: args.scope,
    targetKind: args.targetKind,
    recursive: args.recursive,
    maxDepth: args.maxDepth,
    includeRoot: args.includeRoot,
  };
}
