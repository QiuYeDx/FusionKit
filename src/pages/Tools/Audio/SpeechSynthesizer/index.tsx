import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  FileAudio,
  Loader2,
  Music2,
  Play,
  Radio,
  Settings2,
  Trash2,
  Volume2,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
import {
  InfoHint,
  ToolField,
  ToolFileDropZone,
  ToolOutputPathPicker,
  ToolPanel,
} from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { showToast } from "@/utils/toast";
import type { SpeechSynthesisStreamHandle } from "@/services/audio/speechSynthesisService";
import {
  cancelSpeechSynthesis,
  revealSpeechOutput,
  readSpeechOutput,
  synthesizeSpeech,
  synthesizeSpeechStream,
} from "@/services/audio/speechSynthesisService";
import {
  authorizeAudioInputFile,
  flushPendingAudioInputFileRevocations,
  queueAudioInputFileRevocation,
} from "@/services/audio/audioRuntimeConfigService";
import AudioToolShell from "../shared/AudioToolShell";
import { Pcm16StreamPlayer } from "../shared/pcm16StreamPlayer";
import { getAudioErrorMessage } from "../shared/audioErrorMessage";
import {
  MIMO_VOICE_PRESETS,
} from "@/store/tools/audio/audioToolConfig";
import {
  MIMO_VOICE_SAMPLE_ACCEPT,
  buildSpeechSynthesisRequest,
  clampSpeechSpeed,
  createSpeechSynthesisSubmissionSnapshot,
  getSpeechSynthesizerResponseFormats,
  isSpeechSynthesisSubmissionSnapshotCurrent,
  normalizeSpeechSynthesizerPreferences,
  resolveSpeechSynthesisFieldVisibility,
  resolveSpeechSynthesisConfigSummary,
  resolveSpeechSynthesisSubmitIssue,
  validateVoiceSampleFile,
  type SpeechSynthesisConfigSummary,
  type SelectedVoiceSample,
  type VoiceSampleIssue,
} from "@/store/tools/audio/speechSynthesizerConfig";
import useSpeechSynthesizerStore from "@/store/tools/audio/useSpeechSynthesizerStore";
import useAudioApiStore from "@/store/useAudioApiStore";
import type { SpeechSynthesisMode } from "@/type/audio";

const OPENAI_VOICE_HINTS = ["alloy", "ash", "coral", "echo", "fable", "nova", "sage", "shimmer"];
const SPEECH_SETTINGS_PATH =
  "/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Fspeech-synthesis";

export default function SpeechSynthesizer() {
  const { t } = useTranslation(["audio"]);
  const [showModeFallback, setShowModeFallback] = useState(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const preferences = useSpeechSynthesizerStore((state) => state.preferences);
  const setSpeechMode = useSpeechSynthesizerStore((state) => state.setSpeechMode);
  const profiles = useAudioApiStore((state) => state.profiles);
  const assignment = useAudioApiStore((state) => state.assignment);
  const configSummary = useMemo(
    () => resolveSpeechSynthesisConfigSummary(
      { profiles, assignment },
      preferences.speechMode,
    ),
    [assignment, preferences.speechMode, profiles],
  );
  const previousProfileIdRef = useRef(configSummary.profileId);

  useEffect(() => {
    const profileChanged =
      previousProfileIdRef.current !== configSummary.profileId;
    previousProfileIdRef.current = configSummary.profileId;
    if (
      !configSummary.activeMode
    ) {
      setShowModeFallback(false);
      return;
    }
    if (configSummary.activeMode === preferences.speechMode) {
      if (profileChanged) setShowModeFallback(false);
      return;
    }
    setSpeechMode(configSummary.activeMode);
    setShowModeFallback(true);
    showToast(t("audio:speech.messages.mode_fallback"), "warning");
  }, [
    configSummary.activeMode,
    configSummary.profileId,
    preferences.speechMode,
    setSpeechMode,
    t,
  ]);

  const voiceSampleController = useVoiceSampleAuthorization(
    configSummary.profileId,
  );
  const handleModeChange = useCallback(
    (mode: SpeechSynthesisMode) => {
      if (submissionPending) return;
      setShowModeFallback(false);
      setSpeechMode(mode);
    },
    [setSpeechMode, submissionPending],
  );

  return (
    <div data-testid="speech-synthesizer">
      <AudioToolShell
        toolKey="speechSynthesizer"
        titleKey="audio:pages.speech.title"
        descriptionKey="audio:pages.speech.description"
        workspaceTitleKey="audio:pages.speech.workspace"
        configSummary={configSummary}
        settingsPath={SPEECH_SETTINGS_PATH}
        asideExtra={() =>
          configSummary.status === "ready" && configSummary.constraints ? (
            <SpeechConfig
              summary={configSummary}
              showModeFallback={showModeFallback}
              submissionPending={submissionPending}
              onModeChange={handleModeChange}
              voiceSampleController={voiceSampleController}
            />
          ) : null
        }
      >
        {() => (
          <SpeechWorkspace
            summary={configSummary}
            submissionPending={submissionPending}
            onSubmissionPendingChange={setSubmissionPending}
            voiceSampleController={voiceSampleController}
          />
        )}
      </AudioToolShell>
    </div>
  );
}

interface VoiceSampleController {
  selectFiles: (files: FileList) => Promise<void>;
  clear: () => void;
  ensureAuthorized: () => Promise<SelectedVoiceSample | null>;
  releaseToken: (fileToken: string, expiresAt?: number) => Promise<void>;
}

function SpeechConfig({
  summary,
  showModeFallback,
  submissionPending,
  onModeChange,
  voiceSampleController,
}: {
  summary: SpeechSynthesisConfigSummary;
  showModeFallback: boolean;
  submissionPending: boolean;
  onModeChange: (mode: SpeechSynthesisMode) => void;
  voiceSampleController: VoiceSampleController;
}) {
  const { t } = useTranslation(["audio"]);
  const preferences = useSpeechSynthesizerStore((state) => state.preferences);
  const status = useSpeechSynthesizerStore((state) => state.status);
  const voiceSample = useSpeechSynthesizerStore((state) => state.voiceSample);
  const voiceSampleAuthorizationPending = useSpeechSynthesizerStore(
    (state) => state.voiceSampleAuthorizationPending,
  );
  const updatePreferences = useSpeechSynthesizerStore(
    (state) => state.updatePreferences,
  );
  const setOutputDirectoryAuthorization = useSpeechSynthesizerStore(
    (state) => state.setOutputDirectoryAuthorization,
  );
  const constraints = summary.constraints!;
  const normalized = useMemo(
    () => normalizeSpeechSynthesizerPreferences(preferences, constraints),
    [constraints, preferences],
  );
  const responseFormats = getSpeechSynthesizerResponseFormats(
    constraints,
    normalized.stream,
  );
  const fields = resolveSpeechSynthesisFieldVisibility(
    constraints,
    normalized.stream,
  );
  const isMimo = summary.providerPreset === "mimo";
  const isRunning = status === "running" || status === "streaming";
  const isConfigLocked =
    isRunning || submissionPending || voiceSampleAuthorizationPending;

  const handleSelectOutputDir = useCallback(async () => {
    try {
      const response = await window.audioApi.selectOutputDirectory({
        title: t("audio:speech.dialog.select_output_title"),
        buttonLabel: t("audio:speech.dialog.select_output_confirm"),
      });
      if (!response.ok) {
        showToast(
          getAudioErrorMessage(t, response.error, response.error.message),
          "error",
        );
        return;
      }
      if (response.data.cancelled) return;
      updatePreferences({
        outputMode: "custom_dir",
        outputDir: response.data.directoryName,
      });
      setOutputDirectoryAuthorization({
        outputDirToken: response.data.outputDirToken,
        directoryName: response.data.directoryName,
        expiresAt: response.data.expiresAt,
      });
      showToast(t("audio:speech.messages.output_path_selected"), "success");
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : t("audio:speech.errors.output_dir_select_failed"),
        "error",
      );
    }
  }, [setOutputDirectoryAuthorization, t, updatePreferences]);

  return (
    <fieldset disabled={isConfigLocked} className="min-w-0 space-y-4">
      <legend className="sr-only">{t("audio:pages.speech.config")}</legend>
      {showModeFallback ? (
        <Alert data-testid="speech-mode-fallback-notice">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            {t("audio:speech.messages.mode_fallback")}
          </AlertDescription>
        </Alert>
      ) : null}

      {summary.availableModes.length > 1 && summary.activeMode ? (
        <SpeechModeSelector
          availableModes={summary.availableModes}
          activeMode={summary.activeMode}
          disabled={isConfigLocked}
          onChange={onModeChange}
        />
      ) : null}

      {fields.voice ? (
        <ToolField
          testId="speech-field-voice"
          label={t("audio:speech.fields.voice")}
          htmlFor="speech-voice"
          required={constraints.fields.voice === "required"}
          hint={t(
            isMimo
              ? "audio:speech.hints.mimo_voice"
              : "audio:speech.hints.openai_voice",
          )}
        >
          <Input
            id="speech-voice"
            value={preferences.voice}
            className="h-8 text-xs"
            placeholder={t(
              isMimo
                ? "audio:speech.placeholders.mimo_voice"
                : "audio:speech.placeholders.openai_voice",
            )}
            onChange={(event) =>
              updatePreferences({ voice: event.currentTarget.value })
            }
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(isMimo ? MIMO_VOICE_PRESETS : OPENAI_VOICE_HINTS.map((voice) => ({
              id: voice,
              label: voice,
            }))).map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant={preferences.voice === preset.id ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-pressed={preferences.voice === preset.id}
                onClick={() => updatePreferences({ voice: preset.id })}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </ToolField>
      ) : null}

      {fields.styleInstruction ? (
        <ToolField
          testId="speech-field-style-instruction"
          label={t("audio:speech.fields.style_instruction")}
          htmlFor="speech-style-instruction"
          required={constraints.fields.styleInstruction === "required"}
        >
          <Textarea
            id="speech-style-instruction"
            rows={2}
            className="resize-none text-xs"
            value={preferences.styleInstruction}
            placeholder={t("audio:speech.placeholders.style_instruction")}
            onChange={(event) =>
              updatePreferences({ styleInstruction: event.currentTarget.value })
            }
          />
        </ToolField>
      ) : null}

      {fields.voiceDesignPrompt ? (
        <ToolField
          testId="speech-field-voice-design-prompt"
          label={t("audio:speech.fields.voice_design_prompt")}
          hint={t("audio:speech.hints.voice_design")}
          htmlFor="speech-voice-design-prompt"
          required={constraints.fields.voiceDesignPrompt === "required"}
        >
          <Textarea
            id="speech-voice-design-prompt"
            rows={3}
            className="resize-none text-xs"
            value={preferences.voiceDesignPrompt}
            placeholder={t("audio:speech.placeholders.voice_design_prompt")}
            onChange={(event) =>
              updatePreferences({ voiceDesignPrompt: event.currentTarget.value })
            }
          />
          {fields.optimizeTextPreview ? (
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={preferences.optimizeTextPreview}
                onCheckedChange={(checked) =>
                  updatePreferences({ optimizeTextPreview: Boolean(checked) })
                }
              />
              {t("audio:speech.fields.optimize_text_preview")}
            </label>
          ) : null}
        </ToolField>
      ) : null}

      {fields.referenceAudio ? (
        <ToolField
          testId="speech-field-voice-sample"
          label={t("audio:speech.fields.voice_sample")}
          hint={t("audio:speech.hints.voice_clone")}
          required={constraints.fields.referenceAudio === "required"}
        >
          <ToolFileDropZone
            id="speech-voice-sample"
            inputTestId="speech-voice-sample-input"
            accept={MIMO_VOICE_SAMPLE_ACCEPT}
            disabled={isConfigLocked}
            title={
              voiceSampleAuthorizationPending
                ? t("audio:speech.voice_sample.authorizing")
                : t("audio:speech.voice_sample.title")
            }
            description={t("audio:speech.voice_sample.description")}
            actionLabel={t("audio:speech.actions.select_voice_sample")}
            icon={
              voiceSampleAuthorizationPending ? (
                <Loader2
                  data-testid="speech-voice-sample-authorizing"
                  className="h-5 w-5 animate-spin"
                />
              ) : undefined
            }
            onFiles={voiceSampleController.selectFiles}
            layout="stacked"
            className="px-3 py-3"
          />
          {voiceSample ? (
            <div
              data-testid="speech-voice-sample-selected"
              className="mt-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <FileAudio className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {voiceSample.fileName}
              </span>
              <Button
                data-testid="speech-voice-sample-clear"
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={voiceSampleAuthorizationPending}
                onClick={voiceSampleController.clear}
                aria-label={t("audio:speech.actions.clear_voice_sample")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </ToolField>
      ) : null}

      <ToolField
        testId="speech-output-format"
        label={t("audio:speech.fields.response_format")}
        htmlFor={fields.responseFormatSelect ? "speech-response-format" : undefined}
        hint={t(
          isMimo
            ? "audio:speech.hints.mimo_format"
            : "audio:speech.hints.openai_format",
        )}
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
              id="speech-response-format"
              size="sm"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {responseFormats.map((format) => (
                <SelectItem key={format} value={format}>
                  {t(`audio:speech.response_format.${format}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs font-medium">
            {t(
              `audio:speech.response_format.${responseFormats[0] ?? normalized.responseFormat}`,
            )}
          </div>
        )}
      </ToolField>

      {fields.speed ? (
        <ToolField
          testId="speech-field-speed"
          label={t("audio:speech.fields.speed")}
          hint={t("audio:speech.hints.speed")}
          htmlFor="speech-speed"
          required={constraints.fields.speed === "required"}
        >
          <Input
            id="speech-speed"
            type="number"
            min={0.25}
            max={4}
            step={0.05}
            value={normalized.speed}
            className="h-8 text-xs"
            onChange={(event) =>
              updatePreferences({
                speed: clampSpeechSpeed(Number(event.currentTarget.value)),
              })
            }
          />
        </ToolField>
      ) : null}

      {fields.stream ? (
        <ToolField
          testId="speech-stream"
          label={t("audio:speech.fields.stream")}
          hint={t("audio:speech.hints.stream")}
          action={
            <Switch
              checked={normalized.stream}
              aria-label={t("audio:speech.fields.stream")}
              onCheckedChange={(stream) => updatePreferences({ stream })}
            />
          }
        >
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(
              normalized.stream
                ? "audio:speech.hints.stream_on"
                : "audio:speech.hints.stream_off",
            )}
          </p>
        </ToolField>
      ) : null}

      <ToolField
        label={t("audio:speech.fields.output_mode")}
        hint={t("audio:speech.hints.output_mode")}
      >
        <ButtonGroup
          className="w-full"
          role="radiogroup"
          aria-label={t("audio:speech.fields.output_mode")}
        >
          {(["temp", "custom_dir"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              className="flex-1"
              role="radio"
              aria-checked={preferences.outputMode === mode}
              variant={preferences.outputMode === mode ? "default" : "outline"}
              onClick={() => updatePreferences({ outputMode: mode })}
            >
              {t(`audio:speech.output_mode.${mode}`)}
            </Button>
          ))}
        </ButtonGroup>
        {preferences.outputMode === "custom_dir" ? (
          <ToolOutputPathPicker
            className="mt-2"
            value={preferences.outputDir}
            placeholder={t("audio:speech.placeholders.output_dir")}
            selectLabel={t("audio:speech.actions.select_output_dir")}
            onSelect={handleSelectOutputDir}
          />
        ) : null}
      </ToolField>

      <ToolField
        label={t("audio:speech.fields.file_name_hint")}
        hint={t("audio:speech.hints.file_name_hint")}
        htmlFor="speech-file-name-hint"
      >
        <Input
          id="speech-file-name-hint"
          value={preferences.fileNameHint}
          maxLength={120}
          className="h-8 text-xs"
          placeholder={t("audio:speech.placeholders.file_name_hint")}
          onChange={(event) =>
            updatePreferences({ fileNameHint: event.currentTarget.value })
          }
        />
      </ToolField>
    </fieldset>
  );
}

function SpeechModeSelector({
  availableModes,
  activeMode,
  disabled,
  onChange,
}: {
  availableModes: SpeechSynthesisMode[];
  activeMode: SpeechSynthesisMode;
  disabled: boolean;
  onChange: (mode: SpeechSynthesisMode) => void;
}) {
  const { t } = useTranslation(["audio"]);
  const buttonRefs = useRef<
    Partial<Record<SpeechSynthesisMode, HTMLButtonElement | null>>
  >({});

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    mode: SpeechSynthesisMode,
  ) => {
    const currentIndex = availableModes.indexOf(mode);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % availableModes.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + availableModes.length) % availableModes.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = availableModes.length - 1;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextMode = availableModes[nextIndex];
    onChange(nextMode);
    requestAnimationFrame(() => buttonRefs.current[nextMode]?.focus());
  };

  return (
    <ToolField
      testId="speech-mode-group"
      label={t("audio:speech.fields.mode")}
      hint={t("audio:speech.hints.mode")}
    >
      <ButtonGroup
        className="grid w-full grid-cols-1 gap-1 min-[420px]:grid-cols-3"
        role="radiogroup"
        aria-label={t("audio:speech.fields.mode")}
      >
        {availableModes.map((mode) => (
          <Button
            key={mode}
            ref={(node) => {
              buttonRefs.current[mode] = node;
            }}
            data-testid={`speech-mode-${mode}`}
            type="button"
            size="sm"
            className="min-w-0 px-2 text-[11px]"
            role="radio"
            tabIndex={activeMode === mode ? 0 : -1}
            aria-checked={activeMode === mode}
            disabled={disabled}
            variant={activeMode === mode ? "default" : "outline"}
            onKeyDown={(event) => handleKeyDown(event, mode)}
            onClick={() => {
              onChange(mode);
              requestAnimationFrame(() => focusSpeechModePrimaryField(mode));
            }}
          >
            {t(`audio:speech.mode.${mode}`)}
          </Button>
        ))}
      </ButtonGroup>
    </ToolField>
  );
}

function SpeechWorkspace({
  summary,
  submissionPending,
  onSubmissionPendingChange,
  voiceSampleController,
}: {
  summary: SpeechSynthesisConfigSummary;
  submissionPending: boolean;
  onSubmissionPendingChange: (pending: boolean) => void;
  voiceSampleController: VoiceSampleController;
}) {
  const { t } = useTranslation(["audio", "common"]);
  const navigate = useNavigate();
  const preferences = useSpeechSynthesizerStore((state) => state.preferences);
  const voiceSample = useSpeechSynthesizerStore((state) => state.voiceSample);
  const voiceSampleAuthorizationPending = useSpeechSynthesizerStore(
    (state) => state.voiceSampleAuthorizationPending,
  );
  const outputDirectoryAuthorization = useSpeechSynthesizerStore(
    (state) => state.outputDirectoryAuthorization,
  );
  const result = useSpeechSynthesizerStore((state) => state.result);
  const status = useSpeechSynthesizerStore((state) => state.status);
  const lastError = useSpeechSynthesizerStore((state) => state.lastError);
  const activeRequestId = useSpeechSynthesizerStore(
    (state) => state.activeRequestId,
  );
  const activeMode = useSpeechSynthesizerStore((state) => state.activeMode);
  const streamText = useSpeechSynthesizerStore((state) => state.streamText);
  const streamStats = useSpeechSynthesizerStore((state) => state.streamStats);
  const updatePreferences = useSpeechSynthesizerStore(
    (state) => state.updatePreferences,
  );
  const setResult = useSpeechSynthesizerStore((state) => state.setResult);
  const setStatus = useSpeechSynthesizerStore((state) => state.setStatus);
  const setLastError = useSpeechSynthesizerStore((state) => state.setLastError);
  const setActiveRequest = useSpeechSynthesizerStore(
    (state) => state.setActiveRequest,
  );
  const beginTask = useSpeechSynthesizerStore((state) => state.beginTask);
  const invalidateTask = useSpeechSynthesizerStore(
    (state) => state.invalidateTask,
  );
  const appendStreamText = useSpeechSynthesizerStore(
    (state) => state.appendStreamText,
  );
  const updateStreamStats = useSpeechSynthesizerStore(
    (state) => state.updateStreamStats,
  );
  const resetTaskState = useSpeechSynthesizerStore(
    (state) => state.resetTaskState,
  );
  const streamHandleRef = useRef<SpeechSynthesisStreamHandle | null>(null);
  const playerRef = useRef<Pcm16StreamPlayer | null>(null);
  const submissionLockRef = useRef(false);
  const constraints = summary.constraints;
  const normalized = useMemo(
    () => constraints
      ? normalizeSpeechSynthesizerPreferences(preferences, constraints)
      : preferences,
    [constraints, preferences],
  );
  const submitIssueCode = useMemo(
    () => constraints
      ? resolveSpeechSynthesisSubmitIssue({
          preferences: normalized,
          constraints,
          voiceSample,
          voiceSampleAuthorizationPending,
          outputDirectoryAuthorization,
        })
      : null,
    [
      constraints,
      normalized,
      outputDirectoryAuthorization,
      voiceSample,
      voiceSampleAuthorizationPending,
    ],
  );
  const submitIssue = submitIssueCode
    ? t(`audio:speech.errors.${submitIssueCode}`)
    : null;
  const isRunning = status === "running" || status === "streaming";
  const isSubmissionLocked =
    isRunning || submissionPending || voiceSampleAuthorizationPending;

  const cleanupStreamResources = useCallback(() => {
    streamHandleRef.current?.unsubscribe();
    streamHandleRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
  }, []);

  const handleCancel = useCallback(async () => {
    if (!activeRequestId) return;
    const requestId = activeRequestId;
    const mode = activeMode;
    // Invalidate callbacks before awaiting IPC so a completion racing with
    // cancellation cannot resurrect stale task state.
    invalidateTask(requestId);
    const response = mode === "stream"
      ? await streamHandleRef.current?.cancel()
      : await cancelSpeechSynthesis(requestId);
    if (mode === "stream") {
      cleanupStreamResources();
    }
    if (response?.ok && response.data.cancelled) {
      setStatus("cancelled");
      showToast(t("audio:speech.messages.cancelled"), "success");
      return;
    }

    const error = response && !response.ok
      ? response.error
      : {
          code: "renderer_error" as const,
          message: t("audio:speech.errors.cancel_not_confirmed"),
        };
    setLastError(error);
    setStatus("failed");
    showToast(t("audio:speech.errors.cancel_not_confirmed"), "error");
  }, [
    activeMode,
    activeRequestId,
    cleanupStreamResources,
    invalidateTask,
    setLastError,
    setStatus,
    t,
  ]);

  useEffect(() => {
    return () => {
      const state = useSpeechSynthesizerStore.getState();
      if (state.activeRequestId) {
        state.invalidateTask(state.activeRequestId);
        if (state.activeMode === "stream") {
          void streamHandleRef.current?.cancel();
        } else {
          void cancelSpeechSynthesis(state.activeRequestId);
        }
      }
      cleanupStreamResources();
    };
  }, [cleanupStreamResources]);

  const runSubmission = useCallback(async () => {
    if (!constraints || summary.status !== "ready") return;

    const initialIssue = resolveSpeechSynthesisSubmitIssue({
      preferences: normalized,
      constraints,
      voiceSample,
      voiceSampleAuthorizationPending,
      outputDirectoryAuthorization,
    });
    if (initialIssue) {
      const message = t(`audio:speech.errors.${initialIssue}`);
      showToast(message, "error");
      setLastError({ code: "renderer_error", message });
      return;
    }

    const submissionSnapshot = createSpeechSynthesisSubmissionSnapshot(
      summary,
      voiceSample,
    );

    let requestVoiceSample = voiceSample;
    if (constraints.fields.referenceAudio !== "unsupported") {
      requestVoiceSample = await voiceSampleController.ensureAuthorized();
    }

    const latestState = useSpeechSynthesizerStore.getState();
    const latestAudioState = useAudioApiStore.getState();
    const latestSummary = resolveSpeechSynthesisConfigSummary(
      latestAudioState,
      latestState.preferences.speechMode,
    );
    if (
      !isSpeechSynthesisSubmissionSnapshotCurrent(
        submissionSnapshot,
        latestSummary,
        latestState.voiceSample,
      ) ||
      !latestSummary.constraints
    ) {
      if (requestVoiceSample?.fileToken) {
        await voiceSampleController.releaseToken(
          requestVoiceSample.fileToken,
          requestVoiceSample.expiresAt,
        );
      }
      return;
    }
    if (!requestVoiceSample?.fileToken &&
        latestSummary.constraints.fields.referenceAudio !== "unsupported") {
      const message = t("audio:speech.errors.voice_sample_authorization_failed");
      setLastError({ code: "renderer_error", message });
      return;
    }
    const requestConstraints = latestSummary.constraints;
    const requestPreferences = normalizeSpeechSynthesizerPreferences(
      latestState.preferences,
      requestConstraints,
    );
    const finalIssue = resolveSpeechSynthesisSubmitIssue({
      preferences: requestPreferences,
      constraints: requestConstraints,
      voiceSample: requestVoiceSample,
      voiceSampleAuthorizationPending: false,
      outputDirectoryAuthorization: latestState.outputDirectoryAuthorization,
    });
    if (finalIssue) {
      const message = t(`audio:speech.errors.${finalIssue}`);
      showToast(message, "error");
      setLastError({ code: "renderer_error", message });
      return;
    }

    const requestId = createSpeechRequestId();
    const request = buildSpeechSynthesisRequest({
      requestId,
      preferences: requestPreferences,
      constraints: requestConstraints,
      outputDirectoryAuthorization: latestState.outputDirectoryAuthorization,
      voiceSample: requestVoiceSample,
    });
    const voiceSampleToken = requestVoiceSample?.fileToken ?? null;

    try {
      if (requestPreferences.stream) {
        beginTask(requestId, "stream");
        const player = new Pcm16StreamPlayer();
        playerRef.current = player;
        let playerReady: Promise<void> = Promise.resolve();
        let playerStartError: unknown;
        const handle = synthesizeSpeechStream(
          request,
          {
            started: (event) => {
              if (useSpeechSynthesizerStore.getState().activeRequestId !== requestId) {
                return;
              }
              playerReady = player.start(event.sampleRate, event.channels).catch((error) => {
                playerStartError = error;
              });
            },
            audioDelta: (event) => {
              if (useSpeechSynthesizerStore.getState().activeRequestId !== requestId) {
                return;
              }
              player.push(event.pcmBytes);
              const current = useSpeechSynthesizerStore.getState().streamStats;
              updateStreamStats({
                chunkCount: current.chunkCount + 1,
                totalBytes: current.totalBytes + event.pcmBytes.byteLength,
              });
            },
            textDelta: (event) => {
              if (useSpeechSynthesizerStore.getState().activeRequestId === requestId) {
                appendStreamText(event.text);
              }
            },
            metadata: (event) => {
              if (useSpeechSynthesizerStore.getState().activeRequestId === requestId) {
                updateStreamStats(event.stats);
              }
            },
          },
          { requestId },
        );
        streamHandleRef.current = handle;
        const response = await handle.result;
        if (useSpeechSynthesizerStore.getState().activeRequestId !== requestId) {
          return;
        }
        if (response.ok) {
          try {
            await playerReady;
            if (playerStartError) throw playerStartError;
            await player.drain();
          } catch (error) {
            if (useSpeechSynthesizerStore.getState().activeRequestId !== requestId) {
              return;
            }
            setActiveRequest(null, null);
            cleanupStreamResources();
            const message = error instanceof Error
              ? error.message
              : t("audio:speech.errors.playback_failed");
            setLastError({ code: "renderer_error", message });
            setStatus("failed");
            showToast(t("audio:speech.errors.playback_failed"), "error");
            return;
          }
          if (useSpeechSynthesizerStore.getState().activeRequestId !== requestId) {
            return;
          }
          streamHandleRef.current = null;
          playerRef.current = null;
          setActiveRequest(null, null);
          setResult(response.data);
          setStatus("completed");
          showToast(t("audio:speech.messages.completed"), "success");
        } else {
          setActiveRequest(null, null);
          cleanupStreamResources();
          setStatus("failed");
          setLastError(response.error);
          showToast(t("audio:speech.errors.runtime_failed"), "error");
        }
        return;
      }

      beginTask(requestId, "non_stream");
      const response = await synthesizeSpeech(request);
      if (useSpeechSynthesizerStore.getState().activeRequestId !== requestId) {
        return;
      }
      setActiveRequest(null, null);
      if (response.ok) {
        setResult(response.data);
        setStatus("completed");
        showToast(t("audio:speech.messages.completed"), "success");
      } else {
        setStatus("failed");
        setLastError(response.error);
        showToast(t("audio:speech.errors.runtime_failed"), "error");
      }
    } finally {
      if (voiceSampleToken) {
        await voiceSampleController.releaseToken(
          voiceSampleToken,
          requestVoiceSample?.expiresAt,
        );
      }
    }
  }, [
    appendStreamText,
    beginTask,
    cleanupStreamResources,
    constraints,
    normalized,
    outputDirectoryAuthorization,
    setActiveRequest,
    setLastError,
    setResult,
    setStatus,
    t,
    updateStreamStats,
    voiceSample,
    voiceSampleAuthorizationPending,
    voiceSampleController,
    summary,
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

  const handleReveal = useCallback(async () => {
    if (!result?.outputToken) {
      showToast(t("audio:speech.errors.output_not_ready"), "error");
      return;
    }
    const response = await revealSpeechOutput({ outputToken: result.outputToken });
    if (!response.ok) {
      showToast(response.error.message, "error");
    }
  }, [result?.outputToken, t]);

  if (summary.status !== "ready" || !constraints) {
    return (
      <ToolPanel
        icon={Volume2}
        title={t("audio:pages.speech.workspace")}
        badge={<SpeechStatusBadge status="idle" />}
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
              data-testid="speech-config-cta"
              type="button"
              className="gap-1.5"
              onClick={() => navigate(SPEECH_SETTINGS_PATH)}
            >
              <Settings2 className="h-4 w-4" />
              {t("audio:global.configure_audio_api")}
            </Button>
          </div>
        </div>
      </ToolPanel>
    );
  }

  const inputIssue = submitIssueCode === "no_input" ||
    submitIssueCode === "input_too_long";
  const instructionsIssue = submitIssueCode === "instructions_too_long";
  const inputRequired = constraints.inputRequired && !(
    constraints.allowEmptyInputWhenOptimizeTextPreview &&
    normalized.optimizeTextPreview
  );

  return (
    <ToolPanel
      icon={Volume2}
      title={t("audio:pages.speech.workspace")}
      badge={<SpeechStatusBadge status={status} />}
      bodyClassName="p-5"
    >
      <div className="space-y-4">
        <ToolField
          testId="speech-field-input"
          label={t("audio:speech.fields.input")}
          htmlFor="speech-input"
          required={inputRequired}
          hint={t("audio:speech.hints.input")}
        >
          <Textarea
            id="speech-input"
            value={preferences.input}
            maxLength={constraints.maxInputChars}
            disabled={isSubmissionLocked}
            aria-invalid={inputIssue || undefined}
            aria-describedby={inputIssue ? "speech-input-error" : undefined}
            rows={8}
            className="min-h-[180px] resize-y text-sm leading-relaxed"
            placeholder={t("audio:speech.placeholders.input")}
            onChange={(event) =>
              updatePreferences({ input: event.currentTarget.value })
            }
          />
          {inputIssue && submitIssue ? (
            <p
              id="speech-input-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {submitIssue}
            </p>
          ) : null}
        </ToolField>

        {constraints.fields.instructions !== "unsupported" ? (
          <ToolField
            testId="speech-field-instructions"
            label={t("audio:speech.fields.instructions")}
            htmlFor="speech-instructions"
            required={constraints.fields.instructions === "required"}
          >
            <Textarea
              id="speech-instructions"
              value={preferences.instructions}
              maxLength={constraints.maxInstructionsChars}
              disabled={isSubmissionLocked}
              aria-invalid={instructionsIssue || undefined}
              aria-describedby={
                instructionsIssue ? "speech-instructions-error" : undefined
              }
              rows={3}
              className="resize-y text-xs"
              placeholder={t("audio:speech.placeholders.instructions")}
              onChange={(event) =>
                updatePreferences({ instructions: event.currentTarget.value })
              }
            />
            {instructionsIssue && submitIssue ? (
              <p
                id="speech-instructions-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {submitIssue}
              </p>
            ) : null}
          </ToolField>
        ) : null}

        {lastError ? (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>{t("audio:speech.errors.title")}</AlertTitle>
            <AlertDescription>
              <div className="space-y-1">
                <div>{getAudioErrorMessage(t, lastError, lastError.message)}</div>
                <div className="font-mono text-[11px]">code: {lastError.code}</div>
                {lastError.code !== "renderer_error" ? (
                  <details className="text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer">
                      {t("audio:runtime_error.technical_details")}
                    </summary>
                    <div className="mt-1 break-words font-mono">
                      {lastError.message}
                    </div>
                  </details>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="speech-generate"
            type="button"
            disabled={Boolean(submitIssue) || isSubmissionLocked}
            onClick={handleStart}
            className="gap-1.5"
          >
            {isSubmissionLocked ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : normalized.stream ? (
              <Radio className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isSubmissionLocked
              ? t("audio:speech.actions.running")
              : normalized.stream
                ? t("audio:speech.actions.start_stream")
                : t("audio:speech.actions.start")}
          </Button>
          <Button
            data-testid="speech-cancel"
            type="button"
            variant="outline"
            disabled={!isRunning}
            onClick={handleCancel}
            className="gap-1.5"
          >
            <XCircle className="h-4 w-4" />
            {t("common:action.cancel")}
          </Button>
          {submitIssue && !inputIssue && !instructionsIssue ? (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <InfoHint>{submitIssue}</InfoHint>
              <span className="truncate">{submitIssue}</span>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isRunning}
            onClick={resetTaskState}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("audio:speech.actions.clear")}
          </Button>
        </div>

        <SpeechResultPanel
          result={result}
          status={status}
          streamText={streamText}
          streamStats={streamStats}
          onReveal={handleReveal}
        />
      </div>
    </ToolPanel>
  );
}

function SpeechResultPanel({
  result,
  status,
  streamText,
  streamStats,
  onReveal,
}: {
  result: ReturnType<typeof useSpeechSynthesizerStore.getState>["result"];
  status: string;
  streamText: string;
  streamStats: ReturnType<typeof useSpeechSynthesizerStore.getState>["streamStats"];
  onReveal: () => void;
}) {
  const { t } = useTranslation(["audio"]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setAudioUrl(null);
    if (!result?.outputToken) return;
    void readSpeechOutput(result.outputToken).then((response) => {
      if (!active || !response.ok) return;
      objectUrl = URL.createObjectURL(
        new Blob([Uint8Array.from(response.data.bytes).buffer], {
          type: response.data.mimeType,
        }),
      );
      setAudioUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [result?.outputToken]);

  if (!result) {
    return (
      <div
        className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center"
        role="status"
        aria-live="polite"
      >
        <div className="max-w-md space-y-3">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
            {status === "running" || status === "streaming" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Music2 className="h-4 w-4" />
            )}
          </div>
          <div className="text-sm font-medium">
            {t(
              `audio:speech.empty.${
                status === "running" || status === "streaming" ? "running" : "title"
              }`,
            )}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t(
              `audio:speech.empty.${
                status === "running" || status === "streaming"
                  ? "running_description"
                  : "description"
              }`,
            )}
          </div>
          {status === "streaming" ? (
            <StreamStats stats={streamStats} streamText={streamText} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="space-y-3 rounded-lg border bg-background p-4"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {t("audio:speech.result.title")}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span>{t(`audio:speech.response_format.${result.responseFormat}`)}</span>
            {result.model ? <span>{result.model}</span> : null}
            <span>{formatBytes(result.sizeBytes)}</span>
            {result.streamStats?.streamMode ? (
              <span>{t(`audio:speech.stream_mode.${result.streamStats.streamMode}`)}</span>
            ) : null}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onReveal}>
          <FileAudio className="h-3.5 w-3.5" />
          {t("audio:speech.actions.open_output")}
        </Button>
      </div>
      <audio
        controls
        className="w-full"
        src={audioUrl ?? undefined}
      />
      {result.streamStats ? (
        <StreamStats stats={{
          chunkCount: result.streamStats.chunkCount ?? 0,
          totalBytes: result.streamStats.totalBytes ?? result.sizeBytes,
          firstChunkLatencyMs: result.streamStats.firstChunkLatencyMs,
          streamMode: result.streamStats.streamMode,
        }} streamText={streamText} />
      ) : null}
    </div>
  );
}

function StreamStats({
  stats,
  streamText,
}: {
  stats: ReturnType<typeof useSpeechSynthesizerStore.getState>["streamStats"];
  streamText: string;
}) {
  const { t } = useTranslation(["audio"]);
  return (
    <div className="grid gap-2 rounded-md border bg-background/70 p-3 text-left text-xs">
      <div className="grid grid-cols-3 gap-2">
        <Stat label={t("audio:speech.stats.chunks")} value={String(stats.chunkCount)} />
        <Stat label={t("audio:speech.stats.bytes")} value={formatBytes(stats.totalBytes)} />
        <Stat
          label={t("audio:speech.stats.latency")}
          value={
            stats.firstChunkLatencyMs !== undefined
              ? `${stats.firstChunkLatencyMs} ms`
              : "-"
          }
        />
      </div>
      {streamText ? (
        <div className="rounded border bg-muted/30 p-2 text-muted-foreground">
          {streamText}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs">{value}</div>
    </div>
  );
}

function SpeechStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation(["audio"]);
  const tone =
    status === "completed"
      ? "border-emerald-500/25 text-emerald-700 dark:text-emerald-300"
      : status === "failed" || status === "cancelled"
        ? "border-amber-500/25 text-amber-700 dark:text-amber-300"
        : "";
  const Icon =
    status === "running" || status === "streaming"
      ? Loader2
      : status === "completed"
        ? CheckCircle2
        : status === "failed" || status === "cancelled"
          ? AlertTriangle
          : Volume2;
  return (
    <Badge variant="outline" className={cn("gap-1", tone)}>
      <Icon
        className={cn(
          "h-3 w-3",
          (status === "running" || status === "streaming") && "animate-spin",
        )}
      />
      {t(`audio:speech.status.${status}`)}
    </Badge>
  );
}

function useVoiceSampleAuthorization(
  profileId: string | undefined,
): VoiceSampleController {
  const { t } = useTranslation(["audio"]);
  const generationRef = useRef(0);
  const setVoiceSample = useSpeechSynthesizerStore(
    (state) => state.setVoiceSample,
  );
  const setVoiceSampleAuthorizationPending = useSpeechSynthesizerStore(
    (state) => state.setVoiceSampleAuthorizationPending,
  );

  const revokeTokenQuietly = useCallback(async (
    fileToken: string,
    expiresAt?: number,
  ) => {
    await queueAudioInputFileRevocation(fileToken, expiresAt);
  }, []);

  const clear = useCallback(() => {
    generationRef.current += 1;
    const current = useSpeechSynthesizerStore.getState().voiceSample;
    setVoiceSample(null);
    if (current?.fileToken) {
      void revokeTokenQuietly(current.fileToken, current.expiresAt);
    }
  }, [revokeTokenQuietly, setVoiceSample]);

  const selectFiles = useCallback(async (files: FileList) => {
    const file = files[0];
    if (!file) return;
    const validation = validateVoiceSampleFile(file);
    if (!validation.ok) {
      showToast(getVoiceSampleIssueMessage(t, validation.issue), "error");
      return;
    }

    const previous = useSpeechSynthesizerStore.getState().voiceSample;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setVoiceSampleAuthorizationPending(true);

    let response: Awaited<ReturnType<typeof authorizeAudioInputFile>>;
    try {
      response = await authorizeAudioInputFile(file);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setVoiceSampleAuthorizationPending(false);
      showToast(
        error instanceof Error
          ? error.message
          : t("audio:speech.errors.voice_sample_authorization_failed"),
        "error",
      );
      return;
    }

    if (generation !== generationRef.current) {
      if (response.ok) {
        void revokeTokenQuietly(
          response.data.fileToken,
          response.data.expiresAt,
        );
      }
      return;
    }
    if (!response.ok) {
      setVoiceSampleAuthorizationPending(false);
      const message = response.error.code === "file_read_failed"
        ? t("audio:speech.errors.voice_sample_path_unavailable")
        : getAudioErrorMessage(
            t,
            response.error,
            t("audio:speech.errors.voice_sample_authorization_failed"),
          );
      showToast(message, "error");
      return;
    }

    const sample: SelectedVoiceSample = {
      sourceFile: file,
      fileToken: response.data.fileToken,
      fileName: response.data.fileName || file.name,
      mimeType: validation.mimeType,
      sizeBytes: response.data.sizeBytes,
      expiresAt: response.data.expiresAt,
      modifiedAt: file.lastModified,
    };
    setVoiceSample(sample);
    if (
      previous?.fileToken &&
      previous.fileToken !== response.data.fileToken
    ) {
      void revokeTokenQuietly(previous.fileToken, previous.expiresAt);
    }
    showToast(t("audio:speech.messages.voice_sample_selected"), "success");
  }, [
    revokeTokenQuietly,
    setVoiceSample,
    setVoiceSampleAuthorizationPending,
    t,
  ]);

  const ensureAuthorized = useCallback(async () => {
    const current = useSpeechSynthesizerStore.getState().voiceSample;
    if (!current) return null;
    if (
      current.fileToken &&
      (current.expiresAt === undefined || current.expiresAt > Date.now())
    ) {
      return current;
    }
    if (!current.sourceFile) return null;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setVoiceSampleAuthorizationPending(true);
    let response: Awaited<ReturnType<typeof authorizeAudioInputFile>>;
    try {
      response = await authorizeAudioInputFile(current.sourceFile);
    } catch (error) {
      if (generation !== generationRef.current) return null;
      setVoiceSampleAuthorizationPending(false);
      showToast(
        error instanceof Error
          ? error.message
          : t("audio:speech.errors.voice_sample_authorization_failed"),
        "error",
      );
      return null;
    }

    if (generation !== generationRef.current) {
      if (response.ok) {
        void revokeTokenQuietly(
          response.data.fileToken,
          response.data.expiresAt,
        );
      }
      return null;
    }
    const latest = useSpeechSynthesizerStore.getState().voiceSample;
    if (!latest || latest.sourceFile !== current.sourceFile) {
      if (response.ok) {
        void revokeTokenQuietly(
          response.data.fileToken,
          response.data.expiresAt,
        );
      }
      setVoiceSampleAuthorizationPending(false);
      return null;
    }
    if (!response.ok) {
      setVoiceSampleAuthorizationPending(false);
      const message = response.error.code === "file_read_failed"
        ? t("audio:speech.errors.voice_sample_path_unavailable")
        : getAudioErrorMessage(
            t,
            response.error,
            t("audio:speech.errors.voice_sample_authorization_failed"),
          );
      showToast(message, "error");
      return null;
    }

    const authorized: SelectedVoiceSample = {
      ...latest,
      fileToken: response.data.fileToken,
      fileName: response.data.fileName || latest.fileName,
      sizeBytes: response.data.sizeBytes,
      expiresAt: response.data.expiresAt,
    };
    setVoiceSample(authorized);
    if (current.fileToken && current.fileToken !== response.data.fileToken) {
      void revokeTokenQuietly(current.fileToken, current.expiresAt);
    }
    return authorized;
  }, [
    revokeTokenQuietly,
    setVoiceSample,
    setVoiceSampleAuthorizationPending,
    t,
  ]);

  const releaseToken = useCallback(async (
    fileToken: string,
    expiresAt?: number,
  ) => {
    const current = useSpeechSynthesizerStore.getState().voiceSample;
    const tokenExpiresAt = current?.fileToken === fileToken
      ? current.expiresAt
      : expiresAt;
    if (current?.fileToken === fileToken) {
      setVoiceSample({
        ...current,
        fileToken: null,
        expiresAt: undefined,
      });
    }
    await revokeTokenQuietly(fileToken, tokenExpiresAt);
  }, [revokeTokenQuietly, setVoiceSample]);

  useEffect(() => {
    void flushPendingAudioInputFileRevocations();
    return () => {
      generationRef.current += 1;
      const current = useSpeechSynthesizerStore.getState().voiceSample;
      setVoiceSample(null);
      if (current?.fileToken) {
        void revokeTokenQuietly(current.fileToken, current.expiresAt);
      }
    };
  }, [profileId, revokeTokenQuietly, setVoiceSample]);

  return useMemo(
    () => ({ selectFiles, clear, ensureAuthorized, releaseToken }),
    [clear, ensureAuthorized, releaseToken, selectFiles],
  );
}

function focusSpeechModePrimaryField(mode: SpeechSynthesisMode): void {
  const selector = mode === "preset_voice"
    ? "#speech-voice"
    : mode === "voice_design"
      ? "#speech-voice-design-prompt"
      : '[data-testid="speech-field-voice-sample"] button';
  const target = document.querySelector<HTMLElement>(selector) ??
    document.querySelector<HTMLElement>("#speech-input");
  target?.focus();
}

function getVoiceSampleIssueMessage(
  t: (key: string) => string,
  issue: VoiceSampleIssue,
): string {
  return t(`audio:speech.errors.${issue.code}`);
}

function createSpeechRequestId(): string {
  return `speech_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
