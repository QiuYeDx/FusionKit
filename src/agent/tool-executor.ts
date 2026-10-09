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
  isSubtitleConvertFormat,
  type SubtitleConvertFormat,
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
import { detectCustomSliceLengthIntent, resolveTranslationSliceConfig } from "./translation-slice-config";
import { converterPageSettings, extractorPageSettings, nameTranslatorPageSettings, SettingsResolver, translatorPageSettings } from "./tool-page-settings";
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
import i18n from "@/i18n";
import { latestUserMessage, latestUserMessageText, userMentionedDirectory, userRequestedOverwrite } from "./user-intent-authority";

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
        error: "scan_failed",
        data: { directory: dir, reason: errorReason(err) },
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
      error: "rename_inspect_failed",
      data: { reason: errorReason(err) },
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
    const page = nameTranslatorPageSettings();
    const settings = new SettingsResolver();
    const pageFormat = page.nameMode ? { nameMode: page.nameMode, bilingualOrder: page.bilingualOrder ?? "translated_first",
      bilingualStyle: page.bilingualStyle ?? "paren", customTemplate: page.customTemplate ?? "{translated} ({original})" } : undefined;
    const nameFormat = args.nameFormat ? settings.note("nameFormat", args.nameFormat, "user")
      : pageFormat ? (settings.note("nameFormat", pageFormat, "tool_page"), "translated" as const) : settings.note("nameFormat", "translated" as const, "default");
    const instructions = args.instructions ?? (page.instructions?.trim() ? page.instructions : undefined);
    if (instructions !== undefined) settings.note("instructions", instructions, args.instructions !== undefined ? "user" : "tool_page");
    const summary = await createAgentNamePlan(
      {
        roots: args.roots,
        scope: args.scope,
        targetKind: args.targetKind,
        includeRoots: args.includeRoots,
        includeHidden: settings.pick("includeHidden", args.includeHidden, page.includeHidden, false),
        sourceLang: settings.pick("sourceLang", args.sourceLang, page.sourceLang, "auto"),
        targetLang: settings.pick("targetLang", args.targetLang, page.targetLang, "ZH"),
        nameFormat,
        ...(!args.nameFormat && pageFormat ? { format: pageFormat } : {}),
        instructions,
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
        createdByUserMessageId: latestUserMessage(store.session.messages)?.id,
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
        appliedSettings: settings.applied,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: errorReason(err) === "task_model_not_configured" ? "task_model_not_configured" : "rename_plan_failed",
      data: { reason: errorReason(err) },
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
  const latestUser = latestUserMessage(store.session.messages);
  if (!pending || pending.planId !== args.planId || pending.resolvedAction || pending.isApplying ||
      !pending.createdByUserMessageId || !latestUser || latestUser.id === pending.createdByUserMessageId ||
      !isExplicitRenameConfirmation(latestUser.content, args.planId)) {
    return { success: false, error: "rename_confirmation_required", data: { planId: args.planId, executionStatus: "confirmation_required", nextAction: "Ask the user to confirm this rename plan in a new message, or to use the confirm button on the preview." } };
  }
  const result = await store.confirmNameTranslationPlan(args.planId, signal);
  if (result) return { success: true, data: { ...result, executionStatus: "applied" } };
  return { success: false, error: useAgentStore.getState().pendingNameTranslationPlan?.error ?? "rename_not_applied", data: { planId: args.planId, executionStatus: "not_applied" } };
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
    return { success: false, error: "translation_requires_picker" };
  }
  const store = useSubtitleTranslatorStore.getState();
  const taskProfile = useModelStore.getState().getTaskProfile();
  if (!taskProfile?.apiKey) return { success: false, error: "task_model_not_configured" };
  const page = translatorPageSettings();
  const settings = new SettingsResolver();
  const conflict = resolveConflictPolicy(args.conflictPolicy, page.conflictPolicy, settings);
  // The translator page's output folder needs a fresh authorization, so an omitted output location stays next to the inputs.
  const outputMode = settings.pick("outputMode", args.outputMode, undefined, "source" as const);
  const concurrentSlices = settings.pick("concurrentSlices", args.concurrentSlices, page.concurrentSlices, true);
  const thinkingEnabled = settings.pick("thinkingEnabled", undefined, page.thinkingEnabled, false);
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
    if (outputMode === "custom") {
      const directory = await api.selectOutputDirectory();
      if (directory.ok) directoryToken = directory.data.directoryToken;
      check();
      if (!directory.ok) return { success: false, error: "translation_output_authorization_failed", data: { reason: directory.error.code } };
      if (directory.data.cancelled) return { success: false, error: "translation_output_selection_cancelled" };
    }
    const selected = await api.selectAgentInputFiles();
    if (selected.ok && !selected.data.cancelled) selectionRef = selected.data.selectionRef;
    check();
    if (!selected.ok) return { success: false, error: "translation_input_authorization_failed", data: { reason: selected.error.code } };
    if (selected.data.cancelled) return { success: false, error: "translation_input_selection_cancelled" };
    const selection = selected.data;
    totalFiles = selection.files.length;
    const userMessage = latestUserMessageText(useAgentStore.getState().session.messages);
    const requestedSlice = args.sliceType !== undefined || args.customSliceLength !== undefined || detectCustomSliceLengthIntent(userMessage) !== undefined;
    const sliceConfig = requestedSlice ? resolveTranslationSliceConfig(args, userMessage)
      : { sliceType: page.sliceType ?? "NORMAL", ...(page.sliceType === "CUSTOM" && page.customSliceLength ? { customSliceLength: page.customSliceLength } : {}) };
    settings.note("sliceType", sliceConfig.sliceType, requestedSlice ? "user" : page.sliceType ? "tool_page" : "default");
    if (sliceConfig.customSliceLength) settings.note("customSliceLength", sliceConfig.customSliceLength, requestedSlice ? "user" : "tool_page");
    const sourceLang = settings.pick("sourceLang", args.sourceLang, page.sourceLang, "JA") as TranslationLanguage;
    const targetLang = settings.pick("targetLang", args.targetLang, page.targetLang, "ZH") as TranslationLanguage;
    const translationOutputMode = settings.pick("translationOutputMode", args.translationOutputMode, page.translationOutputMode, "bilingual") as TranslationOutputMode;
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
        executionBinding: createSubtitleTaskExecutionBinding(taskProfile, { thinkingEnabled }), sourceLang, targetLang, translationOutputMode,
        conflictPolicy: conflict.policy, concurrentSlices,
      });
      check();
      const registration = await api.registerAgentAuthorizedTask({
        selectionRef: selection.selectionRef, itemRef: selectedFile.itemRef, taskId: task.taskId,
        outputMode, outputFileName: fileName, ...(directoryToken ? { directoryToken } : {}),
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
    ...(cancelled && !taskIds.length ? { error: "agent_stopped_before_queue" } : {}),
    data: { queuedCount: taskIds.length, totalFiles, ...(errors.length ? { errors } : {}), ...conflict.receipt, appliedSettings: settings.applied,
      ...(!args.outputMode && page.outputMode === "custom" ? { outputNote: "saved_next_to_inputs_translator_page_folder_needs_picking" } : {}) },
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
  const page = converterPageSettings();
  const settings = new SettingsResolver();
  const to = settings.pick("to", args.to, page.to, "SRT") as SubtitleConvertFormat;
  const output = await resolvePageOutput("convert", args, page, settings, check);
  if (!output.ok) return { success: false, error: output.error };
  const conflict = resolveConflictPolicy(args.conflictPolicy, page.conflictPolicy, settings);
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
      if (!isSubtitleConvertFormat(ext)) { errors.push(`Unsupported format: ${fileName}`); continue; }
      if (ext === to) { errors.push(`Already ${to}: ${fileName}`); continue; }
      const task: SubtitleConverterTask & { agentTaskId: string } = {
        agentTaskId: crypto.randomUUID(), fileName, fileContent, from: ext, to,
        originFileURL: filePath, targetFileURL: output.directory ?? sourceDirectoryOf(filePath),
        status: TaskStatus.NOT_STARTED, progress: 0, conflictPolicy: conflict.policy,
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
    ...(cancelled && !taskIds.length ? { error: "agent_stopped_before_queue" } : {}),
    data: { ...createQueueResultData(selection, taskIds.length, errors), ...conflict.receipt, appliedSettings: settings.applied },
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
  const page = extractorPageSettings();
  const settings = new SettingsResolver();
  const keep = settings.pick("keep", args.keep, page.keep, "ZH") as TranslationLanguage;
  const output = await resolvePageOutput("extract", args, page, settings, check);
  if (!output.ok) return { success: false, error: output.error };
  const conflict = resolveConflictPolicy(args.conflictPolicy, page.conflictPolicy, settings);
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
      if (!isSubtitleConvertFormat(ext)) { errors.push(`Unsupported format: ${fileName}`); continue; }
      const task: SubtitleExtractorTask & { agentTaskId: string } = {
        agentTaskId: crypto.randomUUID(), fileName, fileContent, fileType: ext, keep,
        originFileURL: filePath, targetFileURL: output.directory ?? sourceDirectoryOf(filePath),
        status: TaskStatus.NOT_STARTED, progress: 0, conflictPolicy: conflict.policy,
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
    ...(cancelled && !taskIds.length ? { error: "agent_stopped_before_queue" } : {}),
    data: { ...createQueueResultData(selection, taskIds.length, errors), ...conflict.receipt },
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
    return { success: false, error: "recovery_selection_cancelled" };
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
    return { success: false, error: "task_model_not_configured" };
  }

  await flushPendingAgentTranslationRevocations();
  check();
  let queuedCount = 0;
  let skippedCount = 0;
  const sessionId = useAgentStore.getState().session.id;
  const retained = recoveryOutputDirectories.get(args.recoveryScanId);
  recoveryOutputDirectories.delete(args.recoveryScanId);
  let recoveryDirectoryToken: string | undefined;
  if (retained?.sessionId === sessionId) {
    // A later batch of the same scan reuses the directory the user already chose.
    recoveryDirectoryToken = retained.directoryToken;
  } else {
    if (retained) await scheduleAgentOutputDirectoryRevocation(retained.directoryToken);
    const directory = await getSubtitleTranslationApi().selectOutputDirectory();
    if (!directory.ok) { check(); return { success: false, error: directory.error.message }; }
    try { check(); } catch (error) {
      if (directory.data.directoryToken) await scheduleAgentOutputDirectoryRevocation(directory.data.directoryToken);
      throw error;
    }
    if (directory.data.cancelled) {
      return { success: false, error: "recovery_output_selection_cancelled" };
    }
    recoveryDirectoryToken = directory.data.directoryToken;
  }
  if (!recoveryDirectoryToken) {
    return { success: false, error: "recovery_output_authorization_unavailable" };
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
  // Main keeps the directory authority only while the scan has more batches.
  if (prepared.hasMore && !args.candidateIds?.length && useAgentStore.getState().session.id === sessionId) {
    recoveryOutputDirectories.set(args.recoveryScanId, { sessionId, directoryToken: recoveryDirectoryToken });
  } else {
    await scheduleAgentOutputDirectoryRevocation(recoveryDirectoryToken);
  }
  try { check(); } catch (error) {
    for (const draft of prepared.tasks) releaseSubtitleTranslationTaskAuthority(draft.taskId);
    await releaseRecoveryOutputDirectory(args.recoveryScanId);
    throw error;
  }
  const page = translatorPageSettings();
  const settings = new SettingsResolver();
  const conflict = resolveConflictPolicy(args.conflictPolicy, page.conflictPolicy, settings);
  const concurrentSlices = settings.pick("concurrentSlices", args.concurrentSlices, page.concurrentSlices, true);
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
    conflictPolicy: conflict.policy,
    concurrentSlices,
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
    ...conflict.receipt,
    appliedSettings: settings.applied,
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

/** Bounded raw failure detail kept beside a stable error code. */
function errorReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 600);
}

function extractFileName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() || filePath;
}

function extractExtension(filePath: string): string {
  const parts = filePath.split(".");
  return (parts.pop() || "").toUpperCase();
}

function sourceDirectoryOf(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

/**
 * Overwriting replaces user files, so it needs the user's own words in the latest
 * message; otherwise the safe indexed policy is used and reported to the model.
 */
function resolveConflictPolicy(requested: "index" | "overwrite" | undefined, page?: "index" | "overwrite", settings?: SettingsResolver) {
  // A policy the user set on the tool page is their own choice; a policy the model sends is checked below.
  if (requested === undefined) return { policy: settings ? settings.pick("conflictPolicy", undefined, page, "index" as const) : page ?? "index" as const, receipt: {} };
  if (requested !== "overwrite") return { policy: settings?.note("conflictPolicy", "index" as const, "user") ?? "index" as const, receipt: {} };
  if (userRequestedOverwrite(latestUserMessageText(useAgentStore.getState().session.messages))) {
    return { policy: settings?.note("conflictPolicy", "overwrite" as const, "user") ?? "overwrite" as const, receipt: {} };
  }
  settings?.note("conflictPolicy", "index", "default");
  return { policy: "index" as const, receipt: { conflictPolicy: "index", conflictPolicyAdjusted: "overwrite_requires_explicit_user_request" } };
}

/**
 * The output location of a converter or extractor task: the request's, the
 * folder the user chose on the tool page, or next to each input.
 */
async function resolvePageOutput(
  kind: "convert" | "extract",
  args: { outputMode?: "source" | "custom"; outputDir?: string; scanId?: string },
  page: { outputMode?: "source" | "custom"; outputDir?: string },
  settings: SettingsResolver,
  check: () => void,
): Promise<{ ok: true; directory?: string } | { ok: false; error: string }> {
  if (args.outputMode === undefined && page.outputMode === "custom" && page.outputDir) {
    settings.note("outputMode", "custom", "tool_page");
    settings.note("outputDir", page.outputDir, "tool_page");
    return { ok: true, directory: page.outputDir };
  }
  const outputMode = settings.pick("outputMode", args.outputMode, undefined, "source" as const);
  return resolveLegacyOutputDirectory(kind, { ...args, outputMode }, check);
}

/** Custom output directories chosen in the picker, reused by later batches of one scan. */
const legacyOutputDirectories = new Map<string, { sessionId: string; directory: string }>();

/**
 * A custom output directory must come from the user: either typed in this
 * conversation or chosen in the native picker. Model-invented paths are ignored.
 */
async function resolveLegacyOutputDirectory(
  kind: "convert" | "extract",
  args: { outputMode?: string; outputDir?: string; scanId?: string },
  check: () => void,
): Promise<{ ok: true; directory?: string } | { ok: false; error: string }> {
  if (args.outputMode !== "custom") return { ok: true };
  const { session } = useAgentStore.getState();
  if (args.outputDir && userMentionedDirectory(session.messages, args.outputDir)) {
    return { ok: true, directory: args.outputDir.trim() };
  }
  const cacheKey = args.scanId ? `${kind}:${args.scanId}` : undefined;
  const cached = cacheKey ? legacyOutputDirectories.get(cacheKey) : undefined;
  if (cached?.sessionId === session.id) return { ok: true, directory: cached.directory };
  const result = await getIpcRenderer().invoke("select-output-directory", {
    title: i18n.t("subtitle:converter.dialog.select_output_title"),
    buttonLabel: i18n.t("subtitle:converter.dialog.select_output_confirm"),
  }) as { canceled?: boolean; filePaths?: string[] } | undefined;
  check();
  const directory = result && !result.canceled ? result.filePaths?.[0] : undefined;
  if (!directory) return { ok: false, error: "output_selection_cancelled" };
  if (cacheKey) legacyOutputDirectories.set(cacheKey, { sessionId: session.id, directory });
  return { ok: true, directory };
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
/** Output authority main retains for the remaining batches of one recovery scan. */
const recoveryOutputDirectories = new Map<string, { sessionId: string; directoryToken: string }>();

async function releaseRecoveryOutputDirectory(recoveryScanId: string): Promise<void> {
  const retained = recoveryOutputDirectories.get(recoveryScanId);
  if (!retained) return;
  recoveryOutputDirectories.delete(recoveryScanId);
  await scheduleAgentOutputDirectoryRevocation(retained.directoryToken);
}

useAgentStore.subscribe((state, previous) => {
  if (state.session.id === previous.session.id) return;
  legacyOutputDirectories.clear();
  for (const [recoveryScanId, retained] of recoveryOutputDirectories) {
    if (retained.sessionId !== state.session.id) {
      void releaseRecoveryOutputDirectory(recoveryScanId).catch(() => {});
    }
  }
});

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
