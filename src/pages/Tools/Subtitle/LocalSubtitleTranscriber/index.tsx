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
  FileVideo2,
  Loader2,
  Play,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import {
  getLocalSubtitlePostActionService,
  type LocalSubtitleManualHandoffResult,
} from "@/services/local-subtitle/localSubtitlePostActionService";
import useLocalSubtitleTranscriberStore from "@/store/tools/subtitle/useLocalSubtitleTranscriberStore";
import type {
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleBatchSummary,
  LocalSubtitleError,
  LocalSubtitleTaskSummary,
  LocalSubtitleFormat,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleIpcResult,
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleBackendPreviewSummary,
  LocalSubtitleManagedResourceSummary,
  LocalSubtitleRuntimeSummary,
  EnqueueLocalSubtitleBatchRequest,
} from "@/type/localSubtitleIpc";
import type { SubtitleTranslationImportConfigSummary } from "@/type/generatedSubtitleImport";
import { showToast } from "@/utils/toast";
import {
  createLocalSubtitleBatchRequest,
  deriveLocalSubtitleDraftMediaProbeStatus,
  deriveLocalSubtitleStartIssue,
  formatLocalSubtitleBytes,
  getReadyLocalSubtitleModels,
  type LocalSubtitleDraftMediaProbe,
  type LocalSubtitleStartIssue,
} from "./localSubtitleTranscriberModel";
import { LocalSubtitleDraftMediaList } from "./LocalSubtitleDraftMediaList";
import {
  LocalSubtitleEnvironmentManager,
  localSubtitleResourceActionKey,
} from "./LocalSubtitleEnvironmentManager";
import {
  LocalSubtitleErrorNotice,
  type LocalSubtitleDisplayError,
} from "./LocalSubtitleErrorNotice";
import {
  LocalSubtitleTaskQueue,
  localSubtitleTaskActionKey,
  type LocalSubtitleTaskAction,
} from "./LocalSubtitleTaskQueue";
import {
  LocalSubtitleArtifactPreviewDialog,
  LocalSubtitleErrorDetailsDialog,
  type LocalSubtitleArtifactPreviewSelection,
} from "./LocalSubtitleTaskDetailsDialogs";
import { LocalSubtitleRecoveredSession } from "./LocalSubtitleRecoveredSession";
import { LocalSubtitleTranslationConfirmDialog } from "./LocalSubtitleTranslationConfirmDialog";

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

const START_ISSUE_KEYS = {
  environment_loading: "subtitle:local_transcriber.readiness.environment_loading",
  environment_unavailable: "subtitle:local_transcriber.readiness.environment_unavailable",
  runtime_unavailable: "subtitle:local_transcriber.readiness.runtime_unavailable",
  session_unavailable: "subtitle:local_transcriber.readiness.session_unavailable",
  model_required: "subtitle:local_transcriber.readiness.model_required",
  vad_required: "subtitle:local_transcriber.readiness.vad_required",
  backend_preview_loading: "subtitle:local_transcriber.readiness.backend_preview_loading",
  backend_preview_unavailable: "subtitle:local_transcriber.readiness.backend_preview_unavailable",
  file_required: "subtitle:local_transcriber.readiness.file_required",
  media_probe_loading: "subtitle:local_transcriber.readiness.media_probe_loading",
  media_probe_failed: "subtitle:local_transcriber.readiness.media_probe_failed",
  output_directory_required: "subtitle:local_transcriber.readiness.output_directory_required",
} as const satisfies Record<LocalSubtitleStartIssue, string>;

const POST_ACTION_PREPARE_ERROR_KEYS = {
  configuration_not_ready:
    "subtitle:local_transcriber.post_action.error.configuration_not_ready",
  directory_authorization_required:
    "subtitle:local_transcriber.post_action.error.directory_authorization_required",
  profile_required:
    "subtitle:local_transcriber.post_action.error.profile_required",
} as const;

interface EnvironmentState {
  readonly loading: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly resources: readonly LocalSubtitleManagedResourceSummary[];
  readonly error: LocalSubtitleError | null;
}

interface BackendPreviewState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly modelId: string | null;
  readonly devicePreference: LocalSubtitleBackendPreviewSummary["devicePreference"] | null;
  readonly summary: LocalSubtitleBackendPreviewSummary | null;
}

const LOCAL_SUBTITLE_LANGUAGE_OPTIONS = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
] as const;

interface PreparedTranslationBatch {
  readonly request: EnqueueLocalSubtitleBatchRequest;
  readonly snapshot: SubtitleTranslationImportConfigSummary;
  readonly preferredFormat: LocalSubtitleFormat;
}

export default function LocalSubtitleTranscriber() {
  const { t } = useTranslation(["subtitle", "common"]);
  const runtimeService = useMemo(getLocalSubtitleRuntimeService, []);
  const postActionService = useMemo(getLocalSubtitlePostActionService, []);
  const runtimeState = useSyncExternalStore(
    runtimeService.subscribe,
    runtimeService.getState,
    runtimeService.getState,
  );
  const preferences = useLocalSubtitleTranscriberStore(
    (state) => state.preferences,
  );
  const selectedFiles = useLocalSubtitleTranscriberStore(
    (state) => state.draftInputFiles,
  );
  const outputDirectory = useLocalSubtitleTranscriberStore(
    (state) => state.draftOutputDirectory,
  );
  const draftConflictPolicy = useLocalSubtitleTranscriberStore(
    (state) => state.draftConflictPolicy,
  );
  const draftInitialPrompt = useLocalSubtitleTranscriberStore(
    (state) => state.draftInitialPrompt,
  );
  const draftTaskMode = useLocalSubtitleTranscriberStore(
    (state) => state.draftTaskMode,
  );
  const draftPostActionMode = useLocalSubtitleTranscriberStore(
    (state) => state.draftPostActionMode,
  );
  const draftPreferredHandoffFormat = useLocalSubtitleTranscriberStore(
    (state) => state.draftPreferredHandoffFormat,
  );
  const updatePreferences = useLocalSubtitleTranscriberStore(
    (state) => state.updatePreferences,
  );
  const setDraftInputFiles = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftInputFiles,
  );
  const removeDraftInputFile = useLocalSubtitleTranscriberStore(
    (state) => state.removeDraftInputFile,
  );
  const setDraftOutputDirectory = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftOutputDirectory,
  );
  const setDraftInitialPrompt = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftInitialPrompt,
  );
  const setDraftTaskMode = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftTaskMode,
  );
  const setDraftConflictPolicy = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftConflictPolicy,
  );
  const setDraftPostActionMode = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftPostActionMode,
  );
  const setDraftPreferredHandoffFormat = useLocalSubtitleTranscriberStore(
    (state) => state.setDraftPreferredHandoffFormat,
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
  const backendPreviewGenerationRef = useRef(0);
  const mediaProbeGenerationRef = useRef(0);
  const mediaProbeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const terminalResourceJobsRef = useRef("");
  const [environment, setEnvironment] = useState<EnvironmentState>({
    loading: true,
    runtime: null,
    resources: [],
    error: null,
  });
  const [backendPreview, setBackendPreview] = useState<BackendPreviewState>({
    status: "idle",
    modelId: null,
    devicePreference: null,
    summary: null,
  });
  const [dragging, setDragging] = useState(false);
  const [fileAuthorizationPending, setFileAuthorizationPending] = useState(false);
  const [outputSelectionPending, setOutputSelectionPending] = useState(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const [preparedTranslationBatch, setPreparedTranslationBatch] =
    useState<PreparedTranslationBatch | null>(null);
  const preparedTranslationBatchRef = useRef<PreparedTranslationBatch | null>(null);
  const preparedBatchCommitPendingRef = useRef(false);
  const [mediaProbeQueuePending, setMediaProbeQueuePending] = useState(false);
  const [draftMediaProbes, setDraftMediaProbes] = useState<
    ReadonlyMap<string, LocalSubtitleDraftMediaProbe>
  >(() => new Map());
  const [explicitAudioStreamIds, setExplicitAudioStreamIds] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [cpuRetryCandidate, setCpuRetryCandidate] =
    useState<LocalSubtitleTaskSummary | null>(null);
  const [artifactPreview, setArtifactPreview] =
    useState<LocalSubtitleArtifactPreviewSelection | null>(null);
  const [errorDetailsTask, setErrorDetailsTask] =
    useState<LocalSubtitleTaskSummary | null>(null);
  const [actionError, setActionError] = useState<LocalSubtitleDisplayError | null>(null);
  const [resourceActionError, setResourceActionError] =
    useState<LocalSubtitleDisplayError | null>(null);
  const [pendingResourceActions, setPendingResourceActions] =
    useState<ReadonlySet<string>>(() => new Set());
  const [pendingTaskActions, setPendingTaskActions] =
    useState<ReadonlySet<string>>(() => new Set());
  const [manualHandoffResults, setManualHandoffResults] = useState<
    ReadonlyMap<string, LocalSubtitleManualHandoffResult>
  >(() => new Map());
  const [submittedBatches, setSubmittedBatches] = useState<
    readonly LocalSubtitleBatchSummary[]
  >([]);

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
      backendPreviewGenerationRef.current += 1;
      mediaProbeGenerationRef.current += 1;
      const prepared = preparedTranslationBatchRef.current;
      preparedTranslationBatchRef.current = null;
      if (prepared && !preparedBatchCommitPendingRef.current) {
        void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
      }
      resetDraft();
    };
  }, [postActionService, refreshEnvironment, resetDraft]);

  useEffect(() => {
    preparedTranslationBatchRef.current = preparedTranslationBatch;
  }, [preparedTranslationBatch]);

  useEffect(() => {
    if (preferences.outputFormats.includes(draftPreferredHandoffFormat)) return;
    setDraftPreferredHandoffFormat(
      preferences.outputFormats.includes("SRT")
        ? "SRT"
        : preferences.outputFormats[0] ?? "SRT",
    );
  }, [
    draftPreferredHandoffFormat,
    preferences.outputFormats,
    setDraftPreferredHandoffFormat,
  ]);

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
  const selectedModel = readyModels.find(
    (model) => model.resourceId === selectedModelId,
  ) ?? null;
  const vadReady = environment.resources.some(
    (resource) => resource.resourceType === "vad" && resource.status === "ready",
  );

  useEffect(() => {
    const generation = ++backendPreviewGenerationRef.current;
    if (
      !selectedModel ||
      environment.loading ||
      environment.error ||
      !environment.runtime ||
      runtimeState.syncStatus !== "ready"
    ) {
      setBackendPreview({
        status: "idle",
        modelId: selectedModel?.resourceId ?? null,
        devicePreference: preferences.devicePreference,
        summary: null,
      });
      return;
    }

    const modelId = selectedModel.resourceId;
    const devicePreference = preferences.devicePreference;
    setBackendPreview({
      status: "loading",
      modelId,
      devicePreference,
      summary: null,
    });
    void window.localSubtitleApi.previewBackend({
      modelId,
      devicePreference,
    }).then((result) => {
      if (
        !mountedRef.current ||
        generation !== backendPreviewGenerationRef.current
      ) return;
      if (
        result.ok &&
        (result.data.modelId !== modelId ||
          result.data.devicePreference !== devicePreference)
      ) {
        setBackendPreview({
          status: "error",
          modelId,
          devicePreference,
          summary: null,
        });
        return;
      }
      setBackendPreview(result.ok
        ? {
            status: "ready",
            modelId,
            devicePreference,
            summary: result.data,
          }
        : {
            status: "error",
            modelId,
            devicePreference,
            summary: null,
          });
    }).catch(() => {
      if (
        !mountedRef.current ||
        generation !== backendPreviewGenerationRef.current
      ) return;
      setBackendPreview({
        status: "error",
        modelId,
        devicePreference,
        summary: null,
      });
    });
  }, [
    environment.error,
    environment.loading,
    environment.runtime,
    preferences.devicePreference,
    runtimeState.syncStatus,
    selectedModel,
  ]);

  const enqueueMediaProbes = useCallback((
    files: readonly LocalSubtitleAuthorizedMedia[],
    generation: number,
  ) => {
    const operation = mediaProbeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        for (const file of files) {
          if (
            !mountedRef.current ||
            generation !== mediaProbeGenerationRef.current
          ) return;

          let next: LocalSubtitleDraftMediaProbe;
          try {
            const result = await window.localSubtitleApi.probeMedia(file.fileToken);
            if (
              result.ok &&
              (result.data.fileToken !== file.fileToken ||
                result.data.displayName !== file.displayName)
            ) {
              next = {
                status: "error",
                error: { kind: "mismatched_file" },
              };
            } else {
              next = result.ok
                ? { status: "ready", summary: result.data }
                : { status: "error", error: result.error };
            }
          } catch (error) {
            next = { status: "error", error: toDisplayError(error) };
          }
          if (
            !mountedRef.current ||
            generation !== mediaProbeGenerationRef.current
          ) return;
          setDraftMediaProbes((current) => {
            const updated = new Map(current);
            updated.set(file.fileToken, next);
            return updated;
          });
        }
      });
    mediaProbeQueueRef.current = operation;
    void operation.finally(() => {
      if (
        mountedRef.current &&
        generation === mediaProbeGenerationRef.current
      ) {
        setMediaProbeQueuePending(false);
      }
    });
  }, []);

  useEffect(() => {
    const generation = ++mediaProbeGenerationRef.current;
    setExplicitAudioStreamIds(new Map());
    setDraftMediaProbes(new Map(
      selectedFiles.map((file) => [
        file.fileToken,
        { status: "loading" as const },
      ]),
    ));
    setMediaProbeQueuePending(selectedFiles.length > 0);
    if (selectedFiles.length > 0) enqueueMediaProbes(selectedFiles, generation);
  }, [enqueueMediaProbes, selectedFiles]);

  const handleRetryMediaProbe = useCallback((
    file: LocalSubtitleAuthorizedMedia,
  ) => {
    const generation = ++mediaProbeGenerationRef.current;
    setMediaProbeQueuePending(true);
    setDraftMediaProbes((current) => {
      const updated = new Map(current);
      updated.set(file.fileToken, { status: "loading" });
      return updated;
    });
    setExplicitAudioStreamIds((current) => {
      const updated = new Map(current);
      updated.delete(file.fileToken);
      return updated;
    });
    enqueueMediaProbes([file], generation);
  }, [enqueueMediaProbes]);

  const handleAudioStreamChange = useCallback((
    fileToken: string,
    audioStreamId: string | null,
  ) => {
    setExplicitAudioStreamIds((current) => {
      const updated = new Map(current);
      if (audioStreamId === null) {
        updated.delete(fileToken);
        return updated;
      }
      const probe = draftMediaProbes.get(fileToken);
      if (
        probe?.status === "ready" &&
        probe.summary.audioTracks.some((track) => track.streamId === audioStreamId)
      ) {
        updated.set(fileToken, audioStreamId);
      }
      return updated;
    });
  }, [draftMediaProbes]);

  useEffect(() => {
    const liveBatchIds = new Set(
      runtimeState.batches.map((batch) => batch.batchId),
    );
    if (liveBatchIds.size === 0) return;
    setSubmittedBatches((current) => current.filter(
      (batch) => !liveBatchIds.has(batch.batchId),
    ));
  }, [runtimeState.batches]);

  const visibleBatches = useMemo(() => {
    const liveBatchIds = new Set(
      runtimeState.batches.map((batch) => batch.batchId),
    );
    return [
      ...submittedBatches.filter((batch) => !liveBatchIds.has(batch.batchId)),
      ...runtimeState.batches,
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [runtimeState.batches, submittedBatches]);
  const latestActiveTask = visibleBatches
    .flatMap((batch) => batch.tasks)
    .find((task) => !["completed", "cancelled", "failed"].includes(task.status));
  const missingTranslationTaskIds = new Set(
    visibleBatches
      .flatMap((batch) => batch.tasks)
      .map((task) => task.postAction.translationTaskId)
      .filter((taskId): taskId is string =>
        Boolean(taskId) && !postActionService.hasTranslationTask(taskId!)),
  );
  const submissionLocked = submissionPending || preparedTranslationBatch !== null;
  const mediaProbeStatus = deriveLocalSubtitleDraftMediaProbeStatus(
    selectedFiles,
    draftMediaProbes,
  );
  const startIssue = deriveLocalSubtitleStartIssue({
    environmentLoading: environment.loading,
    environmentError: Boolean(environment.error),
    runtime: environment.runtime,
    runtimeSyncStatus: runtimeState.syncStatus,
    readyModels,
    selectedModelId,
    vadEnabled: preferences.vadEnabled,
    vadReady,
    backendPreviewStatus: backendPreview.status,
    backendPreviewModelId: backendPreview.modelId,
    backendPreviewDevicePreference: backendPreview.devicePreference,
    devicePreference: preferences.devicePreference,
    selectedFiles,
    mediaProbeStatus,
    outputMode: preferences.outputMode,
    outputDirectory,
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
    const selected = Array.from(files).slice(
      0,
      LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
    );
    if (selected.length === 0) return;
    setFileAuthorizationPending(true);
    setActionError(null);
    try {
      const result = await window.localSubtitleApi.authorizeInputFiles(selected);
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
      setDraftInputFiles(result.data);
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

  const handleOutputFormatChange = useCallback((
    format: LocalSubtitleFormat,
    checked: boolean,
  ) => {
    const current = preferences.outputFormats;
    const next = checked
      ? Array.from(new Set([...current, format]))
      : current.filter((candidate) => candidate !== format);
    if (next.length === 0) return;
    updatePreferences({ outputFormats: next });
    if (!next.includes(draftPreferredHandoffFormat)) {
      setDraftPreferredHandoffFormat(
        next.includes("SRT") ? "SRT" : next[0]!,
      );
    }
  }, [
    draftPreferredHandoffFormat,
    preferences.outputFormats,
    setDraftPreferredHandoffFormat,
    updatePreferences,
  ]);

  const commitBatchRequest = useCallback(async (
    request: EnqueueLocalSubtitleBatchRequest,
    prepared?: PreparedTranslationBatch,
  ) => {
    if (prepared) preparedBatchCommitPendingRef.current = true;
    setSubmissionPending(true);
    setActionError(null);
    try {
      const result = await window.localSubtitleApi.enqueue(request);
      if (!mountedRef.current) {
        if (prepared && result.ok && result.data.tasks.length > 0) {
          postActionService.registerAutomaticBatch(
            result.data,
            prepared.snapshot.snapshotId,
          );
        } else if (prepared) {
          void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
        }
        return;
      }
      if (!result.ok) {
        setActionError(result.error);
        if (prepared) {
          preparedTranslationBatchRef.current = null;
          setPreparedTranslationBatch(null);
          void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
        }
        return;
      }
      if (result.data.tasks.length === 0) {
        setActionError({ message: "The local subtitle batch did not return a task." });
        if (prepared) {
          preparedTranslationBatchRef.current = null;
          setPreparedTranslationBatch(null);
          void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
        }
        return;
      }
      if (prepared) {
        postActionService.registerAutomaticBatch(
          result.data,
          prepared.snapshot.snapshotId,
        );
      }
      setPreparedTranslationBatch(null);
      preparedTranslationBatchRef.current = null;
      setSubmittedBatches((current) => [result.data, ...current]);
      consumeDraftCapabilitiesAfterCommit();
      void runtimeService.refresh();
    } catch (error) {
      if (prepared) {
        preparedTranslationBatchRef.current = null;
        if (mountedRef.current) setPreparedTranslationBatch(null);
        void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
      }
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (prepared) preparedBatchCommitPendingRef.current = false;
      if (mountedRef.current) setSubmissionPending(false);
    }
  }, [
    consumeDraftCapabilitiesAfterCommit,
    postActionService,
    runtimeService,
  ]);

  const handleStart = useCallback(async () => {
    if (
      startIssue ||
      fileAuthorizationPending ||
      outputSelectionPending ||
      selectedFiles.length === 0 ||
      !selectedModelId ||
      preparedTranslationBatch
    ) return;
    setSubmissionPending(true);
    setActionError(null);
    try {
      if (draftPostActionMode === "export_only") {
        const request = createLocalSubtitleBatchRequest({
          files: selectedFiles,
          modelId: selectedModelId,
          preferences,
          initialPrompt: draftInitialPrompt,
          taskMode: draftTaskMode,
          outputDirectory,
          explicitAudioStreamIds,
          conflictPolicy: draftConflictPolicy,
          postAction: { mode: "export_only" },
        });
        setSubmissionPending(false);
        await commitBatchRequest(request);
        return;
      }
      const prepared = await postActionService.prepareBatch(
        draftPostActionMode,
      );
      if (!mountedRef.current) {
        if (prepared.ok) {
          void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
        }
        return;
      }
      if (!prepared.ok) {
        setActionError({
          code: prepared.code,
          message: t(POST_ACTION_PREPARE_ERROR_KEYS[prepared.code]),
        });
        return;
      }
      const request = createLocalSubtitleBatchRequest({
        files: selectedFiles,
        modelId: selectedModelId,
        preferences,
        initialPrompt: draftInitialPrompt,
        taskMode: draftTaskMode,
        outputDirectory,
        explicitAudioStreamIds,
        conflictPolicy: draftConflictPolicy,
        postAction: {
          mode: draftPostActionMode,
          preferredFormat: draftPreferredHandoffFormat,
          translationSnapshotId: prepared.snapshot.snapshotId,
        },
      });
      setPreparedTranslationBatch({
        request,
        snapshot: prepared.snapshot,
        preferredFormat: draftPreferredHandoffFormat,
      });
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (mountedRef.current) setSubmissionPending(false);
    }
  }, [
    commitBatchRequest,
    draftConflictPolicy,
    draftInitialPrompt,
    draftPostActionMode,
    draftPreferredHandoffFormat,
    draftTaskMode,
    explicitAudioStreamIds,
    fileAuthorizationPending,
    outputDirectory,
    outputSelectionPending,
    postActionService,
    preferences,
    preparedTranslationBatch,
    selectedFiles,
    selectedModelId,
    startIssue,
    t,
  ]);

  const handlePreparedBatchCancel = useCallback(() => {
    const prepared = preparedTranslationBatchRef.current;
    preparedTranslationBatchRef.current = null;
    setPreparedTranslationBatch(null);
    if (prepared) {
      void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
    }
  }, [postActionService]);

  const handlePreparedBatchConfirm = useCallback(() => {
    const prepared = preparedTranslationBatchRef.current;
    if (!prepared || submissionPending) return;
    void commitBatchRequest(prepared.request, prepared);
  }, [commitBatchRequest, submissionPending]);

  const runTaskAction = useCallback(async (
    action: LocalSubtitleTaskAction,
    task: LocalSubtitleTaskSummary,
    operation: () => Promise<LocalSubtitleIpcResult<unknown>>,
    refreshAfter = true,
  ): Promise<boolean> => {
    const key = localSubtitleTaskActionKey(action, task.taskId);
    setPendingTaskActions((current) => new Set(current).add(key));
    setActionError(null);
    try {
      const result = await operation();
      if (!mountedRef.current) return false;
      if (!result.ok) {
        setActionError(result.error);
        return false;
      }
      if (refreshAfter) void runtimeService.refresh();
      return true;
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
      return false;
    } finally {
      if (mountedRef.current) {
        setPendingTaskActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, [runtimeService]);

  const handleCancel = useCallback((task: LocalSubtitleTaskSummary) => {
    void runTaskAction(
      "cancel",
      task,
      () => window.localSubtitleApi.cancelTask(task.taskId),
    );
  }, [runTaskAction]);

  const handleRetry = useCallback((task: LocalSubtitleTaskSummary) => {
    void runTaskAction(
      "retry",
      task,
      () => window.localSubtitleApi.retryTask(task.taskId),
    );
  }, [runTaskAction]);

  const handleRemove = useCallback((task: LocalSubtitleTaskSummary) => {
    void runTaskAction(
      "remove",
      task,
      () => window.localSubtitleApi.removeTask(task.taskId),
    );
  }, [runTaskAction]);

  const handleReveal = useCallback((
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => {
    void runTaskAction(
      "reveal",
      task,
      () => window.localSubtitleApi.revealArtifact(artifact.artifactRef),
      false,
    );
  }, [runTaskAction]);

  const handleHandoff = useCallback(async (
    task: LocalSubtitleTaskSummary,
    artifact: GeneratedSubtitleArtifactSummary,
  ) => {
    const key = localSubtitleTaskActionKey("handoff", task.taskId);
    setPendingTaskActions((current) => new Set(current).add(key));
    setActionError(null);
    try {
      const mode = task.postAction.mode === "export_only"
        ? "enqueue_translation"
        : task.postAction.mode;
      const result = await postActionService.importManually({ artifact, mode });
      if (!mountedRef.current) return;
      setManualHandoffResults((current) => {
        const next = new Map(current);
        next.set(task.taskId, result);
        return next;
      });
      if (!result.ok) {
        setActionError({
          code: result.code,
          message: t("subtitle:local_transcriber.post_action.manual_failed"),
        });
        return;
      }
      showToast(
        t("subtitle:local_transcriber.post_action.manual_complete"),
        "success",
      );
    } catch (error) {
      if (mountedRef.current) setActionError(toDisplayError(error));
    } finally {
      if (mountedRef.current) {
        setPendingTaskActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, [postActionService, t]);

  const handleCpuRetryConfirm = useCallback(async () => {
    const candidate = cpuRetryCandidate;
    if (!candidate || candidate.cpuRetryAvailable !== true) return;
    const succeeded = await runTaskAction(
      "cpu-retry",
      candidate,
      () => window.localSubtitleApi.retryTaskOnCpu({
        taskId: candidate.taskId,
        generation: candidate.generation,
      }),
    );
    if (succeeded && mountedRef.current) setCpuRetryCandidate(null);
  }, [cpuRetryCandidate, runTaskAction]);

  const cpuRetryPending = cpuRetryCandidate !== null && pendingTaskActions.has(
    localSubtitleTaskActionKey("cpu-retry", cpuRetryCandidate.taskId),
  );

  const environmentReady = !startIssue || [
    "file_required",
    "media_probe_loading",
    "media_probe_failed",
    "output_directory_required",
  ].includes(startIssue);

  return (
    <div data-testid="local-subtitle-transcriber">
      <ToolDetailLayout
        header={
          <ToolPageHeader
            meta={TOOL_META.localSubtitleTranscriber}
            title={t("subtitle:local_transcriber.title")}
            description={t("subtitle:local_transcriber.description")}
            right={
              <Badge variant="outline">
                {(latestActiveTask?.resolvedBackend ?? backendPreview.summary?.resolvedBackend ?? "auto")
                  .toUpperCase()} · {preferences.outputFormats.join("+")}
              </Badge>
            }
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
              {selectedModel?.modelFormat && selectedModel.quantization ? (
                <p
                  data-testid="local-subtitle-model-description"
                  className="min-w-0 break-words text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {t("subtitle:local_transcriber.config.model_details", {
                    format: selectedModel.modelFormat.toUpperCase(),
                    quantization: selectedModel.quantization.toUpperCase(),
                    size: formatLocalSubtitleBytes(selectedModel.byteSize),
                  })}
                </p>
              ) : null}
            </ToolField>

            <ToolField label={t("subtitle:local_transcriber.config.device")}>
              <Select
                value={preferences.devicePreference}
                disabled={submissionLocked}
                onValueChange={(devicePreference) => updatePreferences({
                  devicePreference: devicePreference as typeof preferences.devicePreference,
                })}
              >
                <SelectTrigger data-testid="local-subtitle-device-select" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("subtitle:local_transcriber.config.device_auto")}
                  </SelectItem>
                  {(["cpu", "cuda", "metal"] as const).map((backend) => (
                    <SelectItem key={backend} value={backend}>
                      {t(`subtitle:local_transcriber.environment.backend.${backend}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolField>

            <ToolField label={t("subtitle:local_transcriber.config.language")}>
              <Select
                value={preferences.language}
                disabled={submissionLocked}
                onValueChange={(language) => updatePreferences({ language })}
              >
                <SelectTrigger data-testid="local-subtitle-language-select" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCAL_SUBTITLE_LANGUAGE_OPTIONS.map((language) => (
                    <SelectItem key={language} value={language}>
                      {t(`subtitle:local_transcriber.config.language_option.${language}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolField>

            <ToolField label={t("subtitle:local_transcriber.config.quality")}>
              <Select
                value={preferences.qualityPreset}
                disabled={submissionLocked}
                onValueChange={(qualityPreset) => updatePreferences({
                  qualityPreset: qualityPreset as typeof preferences.qualityPreset,
                })}
              >
                <SelectTrigger data-testid="local-subtitle-quality-select" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["subtitle_quality", "balanced", "fast"] as const).map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {t(`subtitle:local_transcriber.config.quality_option.${preset}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ToolField>

            <ToolField
              label={t("subtitle:local_transcriber.config.vad")}
              htmlFor="local-subtitle-vad"
              hint={t("subtitle:local_transcriber.config.vad_hint")}
              action={
                <Switch
                  id="local-subtitle-vad"
                  checked={preferences.vadEnabled}
                  disabled={submissionLocked}
                  onCheckedChange={(vadEnabled) => updatePreferences({ vadEnabled })}
                />
              }
            >
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t(
                  vadReady
                    ? "subtitle:local_transcriber.config.vad_ready"
                    : "subtitle:local_transcriber.config.vad_not_ready",
                )}
              </p>
            </ToolField>

            <details data-testid="local-subtitle-advanced-settings" className="group border-t pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                {t("subtitle:local_transcriber.config.advanced")}
              </summary>
              <div className="mt-3 space-y-3">
                <ToolField label={t("subtitle:local_transcriber.config.task_mode")}>
                  <ToolRadioButtonGroup
                    value={draftTaskMode}
                    disabled={submissionLocked}
                    ariaLabel={t("subtitle:local_transcriber.config.task_mode")}
                    options={[
                      {
                        value: "transcribe",
                        label: t("subtitle:local_transcriber.config.task_transcribe"),
                      },
                      {
                        value: "translate_to_english",
                        label: t("subtitle:local_transcriber.config.task_translate_english"),
                      },
                    ]}
                    onValueChange={setDraftTaskMode}
                  />
                </ToolField>
                <ToolField
                  label={t("subtitle:local_transcriber.config.initial_prompt")}
                  htmlFor="local-subtitle-initial-prompt"
                  hint={t("subtitle:local_transcriber.config.initial_prompt_hint")}
                  action={
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {draftInitialPrompt.length}/{LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars}
                    </span>
                  }
                >
                  <Textarea
                    id="local-subtitle-initial-prompt"
                    data-testid="local-subtitle-initial-prompt"
                    value={draftInitialPrompt}
                    maxLength={LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars}
                    rows={3}
                    disabled={submissionLocked}
                    className="resize-none text-xs"
                    placeholder={t("subtitle:local_transcriber.config.initial_prompt_placeholder")}
                    onChange={(event) => setDraftInitialPrompt(event.currentTarget.value)}
                  />
                </ToolField>
                <div className="grid grid-cols-2 gap-3">
                <NumericPreferenceField
                  id="local-subtitle-beam-size"
                  label={t("subtitle:local_transcriber.config.beam_size")}
                  value={preferences.beamSize}
                  min={1}
                  max={10}
                  step={1}
                  disabled={submissionLocked}
                  onCommit={(beamSize) => updatePreferences({ beamSize })}
                />
                <NumericPreferenceField
                  id="local-subtitle-temperature"
                  label={t("subtitle:local_transcriber.config.temperature")}
                  value={preferences.temperature}
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={submissionLocked}
                  onCommit={(temperature) => updatePreferences({ temperature })}
                />
                <NumericPreferenceField
                  id="local-subtitle-vad-silence"
                  label={t("subtitle:local_transcriber.config.vad_silence")}
                  value={preferences.vadMinSilenceMs}
                  min={100}
                  max={5_000}
                  step={100}
                  disabled={submissionLocked || !preferences.vadEnabled}
                  onCommit={(vadMinSilenceMs) => updatePreferences({ vadMinSilenceMs })}
                />
                <NumericPreferenceField
                  id="local-subtitle-cue-duration"
                  label={t("subtitle:local_transcriber.config.max_cue_duration")}
                  value={preferences.maxCueDurationMs}
                  min={500}
                  max={LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs}
                  step={500}
                  disabled={submissionLocked}
                  onCommit={(maxCueDurationMs) => updatePreferences({ maxCueDurationMs })}
                />
                <NumericPreferenceField
                  id="local-subtitle-cue-chars"
                  label={t("subtitle:local_transcriber.config.max_cue_chars")}
                  value={preferences.maxCueChars}
                  min={20}
                  max={LOCAL_SUBTITLE_LIMITS.maxCueTextChars}
                  step={1}
                  disabled={submissionLocked}
                  onCommit={(maxCueChars) => updatePreferences({ maxCueChars })}
                />
                <NumericPreferenceField
                  id="local-subtitle-line-chars"
                  label={t("subtitle:local_transcriber.config.max_line_chars")}
                  value={preferences.maxLineChars}
                  min={10}
                  max={LOCAL_SUBTITLE_LIMITS.maxLineChars}
                  step={1}
                  disabled={submissionLocked}
                  onCommit={(maxLineChars) => updatePreferences({ maxLineChars })}
                />
                </div>
              </div>
            </details>

            <ToolField label={t("subtitle:local_transcriber.config.output_formats")}>
              <div className="grid grid-cols-2 gap-2">
                {(["SRT", "LRC"] as const).map((format) => (
                  <label
                    key={format}
                    className="flex min-w-0 cursor-pointer items-center gap-2 border px-2.5 py-2 text-xs"
                  >
                    <Checkbox
                      checked={preferences.outputFormats.includes(format)}
                      disabled={submissionLocked}
                      onCheckedChange={(checked) =>
                        handleOutputFormatChange(format, checked === true)}
                    />
                    <span>{format}</span>
                  </label>
                ))}
              </div>
            </ToolField>

            <ToolField label={t("subtitle:local_transcriber.config.conflict_policy")}>
              <ToolRadioButtonGroup
                value={draftConflictPolicy}
                disabled={submissionLocked}
                ariaLabel={t("subtitle:local_transcriber.config.conflict_policy")}
                options={[
                  {
                    value: "index",
                    label: t("subtitle:local_transcriber.config.conflict_index"),
                  },
                  {
                    value: "overwrite",
                    label: t("subtitle:local_transcriber.config.conflict_overwrite"),
                  },
                ]}
                onValueChange={setDraftConflictPolicy}
              />
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

            <ToolField label={t("subtitle:local_transcriber.post_action.mode")}>
              <div className="divide-y border">
                <label className="flex min-w-0 cursor-pointer items-center justify-between gap-3 px-2.5 py-2 text-xs">
                  <span>{t("subtitle:local_transcriber.post_action.send_to_translation")}</span>
                  <Checkbox
                    checked={draftPostActionMode !== "export_only"}
                    disabled={submissionLocked}
                    onCheckedChange={(checked) =>
                      setDraftPostActionMode(
                        checked === true ? "enqueue_translation" : "export_only",
                      )}
                  />
                </label>
                <label className="flex min-w-0 cursor-pointer items-center justify-between gap-3 px-2.5 py-2 text-xs">
                  <span>{t("subtitle:local_transcriber.post_action.start_automatically")}</span>
                  <Checkbox
                    checked={draftPostActionMode === "enqueue_and_start_translation"}
                    disabled={submissionLocked || draftPostActionMode === "export_only"}
                    onCheckedChange={(checked) =>
                      setDraftPostActionMode(
                        checked === true
                          ? "enqueue_and_start_translation"
                          : "enqueue_translation",
                      )}
                  />
                </label>
              </div>
            </ToolField>

            {draftPostActionMode !== "export_only" ? (
              <ToolField
                label={t("subtitle:local_transcriber.post_action.handoff_format")}
              >
                <Select
                  value={draftPreferredHandoffFormat}
                  disabled={submissionLocked}
                  onValueChange={(format) =>
                    setDraftPreferredHandoffFormat(format as LocalSubtitleFormat)}
                >
                  <SelectTrigger
                    data-testid="local-subtitle-handoff-format"
                    className="h-8 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {preferences.outputFormats.map((format) => (
                      <SelectItem key={format} value={format}>
                        {format}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ToolField>
            ) : null}
          </ToolConfigPanel>
        }
      >
        <LocalSubtitleEnvironmentManager
          loading={environment.loading}
          runtime={environment.runtime}
          backendPreviewStatus={backendPreview.status}
          backendPreview={backendPreview.summary}
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
              multiple
              dragging={dragging}
              disabled={submissionLocked || fileAuthorizationPending}
              title={t(
                fileAuthorizationPending
                  ? "subtitle:local_transcriber.file.authorizing"
                  : "subtitle:local_transcriber.file.title",
              )}
              description={t("subtitle:local_transcriber.file.description", {
                max: LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
              })}
              actionLabel={t("subtitle:local_transcriber.actions.select_files")}
              icon={fileAuthorizationPending ? <Loader2 className="h-5 w-5 animate-spin" /> : undefined}
              onDraggingChange={setDragging}
              onFiles={handleFiles}
            />

            {selectedFiles.length > 0 ? (
              <LocalSubtitleDraftMediaList
                files={selectedFiles}
                probes={draftMediaProbes}
                explicitAudioStreamIds={explicitAudioStreamIds}
                disabled={submissionLocked}
                probeQueuePending={mediaProbeQueuePending}
                onClear={() => setDraftInputFiles([])}
                onRemove={removeDraftInputFile}
                onRetryProbe={handleRetryMediaProbe}
                onAudioStreamChange={handleAudioStreamChange}
              />
            ) : null}

            {actionError || runtimeState.error ? (
              <LocalSubtitleErrorNotice error={actionError ?? runtimeState.error!} />
            ) : null}

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                data-testid="local-subtitle-start"
                type="button"
                disabled={
                  Boolean(startIssue) ||
                  fileAuthorizationPending ||
                  outputSelectionPending ||
                  submissionLocked
                }
                onClick={handleStart}
              >
                {submissionPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {t("subtitle:local_transcriber.actions.start")}
              </Button>
              {startIssue ? (
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                  {t(START_ISSUE_KEYS[startIssue])}
                </p>
              ) : null}
            </div>

            <LocalSubtitleTaskQueue
              batches={visibleBatches}
              pendingActionKeys={pendingTaskActions}
              manualHandoffResults={manualHandoffResults}
              missingTranslationTaskIds={missingTranslationTaskIds}
              onCancel={handleCancel}
              onRetry={handleRetry}
              onPreview={(task, artifact) => setArtifactPreview({
                taskName: task.displayName,
                artifact,
              })}
              onReveal={handleReveal}
              onHandoff={(task, artifact) => void handleHandoff(task, artifact)}
              onShowError={setErrorDetailsTask}
              onRetryOnCpu={setCpuRetryCandidate}
              onRemove={handleRemove}
            />
            <LocalSubtitleRecoveredSession
              summary={runtimeState.recoveredSession}
            />
          </div>
        </ToolPanel>
      </ToolDetailLayout>

      <ConfirmDialog
        open={cpuRetryCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !cpuRetryPending) setCpuRetryCandidate(null);
        }}
        title={t("subtitle:local_transcriber.cpu_retry.title")}
        description={t("subtitle:local_transcriber.cpu_retry.description", {
          name: cpuRetryCandidate?.displayName ?? "",
        })}
        confirmText={t("subtitle:local_transcriber.cpu_retry.confirm")}
        cancelText={t("common:action.cancel")}
        variant="default"
        onConfirm={() => void handleCpuRetryConfirm()}
      />
      <LocalSubtitleArtifactPreviewDialog
        selection={artifactPreview}
        onOpenChange={(open) => {
          if (!open) setArtifactPreview(null);
        }}
      />
      <LocalSubtitleErrorDetailsDialog
        task={errorDetailsTask}
        onOpenChange={(open) => {
          if (!open) setErrorDetailsTask(null);
        }}
      />
      <LocalSubtitleTranslationConfirmDialog
        snapshot={preparedTranslationBatch?.snapshot ?? null}
        format={preparedTranslationBatch?.preferredFormat ?? null}
        pending={submissionPending}
        onCancel={handlePreparedBatchCancel}
        onConfirm={handlePreparedBatchConfirm}
      />
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

function NumericPreferenceField({
  id,
  label,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = Number(draft);
    if (
      !Number.isFinite(next) ||
      next < min ||
      next > max ||
      (step >= 1 && !Number.isInteger(next))
    ) {
      setDraft(String(value));
      return;
    }
    onCommit(next);
    setDraft(String(next));
  };

  return (
    <ToolField label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="h-8 px-2 text-xs tabular-nums"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
    </ToolField>
  );
}

function toDisplayError(error: unknown): LocalSubtitleDisplayError {
  return {
    message: error instanceof Error
      ? error.message
      : "The local subtitle operation could not be completed.",
  };
}
