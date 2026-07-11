import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  FileAudio,
  Loader2,
  Music2,
  Play,
  Radio,
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
import { getFilePathFromFile } from "@/utils/filePath";
import { showToast } from "@/utils/toast";
import type { SpeechSynthesisStreamHandle } from "@/services/audio/speechSynthesisService";
import {
  cancelSpeechSynthesis,
  revealSpeechOutput,
  readSpeechOutput,
  synthesizeSpeech,
  synthesizeSpeechStream,
} from "@/services/audio/speechSynthesisService";
import type { MimoSpeechSynthesisMode } from "@/type/audio";
import AudioToolShell, {
  type AudioToolShellContext,
} from "../shared/AudioToolShell";
import { Pcm16StreamPlayer } from "../shared/pcm16StreamPlayer";
import { getAudioErrorMessage } from "../shared/audioErrorMessage";
import {
  MIMO_VOICE_PRESETS,
} from "@/store/tools/audio/audioToolConfig";
import {
  MIMO_TTS_MODEL_BY_MODE,
  MIMO_VOICE_SAMPLE_ACCEPT,
  OPENAI_SPEECH_MAX_INPUT_CHARS,
  OPENAI_SPEECH_MAX_INSTRUCTIONS_CHARS,
  buildSpeechSynthesisRequest,
  canStreamSpeechSynthesis,
  clampSpeechSpeed,
  getMimoModeForModel,
  getSpeechSynthesizerResponseFormats,
  isMimoModeCompatibleWithModel,
  normalizeSpeechSynthesizerPreferences,
  validateVoiceSampleFile,
  type SelectedVoiceSample,
  type VoiceSampleIssue,
} from "@/store/tools/audio/speechSynthesizerConfig";
import useSpeechSynthesizerStore from "@/store/tools/audio/useSpeechSynthesizerStore";

const OPENAI_VOICE_HINTS = ["alloy", "ash", "coral", "echo", "fable", "nova", "sage", "shimmer"];
const MIMO_MODES: MimoSpeechSynthesisMode[] = [
  "preset_voice",
  "voice_design",
  "voice_clone",
];

export default function SpeechSynthesizer() {
  return (
    <AudioToolShell
      toolKey="speechSynthesizer"
      assignmentKey="speechSynthesis"
      titleKey="audio:pages.speech.title"
      descriptionKey="audio:pages.speech.description"
      workspaceTitleKey="audio:pages.speech.workspace"
      asideExtra={(context) => <SpeechConfig context={context} />}
    >
      {(context) => <SpeechWorkspace context={context} />}
    </AudioToolShell>
  );
}
function SpeechConfig({ context }: { context: AudioToolShellContext }) {
  const { t } = useTranslation(["audio"]);
  const preferences = useSpeechSynthesizerStore((state) => state.preferences);
  const status = useSpeechSynthesizerStore((state) => state.status);
  const voiceSample = useSpeechSynthesizerStore((state) => state.voiceSample);
  const updatePreferences = useSpeechSynthesizerStore(
    (state) => state.updatePreferences,
  );
  const seedProfileDefaults = useSpeechSynthesizerStore(
    (state) => state.seedProfileDefaults,
  );
  const setVoiceSample = useSpeechSynthesizerStore(
    (state) => state.setVoiceSample,
  );
  const dialect = context.configSummary.audioDialect;
  useEffect(() => {
    if (!context.configSummary.profileId) return;
    seedProfileDefaults(
      context.configSummary.profileId,
      context.configSummary.defaults ?? {},
    );
  }, [
    context.configSummary.defaults,
    context.configSummary.profileId,
    seedProfileDefaults,
  ]);
  const isMimo = dialect === "mimo_chat_audio";
  const streamSupported = canStreamSpeechSynthesis(
    dialect,
    context.configSummary.capabilities,
  );
  const normalized = useMemo(
    () =>
      normalizeSpeechSynthesizerPreferences(
        preferences,
        dialect,
        context.configSummary.capabilities,
      ),
    [context.configSummary.capabilities, dialect, preferences],
  );
  const responseFormats = getSpeechSynthesizerResponseFormats(
    dialect,
    normalized.stream,
  );
  const modeForModel = getMimoModeForModel(context.configSummary.modelKey);
  const isRunning = status === "running" || status === "streaming";

  const handleSelectOutputDir = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.invoke("select-output-directory", {
        title: t("audio:speech.dialog.select_output_title"),
        buttonLabel: t("audio:speech.dialog.select_output_confirm"),
      });
      if (result?.canceled || !result?.filePaths?.[0]) return;
      updatePreferences({
        outputMode: "custom_dir",
        outputDir: result.filePaths[0],
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
  }, [t, updatePreferences]);

  const handleVoiceSample = useCallback(
    (files: FileList) => {
      const file = files[0];
      if (!file) return;
      const filePath = getFilePathFromFile(file);
      if (!filePath) {
        showToast(t("audio:speech.errors.voice_sample_path_unavailable"), "error");
        return;
      }
      const validation = validateVoiceSampleFile(file);
      if (!validation.ok) {
        showToast(getVoiceSampleIssueMessage(t, validation.issue), "error");
        return;
      }
      const sample: SelectedVoiceSample = {
        fileName: file.name,
        filePath,
        mimeType: validation.mimeType,
        sizeBytes: file.size,
        modifiedAt: file.lastModified,
      };
      setVoiceSample(sample);
      showToast(t("audio:speech.messages.voice_sample_selected"), "success");
    },
    [setVoiceSample, t],
  );

  return (
    <fieldset disabled={isRunning} className="min-w-0 space-y-4">
      <legend className="sr-only">{t("audio:pages.speech.config")}</legend>
      <ToolField
        label={t("audio:speech.fields.voice")}
        htmlFor="speech-voice"
        hint={
          isMimo
            ? t("audio:speech.hints.mimo_voice")
            : t("audio:speech.hints.openai_voice")
        }
      >
        <Input
          id="speech-voice"
          value={preferences.voice}
          disabled={isMimo && normalized.mimoMode !== "preset_voice"}
          className="h-8 text-xs"
          placeholder={
            isMimo
              ? t("audio:speech.placeholders.mimo_voice")
              : t("audio:speech.placeholders.openai_voice")
          }
          onChange={(event) =>
            updatePreferences({ voice: event.currentTarget.value })
          }
        />
        {isMimo && normalized.mimoMode === "preset_voice" ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {MIMO_VOICE_PRESETS.map((preset) => (
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
        ) : null}
        {!isMimo ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {OPENAI_VOICE_HINTS.map((voice) => (
              <Button
                key={voice}
                type="button"
                variant={preferences.voice === voice ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-pressed={preferences.voice === voice}
                onClick={() => updatePreferences({ voice })}
              >
                {voice}
              </Button>
            ))}
          </div>
        ) : null}
      </ToolField>

      <ToolField
        label={t("audio:speech.fields.response_format")}
        htmlFor="speech-response-format"
        hint={
          isMimo
            ? t("audio:speech.hints.mimo_format")
            : t("audio:speech.hints.openai_format")
        }
      >
        <Select
          value={normalized.responseFormat}
          onValueChange={(responseFormat) =>
            updatePreferences({
              responseFormat: responseFormat as typeof normalized.responseFormat,
            })
          }
          disabled={isMimo}
        >
          <SelectTrigger id="speech-response-format" size="sm" className="w-full">
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
      </ToolField>

      <ToolField
        label={t("audio:speech.fields.speed")}
        hint={t("audio:speech.hints.speed")}
        htmlFor="speech-speed"
      >
        <Input
          id="speech-speed"
          type="number"
          min={0.25}
          max={4}
          step={0.05}
          disabled={isMimo}
          value={isMimo ? 1 : normalized.speed}
          className="h-8 text-xs"
          onChange={(event) =>
            updatePreferences({
              speed: clampSpeechSpeed(Number(event.currentTarget.value)),
            })
          }
        />
      </ToolField>

      <ToolField
        label={t("audio:speech.fields.stream")}
        hint={
          streamSupported
            ? t("audio:speech.hints.stream")
            : t("audio:speech.hints.stream_disabled")
        }
        action={
          <Switch
            checked={normalized.stream}
            disabled={!streamSupported}
            aria-label={t("audio:speech.fields.stream")}
            onCheckedChange={(stream) => updatePreferences({ stream })}
          />
        }
      >
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {normalized.stream
            ? t("audio:speech.hints.stream_on")
            : t("audio:speech.hints.stream_off")}
        </p>
      </ToolField>

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

      <div className={cn("space-y-4", !isMimo && "opacity-60")}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("audio:speech.mimo.title")}
          </div>
          {!isMimo ? (
            <Badge variant="outline" className="text-[10px]">
              {t("audio:speech.mimo.disabled_badge")}
            </Badge>
          ) : null}
        </div>

        <ToolField
          label={t("audio:speech.fields.mimo_mode")}
          hint={t("audio:speech.hints.mimo_mode")}
        >
          <ButtonGroup
            className="w-full"
            role="radiogroup"
            aria-label={t("audio:speech.fields.mimo_mode")}
          >
            {MIMO_MODES.map((mode) => {
              const compatible = isMimoModeCompatibleWithModel(
                mode,
                context.configSummary.modelKey,
              );
              return (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  className="flex-1"
                  role="radio"
                  aria-checked={preferences.mimoMode === mode}
                  disabled={!isMimo}
                  variant={preferences.mimoMode === mode ? "default" : "outline"}
                  onClick={() => updatePreferences({ mimoMode: mode })}
                  title={
                    compatible || !isMimo
                      ? undefined
                      : t("audio:speech.hints.mimo_model_mismatch", {
                          model: MIMO_TTS_MODEL_BY_MODE[mode],
                        })
                  }
                >
                  {t(`audio:speech.mimo.mode.${mode}`)}
                </Button>
              );
            })}
          </ButtonGroup>
          {isMimo && modeForModel ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("audio:speech.mimo.current_model_mode", {
                mode: t(`audio:speech.mimo.mode.${modeForModel}`),
              })}
            </p>
          ) : null}
        </ToolField>

        <ToolField
          label={t("audio:speech.fields.style_instruction")}
          htmlFor="speech-mimo-style"
        >
          <Textarea
            id="speech-mimo-style"
            disabled={!isMimo}
            rows={2}
            className="resize-none text-xs"
            value={preferences.mimoStyleInstruction}
            placeholder={t("audio:speech.placeholders.style_instruction")}
            onChange={(event) =>
              updatePreferences({
                mimoStyleInstruction: event.currentTarget.value,
              })
            }
          />
        </ToolField>

        <ToolField
          label={t("audio:speech.fields.voice_design_prompt")}
          hint={t("audio:speech.hints.voice_design")}
          htmlFor="speech-voice-design-prompt"
        >
          <Textarea
            id="speech-voice-design-prompt"
            disabled={!isMimo || normalized.mimoMode !== "voice_design"}
            rows={3}
            className="resize-none text-xs"
            value={
              normalized.mimoMode === "voice_design"
                ? preferences.voiceDesignPrompt
                : ""
            }
            placeholder={t("audio:speech.placeholders.voice_design_prompt")}
            onChange={(event) =>
              updatePreferences({
                voiceDesignPrompt: event.currentTarget.value,
              })
            }
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={
                normalized.mimoMode === "voice_design" &&
                preferences.optimizeTextPreview
              }
              disabled={!isMimo || normalized.mimoMode !== "voice_design"}
              onCheckedChange={(checked) =>
                updatePreferences({ optimizeTextPreview: Boolean(checked) })
              }
            />
            {t("audio:speech.fields.optimize_text_preview")}
          </label>
        </ToolField>

        <ToolField
          label={t("audio:speech.fields.voice_sample")}
          hint={t("audio:speech.hints.voice_clone")}
        >
          <ToolFileDropZone
            accept={MIMO_VOICE_SAMPLE_ACCEPT}
            disabled={!isMimo || normalized.mimoMode !== "voice_clone"}
            title={t("audio:speech.voice_sample.title")}
            description={t("audio:speech.voice_sample.description")}
            actionLabel={t("audio:speech.actions.select_voice_sample")}
            onFiles={handleVoiceSample}
            className="px-3 py-3"
          />
          {voiceSample && normalized.mimoMode === "voice_clone" ? (
            <div className="mt-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
              <FileAudio className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{voiceSample.fileName}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setVoiceSample(null)}
                aria-label={t("audio:speech.actions.clear_voice_sample")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </ToolField>

      </div>
    </fieldset>
  );
}

function SpeechWorkspace({ context }: { context: AudioToolShellContext }) {
  const { t } = useTranslation(["audio", "common"]);
  const preferences = useSpeechSynthesizerStore((state) => state.preferences);
  const voiceSample = useSpeechSynthesizerStore((state) => state.voiceSample);
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
  const dialect = context.configSummary.audioDialect;
  const normalized = useMemo(
    () =>
      normalizeSpeechSynthesizerPreferences(
        preferences,
        dialect,
        context.configSummary.capabilities,
      ),
    [context.configSummary.capabilities, dialect, preferences],
  );
  const submitIssue = useMemo(() => {
    const issueKey = resolveSubmitIssueKey(context, normalized, voiceSample);
    return issueKey ? t(issueKey, {
      model: MIMO_TTS_MODEL_BY_MODE[normalized.mimoMode],
    }) : null;
  }, [context, normalized, t, voiceSample]);
  const isRunning = status === "running" || status === "streaming";

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

  const handleStart = useCallback(async () => {
    const issueKey = resolveSubmitIssueKey(context, normalized, voiceSample);
    if (issueKey) {
      const message = t(issueKey, {
        model: MIMO_TTS_MODEL_BY_MODE[normalized.mimoMode],
      });
      showToast(message, "error");
      setLastError({ code: "renderer_error", message });
      return;
    }

    const requestId = createSpeechRequestId();
    const request = buildSpeechSynthesisRequest({
      requestId,
      preferences: normalized,
      dialect,
      capabilities: context.configSummary.capabilities,
      voiceSample,
    });

    if (normalized.stream) {
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
  }, [
    appendStreamText,
    beginTask,
    cleanupStreamResources,
    context,
    dialect,
    normalized,
    setActiveRequest,
    setLastError,
    setResult,
    setStatus,
    t,
    updateStreamStats,
    voiceSample,
  ]);

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

  return (
    <ToolPanel
      icon={Volume2}
      title={t("audio:pages.speech.workspace")}
      badge={<SpeechStatusBadge status={status} />}
      bodyClassName="p-5"
    >
      <div className="space-y-4">
        {context.configSummary.status !== "ready" ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              {t(`audio:workspace.${context.configSummary.status}.title`)}
            </AlertTitle>
            <AlertDescription>
              {t(`audio:workspace.${context.configSummary.status}.description`)}
            </AlertDescription>
          </Alert>
        ) : null}

        <ToolField
          label={t("audio:speech.fields.input")}
          htmlFor="speech-input"
          required={!(
            dialect === "mimo_chat_audio" &&
            normalized.mimoMode === "voice_design" &&
            normalized.optimizeTextPreview
          )}
          hint={t("audio:speech.hints.input")}
        >
          <Textarea
            id="speech-input"
            value={preferences.input}
            maxLength={
              dialect === "openai_audio"
                ? OPENAI_SPEECH_MAX_INPUT_CHARS
                : undefined
            }
            disabled={isRunning}
            rows={8}
            className="min-h-[180px] resize-y text-sm leading-relaxed"
            placeholder={t("audio:speech.placeholders.input")}
            onChange={(event) =>
              updatePreferences({ input: event.currentTarget.value })
            }
          />
        </ToolField>

        <ToolField
          label={t("audio:speech.fields.instructions")}
          htmlFor="speech-instructions"
        >
          <Textarea
            id="speech-instructions"
            value={preferences.instructions}
            maxLength={OPENAI_SPEECH_MAX_INSTRUCTIONS_CHARS}
            disabled={isRunning || dialect === "mimo_chat_audio"}
            rows={3}
            className="resize-y text-xs"
            placeholder={
              dialect === "mimo_chat_audio"
                ? t("audio:speech.placeholders.instructions_mimo_disabled")
                : t("audio:speech.placeholders.instructions")
            }
            onChange={(event) =>
              updatePreferences({ instructions: event.currentTarget.value })
            }
          />
        </ToolField>

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
            type="button"
            disabled={Boolean(submitIssue) || isRunning}
            onClick={handleStart}
            className="gap-1.5"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : normalized.stream ? (
              <Radio className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isRunning
              ? t("audio:speech.actions.running")
              : normalized.stream
                ? t("audio:speech.actions.start_stream")
                : t("audio:speech.actions.start")}
          </Button>
          <Button
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
      <div className="truncate font-mono text-[11px] text-muted-foreground">
        {result.outputPath}
      </div>
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

function resolveSubmitIssueKey(
  context: AudioToolShellContext,
  preferences: ReturnType<typeof normalizeSpeechSynthesizerPreferences>,
  voiceSample: SelectedVoiceSample | null,
): string | null {
  if (context.configSummary.status !== "ready") {
    return `audio:workspace.${context.configSummary.status}.title`;
  }
  const isMimo = context.configSummary.audioDialect === "mimo_chat_audio";
  if (
    !preferences.input.trim() &&
    !(isMimo && preferences.mimoMode === "voice_design" && preferences.optimizeTextPreview)
  ) {
    return "audio:speech.errors.no_input";
  }
  if (!isMimo && !preferences.voice.trim()) {
    return "audio:speech.errors.no_voice";
  }
  if (
    !isMimo &&
    preferences.input.length > OPENAI_SPEECH_MAX_INPUT_CHARS
  ) {
    return "audio:speech.errors.input_too_long";
  }
  if (
    !isMimo &&
    preferences.instructions.length > OPENAI_SPEECH_MAX_INSTRUCTIONS_CHARS
  ) {
    return "audio:speech.errors.instructions_too_long";
  }
  if (preferences.outputMode === "custom_dir" && !preferences.outputDir.trim()) {
    return "audio:speech.errors.output_dir_required";
  }
  if (isMimo) {
    if (
      !isMimoModeCompatibleWithModel(
        preferences.mimoMode,
        context.configSummary.modelKey,
      )
    ) {
      return "audio:speech.errors.mimo_model_mismatch";
    }
    if (
      preferences.mimoMode === "voice_design" &&
      !preferences.voiceDesignPrompt.trim()
    ) {
      return "audio:speech.errors.voice_design_prompt_required";
    }
    if (preferences.mimoMode === "voice_clone" && !voiceSample) {
      return "audio:speech.errors.voice_sample_required";
    }
  }
  return null;
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
