import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  FileVideo2,
  FolderOpen,
  Loader2,
  Play,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import {
  ToolConfigPanel,
  ToolDetailLayout,
  ToolField,
  ToolFileDropZone,
  ToolOutputPathPicker,
  ToolPanel,
  ToolRadioButtonGroup,
} from "@/pages/Tools/_shared/ui";
import {
  getLocalSubtitleRuntimeService,
} from "@/services/local-subtitle/localSubtitleRuntimeService";
import useLocalSubtitleTranscriberStore from "@/store/tools/subtitle/useLocalSubtitleTranscriberStore";
import type {
  LocalSubtitleBatchSummary,
  LocalSubtitleError,
  LocalSubtitleTaskStage,
  LocalSubtitleTaskStatus,
  LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleIpcResult,
  LocalSubtitleManagedResourceSummary,
  LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";
import {
  createSingleFileLocalSubtitleRequest,
  deriveLocalSubtitleStartIssue,
  findLocalSubtitleTask,
  formatLocalSubtitleBytes,
  getCommittedSrtArtifact,
  getReadyLocalSubtitleModels,
  isLocalSubtitleTaskActive,
  type LocalSubtitleStartIssue,
} from "./localSubtitleTranscriberModel";
import {
  LocalSubtitleEnvironmentManager,
  localSubtitleResourceActionKey,
} from "./LocalSubtitleEnvironmentManager";
import {
  LocalSubtitleErrorNotice,
  type LocalSubtitleDisplayError,
} from "./LocalSubtitleErrorNotice";

const MEDIA_ACCEPT = [
  "audio/*",
  "video/*",
  ".aac",
  ".flac",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".wav",
  ".webm",
].join(",");

const TASK_STAGE_KEYS = {
  queued: "subtitle:local_transcriber.stage.queued",
  preparing_media: "subtitle:local_transcriber.stage.preparing_media",
  loading_model: "subtitle:local_transcriber.stage.loading_model",
  transcribing: "subtitle:local_transcriber.stage.transcribing",
  post_processing: "subtitle:local_transcriber.stage.post_processing",
  exporting: "subtitle:local_transcriber.stage.exporting",
  cancelling: "subtitle:local_transcriber.stage.cancelling",
} as const satisfies Record<LocalSubtitleTaskStage, string>;

const TASK_STATUS_KEYS = {
  queued: "subtitle:local_transcriber.status.queued",
  preparing_media: "subtitle:local_transcriber.status.preparing_media",
  loading_model: "subtitle:local_transcriber.status.loading_model",
  transcribing: "subtitle:local_transcriber.status.transcribing",
  post_processing: "subtitle:local_transcriber.status.post_processing",
  exporting: "subtitle:local_transcriber.status.exporting",
  completed: "subtitle:local_transcriber.status.completed",
  cancelling: "subtitle:local_transcriber.status.cancelling",
  cancelled: "subtitle:local_transcriber.status.cancelled",
  failed: "subtitle:local_transcriber.status.failed",
} as const satisfies Record<LocalSubtitleTaskStatus, string>;

const START_ISSUE_KEYS = {
  environment_loading: "subtitle:local_transcriber.readiness.environment_loading",
  environment_unavailable: "subtitle:local_transcriber.readiness.environment_unavailable",
  runtime_unavailable: "subtitle:local_transcriber.readiness.runtime_unavailable",
  session_unavailable: "subtitle:local_transcriber.readiness.session_unavailable",
  model_required: "subtitle:local_transcriber.readiness.model_required",
  file_required: "subtitle:local_transcriber.readiness.file_required",
  output_directory_required: "subtitle:local_transcriber.readiness.output_directory_required",
  task_active: "subtitle:local_transcriber.readiness.task_active",
} as const satisfies Record<LocalSubtitleStartIssue, string>;

interface EnvironmentState {
  readonly loading: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly resources: readonly LocalSubtitleManagedResourceSummary[];
  readonly error: LocalSubtitleError | null;
}

export default function LocalSubtitleTranscriber() {
  const { t } = useTranslation(["subtitle", "common"]);
  const runtimeService = useMemo(getLocalSubtitleRuntimeService, []);
  const runtimeState = useSyncExternalStore(
    runtimeService.subscribe,
    runtimeService.getState,
    runtimeService.getState,
  );
  const preferences = useLocalSubtitleTranscriberStore(
    (state) => state.preferences,
  );
  const selectedFile = useLocalSubtitleTranscriberStore(
    (state) => state.draftInputFiles[0] ?? null,
  );
  const outputDirectory = useLocalSubtitleTranscriberStore(
    (state) => state.draftOutputDirectory,
  );
  const updatePreferences = useLocalSubtitleTranscriberStore(
    (state) => state.updatePreferences,
  );
  const setDraftInputFiles = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftInputFiles,
  );
  const setDraftOutputDirectory = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftOutputDirectory,
  );
  const consumeDraftCapabilitiesAfterCommit = useLocalSubtitleTranscriberStore(
    (state) => state.consumeDraftCapabilitiesAfterCommit,
  );
  const resetDraft = useLocalSubtitleTranscriberStore(
    (state) => state.resetDraft,
  );

  const mountedRef = useRef(true);
  const refreshGenerationRef = useRef(0);
  const resourceRefreshGenerationRef = useRef(0);
  const terminalResourceJobsRef = useRef("");
  const [environment, setEnvironment] = useState<EnvironmentState>({
    loading: true,
    runtime: null,
    resources: [],
    error: null,
  });
  const [dragging, setDragging] = useState(false);
  const [fileAuthorizationPending, setFileAuthorizationPending] = useState(false);
  const [outputSelectionPending, setOutputSelectionPending] = useState(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [actionError, setActionError] = useState<LocalSubtitleDisplayError | null>(null);
  const [resourceActionError, setResourceActionError] =
    useState<LocalSubtitleDisplayError | null>(null);
  const [pendingResourceActions, setPendingResourceActions] =
    useState<ReadonlySet<string>>(() => new Set());
  const [activeIdentity, setActiveIdentity] = useState<{
    readonly batchId: string;
    readonly taskId: string;
  } | null>(null);
  const [submittedBatch, setSubmittedBatch] = useState<LocalSubtitleBatchSummary | null>(null);

  const refreshEnvironment = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    setResourceActionError(null);
    try {
      const [runtimeResult, resourceResult] = await Promise.all([
        window.localSubtitleApi.probeRuntime(),
        window.localSubtitleApi.listManagedResources(),
      ]);
      if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
      if (!runtimeResult.ok) {
        setEnvironment({
          loading: false,
          runtime: null,
          resources: resourceResult.ok ? resourceResult.data : [],
          error: runtimeResult.error,
        });
        return;
      }
      if (!resourceResult.ok) {
        setEnvironment({
          loading: false,
          runtime: runtimeResult.data,
          resources: [],
          error: resourceResult.error,
        });
        return;
      }
      setEnvironment({
        loading: false,
        runtime: runtimeResult.data,
        resources: resourceResult.data,
        error: null,
      });
      void runtimeService.refresh();
    } catch (error) {
      if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
      setEnvironment({
        loading: false,
        runtime: null,
        resources: [],
        error: null,
      });
      setResourceActionError(toDisplayError(error));
    }
  }, [runtimeService]);

  const refreshManagedResources = useCallback(async () => {
    const generation = ++resourceRefreshGenerationRef.current;
    try {
      const result = await window.localSubtitleApi.listManagedResources();
      if (!mountedRef.current || generation !== resourceRefreshGenerationRef.current) return;
      if (!result.ok) {
        setResourceActionError(result.error);
        return;
      }
      setEnvironment((current) => ({
        ...current,
        resources: result.data,
      }));
    } catch (error) {
      if (mountedRef.current && generation === resourceRefreshGenerationRef.current) {
        setResourceActionError(toDisplayError(error));
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshEnvironment();
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
      resourceRefreshGenerationRef.current += 1;
      resetDraft();
    };
  }, [refreshEnvironment, resetDraft]);

  const terminalResourceJobsSignature = useMemo(
    () => runtimeState.resourceJobs
      .filter((job) => ["completed", "cancelled", "failed"].includes(job.status))
      .map((job) => `${job.jobId}:${job.status}:${job.updatedAt}`)
      .sort()
      .join("|"),
    [runtimeState.resourceJobs],
  );

  useEffect(() => {
    if (
      terminalResourceJobsSignature.length === 0 ||
      terminalResourceJobsRef.current === terminalResourceJobsSignature
    ) return;
    terminalResourceJobsRef.current = terminalResourceJobsSignature;
    void refreshManagedResources();
  }, [refreshManagedResources, terminalResourceJobsSignature]);

  const readyModels = useMemo(
    () => getReadyLocalSubtitleModels(environment.resources),
    [environment.resources],
  );
  const selectedModelId = readyModels.some(
    (model) => model.resourceId === preferences.modelId,
  )
    ? preferences.modelId
    : readyModels[0]?.resourceId ?? null;
  const liveTask = findLocalSubtitleTask(
    runtimeState.batches,
    activeIdentity?.batchId ?? null,
    activeIdentity?.taskId ?? null,
  );
  const fallbackTask = activeIdentity && submittedBatch?.batchId === activeIdentity.batchId
    ? submittedBatch.tasks.find((task) => task.taskId === activeIdentity.taskId) ?? null
    : null;
  const activeTask = liveTask ?? fallbackTask;
  const taskActive = isLocalSubtitleTaskActive(activeTask);
  const submissionLocked = submissionPending || taskActive;
  const startIssue = deriveLocalSubtitleStartIssue({
    environmentLoading: environment.loading,
    environmentError: Boolean(environment.error),
    runtime: environment.runtime,
    runtimeSyncStatus: runtimeState.syncStatus,
    readyModels,
    selectedModelId,
    selectedFile,
    outputMode: preferences.outputMode,
    outputDirectory,
    taskActive,
  });

  const runResourceAction = useCallback(async (
    key: string,
    operation: () => Promise<LocalSubtitleIpcResult<unknown>>,
    refreshResourcesAfter: boolean,
  ): Promise<boolean> => {
    setPendingResourceActions((current) => new Set(current).add(key));
    setResourceActionError(null);
    try {
      const result = await operation();
      if (!mountedRef.current) return false;
      if (!result.ok) {
        setResourceActionError(result.error);
        return false;
      }
      if (refreshResourcesAfter) void refreshManagedResources();
      void runtimeService.refresh();
      return true;
    } catch (error) {
      if (mountedRef.current) setResourceActionError(toDisplayError(error));
      return false;
    } finally {
      if (mountedRef.current) {
        setPendingResourceActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, [refreshManagedResources, runtimeService]);

  const handleResourceInstall = useCallback(
    (resourceId: string) => runResourceAction(
      localSubtitleResourceActionKey("install", resourceId),
      () => window.localSubtitleApi.startResourceInstall({ resourceId }),
      true,
    ),
    [runResourceAction],
  );

  const handleResourceCancel = useCallback(
    (jobId: string) => runResourceAction(
      localSubtitleResourceActionKey("cancel", jobId),
      () => window.localSubtitleApi.cancelResourceJob(jobId),
      false,
    ),
    [runResourceAction],
  );

  const handleResourceDelete = useCallback(
    (resourceId: string) => runResourceAction(
      localSubtitleResourceActionKey("delete", resourceId),
      () => window.localSubtitleApi.deleteManagedResource(resourceId),
      true,
    ),
    [runResourceAction],
  );

  const handleModelImport = useCallback(
    (file: File, mode: "copy" | "move") => {
      const modelId = environment.resources.find(
        (resource) => resource.resourceType === "model",
      )?.resourceId ?? "model";
      return runResourceAction(
        localSubtitleResourceActionKey("import", modelId),
        () => window.localSubtitleApi.importModel(file, { mode }),
        true,
      );
    },
    [environment.resources, runResourceAction],
  );

  const handleFiles = useCallback(async (files: FileList) => {
    const file = files.item(0);
    if (!file) return;
    setFileAuthorizationPending(true);
    setActionError(null);
    try {
      const result = await window.localSubtitleApi.authorizeInputFiles([file]);
      if (!mountedRef.current) {
        if (result.ok) {
          for (const authorized of result.data) {
            runtimeService.queueInputDraftRevocation(authorized);
          }
        }
        return;
      }
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setDraftInputFiles(result.data.slice(0, 1));
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (mountedRef.current) setFileAuthorizationPending(false);
    }
  }, [runtimeService, setDraftInputFiles]);

  const handleSelectOutput = useCallback(async () => {
    setOutputSelectionPending(true);
    setActionError(null);
    try {
      const result = await window.localSubtitleApi.selectOutputDirectory();
      if (!mountedRef.current) {
        if (result.ok && !result.data.cancelled) {
          runtimeService.queueOutputDraftRevocation(result.data);
        }
        return;
      }
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      if (!result.data.cancelled) setDraftOutputDirectory(result.data);
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (mountedRef.current) setOutputSelectionPending(false);
    }
  }, [runtimeService, setDraftOutputDirectory]);

  const handleStart = useCallback(async () => {
    if (startIssue || !selectedFile || !selectedModelId) return;
    setSubmissionPending(true);
    setActionError(null);
    try {
      const request = createSingleFileLocalSubtitleRequest({
        file: selectedFile,
        modelId: selectedModelId,
        preferences,
        outputDirectory,
      });
      const result = await window.localSubtitleApi.enqueue(request);
      if (!mountedRef.current) return;
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      const task = result.data.tasks[0];
      if (!task) {
        setActionError({ message: "The local subtitle batch did not return a task." });
        return;
      }
      setSubmittedBatch(result.data);
      setActiveIdentity({ batchId: result.data.batchId, taskId: task.taskId });
      consumeDraftCapabilitiesAfterCommit();
      void runtimeService.refresh();
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (mountedRef.current) setSubmissionPending(false);
    }
  }, [
    consumeDraftCapabilitiesAfterCommit,
    outputDirectory,
    preferences,
    runtimeService,
    selectedFile,
    selectedModelId,
    startIssue,
  ]);

  const handleCancel = useCallback(async () => {
    if (!activeTask || !isLocalSubtitleTaskActive(activeTask)) return;
    setCancelPending(true);
    setActionError(null);
    try {
      const result = await window.localSubtitleApi.cancelTask(activeTask.taskId);
      if (mountedRef.current && !result.ok) setActionError(result.error);
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (mountedRef.current) setCancelPending(false);
    }
  }, [activeTask]);

  const handleReveal = useCallback(async (task: LocalSubtitleTaskSummary) => {
    const artifact = getCommittedSrtArtifact(task);
    if (!artifact) return;
    setActionError(null);
    try {
      const result = await window.localSubtitleApi.revealArtifact(artifact.artifactRef);
      if (mountedRef.current && !result.ok) setActionError(result.error);
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    }
  }, []);

  const environmentReady = !startIssue || [
    "file_required",
    "output_directory_required",
    "task_active",
  ].includes(startIssue);

  return (
    <div data-testid="local-subtitle-transcriber">
      <ToolDetailLayout
        header={
          <ToolPageHeader
            meta={TOOL_META.localSubtitleTranscriber}
            title={t("subtitle:local_transcriber.title")}
            description={t("subtitle:local_transcriber.description")}
            right={<Badge variant="outline">CPU · SRT</Badge>}
          />
        }
        aside={
          <ToolConfigPanel
            icon={Settings2}
            title={t("subtitle:local_transcriber.config.title")}
          >
            <ToolField label={t("subtitle:local_transcriber.config.model")}>
              <Select
                value={selectedModelId ?? undefined}
                disabled={submissionLocked || readyModels.length === 0}
                onValueChange={(modelId) => updatePreferences({ modelId })}
              >
                <SelectTrigger data-testid="local-subtitle-model-select" className="h-8 text-xs">
                  <SelectValue placeholder={t("subtitle:local_transcriber.config.no_model")} />
                </SelectTrigger>
                <SelectContent>
                  {readyModels.map((model) => (
                    <SelectItem key={model.resourceId} value={model.resourceId}>
                      {model.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolField>

            <ToolField label={t("subtitle:local_transcriber.config.output_mode")}>
              <ToolRadioButtonGroup
                value={preferences.outputMode}
                disabled={submissionLocked}
                ariaLabel={t("subtitle:local_transcriber.config.output_mode")}
                options={[
                  {
                    value: "source",
                    label: t("subtitle:local_transcriber.config.output_source"),
                  },
                  {
                    value: "custom",
                    label: t("subtitle:local_transcriber.config.output_custom"),
                  },
                ]}
                onValueChange={(outputMode) => updatePreferences({ outputMode })}
              />
            </ToolField>

            {preferences.outputMode === "custom" ? (
              <ToolField label={t("subtitle:local_transcriber.config.output_directory")}>
                <ToolOutputPathPicker
                  value={outputDirectory?.displayLabel ?? ""}
                  placeholder={t("subtitle:local_transcriber.config.output_placeholder")}
                  selectLabel={t("subtitle:local_transcriber.actions.select_output")}
                  disabled={submissionLocked || outputSelectionPending}
                  onSelect={handleSelectOutput}
                />
              </ToolField>
            ) : null}
          </ToolConfigPanel>
        }
      >
        <LocalSubtitleEnvironmentManager
          loading={environment.loading}
          runtime={environment.runtime}
          resources={environment.resources}
          resourceJobs={runtimeState.resourceJobs}
          pendingActionKeys={pendingResourceActions}
          error={resourceActionError ?? environment.error}
          onRefresh={refreshEnvironment}
          onInstall={handleResourceInstall}
          onCancel={handleResourceCancel}
          onDelete={handleResourceDelete}
          onImport={handleModelImport}
        />

        <ToolPanel
          icon={FileVideo2}
          title={t("subtitle:local_transcriber.workspace.title")}
          badge={
            <EnvironmentBadge
              ready={environmentReady}
              loading={environment.loading || runtimeState.syncStatus === "syncing"}
            />
          }
          bodyClassName="p-5"
        >
          <div className="space-y-4">
            <ToolFileDropZone
              id="local-subtitle-file"
              inputTestId="local-subtitle-file-input"
              accept={MEDIA_ACCEPT}
              dragging={dragging}
              disabled={submissionLocked || fileAuthorizationPending}
              title={t(
                fileAuthorizationPending
                  ? "subtitle:local_transcriber.file.authorizing"
                  : "subtitle:local_transcriber.file.title",
              )}
              description={t("subtitle:local_transcriber.file.description")}
              actionLabel={t("subtitle:local_transcriber.actions.select_file")}
              icon={fileAuthorizationPending ? <Loader2 className="h-5 w-5 animate-spin" /> : undefined}
              onDraggingChange={setDragging}
              onFiles={handleFiles}
            />

            {selectedFile ? (
              <div
                data-testid="local-subtitle-file-selected"
                className="flex min-w-0 items-center gap-3 border-y px-1 py-3"
              >
                <FileVideo2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{selectedFile.displayName}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatLocalSubtitleBytes(selectedFile.byteSize)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={submissionLocked}
                  onClick={() => setDraftInputFiles([])}
                  aria-label={t("subtitle:local_transcriber.actions.clear_file")}
                  title={t("subtitle:local_transcriber.actions.clear_file")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : null}

            {actionError || runtimeState.error ? (
              <LocalSubtitleErrorNotice error={actionError ?? runtimeState.error!} />
            ) : null}

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                data-testid="local-subtitle-start"
                type="button"
                disabled={Boolean(startIssue) || submissionPending}
                onClick={handleStart}
              >
                {submissionPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {t("subtitle:local_transcriber.actions.start")}
              </Button>
              <Button
                data-testid="local-subtitle-cancel"
                type="button"
                variant="outline"
                disabled={!taskActive || cancelPending}
                onClick={handleCancel}
              >
                {cancelPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                {t("common:action.cancel")}
              </Button>
              {startIssue ? (
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                  {t(START_ISSUE_KEYS[startIssue])}
                </p>
              ) : null}
            </div>

            <TaskResult task={activeTask} onReveal={handleReveal} />
          </div>
        </ToolPanel>
      </ToolDetailLayout>
    </div>
  );
}

function EnvironmentBadge({ ready, loading }: { ready: boolean; loading: boolean }) {
  const { t } = useTranslation(["subtitle"]);
  return (
    <Badge variant={ready ? "secondary" : "outline"}>
      {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
      {t(
        loading
          ? "subtitle:local_transcriber.environment.checking"
          : ready
            ? "subtitle:local_transcriber.environment.ready"
            : "subtitle:local_transcriber.environment.unavailable",
      )}
    </Badge>
  );
}

function TaskResult({
  task,
  onReveal,
}: {
  task: LocalSubtitleTaskSummary | null;
  onReveal: (task: LocalSubtitleTaskSummary) => void;
}) {
  const { t } = useTranslation(["subtitle"]);
  if (!task) {
    return (
      <div
        data-testid="local-subtitle-result-empty"
        className="flex min-h-48 items-center justify-center border-t px-4 py-8 text-center"
      >
        <div className="max-w-sm space-y-2">
          <FileVideo2 className="mx-auto h-6 w-6 text-muted-foreground" />
          <div className="text-sm font-medium">
            {t("subtitle:local_transcriber.result.empty_title")}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t("subtitle:local_transcriber.result.empty_description")}
          </div>
        </div>
      </div>
    );
  }

  const artifact = getCommittedSrtArtifact(task);
  return (
    <div data-testid="local-subtitle-result" className="space-y-3 border-t pt-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{task.displayName}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t(TASK_STATUS_KEYS[task.status])} · {task.resolvedBackend.toUpperCase()}
          </div>
        </div>
        {artifact ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onReveal(task)}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t("subtitle:local_transcriber.actions.reveal")}
          </Button>
        ) : null}
      </div>

      {isLocalSubtitleTaskActive(task) ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{t(TASK_STAGE_KEYS[task.progress.stage])}</span>
            <span>{Math.round(task.progress.overallProgress)}%</span>
          </div>
          <Progress value={task.progress.overallProgress} />
        </div>
      ) : null}

      {task.status === "completed" && artifact ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="truncate">{artifact.displayName}</span>
        </div>
      ) : null}

      {task.error ? <LocalSubtitleErrorNotice error={task.error} /> : null}
    </div>
  );
}

function toDisplayError(error: unknown): LocalSubtitleDisplayError {
  return {
    message: error instanceof Error
      ? error.message
      : "The local subtitle operation could not be completed.",
  };
}
