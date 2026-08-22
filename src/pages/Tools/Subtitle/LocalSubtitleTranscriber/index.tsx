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
  Loader2,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
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
  ToolConfigDisclosure,
  ToolDetailLayout,
  ToolField,
  ToolFileDropZone,
  type ToolFileSelectionSource,
  ToolOutputPathPicker,
  ToolRadioButtonGroup,
} from "@/pages/Tools/_shared/ui";
import {
  getLocalSubtitleEnvironmentService,
} from "@/services/local-subtitle/localSubtitleEnvironmentService";
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
  LocalSubtitleTaskSummary,
  LocalSubtitleFormat,
  SubtitleTranslationHandoffMode,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleIpcResult,
  LocalSubtitleInputFileCapture,
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleBackendPreviewSummary,
  EnqueueLocalSubtitleBatchRequest,
} from "@/type/localSubtitleIpc";
import type { SubtitleTranslationImportConfigSummary } from "@/type/generatedSubtitleImport";
import { showToast } from "@/utils/toast";
import {
  createLocalSubtitleBatchRequest,
  createLocalSubtitleBackendPreviewKey,
  deriveLocalSubtitleDraftMediaProbeStatus,
  deriveLocalSubtitleStartIssue,
  flattenLocalSubtitleTasksInQueueOrder,
  formatLocalSubtitleBytes,
  getReadyLocalSubtitleModels,
  hasActiveLocalSubtitleTasks,
  isLocalSubtitleDevicePreferenceAvailable,
  isLocalSubtitleTaskActive,
  mergeLocalSubtitleVisibleBatches,
  pruneLocalSubtitleDraftAudioSelections,
  reconcileLocalSubtitleDraftMediaProbes,
  resolveLocalSubtitleConflictPolicy,
  shouldRequestLocalSubtitleBackendPreview,
  supportedLocalSubtitleConflictPolicies,
  type LocalSubtitleDraftMediaProbe,
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
const BRIDGE_RELOAD_STORAGE_KEY =
  "fusionkit-local-subtitle-bridge-reload-version";

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
  const bridgeCompatible =
    window.localSubtitleApi.bridgeVersion ===
      LOCAL_SUBTITLE_IPC_BRIDGE_VERSION;
  const environmentService = useMemo(getLocalSubtitleEnvironmentService, []);
  const runtimeService = useMemo(getLocalSubtitleRuntimeService, []);
  const postActionService = useMemo(getLocalSubtitlePostActionService, []);
  const runtimeState = useSyncExternalStore(
    runtimeService.subscribe,
    runtimeService.getState,
    runtimeService.getState,
  );
  const environment = useSyncExternalStore(
    environmentService.subscribe,
    environmentService.getState,
    environmentService.getState,
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
  const addDraftInputFiles = useLocalSubtitleTranscriberStore(
    (state) => state.addDraftInputFiles,
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
  const mountedRef = useRef(true);
  const backendPreviewGenerationRef = useRef(0);
  const mediaProbeGenerationRef = useRef(0);
  const mediaProbeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const selectedDraftFileTokensRef = useRef<ReadonlySet<string>>(new Set());
  const terminalResourceJobsRef = useRef("");
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
  const [clearPending, setClearPending] = useState(false);
  const [bulkRemovalInFlight, setBulkRemovalInFlight] = useState(false);
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const [pendingClearTaskIds, setPendingClearTaskIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
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
  const taskMediaOperationActive = useMemo(
    () => hasActiveLocalSubtitleTasks(runtimeState.batches),
    [runtimeState.batches],
  );

  const refreshEnvironmentManually = useCallback(() => {
    setResourceActionError(null);
    void runtimeService.refresh();
    if (taskMediaOperationActive) {
      void environmentService.refreshManagedResources().then((result) => {
        if (mountedRef.current && !result.ok) {
          setResourceActionError(result.error);
        }
      });
      return;
    }
    backendPreviewGenerationRef.current += 1;
    setBackendPreview((current) => ({
      ...current,
      status: "idle",
      summary: null,
    }));
    void environmentService.refresh();
  }, [environmentService, runtimeService, taskMediaOperationActive]);

  const refreshManagedResources = useCallback(async () => {
    try {
      const result = await environmentService.refreshManagedResources();
      if (!mountedRef.current) return;
      if (!result.ok) {
        setResourceActionError(result.error);
      }
    } catch (error) {
      if (mountedRef.current) {
        setResourceActionError(toDisplayError(error));
      }
    }
  }, [environmentService]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      backendPreviewGenerationRef.current += 1;
      mediaProbeGenerationRef.current += 1;
      selectedDraftFileTokensRef.current = new Set();
      const prepared = preparedTranslationBatchRef.current;
      preparedTranslationBatchRef.current = null;
      if (prepared && !preparedBatchCommitPendingRef.current) {
        void postActionService.releaseSnapshot(prepared.snapshot.snapshotId);
      }
    };
  }, [postActionService]);

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
  const deviceAvailability = useMemo(
    () => ({
      auto: isLocalSubtitleDevicePreferenceAvailable(environment.runtime, "auto"),
      cpu: isLocalSubtitleDevicePreferenceAvailable(environment.runtime, "cpu"),
      cuda: isLocalSubtitleDevicePreferenceAvailable(environment.runtime, "cuda"),
      metal: isLocalSubtitleDevicePreferenceAvailable(environment.runtime, "metal"),
    }),
    [environment.runtime],
  );

  useEffect(() => {
    if (
      environment.loading ||
      !environment.runtime ||
      deviceAvailability[preferences.devicePreference] ||
      !deviceAvailability.auto
    ) return;
    updatePreferences({ devicePreference: "auto" });
  }, [
    deviceAvailability,
    environment.loading,
    environment.runtime,
    preferences.devicePreference,
    updatePreferences,
  ]);

  const backendPreviewKey = createLocalSubtitleBackendPreviewKey({
    runtime: environment.runtime,
    modelId: selectedModelId,
    devicePreference: preferences.devicePreference,
  });

  useEffect(() => {
    const cached = backendPreviewKey
      ? environmentService.getCachedBackendPreview(backendPreviewKey)
      : undefined;
    if (!backendPreviewKey || !selectedModelId) {
      backendPreviewGenerationRef.current += 1;
      setBackendPreview((current) =>
        current.status === "idle" &&
        current.modelId === selectedModelId &&
        current.devicePreference === preferences.devicePreference &&
        current.summary === null
          ? current
          : {
              status: "idle",
              modelId: selectedModelId,
              devicePreference: preferences.devicePreference,
              summary: null,
            });
      return;
    }

    const modelId = selectedModelId;
    const devicePreference = preferences.devicePreference;
    if (!shouldRequestLocalSubtitleBackendPreview({
      previewKey: backendPreviewKey,
      cachedPreviewKey: cached ? backendPreviewKey : null,
      environmentLoading: environment.loading,
      environmentError: Boolean(environment.error),
      runtimeSyncStatus: runtimeState.syncStatus,
      taskMediaOperationActive,
    })) {
      setBackendPreview((current) => {
        if (cached) {
          return current.status === "ready" && current.summary === cached
            ? current
            : {
                status: "ready",
                modelId,
                devicePreference,
                summary: cached,
              };
        }
        if (
          current.modelId === modelId &&
          current.devicePreference === devicePreference &&
          (current.status === "idle" || current.status === "loading")
        ) return current;
        return {
          status: "idle",
          modelId,
          devicePreference,
          summary: null,
        };
      });
      return;
    }

    const generation = ++backendPreviewGenerationRef.current;
    setBackendPreview({
      status: "loading",
      modelId,
      devicePreference,
      summary: null,
    });
    void environmentService.requestBackendPreview(
      backendPreviewKey,
      { modelId, devicePreference },
    ).then((result) => {
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
    backendPreviewKey,
    environment.backendPreviewRevision,
    environment.error,
    environment.loading,
    environmentService,
    preferences.devicePreference,
    runtimeState.syncStatus,
    selectedModelId,
    taskMediaOperationActive,
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
          if (!selectedDraftFileTokensRef.current.has(file.fileToken)) continue;

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
          if (!selectedDraftFileTokensRef.current.has(file.fileToken)) continue;
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
        generation === mediaProbeGenerationRef.current &&
        mediaProbeQueueRef.current === operation
      ) {
        setMediaProbeQueuePending(false);
      }
    });
  }, []);

  useEffect(() => {
    const previousTokens = selectedDraftFileTokensRef.current;
    const nextTokens = new Set(selectedFiles.map((file) => file.fileToken));
    const addedFiles = selectedFiles.filter(
      (file) => !previousTokens.has(file.fileToken),
    );
    selectedDraftFileTokensRef.current = nextTokens;
    setDraftMediaProbes((current) =>
      reconcileLocalSubtitleDraftMediaProbes(selectedFiles, current));
    setExplicitAudioStreamIds((current) =>
      pruneLocalSubtitleDraftAudioSelections(selectedFiles, current));
    if (addedFiles.length === 0) return;
    setMediaProbeQueuePending(true);
    enqueueMediaProbes(addedFiles, mediaProbeGenerationRef.current);
  }, [enqueueMediaProbes, selectedFiles]);

  const handleRetryMediaProbe = useCallback((
    file: LocalSubtitleAuthorizedMedia,
  ) => {
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
    enqueueMediaProbes([file], mediaProbeGenerationRef.current);
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
    return mergeLocalSubtitleVisibleBatches(
      runtimeState.batches,
      submittedBatches,
    );
  }, [runtimeState.batches, submittedBatches]);
  const visibleTasks = useMemo(
    () => flattenLocalSubtitleTasksInQueueOrder(visibleBatches),
    [visibleBatches],
  );

  useEffect(() => {
    if (bridgeCompatible) {
      sessionStorage.removeItem(BRIDGE_RELOAD_STORAGE_KEY);
      return;
    }
    const expected = String(LOCAL_SUBTITLE_IPC_BRIDGE_VERSION);
    if (sessionStorage.getItem(BRIDGE_RELOAD_STORAGE_KEY) !== expected) {
      sessionStorage.setItem(BRIDGE_RELOAD_STORAGE_KEY, expected);
      window.location.reload();
      return;
    }
    setActionError({
      code: "runtime_protocol_mismatch",
      message: t("subtitle:local_transcriber.error.bridge_protocol_mismatch"),
    });
  }, [bridgeCompatible, t]);
  const supportedConflictPolicies = supportedLocalSubtitleConflictPolicies(
    environment.runtime,
  );
  const resolvedConflictPolicy = resolveLocalSubtitleConflictPolicy(
    environment.runtime,
    draftConflictPolicy,
  );
  const overwriteSupported = supportedConflictPolicies.includes("overwrite");

  useEffect(() => {
    if (
      environment.runtime &&
      resolvedConflictPolicy !== draftConflictPolicy
    ) {
      setDraftConflictPolicy(resolvedConflictPolicy);
    }
  }, [
    draftConflictPolicy,
    environment.runtime,
    resolvedConflictPolicy,
    setDraftConflictPolicy,
  ]);
  const missingTranslationTaskIds = new Set(
    visibleTasks
      .map((task) => task.postAction.translationTaskId)
      .filter((taskId): taskId is string =>
        Boolean(taskId) && !postActionService.hasTranslationTask(taskId!)),
  );
  const submissionLocked = submissionPending || preparedTranslationBatch !== null;
  const mediaProbeStatus = deriveLocalSubtitleDraftMediaProbeStatus(
    selectedFiles,
    draftMediaProbes,
  );
  const startableFiles = selectedFiles.filter(
    (file) => draftMediaProbes.get(file.fileToken)?.status === "ready",
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
    selectedFiles: startableFiles,
    mediaProbeStatus: startableFiles.length > 0 ? "ready" : mediaProbeStatus,
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
    (file: File, mode: "copy" | "move", modelId: string) => {
      return runResourceAction(
        localSubtitleResourceActionKey("import", modelId),
        () => window.localSubtitleApi.importModel(file, { mode, modelId }),
        true,
      );
    },
    [runResourceAction],
  );

  const handleFiles = useCallback(
    (files: FileList, source: ToolFileSelectionSource) => {
      if (!bridgeCompatible) return;
      const fileCount = Math.min(
        files.length,
        LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
      );
      if (fileCount === 0) return;

      let captured:
        | LocalSubtitleIpcResult<LocalSubtitleInputFileCapture>
        | undefined;
      for (let index = 0; index < fileCount; index += 1) {
        const file = files.item(index);
        if (!file) return;
        // Consume the original FileList synchronously and keep all native paths
        // inside the fixed preload bridge. On Electron 41, main additionally
        // resolves proven Explorer long-path sources before authorization.
        captured = window.localSubtitleApi.captureInputFile(
          file,
          captured?.ok ? captured.data.captureRef : undefined,
          source,
        );
        if (!captured.ok) {
          setActionError(captured.error);
          return;
        }
      }
      if (!captured?.ok) return;

      setFileAuthorizationPending(true);
      setActionError(null);
      return (async () => {
        try {
          const result =
            await window.localSubtitleApi.authorizeCapturedInputFiles(
              captured.data.captureRef,
            );
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
          const currentDraftFiles =
            useLocalSubtitleTranscriberStore.getState().draftInputFiles;
          const existingSourceKeys = new Set([
            ...currentDraftFiles.map((file) => file.sourceKey),
            ...visibleTasks.map((task) => task.sourceKey),
          ]);
          const availableSlots = Math.max(
            0,
            LOCAL_SUBTITLE_LIMITS.maxBatchFiles - currentDraftFiles.length,
          );
          const accepted: LocalSubtitleAuthorizedMedia[] = [];
          const rejected: LocalSubtitleAuthorizedMedia[] = [];
          for (const authorized of result.data) {
            if (
              existingSourceKeys.has(authorized.sourceKey) ||
              accepted.length >= availableSlots
            ) {
              rejected.push(authorized);
              continue;
            }
            existingSourceKeys.add(authorized.sourceKey);
            accepted.push(authorized);
          }
          for (const duplicate of rejected) {
            runtimeService.queueInputDraftRevocation(duplicate);
          }
          if (accepted.length > 0) addDraftInputFiles(accepted);
          const duplicateCount = rejected.filter((file) =>
            visibleTasks.some((task) => task.sourceKey === file.sourceKey) ||
            currentDraftFiles.some(
              (draft) => draft.sourceKey === file.sourceKey,
            ),
          ).length;
          if (duplicateCount > 0) {
            showToast(
              t("subtitle:local_transcriber.file.duplicate_skipped", {
                count: duplicateCount,
              }),
              "warning",
            );
          }
        } catch (error) {
          if (mountedRef.current) setActionError(toDisplayError(error));
        } finally {
          if (mountedRef.current) setFileAuthorizationPending(false);
        }
      })();
    },
    [addDraftInputFiles, bridgeCompatible, runtimeService, t, visibleTasks],
  );

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
        setActionError({ message: "The local subtitle request did not return a task." });
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
      setSubmittedBatches((current) => [...current, result.data]);
      consumeDraftCapabilitiesAfterCommit(
        request.files.map((file) => file.fileToken),
      );
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
      !bridgeCompatible ||
      startIssue ||
      fileAuthorizationPending ||
      outputSelectionPending ||
      startableFiles.length === 0 ||
      !selectedModelId ||
      preparedTranslationBatch
    ) return;
    setSubmissionPending(true);
    setActionError(null);
    try {
      if (draftPostActionMode === "export_only") {
        const request = createLocalSubtitleBatchRequest({
          files: startableFiles,
          modelId: selectedModelId,
          preferences,
          initialPrompt: draftInitialPrompt,
          taskMode: draftTaskMode,
          outputDirectory,
          explicitAudioStreamIds,
          conflictPolicy: resolvedConflictPolicy,
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
        files: startableFiles,
        modelId: selectedModelId,
        preferences,
        initialPrompt: draftInitialPrompt,
        taskMode: draftTaskMode,
        outputDirectory,
        explicitAudioStreamIds,
        conflictPolicy: resolvedConflictPolicy,
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
    bridgeCompatible,
    resolvedConflictPolicy,
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
    startableFiles,
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

  const clearableCompletedTasks = useMemo(
    () => visibleTasks.filter((task) =>
      task.status === "completed" && isLocalSubtitleTaskReadyToRemove(task),
    ),
    [visibleTasks],
  );

  const handleClearCompleted = useCallback(() => {
    if (clearPending || clearableCompletedTasks.length === 0) return;
    setActionError(null);
    setClearPending(true);
    setPendingClearTaskIds(new Set(
      clearableCompletedTasks.map((task) => task.taskId),
    ));
  }, [clearPending, clearableCompletedTasks]);

  const executeClearAll = useCallback(async () => {
    if (clearPending) return;
    setClearAllConfirmOpen(false);
    setActionError(null);
    setClearPending(true);
    setDraftInputFiles([]);
    setPendingClearTaskIds(new Set(visibleTasks.map((task) => task.taskId)));

    const activeTasks = visibleTasks.filter(isLocalSubtitleTaskActive);
    const failedTaskIds = new Set<string>();
    let firstError: LocalSubtitleDisplayError | null = null;
    for (const task of activeTasks) {
      try {
        const result = await window.localSubtitleApi.cancelTask(task.taskId);
        if (!result.ok) {
          failedTaskIds.add(task.taskId);
          firstError ??= result.error;
        }
      } catch (error) {
        failedTaskIds.add(task.taskId);
        firstError ??= toDisplayError(error);
      }
    }
    if (!mountedRef.current) return;
    if (failedTaskIds.size > 0) {
      setPendingClearTaskIds((current) => {
        const next = new Set(current);
        for (const taskId of failedTaskIds) next.delete(taskId);
        return next;
      });
    }
    if (firstError) setActionError(firstError);
    void runtimeService.refresh();
  }, [clearPending, runtimeService, setDraftInputFiles, visibleTasks]);

  const handleClearAll = useCallback(() => {
    if (clearPending || selectedFiles.length + visibleTasks.length === 0) return;
    if (visibleTasks.some(isLocalSubtitleTaskActive)) {
      setClearAllConfirmOpen(true);
      return;
    }
    void executeClearAll();
  }, [clearPending, executeClearAll, selectedFiles.length, visibleTasks]);

  useEffect(() => {
    if (bulkRemovalInFlight || pendingClearTaskIds.size === 0) return;
    const liveTaskIds = new Set(visibleTasks.map((task) => task.taskId));
    const removableTasks = visibleTasks.filter((task) =>
      pendingClearTaskIds.has(task.taskId) &&
      isLocalSubtitleTaskReadyToRemove(task),
    );
    const vanishedTaskIds = [...pendingClearTaskIds].filter(
      (taskId) => !liveTaskIds.has(taskId),
    );
    if (removableTasks.length === 0 && vanishedTaskIds.length === 0) return;

    setBulkRemovalInFlight(true);
    setPendingClearTaskIds((current) => {
      const next = new Set(current);
      for (const task of removableTasks) next.delete(task.taskId);
      for (const taskId of vanishedTaskIds) next.delete(taskId);
      return next;
    });
    void (async () => {
      let firstError: LocalSubtitleDisplayError | null = null;
      for (const task of removableTasks) {
        try {
          const result = await window.localSubtitleApi.removeTask(task.taskId);
          if (!result.ok) firstError ??= result.error;
        } catch (error) {
          firstError ??= toDisplayError(error);
        }
      }
      if (!mountedRef.current) return;
      if (firstError) setActionError(firstError);
      setBulkRemovalInFlight(false);
      void runtimeService.refresh();
    })();
  }, [
    bulkRemovalInFlight,
    pendingClearTaskIds,
    runtimeService,
    visibleTasks,
  ]);

  useEffect(() => {
    if (
      clearPending &&
      pendingClearTaskIds.size === 0 &&
      !bulkRemovalInFlight
    ) {
      setClearPending(false);
    }
  }, [bulkRemovalInFlight, clearPending, pendingClearTaskIds]);

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

  return (
    <div data-testid="local-subtitle-transcriber">
      <ToolDetailLayout
        header={
          <ToolPageHeader
            meta={TOOL_META.localSubtitleTranscriber}
            title={t("subtitle:local_transcriber.title")}
            description={t("subtitle:local_transcriber.description")}
          />
        }
        asideClassName="order-2 lg:order-1"
        mainClassName="order-1 lg:order-2"
        aside={
          <ToolConfigPanel
            icon={Settings2}
            title={t("subtitle:local_transcriber.config.title")}
            contentClassName="space-y-4"
          >
            <ToolField label={t("subtitle:local_transcriber.config.model")}>
              <Select
                value={selectedModelId ?? undefined}
                disabled={submissionLocked || readyModels.length === 0}
                onValueChange={(modelId) => updatePreferences({ modelId })}
              >
                <SelectTrigger data-testid="local-subtitle-model-select" className="h-8 w-full text-xs">
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
                disabled={submissionLocked || environment.loading || !deviceAvailability.auto}
                onValueChange={(devicePreference) => {
                  const nextPreference = devicePreference as typeof preferences.devicePreference;
                  if (!deviceAvailability[nextPreference]) return;
                  updatePreferences({ devicePreference: nextPreference });
                }}
              >
                <SelectTrigger data-testid="local-subtitle-device-select" className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" disabled={!deviceAvailability.auto}>
                    {t("subtitle:local_transcriber.config.device_option.auto")}
                  </SelectItem>
                  {(["cpu", "cuda", "metal"] as const).map((backend) => (
                    <SelectItem
                      key={backend}
                      value={backend}
                      disabled={!deviceAvailability[backend]}
                    >
                      {t(`subtitle:local_transcriber.config.device_option.${backend}`)}
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
                <SelectTrigger data-testid="local-subtitle-language-select" className="h-8 w-full text-xs">
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

            <div>
              <ToolConfigDisclosure
                testId="local-subtitle-advanced-settings"
                icon={SlidersHorizontal}
                title={t("subtitle:local_transcriber.config.advanced")}
                summary={t(
                  draftTaskMode === "transcribe"
                    ? "subtitle:local_transcriber.config.task_transcribe"
                    : "subtitle:local_transcriber.config.task_translate_english",
                )}
              >
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
              </ToolConfigDisclosure>
            </div>

            <ToolField
              label={t("subtitle:local_transcriber.config.output_formats")}
            >
              <div className="grid grid-cols-2 gap-2">
                {(["SRT", "LRC"] as const).map((format) => (
                  <label
                    key={format}
                    className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs transition-[background-color,border-color,transform] duration-150 hover:bg-muted/50 active:scale-[0.98] has-[[data-state=checked]]:border-foreground/25 has-[[data-state=checked]]:bg-muted/50 motion-reduce:transform-none"
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
                    disabled: !overwriteSupported,
                  },
                ]}
                onValueChange={setDraftConflictPolicy}
              />
              {!overwriteSupported && environment.runtime ? (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {t("subtitle:local_transcriber.config.conflict_overwrite_unavailable")}
                </p>
              ) : null}
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
              <Select
                value={draftPostActionMode}
                disabled={submissionLocked}
                onValueChange={(mode) =>
                  setDraftPostActionMode(mode as SubtitleTranslationHandoffMode)}
              >
                <SelectTrigger
                  data-testid="local-subtitle-post-action-select"
                  className="h-8 w-full text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="export_only">
                    {t("subtitle:local_transcriber.post_action.export_only")}
                  </SelectItem>
                  <SelectItem value="enqueue_translation">
                    {t("subtitle:local_transcriber.post_action.enqueue")}
                  </SelectItem>
                  <SelectItem value="enqueue_and_start_translation">
                    {t("subtitle:local_transcriber.post_action.enqueue_and_start")}
                  </SelectItem>
                </SelectContent>
              </Select>
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
                    className="h-8 w-full text-xs"
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
        <div className="space-y-3">
          <ToolFileDropZone
            id="local-subtitle-file"
            inputTestId="local-subtitle-file-input"
            accept={MEDIA_ACCEPT}
            multiple
            dragging={dragging}
            disabled={
              !bridgeCompatible || submissionLocked || fileAuthorizationPending
            }
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
            className="px-4 py-4"
            onDraggingChange={setDragging}
            onFiles={handleFiles}
          />

          {actionError || runtimeState.error ? (
            <LocalSubtitleErrorNotice error={actionError ?? runtimeState.error!} />
          ) : null}

          {startIssue && selectedFiles.length > 0 ? (
            <p className="min-w-0 px-1 text-xs leading-relaxed text-muted-foreground">
              {t(START_ISSUE_KEYS[startIssue])}
            </p>
          ) : null}
        </div>

        <LocalSubtitleTaskQueue
          tasks={visibleTasks}
          draftFiles={selectedFiles}
          draftProbes={draftMediaProbes}
          explicitAudioStreamIds={explicitAudioStreamIds}
          draftDisabled={submissionLocked}
          probeQueuePending={mediaProbeQueuePending}
          startDisabled={
            Boolean(startIssue) ||
            fileAuthorizationPending ||
            outputSelectionPending ||
            submissionLocked
          }
          startPending={submissionPending}
          clearPending={clearPending}
          pendingActionKeys={pendingTaskActions}
          manualHandoffResults={manualHandoffResults}
          missingTranslationTaskIds={missingTranslationTaskIds}
          onStartAll={() => void handleStart()}
          onClearCompleted={handleClearCompleted}
          onClearAll={handleClearAll}
          onRemoveDraft={removeDraftInputFile}
          onRetryProbe={handleRetryMediaProbe}
          onAudioStreamChange={handleAudioStreamChange}
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

        <LocalSubtitleEnvironmentManager
          loading={environment.loading}
          runtime={environment.runtime}
          backendPreviewStatus={backendPreview.status}
          backendPreview={backendPreview.summary}
          resources={environment.resources}
          resourceJobs={runtimeState.resourceJobs}
          pendingActionKeys={pendingResourceActions}
          environmentError={environment.error}
          resourceActionError={resourceActionError}
          onRefresh={refreshEnvironmentManually}
          onInstall={handleResourceInstall}
          onCancel={handleResourceCancel}
          onDelete={handleResourceDelete}
          onImport={handleModelImport}
        />
      </ToolDetailLayout>

      <ConfirmDialog
        open={clearAllConfirmOpen}
        onOpenChange={(open) => {
          if (!clearPending) setClearAllConfirmOpen(open);
        }}
        title={t("subtitle:local_transcriber.clear_all.title")}
        description={t("subtitle:local_transcriber.clear_all.description")}
        confirmText={t("subtitle:local_transcriber.clear_all.confirm")}
        cancelText={t("common:action.cancel")}
        variant="destructive"
        onConfirm={() => void executeClearAll()}
      />
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

function isLocalSubtitleTaskReadyToRemove(
  task: LocalSubtitleTaskSummary,
): boolean {
  if (isLocalSubtitleTaskActive(task)) return false;
  return !(
    task.status === "completed" &&
    task.postAction.mode !== "export_only" &&
    (task.postAction.importStatus === "pending" ||
      task.postAction.importStatus === "importing")
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
