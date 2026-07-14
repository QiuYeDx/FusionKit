import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  FileAudio,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  InfoHint,
  ToolField,
  ToolFileDropZone,
  ToolOutputPathPicker,
  ToolPanel,
} from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { showToast } from "@/utils/toast";
import type {
  AudioApiProfile,
  AudioTimestampGranularity,
} from "@/type/audio";
import type { AuthorizedAudioTranscriptionResult } from "@/type/audioIpc";
import {
  authorizeAudioInputFile,
  flushPendingAudioInputFileRevocations,
  flushPendingAudioOutputDirectoryRevocations,
  queueAudioInputFileRevocation,
  queueAudioOutputDirectoryRevocation,
} from "@/services/audio/audioRuntimeConfigService";
import {
  cancelAudioTranscriptionBounded,
  flushPendingAudioTranscriptionCancellations,
  queueAudioTranscriptionCancellation,
  revealAudioOutput,
  saveAudioTranscriptionResult,
  settleAudioTranscriptionCancellation,
  transcribeAudio,
} from "@/services/audio/audioTranscriptionService";
import AudioToolShell from "../shared/AudioToolShell";
import useAudioTranscriberStore from "@/store/tools/audio/useAudioTranscriberStore";
import useAudioApiStore from "@/store/useAudioApiStore";
import {
  isAudioOutputDirectoryAuthorizationValid,
  type AudioOutputDirectoryAuthorization,
} from "@/store/tools/audio/audioOutputDirectory";
import { getAudioErrorMessage } from "../shared/audioErrorMessage";
import {
  buildAudioTranscriptionRequest,
  getAudioTranscriberAccept,
  getAudioTranscriberLanguages,
  getAudioTranscriberResponseFormats,
  normalizeAudioTranscriberPreferences,
  resolveAudioTranscriberFieldVisibility,
  resolveAudioTranscriptionConfigSummary,
  validateAudioTranscriberFile,
  type AudioTranscriberPreferences,
  type AudioTranscriberFileIssue,
  type AudioTranscriptionConfigSummary,
  type SelectedAudioInput,
} from "@/store/tools/audio/audioTranscriberConfig";

const TIMESTAMP_GRANULARITIES: AudioTimestampGranularity[] = [
  "segment",
  "word",
];
const TRANSCRIBER_OUTPUT_MODES = [
  "display_only",
  "source_dir",
  "custom_dir",
] as const;
const TRANSCRIBER_SETTINGS_PATH =
  "/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Ftranscriber";

export default function AudioTranscriber() {
  const [submissionPending, setSubmissionPending] = useState(false);
  const profiles = useAudioApiStore((state) => state.profiles);
  const assignment = useAudioApiStore((state) => state.assignment);
  const configSummary = useMemo(
    () => resolveAudioTranscriptionConfigSummary({ profiles, assignment }),
    [assignment, profiles],
  );
  const routeIdentity = getTranscriptionRouteIdentity(configSummary);
  const assignedProfile = useMemo(
    () => profiles.find((profile) => profile.id === configSummary.profileId),
    [configSummary.profileId, profiles],
  );
  const fileController = useAudioInputAuthorization(
    configSummary,
    routeIdentity,
  );
  const outputDirectoryController =
    useAudioOutputDirectoryAuthorization(routeIdentity);

  return (
    <div data-testid="audio-transcriber">
      <AudioToolShell
        toolKey="audioTranscriber"
        assignmentKey="transcription"
        titleKey="audio:pages.transcriber.title"
        descriptionKey="audio:pages.transcriber.description"
        workspaceTitleKey="audio:pages.transcriber.workspace"
        configSummaryOverride={configSummary}
        settingsPath={TRANSCRIBER_SETTINGS_PATH}
        asideExtra={() =>
          configSummary.status === "ready" && configSummary.constraints ? (
            <TranscriberConfig
              summary={configSummary}
              submissionPending={submissionPending}
              outputDirectoryController={outputDirectoryController}
            />
          ) : null
        }
      >
        {() => (
          <TranscriberWorkspace
            summary={configSummary}
            assignedProfile={assignedProfile}
            routeIdentity={routeIdentity}
            submissionPending={submissionPending}
            onSubmissionPendingChange={setSubmissionPending}
            fileController={fileController}
            outputDirectoryPending={outputDirectoryController.pending}
          />
        )}
      </AudioToolShell>
    </div>
  );
}

interface AudioInputAuthorizationController {
  selectFiles: (files: FileList) => Promise<void>;
  clear: () => void;
  ensureAuthorized: () => Promise<SelectedAudioInput | null>;
  releaseToken: (fileToken: string, expiresAt?: number) => void;
}

interface ActiveAudioTranscriptionSubmission {
  requestId: string;
  abortController: AbortController;
  dispatched: boolean;
  cancelPending: boolean;
}

interface AudioOutputDirectoryAuthorizationController {
  pending: boolean;
  select: () => Promise<void>;
  setOutputMode: (mode: AudioTranscriberPreferences["outputMode"]) => void;
}

function TranscriberConfig({
  summary,
  submissionPending,
  outputDirectoryController,
}: {
  summary: AudioTranscriptionConfigSummary;
  submissionPending: boolean;
  outputDirectoryController: AudioOutputDirectoryAuthorizationController;
}) {
  const { t } = useTranslation(["audio"]);
  const preferences = useAudioTranscriberStore((state) => state.preferences);
  const status = useAudioTranscriberStore((state) => state.status);
  const fileAuthorizationPending = useAudioTranscriberStore(
    (state) => state.fileAuthorizationPending,
  );
  const updatePreferences = useAudioTranscriberStore(
    (state) => state.updatePreferences,
  );
  const constraints = summary.constraints!;
  const normalized = useMemo(
    () => normalizeAudioTranscriberPreferences(preferences, constraints),
    [constraints, preferences],
  );
  const fields = useMemo(
    () => resolveAudioTranscriberFieldVisibility(
      constraints,
      normalized.responseFormat,
    ),
    [constraints, normalized.responseFormat],
  );
  const responseFormats = getAudioTranscriberResponseFormats(constraints);
  const languages = getAudioTranscriberLanguages(constraints);
  const isMimo = summary.providerPreset === "mimo";
  const isConfigLocked =
    status === "running" ||
    submissionPending ||
    fileAuthorizationPending ||
    outputDirectoryController.pending;

  return (
    <fieldset className="min-w-0 space-y-4" disabled={isConfigLocked}>
      {fields.language ? (
        <ToolField
          testId="transcriber-field-language"
          label={t("audio:transcriber.fields.language")}
          htmlFor="transcriber-language"
        >
          <Select
            value={normalized.language}
            onValueChange={(language) => updatePreferences({ language })}
          >
            <SelectTrigger id="transcriber-language" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {languages.map((language) => (
                <SelectItem key={language} value={language}>
                  {t(`audio:transcriber.languages.${language}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ToolField>
      ) : null}

      <ToolField
        testId="transcriber-output-format"
        label={t("audio:transcriber.fields.response_format")}
        htmlFor={
          fields.responseFormatSelect ? "transcriber-response-format" : undefined
        }
        hint={
          isMimo
            ? t("audio:transcriber.hints.mimo_response_format")
            : t("audio:transcriber.hints.openai_response_format")
        }
      >
        {fields.responseFormatSelect ? (
          <Select
            value={normalized.responseFormat}
            onValueChange={(responseFormat) =>
              updatePreferences({
                responseFormat:
                  responseFormat as typeof normalized.responseFormat,
              })
            }
          >
            <SelectTrigger
              id="transcriber-response-format"
              size="sm"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {responseFormats.map((format) => (
                <SelectItem key={format} value={format}>
                  {t(`audio:transcriber.response_format.${format}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : fields.responseFormatSummary ? (
          <div
            data-testid="transcriber-output-format-summary"
            className="rounded-md border bg-muted/30 px-3 py-2 text-xs font-medium"
          >
            {t(
              `audio:transcriber.response_format.${responseFormats[0] ?? normalized.responseFormat}`,
            )}
          </div>
        ) : null}
      </ToolField>

      {fields.timestampGranularities ? (
        <ToolField
          testId="transcriber-field-timestamps"
          label={t("audio:transcriber.fields.timestamps")}
          hint={t("audio:transcriber.hints.timestamps")}
        >
          <div className="grid gap-2 rounded-md border px-3 py-2">
            {TIMESTAMP_GRANULARITIES.map((granularity) => {
              const checked = normalized.timestampGranularities.includes(
                granularity,
              );
              return (
                <label
                  key={granularity}
                  className="flex items-center gap-2 text-xs"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(nextChecked) => {
                      const set = new Set(normalized.timestampGranularities);
                      if (nextChecked) {
                        set.add(granularity);
                      } else {
                        set.delete(granularity);
                      }
                      updatePreferences({
                        timestampGranularities: Array.from(set),
                      });
                    }}
                  />
                  {t(`audio:transcriber.timestamp.${granularity}`)}
                </label>
              );
            })}
          </div>
        </ToolField>
      ) : null}

      {fields.prompt ? (
        <ToolField
          testId="transcriber-field-prompt"
          label={t("audio:transcriber.fields.prompt")}
          htmlFor="transcriber-prompt"
          hint={t("audio:transcriber.hints.prompt")}
        >
          <Textarea
            id="transcriber-prompt"
            value={preferences.prompt}
            rows={3}
            className="resize-none text-xs"
            placeholder={t("audio:transcriber.placeholders.prompt")}
            onChange={(event) =>
              updatePreferences({ prompt: event.currentTarget.value })
            }
          />
        </ToolField>
      ) : null}

      {fields.stream ? (
        <ToolField
          testId="transcriber-stream"
          label={t("audio:transcriber.fields.stream")}
          hint={t("audio:transcriber.hints.stream")}
          action={
            <Switch
              checked={normalized.stream}
              aria-label={t("audio:transcriber.fields.stream")}
              onCheckedChange={(stream) => updatePreferences({ stream })}
            />
          }
        >
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("audio:transcriber.hints.stream_enabled")}
          </p>
        </ToolField>
      ) : null}

      <ToolField
        testId="transcriber-output-mode"
        label={t("audio:transcriber.fields.output_mode")}
        hint={t("audio:transcriber.hints.output_mode")}
      >
        <RadioGroup
          className="grid w-full grid-cols-3 gap-0"
          value={preferences.outputMode}
          aria-label={t("audio:transcriber.fields.output_mode")}
          onValueChange={(outputMode) =>
            outputDirectoryController.setOutputMode(
              outputMode as AudioTranscriberPreferences["outputMode"],
            )
          }
          onKeyDownCapture={(event) => {
            if (event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const outputMode = event.key === "Home"
              ? TRANSCRIBER_OUTPUT_MODES[0]
              : TRANSCRIBER_OUTPUT_MODES.at(-1)!;
            outputDirectoryController.setOutputMode(outputMode);
            event.currentTarget
              .querySelector<HTMLElement>(
                `[data-testid="transcriber-output-mode-${outputMode}"]`,
              )
              ?.focus();
          }}
        >
          {TRANSCRIBER_OUTPUT_MODES.map(
            (mode) => (
              <RadioGroupItem
                key={mode}
                value={mode}
                data-testid={`transcriber-output-mode-${mode}`}
                className={cn(
                  "h-8 min-w-0 w-full aspect-auto rounded-none px-2 text-center text-xs font-medium first:rounded-l-md last:rounded-r-md [&:not(:first-child)]:border-l-0",
                  "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=unchecked]:bg-background data-[state=unchecked]:hover:bg-accent data-[state=unchecked]:hover:text-accent-foreground",
                  "[&>[data-slot=radio-group-indicator]]:hidden",
                )}
              >
                <span className="pointer-events-none min-w-0 leading-tight">
                  {t(`audio:transcriber.output_mode.${mode}`)}
                </span>
              </RadioGroupItem>
            ),
          )}
        </RadioGroup>
        {preferences.outputMode === "custom_dir" ? (
          <ToolOutputPathPicker
            className="mt-2"
            value={preferences.outputDir}
            placeholder={t("audio:transcriber.placeholders.output_dir")}
            selectLabel={t("audio:transcriber.actions.select_output_dir")}
            onSelect={outputDirectoryController.select}
          />
        ) : null}
      </ToolField>
    </fieldset>
  );
}

function TranscriberWorkspace({
  summary,
  assignedProfile,
  routeIdentity,
  submissionPending,
  onSubmissionPendingChange,
  fileController,
  outputDirectoryPending,
}: {
  summary: AudioTranscriptionConfigSummary;
  assignedProfile: AudioApiProfile | undefined;
  routeIdentity: string;
  submissionPending: boolean;
  onSubmissionPendingChange: (pending: boolean) => void;
  fileController: AudioInputAuthorizationController;
  outputDirectoryPending: boolean;
}) {
  const { t } = useTranslation(["audio", "common"]);
  const navigate = useNavigate();
  const preferences = useAudioTranscriberStore((state) => state.preferences);
  const selectedFile = useAudioTranscriberStore((state) => state.selectedFile);
  const fileAuthorizationPending = useAudioTranscriberStore(
    (state) => state.fileAuthorizationPending,
  );
  const outputDirectoryAuthorization = useAudioTranscriberStore(
    (state) => state.outputDirectoryAuthorization,
  );
  const result = useAudioTranscriberStore((state) => state.result);
  const status = useAudioTranscriberStore((state) => state.status);
  const lastError = useAudioTranscriberStore((state) => state.lastError);
  const activeRequestId = useAudioTranscriberStore(
    (state) => state.activeRequestId,
  );
  const setResult = useAudioTranscriberStore((state) => state.setResult);
  const setStatus = useAudioTranscriberStore((state) => state.setStatus);
  const setLastError = useAudioTranscriberStore((state) => state.setLastError);
  const beginRequest = useAudioTranscriberStore((state) => state.beginRequest);
  const invalidateActiveRequest = useAudioTranscriberStore(
    (state) => state.invalidateActiveRequest,
  );
  const isRequestCurrent = useAudioTranscriberStore(
    (state) => state.isRequestCurrent,
  );
  const submissionLockRef = useRef(false);
  const activeSubmissionRef = useRef<
    ActiveAudioTranscriptionSubmission | null
  >(null);
  const previousAssignedProfileRef = useRef(assignedProfile);
  const previousRouteIdentityRef = useRef(routeIdentity);
  const constraints = summary.constraints;
  const normalized = useMemo(
    () => constraints
      ? normalizeAudioTranscriberPreferences(preferences, constraints)
      : preferences,
    [constraints, preferences],
  );
  const submitIssueKey = useMemo(
    () => resolveSubmitIssueKey(
      summary,
      selectedFile,
      normalized,
      outputDirectoryAuthorization,
      fileAuthorizationPending,
    ),
    [
      fileAuthorizationPending,
      normalized,
      outputDirectoryAuthorization,
      selectedFile,
      summary,
    ],
  );
  const submitIssue = submitIssueKey ? t(submitIssueKey) : null;
  const isRunning = status === "running";
  const isSubmissionLocked =
    isRunning ||
    submissionPending ||
    fileAuthorizationPending ||
    outputDirectoryPending;

  useEffect(() => {
    if (
      previousAssignedProfileRef.current === assignedProfile &&
      previousRouteIdentityRef.current === routeIdentity
    ) {
      return;
    }
    previousAssignedProfileRef.current = assignedProfile;
    previousRouteIdentityRef.current = routeIdentity;
    const activeSubmission = activeSubmissionRef.current;
    activeSubmission?.abortController.abort();
    if (activeSubmission?.dispatched) {
      void queueAudioTranscriptionCancellation(activeSubmission.requestId);
    }
    useAudioTranscriberStore
      .getState()
      .invalidateActiveRequest("cancelled");
  }, [assignedProfile, routeIdentity]);

  useEffect(() => {
    void flushPendingAudioTranscriptionCancellations();
    return () => {
      const activeSubmission = activeSubmissionRef.current;
      activeSubmission?.abortController.abort();
      if (activeSubmission?.dispatched) {
        void queueAudioTranscriptionCancellation(activeSubmission.requestId);
      }
      useAudioTranscriberStore
        .getState()
        .invalidateActiveRequest("cancelled");
    };
  }, []);

  const runSubmission = useCallback(async () => {
    if (
      !constraints ||
      summary.status !== "ready" ||
      outputDirectoryPending
    ) {
      return;
    }
    const issueKey = resolveSubmitIssueKey(
      summary,
      selectedFile,
      normalized,
      outputDirectoryAuthorization,
      fileAuthorizationPending,
    );
    if (issueKey) {
      const message = t(issueKey);
      showToast(message, "error");
      setLastError({ code: "renderer_error", message });
      return;
    }
    if (!selectedFile) return;

    const submissionSnapshot = createAudioTranscriptionSubmissionSnapshot(
      summary,
      assignedProfile,
      selectedFile,
    );
    let requestFile: SelectedAudioInput | null = null;
    let activeSubmission: ActiveAudioTranscriptionSubmission | null = null;

    try {
      requestFile = await fileController.ensureAuthorized();

      const latestState = useAudioTranscriberStore.getState();
      const latestAudioState = useAudioApiStore.getState();
      const latestSummary = resolveAudioTranscriptionConfigSummary(
        latestAudioState,
      );
      const latestProfile = latestAudioState.profiles.find(
        (profile) => profile.id === latestSummary.profileId,
      );
      if (
        !isAudioTranscriptionSubmissionSnapshotCurrent(
          submissionSnapshot,
          latestSummary,
          latestProfile,
          latestState.selectedFile,
        ) ||
        !latestSummary.constraints
      ) {
        return;
      }
      if (!requestFile?.fileToken) {
        if (!latestState.lastError) {
          const message = t("audio:transcriber.errors.file_path_unavailable");
          setLastError({ code: "renderer_error", message, field: "file" });
          showToast(message, "error");
        }
        return;
      }

      const requestPreferences = normalizeAudioTranscriberPreferences(
        latestState.preferences,
        latestSummary.constraints,
      );
      const finalIssueKey = resolveSubmitIssueKey(
        latestSummary,
        requestFile,
        requestPreferences,
        latestState.outputDirectoryAuthorization,
        false,
      );
      if (finalIssueKey) {
        const message = t(finalIssueKey);
        setLastError({ code: "renderer_error", message });
        showToast(message, "error");
        return;
      }

      const requestId = createTranscriptionRequestId();
      const request = buildAudioTranscriptionRequest({
        requestId,
        file: {
          ...requestFile,
          fileToken: requestFile.fileToken,
        },
        preferences: requestPreferences,
        outputDirectoryAuthorization: latestState.outputDirectoryAuthorization,
        constraints: latestSummary.constraints,
      });
      const currentSubmission: ActiveAudioTranscriptionSubmission = {
        requestId,
        abortController: new AbortController(),
        dispatched: false,
        cancelPending: false,
      };
      activeSubmission = currentSubmission;
      activeSubmissionRef.current = currentSubmission;
      const generation = beginRequest(requestId);

      const response = await transcribeAudio(request, {
        signal: currentSubmission.abortController.signal,
        onDispatch: () => {
          if (activeSubmissionRef.current === currentSubmission) {
            currentSubmission.dispatched = true;
          }
        },
      });
      if (!isRequestCurrent(requestId, generation)) return;

      const responseState = useAudioTranscriberStore.getState();
      const responseAudioState = useAudioApiStore.getState();
      const responseSummary = resolveAudioTranscriptionConfigSummary(
        responseAudioState,
      );
      const responseProfile = responseAudioState.profiles.find(
        (profile) => profile.id === responseSummary.profileId,
      );
      if (
        !isAudioTranscriptionSubmissionSnapshotCurrent(
          submissionSnapshot,
          responseSummary,
          responseProfile,
          responseState.selectedFile,
        )
      ) {
        responseState.invalidateActiveRequest("cancelled");
        return;
      }

      if (
        !response.ok &&
        response.error.code === "aborted" &&
        currentSubmission.abortController.signal.aborted
      ) {
        invalidateActiveRequest("cancelled");
        setLastError(null);
        return;
      }

      invalidateActiveRequest("idle");
      if (response.ok) {
        setResult(response.data);
        setStatus("completed");
        setLastError(null);
        showToast(t("audio:transcriber.messages.completed"), "success");
        return;
      }

      setStatus("failed");
      setLastError({
        code: response.error.code,
        message: response.error.message,
        field: response.error.field,
        details: response.error.details,
      });
      showToast(response.error.message, "error");
    } finally {
      if (activeSubmission) {
        settleAudioTranscriptionCancellation(activeSubmission.requestId);
      }
      if (activeSubmissionRef.current === activeSubmission) {
        activeSubmissionRef.current = null;
      }
      if (requestFile?.fileToken) {
        fileController.releaseToken(
          requestFile.fileToken,
          requestFile.expiresAt,
        );
      }
    }
  }, [
    assignedProfile,
    beginRequest,
    constraints,
    fileAuthorizationPending,
    fileController,
    invalidateActiveRequest,
    isRequestCurrent,
    normalized,
    outputDirectoryAuthorization,
    outputDirectoryPending,
    selectedFile,
    setLastError,
    setResult,
    setStatus,
    summary,
    t,
  ]);

  const handleStart = useCallback(async () => {
    if (submissionLockRef.current) return;
    submissionLockRef.current = true;
    onSubmissionPendingChange(true);
    try {
      await runSubmission();
    } finally {
      submissionLockRef.current = false;
      onSubmissionPendingChange(false);
    }
  }, [onSubmissionPendingChange, runSubmission]);

  const handleCancel = useCallback(async () => {
    const activeSubmission = activeSubmissionRef.current;
    if (
      !activeRequestId ||
      !activeSubmission ||
      activeSubmission.requestId !== activeRequestId ||
      activeSubmission.cancelPending
    ) {
      return;
    }

    activeSubmission.abortController.abort();
    if (!activeSubmission.dispatched) {
      invalidateActiveRequest("cancelled");
      showToast(t("audio:transcriber.messages.cancelled"), "success");
      return;
    }

    activeSubmission.cancelPending = true;
    let response = await cancelAudioTranscriptionBounded(activeRequestId);
    for (const retryDelay of [25, 75, 150]) {
      if (!response || !response.ok || response.data.cancelled) break;
      await waitForAudioCancellationRetry(retryDelay);
      if (
        activeSubmissionRef.current !== activeSubmission ||
        useAudioTranscriberStore.getState().activeRequestId !== activeRequestId
      ) {
        return;
      }
      response = await cancelAudioTranscriptionBounded(activeRequestId);
    }
    if (activeSubmissionRef.current === activeSubmission) {
      activeSubmission.cancelPending = false;
    }
    if (
      activeSubmissionRef.current !== activeSubmission ||
      useAudioTranscriberStore.getState().activeRequestId !== activeRequestId
    ) {
      return;
    }
    if (response?.ok && response.data.cancelled) {
      settleAudioTranscriptionCancellation(activeRequestId);
      invalidateActiveRequest("cancelled");
      showToast(t("audio:transcriber.messages.cancelled"), "success");
      return;
    }
    const message = !response || response.ok
      ? t("audio:transcriber.errors.cancel_failed")
      : response.error.message;
    void queueAudioTranscriptionCancellation(activeRequestId);
    setLastError({
      code: !response || response.ok ? "renderer_error" : response.error.code,
      message,
      ...(!response || response.ok ? {} : { field: response.error.field }),
    });
    showToast(message, "error");
  }, [
    activeRequestId,
    invalidateActiveRequest,
    setLastError,
    t,
  ]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(getResultDisplayText(result));
      showToast(t("audio:transcriber.messages.copied"), "success");
    } catch {
      showToast(t("audio:transcriber.errors.copy_failed"), "error");
    }
  }, [result, t]);

  const handleReveal = useCallback(async () => {
    if (!result?.outputToken) {
      showToast(t("audio:transcriber.errors.output_not_ready"), "error");
      return;
    }
    const response = await revealAudioOutput({ outputToken: result.outputToken });
    if (!response.ok) {
      showToast(response.error.message, "error");
    }
  }, [result?.outputToken, t]);

  const handleSave = useCallback(async () => {
    if (!result) return;
    const response = await saveAudioTranscriptionResult(
      result,
      selectedFile?.fileName,
    );
    if (response.ok) {
      if (response.data.saved) {
        showToast(t("audio:transcriber.messages.saved"), "success");
      }
      return;
    }
    showToast(
      response.error.message || t("audio:transcriber.errors.save_failed"),
      "error",
    );
  }, [result, selectedFile?.fileName, t]);

  if (summary.status !== "ready" || !constraints) {
    return (
      <ToolPanel
        icon={FileAudio}
        title={t("audio:pages.transcriber.workspace")}
        badge={<TranscriberStatusBadge status="idle" />}
        bodyClassName="p-5"
      >
        <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
          <div className="max-w-md space-y-4">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-amber-600 dark:text-amber-300">
              <Settings2 className="h-4 w-4" />
            </div>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">
                {t(`audio:workspace.${summary.status}.title`)}
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">
                {t(`audio:workspace.${summary.status}.description`)}
              </div>
            </div>
            <Button
              data-testid="transcriber-config-cta"
              type="button"
              className="gap-1.5"
              onClick={() => navigate(TRANSCRIBER_SETTINGS_PATH)}
            >
              <Settings2 className="h-4 w-4" />
              {t("audio:global.configure_audio_api")}
            </Button>
          </div>
        </div>
      </ToolPanel>
    );
  }

  return (
    <ToolPanel
      icon={FileAudio}
      title={t("audio:pages.transcriber.workspace")}
      badge={<TranscriberStatusBadge status={status} />}
      bodyClassName="p-5"
    >
      <div data-testid="transcriber-workspace" className="space-y-4">
        <ToolFileDropZone
          id="transcriber-file"
          inputTestId="transcriber-file-input"
          accept={getAudioTranscriberAccept(summary.audioDialect)}
          disabled={isSubmissionLocked}
          title={t(
            fileAuthorizationPending
              ? "audio:transcriber.file.authorizing"
              : "audio:transcriber.file.title",
          )}
          description={
            summary.audioDialect === "mimo_chat_audio"
              ? t("audio:transcriber.file.mimo_description")
              : t("audio:transcriber.file.openai_description")
          }
          actionLabel={t("audio:transcriber.actions.select_file")}
          icon={
            fileAuthorizationPending ? (
              <Loader2
                data-testid="transcriber-file-authorizing"
                className="h-5 w-5 animate-spin"
              />
            ) : undefined
          }
          onFiles={fileController.selectFiles}
        />

        {selectedFile ? (
          <SelectedFileCard
            file={selectedFile}
            disabled={isSubmissionLocked}
            onClear={fileController.clear}
          />
        ) : null}

        {lastError ? (
          <Alert data-testid="transcriber-error" variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>{t("audio:transcriber.errors.title")}</AlertTitle>
            <AlertDescription>
              <div className="space-y-1">
                <div>{getAudioErrorMessage(t, lastError, lastError.message)}</div>
                <div className="font-mono text-[11px]">code: {lastError.code}</div>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="transcriber-start"
            type="button"
            disabled={Boolean(submitIssue) || isSubmissionLocked}
            onClick={handleStart}
            className="gap-1.5"
          >
            {isRunning || submissionPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isRunning
              ? t("audio:transcriber.actions.running")
              : t("audio:transcriber.actions.start")}
          </Button>
          <Button
            data-testid="transcriber-cancel"
            type="button"
            variant="outline"
            disabled={!isRunning}
            onClick={handleCancel}
            className="gap-1.5"
          >
            <XCircle className="h-4 w-4" />
            {t("common:action.cancel")}
          </Button>
          {submitIssue ? (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <InfoHint>{submitIssue}</InfoHint>
              <span className="truncate">{submitIssue}</span>
            </div>
          ) : null}
        </div>

        <ResultPanel
          result={result}
          status={status}
          onCopy={handleCopy}
          onReveal={handleReveal}
          onSave={handleSave}
        />
      </div>
    </ToolPanel>
  );
}

function SelectedFileCard({
  file,
  disabled,
  onClear,
}: {
  file: SelectedAudioInput;
  disabled: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation(["audio"]);
  return (
    <div
      data-testid="transcriber-file-selected"
      className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
        <FileAudio className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{file.fileName}</div>
        <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span>{file.mimeType}</span>
          <span>{formatBytes(file.sizeBytes)}</span>
        </div>
      </div>
      <Button
        data-testid="transcriber-file-clear"
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={onClear}
        aria-label={t("audio:transcriber.actions.clear_file")}
        title={t("audio:transcriber.actions.clear_file")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ResultPanel({
  result,
  status,
  onCopy,
  onReveal,
  onSave,
}: {
  result: AuthorizedAudioTranscriptionResult | null;
  status: string;
  onCopy: () => void;
  onReveal: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation(["audio"]);
  if (!result) {
    return (
      <div
        data-testid="transcriber-result-empty"
        className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center"
      >
        <div className="max-w-md space-y-3">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
            {status === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
          </div>
          <div className="text-sm font-medium">
            {t(`audio:transcriber.empty.${status === "running" ? "running" : "title"}`)}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t(
              `audio:transcriber.empty.${status === "running" ? "running_description" : "description"}`,
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="transcriber-result"
      className="space-y-3 rounded-lg border bg-background p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {t("audio:transcriber.result.title")}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span>{t(`audio:transcriber.response_format.${result.responseFormat}`)}</span>
            {result.model ? <span>{result.model}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCopy}>
            <Clipboard className="h-3.5 w-3.5" />
            {t("audio:transcriber.actions.copy")}
          </Button>
          {result.outputToken ? (
            <Button type="button" variant="outline" size="sm" onClick={onReveal}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t("audio:transcriber.actions.open_output")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSave}
            >
              <Download className="h-3.5 w-3.5" />
              {t("audio:transcriber.actions.save_result")}
            </Button>
          )}
        </div>
      </div>
      <Textarea
        readOnly
        value={getResultDisplayText(result)}
        className="min-h-[220px] resize-y font-mono text-xs leading-relaxed"
      />
    </div>
  );
}

function TranscriberStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation(["audio"]);
  const tone =
    status === "completed"
      ? "border-emerald-500/25 text-emerald-700 dark:text-emerald-300"
      : status === "failed" || status === "cancelled"
        ? "border-amber-500/25 text-amber-700 dark:text-amber-300"
        : "";
  const Icon =
    status === "running"
      ? Loader2
      : status === "completed"
        ? CheckCircle2
        : status === "failed" || status === "cancelled"
          ? AlertTriangle
          : FileText;
  return (
    <Badge variant="outline" className={cn("gap-1", tone)}>
      <Icon className={cn("h-3 w-3", status === "running" && "animate-spin")} />
      {t(`audio:transcriber.status.${status}`)}
    </Badge>
  );
}

function useAudioInputAuthorization(
  summary: AudioTranscriptionConfigSummary,
  routeIdentity: string,
): AudioInputAuthorizationController {
  const { t } = useTranslation(["audio"]);
  const generationRef = useRef(0);
  const setSelectedFile = useAudioTranscriberStore(
    (state) => state.setSelectedFile,
  );
  const setFileAuthorizationPending = useAudioTranscriberStore(
    (state) => state.setFileAuthorizationPending,
  );
  const setLastError = useAudioTranscriberStore((state) => state.setLastError);

  const revokeTokenQuietly = useCallback((
    fileToken: string,
    expiresAt?: number,
  ) => queueAudioInputFileRevocation(fileToken, expiresAt), []);

  const reportAuthorizationError = useCallback((
    error: unknown,
    fallbackMessage: string,
  ) => {
    const message = error instanceof Error ? error.message : fallbackMessage;
    setLastError({ code: "network_error", message, field: "file" });
    showToast(message, "error");
  }, [setLastError]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    const current = useAudioTranscriberStore.getState().selectedFile;
    const revocation = current?.fileToken
      ? revokeTokenQuietly(current.fileToken, current.expiresAt)
      : undefined;
    setSelectedFile(null);
    if (revocation) void revocation;
  }, [revokeTokenQuietly, setSelectedFile]);

  const selectFiles = useCallback(async (files: FileList) => {
    const file = files[0];
    if (!file) return;
    const validation = validateAudioTranscriberFile(file, summary.audioDialect);
    if (!validation.ok) {
      const message = getFileIssueMessage(t, validation.issue);
      setLastError({
        code: "renderer_error",
        message,
        field: "file",
        details: validation.issue.details,
      });
      showToast(message, "error");
      return;
    }

    const previous = useAudioTranscriberStore.getState().selectedFile;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setFileAuthorizationPending(true);

    let response: Awaited<ReturnType<typeof authorizeAudioInputFile>>;
    try {
      response = await authorizeAudioInputFile(file);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setFileAuthorizationPending(false);
      reportAuthorizationError(
        error,
        t("audio:transcriber.errors.file_path_unavailable"),
      );
      return;
    }

    const latestSummary = resolveAudioTranscriptionConfigSummary(
      useAudioApiStore.getState(),
    );
    if (
      generation !== generationRef.current ||
      routeIdentity !== getTranscriptionRouteIdentity(latestSummary)
    ) {
      if (response.ok) {
        void revokeTokenQuietly(
          response.data.fileToken,
          response.data.expiresAt,
        );
      }
      if (generation === generationRef.current) {
        setFileAuthorizationPending(false);
      }
      return;
    }
    if (!response.ok) {
      setFileAuthorizationPending(false);
      const message = response.error.code === "file_read_failed"
        ? t("audio:transcriber.errors.file_path_unavailable")
        : getAudioErrorMessage(
            t,
            response.error,
            t("audio:transcriber.errors.file_path_unavailable"),
          );
      setLastError({
        code: response.error.code,
        message,
        field: response.error.field ?? "file",
        details: response.error.details,
      });
      showToast(message, "error");
      return;
    }

    const selected: SelectedAudioInput = {
      sourceFile: file,
      fileName: response.data.fileName || file.name,
      fileToken: response.data.fileToken,
      mimeType: validation.mimeType,
      sizeBytes: response.data.sizeBytes,
      expiresAt: response.data.expiresAt,
      modifiedAt: file.lastModified,
    };
    const previousRevocation =
      previous?.fileToken && previous.fileToken !== response.data.fileToken
        ? revokeTokenQuietly(previous.fileToken, previous.expiresAt)
        : undefined;
    setSelectedFile(selected);
    if (previousRevocation) void previousRevocation;
    showToast(t("audio:transcriber.messages.file_selected"), "success");
  }, [
    reportAuthorizationError,
    revokeTokenQuietly,
    routeIdentity,
    setFileAuthorizationPending,
    setLastError,
    setSelectedFile,
    summary.audioDialect,
    t,
  ]);

  const ensureAuthorized = useCallback(async () => {
    const current = useAudioTranscriberStore.getState().selectedFile;
    if (!current) return null;
    if (
      current.fileToken &&
      (current.expiresAt === undefined || current.expiresAt > Date.now())
    ) {
      return current;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setFileAuthorizationPending(true);
    let response: Awaited<ReturnType<typeof authorizeAudioInputFile>>;
    try {
      response = await authorizeAudioInputFile(current.sourceFile);
    } catch (error) {
      if (generation !== generationRef.current) return null;
      setFileAuthorizationPending(false);
      reportAuthorizationError(
        error,
        t("audio:transcriber.errors.file_path_unavailable"),
      );
      return null;
    }

    const latestSummary = resolveAudioTranscriptionConfigSummary(
      useAudioApiStore.getState(),
    );
    const latest = useAudioTranscriberStore.getState().selectedFile;
    if (
      generation !== generationRef.current ||
      routeIdentity !== getTranscriptionRouteIdentity(latestSummary) ||
      !latest ||
      latest.sourceFile !== current.sourceFile
    ) {
      if (response.ok) {
        void revokeTokenQuietly(
          response.data.fileToken,
          response.data.expiresAt,
        );
      }
      if (generation === generationRef.current) {
        setFileAuthorizationPending(false);
      }
      return null;
    }
    if (!response.ok) {
      setFileAuthorizationPending(false);
      const message = response.error.code === "file_read_failed"
        ? t("audio:transcriber.errors.file_path_unavailable")
        : getAudioErrorMessage(
            t,
            response.error,
            t("audio:transcriber.errors.file_path_unavailable"),
          );
      setLastError({
        code: response.error.code,
        message,
        field: response.error.field ?? "file",
        details: response.error.details,
      });
      showToast(message, "error");
      return null;
    }

    const authorized: SelectedAudioInput = {
      ...latest,
      fileToken: response.data.fileToken,
      fileName: response.data.fileName || latest.fileName,
      sizeBytes: response.data.sizeBytes,
      expiresAt: response.data.expiresAt,
    };
    const previousRevocation =
      current.fileToken && current.fileToken !== response.data.fileToken
        ? revokeTokenQuietly(current.fileToken, current.expiresAt)
        : undefined;
    setSelectedFile(authorized);
    if (previousRevocation) void previousRevocation;
    return authorized;
  }, [
    reportAuthorizationError,
    revokeTokenQuietly,
    routeIdentity,
    setFileAuthorizationPending,
    setLastError,
    setSelectedFile,
    t,
  ]);

  const releaseToken = useCallback((
    fileToken: string,
    expiresAt?: number,
  ) => {
    const current = useAudioTranscriberStore.getState().selectedFile;
    const tokenExpiresAt = current?.fileToken === fileToken
      ? current.expiresAt
      : expiresAt;
    void revokeTokenQuietly(fileToken, tokenExpiresAt);
    if (current?.fileToken === fileToken) {
      useAudioTranscriberStore.setState({
        selectedFile: {
          ...current,
          fileToken: null,
          expiresAt: undefined,
        },
      });
    }
  }, [revokeTokenQuietly]);

  useEffect(() => {
    void flushPendingAudioInputFileRevocations();
    return () => {
      generationRef.current += 1;
      const current = useAudioTranscriberStore.getState().selectedFile;
      const revocation = current?.fileToken
        ? revokeTokenQuietly(current.fileToken, current.expiresAt)
        : undefined;
      useAudioTranscriberStore.setState({
        selectedFile: null,
        fileAuthorizationPending: false,
      });
      if (revocation) void revocation;
    };
  }, [revokeTokenQuietly, routeIdentity]);

  return useMemo(
    () => ({ selectFiles, clear, ensureAuthorized, releaseToken }),
    [clear, ensureAuthorized, releaseToken, selectFiles],
  );
}

function useAudioOutputDirectoryAuthorization(
  routeIdentity: string,
): AudioOutputDirectoryAuthorizationController {
  const { t } = useTranslation(["audio"]);
  const [pending, setPending] = useState(false);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const previousRouteIdentityRef = useRef(routeIdentity);
  const updatePreferences = useAudioTranscriberStore(
    (state) => state.updatePreferences,
  );
  const setOutputDirectoryAuthorization = useAudioTranscriberStore(
    (state) => state.setOutputDirectoryAuthorization,
  );

  const revokeQuietly = useCallback((
    authorization: AudioOutputDirectoryAuthorization | null,
  ) => {
    if (!authorization) return;
    void queueAudioOutputDirectoryRevocation(
      authorization.outputDirToken,
      authorization.expiresAt,
    );
  }, []);

  const clearAuthorization = useCallback(() => {
    const authorization =
      useAudioTranscriberStore.getState().outputDirectoryAuthorization;
    revokeQuietly(authorization);
    setOutputDirectoryAuthorization(null);
  }, [revokeQuietly, setOutputDirectoryAuthorization]);

  const setOutputMode = useCallback((
    outputMode: AudioTranscriberPreferences["outputMode"],
  ) => {
    if (outputMode !== "custom_dir") {
      generationRef.current += 1;
      pendingRef.current = false;
      setPending(false);
      clearAuthorization();
    }
    updatePreferences({ outputMode });
  }, [clearAuthorization, updatePreferences]);

  const select = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPending(true);

    try {
      const response = await window.audioApi.selectOutputDirectory({
        title: t("audio:transcriber.dialog.select_output_title"),
        buttonLabel: t("audio:transcriber.dialog.select_output_confirm"),
      });
      const latestSummary = resolveAudioTranscriptionConfigSummary(
        useAudioApiStore.getState(),
      );
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        routeIdentity !== getTranscriptionRouteIdentity(latestSummary)
      ) {
        if (response.ok && !response.data.cancelled) {
          void queueAudioOutputDirectoryRevocation(
            response.data.outputDirToken,
            response.data.expiresAt,
          );
        }
        return;
      }
      if (!response.ok) {
        showToast(
          getAudioErrorMessage(t, response.error, response.error.message),
          "error",
        );
        return;
      }
      if (response.data.cancelled) return;

      const previous =
        useAudioTranscriberStore.getState().outputDirectoryAuthorization;
      updatePreferences({
        outputMode: "custom_dir",
        outputDir: response.data.directoryName,
      });
      setOutputDirectoryAuthorization({
        outputDirToken: response.data.outputDirToken,
        directoryName: response.data.directoryName,
        expiresAt: response.data.expiresAt,
      });
      if (previous?.outputDirToken !== response.data.outputDirToken) {
        revokeQuietly(previous);
      }
      showToast(t("audio:transcriber.messages.output_path_selected"), "success");
    } catch (error) {
      if (
        mountedRef.current &&
        generation === generationRef.current
      ) {
        showToast(
          error instanceof Error
            ? error.message
            : t("audio:transcriber.errors.output_dir_select_failed"),
          "error",
        );
      }
    } finally {
      if (
        mountedRef.current &&
        generation === generationRef.current
      ) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [
    revokeQuietly,
    routeIdentity,
    setOutputDirectoryAuthorization,
    t,
    updatePreferences,
  ]);

  useEffect(() => {
    if (previousRouteIdentityRef.current === routeIdentity) return;
    previousRouteIdentityRef.current = routeIdentity;
    generationRef.current += 1;
    pendingRef.current = false;
    setPending(false);
    clearAuthorization();
  }, [clearAuthorization, routeIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    void flushPendingAudioOutputDirectoryRevocations();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      pendingRef.current = false;
      clearAuthorization();
    };
  }, [clearAuthorization]);

  return useMemo(
    () => ({ pending, select, setOutputMode }),
    [pending, select, setOutputMode],
  );
}

interface AudioTranscriptionSubmissionSnapshot {
  profileRevision: AudioApiProfile | undefined;
  profileId: string | undefined;
  providerPreset: AudioTranscriptionConfigSummary["providerPreset"];
  routeTransport: AudioTranscriptionConfigSummary["audioDialect"];
  routeModel: string | undefined;
  routeEnabled: boolean | undefined;
  sourceFile: File | undefined;
}

function createAudioTranscriptionSubmissionSnapshot(
  summary: AudioTranscriptionConfigSummary,
  profileRevision: AudioApiProfile | undefined,
  selectedFile: SelectedAudioInput | null,
): AudioTranscriptionSubmissionSnapshot {
  return {
    profileRevision,
    profileId: summary.profileId,
    providerPreset: summary.providerPreset,
    routeTransport: summary.route?.transport,
    routeModel: summary.route?.model,
    routeEnabled: summary.route?.enabled,
    sourceFile: selectedFile?.sourceFile,
  };
}

function isAudioTranscriptionSubmissionSnapshotCurrent(
  snapshot: AudioTranscriptionSubmissionSnapshot,
  summary: AudioTranscriptionConfigSummary,
  profileRevision: AudioApiProfile | undefined,
  selectedFile: SelectedAudioInput | null,
): boolean {
  return (
    summary.status === "ready" &&
    snapshot.profileRevision === profileRevision &&
    snapshot.profileId === summary.profileId &&
    snapshot.providerPreset === summary.providerPreset &&
    snapshot.routeTransport === summary.route?.transport &&
    snapshot.routeModel === summary.route?.model &&
    snapshot.routeEnabled === summary.route?.enabled &&
    snapshot.sourceFile === selectedFile?.sourceFile
  );
}

function getTranscriptionRouteIdentity(
  summary: AudioTranscriptionConfigSummary,
): string {
  return JSON.stringify([
    summary.status,
    summary.profileId,
    summary.providerPreset,
    summary.route?.transport,
    summary.route?.model,
    summary.route?.enabled,
  ]);
}

function resolveSubmitIssueKey(
  summary: AudioTranscriptionConfigSummary,
  selectedFile: SelectedAudioInput | null,
  preferences: AudioTranscriberPreferences,
  outputDirectoryAuthorization: AudioOutputDirectoryAuthorization | null,
  fileAuthorizationPending: boolean,
): string | null {
  if (summary.status !== "ready" || !summary.constraints) {
    return `audio:workspace.${summary.status}.title`;
  }
  if (fileAuthorizationPending) {
    return "audio:transcriber.errors.file_authorizing";
  }
  if (!selectedFile) {
    return "audio:transcriber.errors.no_file";
  }
  const validation = validateAudioTranscriberFile(
    {
      name: selectedFile.fileName,
      type: selectedFile.mimeType,
      size: selectedFile.sizeBytes,
    } as Pick<File, "name" | "type" | "size">,
    summary.audioDialect,
  );
  if (!validation.ok) {
    return `audio:transcriber.errors.${validation.issue.code}`;
  }
  if (
    preferences.outputMode === "custom_dir" &&
    !isAudioOutputDirectoryAuthorizationValid(
      outputDirectoryAuthorization,
      preferences.outputDir,
    )
  ) {
    return "audio:transcriber.errors.output_dir_required";
  }
  return null;
}

function getFileIssueMessage(
  t: (key: string) => string,
  issue: AudioTranscriberFileIssue,
): string {
  return t(`audio:transcriber.errors.${issue.code}`);
}

function getResultDisplayText(
  result: AuthorizedAudioTranscriptionResult,
): string {
  if (
    (result.responseFormat === "json" ||
      result.responseFormat === "verbose_json") &&
    result.rawJson
  ) {
    return JSON.stringify(result.rawJson, null, 2);
  }
  return result.rawText ?? result.text;
}

function createTranscriptionRequestId(): string {
  return `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function waitForAudioCancellationRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
