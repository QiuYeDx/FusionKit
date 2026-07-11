import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Clipboard,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Radio,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToolField, ToolPanel } from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { showToast } from "@/utils/toast";
import type { AudioRole } from "@/type/audio";
import type { AudioIpcError, AudioRealtimeSessionEvent } from "@/type/audioIpc";
import {
  cancelRecordedAudioChunkTranscription,
  startOpenAIRealtimeWebRtcSession,
  transcribeRecordedAudioChunk,
  type AudioRealtimeSessionHandle,
} from "@/services/audio/audioRealtimeService";
import AudioToolShell, {
  type AudioToolShellContext,
} from "../shared/AudioToolShell";
import {
  REALTIME_CAPTIONS_LANGUAGES,
  REALTIME_CAPTIONS_OUTPUT_FORMATS,
  buildRealtimeCaptionsSessionConfig,
  canStartOpenAIRealtimeCaptions,
  createRealtimeCaptionLine,
  formatRealtimeCaptionLines,
  getRealtimeSessionCloseStatus,
  normalizeRealtimeCaptionsPreferences,
  resolveRealtimeCaptionsMode,
  type RealtimeCaptionsMode,
} from "@/store/tools/audio/realtimeCaptionsConfig";
import useRealtimeCaptionsStore, {
  type RealtimeCaptionsUiError,
} from "@/store/tools/audio/useRealtimeCaptionsStore";
import { BoundedAsyncQueue } from "../shared/boundedAsyncQueue";
import { WavChunkRecorder } from "../shared/wavChunkRecorder";
import { useElapsedMs } from "../shared/useElapsedMs";
import { saveAudioTextOutput } from "@/services/audio/audioTranscriptionService";
import { getAudioErrorMessage } from "../shared/audioErrorMessage";

const CHUNK_QUEUE_MAX_PENDING_ITEMS = 4;
const CHUNK_QUEUE_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const CHUNK_QUEUE_MAX_AGE_MS = 30_000;

export default function RealtimeCaptions() {
  return (
    <AudioToolShell
      toolKey="realtimeCaptions"
      assignmentKey="realtimeCaptions"
      titleKey="audio:pages.captions.title"
      descriptionKey="audio:pages.captions.description"
      workspaceTitleKey="audio:pages.captions.workspace"
      asideExtra={(context) => <RealtimeCaptionsConfig context={context} />}
    >
      {(context) => <RealtimeCaptionsWorkspace context={context} />}
    </AudioToolShell>
  );
}

function RealtimeCaptionsConfig({
  context,
}: {
  context: AudioToolShellContext;
}) {
  const { t } = useTranslation(["audio"]);
  const preferences = useRealtimeCaptionsStore((state) => state.preferences);
  const status = useRealtimeCaptionsStore((state) => state.status);
  const updatePreferences = useRealtimeCaptionsStore(
    (state) => state.updatePreferences,
  );
  const mode = resolveRealtimeCaptionsMode(
    context.configSummary.audioDialect,
    context.configSummary.capabilities,
  );
  const normalized = useMemo(
    () =>
      normalizeRealtimeCaptionsPreferences(
        preferences,
        context.configSummary.audioDialect,
      ),
    [context.configSummary.audioDialect, preferences],
  );
  const isOpenAIRealtime = mode === "openai_realtime";
  const configLocked = ["requesting", "connecting", "listening", "stopping"].includes(status);

  return (
    <fieldset className="space-y-4" disabled={configLocked}>
      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {t("audio:captions.fields.mode")}
        </span>
        <Badge variant="outline" className={resolveModeBadgeClass(mode)}>
          {t(`audio:captions.mode.${mode}`)}
        </Badge>
      </div>

      <ToolField
        label={t("audio:captions.fields.language")}
        htmlFor="captions-language"
        hint={t("audio:captions.hints.language")}
      >
        <Select
          value={normalized.language}
          onValueChange={(language) =>
            updatePreferences({ language: language as typeof normalized.language })
          }
        >
          <SelectTrigger id="captions-language" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REALTIME_CAPTIONS_LANGUAGES.map((language) => (
              <SelectItem key={language} value={language}>
                {t(`audio:captions.languages.${language}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>

      <ToolField
        label={t("audio:captions.fields.input_audio_format")}
        hint={t("audio:captions.hints.input_audio_format")}
      >
        <ButtonGroup className="w-full" role="radiogroup" aria-label={t("audio:captions.fields.input_audio_format")}>
          {(["pcm16", "pcmu", "pcma"] as const).map((format) => (
            <Button
              key={format}
              type="button"
              role="radio"
              aria-checked={normalized.inputAudioFormat === format}
              size="sm"
              className="flex-1"
              disabled={!isOpenAIRealtime}
              variant={normalized.inputAudioFormat === format ? "default" : "outline"}
              onClick={() => updatePreferences({ inputAudioFormat: format })}
            >
              {t(`audio:captions.input_audio_format.${format}`)}
            </Button>
          ))}
        </ButtonGroup>
      </ToolField>

      <ToolField
        label={t("audio:captions.fields.turn_detection")}
        hint={t("audio:captions.hints.turn_detection")}
      >
        <ButtonGroup className="w-full" role="radiogroup" aria-label={t("audio:captions.fields.turn_detection")}>
          {(["server_vad", "manual"] as const).map((turnDetection) => (
            <Button
              key={turnDetection}
              type="button"
              role="radio"
              aria-checked={normalized.turnDetection === turnDetection}
              size="sm"
              className="flex-1"
              disabled={!isOpenAIRealtime || turnDetection === "manual"}
              variant={normalized.turnDetection === turnDetection ? "default" : "outline"}
              onClick={() => updatePreferences({ turnDetection })}
            >
              {t(`audio:captions.turn_detection.${turnDetection}`)}
            </Button>
          ))}
        </ButtonGroup>
      </ToolField>

      <ToolField
        label={t("audio:captions.fields.output_format")}
        htmlFor="captions-output-format"
        hint={t("audio:captions.hints.output_format")}
      >
        <Select
          value={preferences.outputFormat}
          onValueChange={(outputFormat) =>
            updatePreferences({
              outputFormat: outputFormat as typeof preferences.outputFormat,
            })
          }
        >
          <SelectTrigger id="captions-output-format" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REALTIME_CAPTIONS_OUTPUT_FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {t(`audio:captions.output_format.${format}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>

      <ToolField
        label={t("audio:captions.fields.assistant_transcript")}
        hint={t("audio:captions.hints.assistant_transcript")}
        action={
          <Switch
            checked={normalized.showAssistantTranscript}
            disabled
            aria-label={t("audio:captions.fields.assistant_transcript")}
            onCheckedChange={(checked) =>
              updatePreferences({ showAssistantTranscript: Boolean(checked) })
            }
          />
        }
      >
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("audio:captions.hints.assistant_transcript_detail")}
        </p>
      </ToolField>

      <ToolField
        label={t("audio:captions.fields.instructions")}
        htmlFor="captions-instructions"
        hint={t("audio:captions.hints.instructions")}
      >
        <Textarea
          id="captions-instructions"
          value=""
          disabled
          rows={3}
          className="resize-none text-xs"
          placeholder={
            isOpenAIRealtime
              ? t("audio:captions.placeholders.instructions")
              : t("audio:captions.placeholders.instructions_disabled")
          }
          onChange={(event) =>
            updatePreferences({ instructions: event.currentTarget.value })
          }
        />
      </ToolField>
    </fieldset>
  );
}

function RealtimeCaptionsWorkspace({
  context,
}: {
  context: AudioToolShellContext;
}) {
  const { t } = useTranslation(["audio"]);
  const sessionHandleRef = useRef<AudioRealtimeSessionHandle | null>(null);
  const chunkRecorderRef = useRef<WavChunkRecorder | null>(null);
  const chunkQueueRef = useRef<BoundedAsyncQueue | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionGenerationRef = useRef(0);
  const [paused, setPaused] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const partialStartedAtRef = useRef<Record<string, number>>({});
  const preferences = useRealtimeCaptionsStore((state) => state.preferences);
  const status = useRealtimeCaptionsStore((state) => state.status);
  const micState = useRealtimeCaptionsStore((state) => state.micState);
  const sessionId = useRealtimeCaptionsStore((state) => state.sessionId);
  const startedAtMs = useRealtimeCaptionsStore((state) => state.startedAtMs);
  const lines = useRealtimeCaptionsStore((state) => state.lines);
  const partial = useRealtimeCaptionsStore((state) => state.partial);
  const lastError = useRealtimeCaptionsStore((state) => state.lastError);
  const setStatus = useRealtimeCaptionsStore((state) => state.setStatus);
  const setMicState = useRealtimeCaptionsStore((state) => state.setMicState);
  const setSessionId = useRealtimeCaptionsStore((state) => state.setSessionId);
  const setStartedAtMs = useRealtimeCaptionsStore((state) => state.setStartedAtMs);
  const setLastError = useRealtimeCaptionsStore((state) => state.setLastError);
  const setPartial = useRealtimeCaptionsStore((state) => state.setPartial);
  const clearPartial = useRealtimeCaptionsStore((state) => state.clearPartial);
  const addLine = useRealtimeCaptionsStore((state) => state.addLine);
  const clearTranscript = useRealtimeCaptionsStore((state) => state.clearTranscript);
  const resetSessionState = useRealtimeCaptionsStore(
    (state) => state.resetSessionState,
  );
  const seedProfileDefaults = useRealtimeCaptionsStore(
    (state) => state.seedProfileDefaults,
  );
  const mode = resolveRealtimeCaptionsMode(
    context.configSummary.audioDialect,
    context.configSummary.capabilities,
  );
  const canStartOpenAI =
    context.configSummary.status === "ready" &&
    canStartOpenAIRealtimeCaptions(
      context.configSummary.audioDialect,
      context.configSummary.capabilities,
    );
  const canStartChunked =
    context.configSummary.status === "ready" &&
    mode === "chunked_near_realtime";
  const canStart = canStartOpenAI || canStartChunked;
  const isRunning = ["requesting", "connecting", "listening", "stopping"].includes(
    status,
  );
  const canStop = isRunning || status === "failed";
  const displayLines = lines.filter((line) => line.role === "user");
  const visibleLines = displayLines.slice(-300);
  const elapsedMs = useElapsedMs(startedAtMs, isRunning);

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

  const releaseOwnedResources = useCallback(async (
    reason: "user" | "error" | "page_unload",
    options: { flushFinalChunk?: boolean } = {},
  ) => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const recorder = chunkRecorderRef.current;
    const queue = chunkQueueRef.current;
    const handle = sessionHandleRef.current;
    chunkRecorderRef.current = null;
    chunkQueueRef.current = null;
    sessionHandleRef.current = null;

    const flushFinalChunk = options.flushFinalChunk ?? false;
    if (!flushFinalChunk) {
      await queue?.abort();
    }
    try {
      await recorder?.stop({ flushFinalChunk });
    } catch {
      // Recorder teardown still releases tracks in finally.
    }
    if (flushFinalChunk) {
      await queue?.seal();
    }
    if (handle && !handle.closed) {
      await handle.stop(reason);
    }
  }, []);

  const failSession = useCallback((
    error: RealtimeCaptionsUiError,
    generation: number,
  ) => {
    if (sessionGenerationRef.current !== generation) return;
    sessionGenerationRef.current += 1;
    setLastError(error);
    setStatus("failed");
    setMicState(error.code === "microphone_permission_denied" ? "denied" : "idle");
    setSessionId(null);
    void releaseOwnedResources("error");
  }, [
    releaseOwnedResources,
    setLastError,
    setMicState,
    setSessionId,
    setStatus,
  ]);

  useEffect(() => {
    return () => {
      sessionGenerationRef.current += 1;
      void releaseOwnedResources("page_unload");
      useRealtimeCaptionsStore.getState().resetSessionState();
    };
  }, [releaseOwnedResources]);

  const getElapsedMs = useCallback(() => {
    const state = useRealtimeCaptionsStore.getState();
    return Math.max(0, Date.now() - (state.startedAtMs ?? Date.now()));
  }, []);

  const handleStart = useCallback(async () => {
    if (!canStart) {
      setLastError({
        code: "renderer_error",
        message:
          mode === "chunked_near_realtime"
            ? t("audio:captions.errors.chunked_unavailable")
            : t("audio:captions.errors.unsupported_mode"),
      });
      setStatus("failed");
      return;
    }

    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    await releaseOwnedResources("user");
    if (sessionGenerationRef.current !== generation) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    resetSessionState();
    setPaused(false);
    setInputLevel(0);
    clearPartial();
    partialStartedAtRef.current = {};
    setStatus("requesting");
    setMicState("requesting");
    setStartedAtMs(Date.now());
    setLastError(null);

    const normalized = normalizeRealtimeCaptionsPreferences(
      preferences,
      context.configSummary.audioDialect,
    );
    if (mode === "chunked_near_realtime") {
      const queue = new BoundedAsyncQueue({
        maxPendingItems: CHUNK_QUEUE_MAX_PENDING_ITEMS,
        maxPendingBytes: CHUNK_QUEUE_MAX_PENDING_BYTES,
        maxQueueAgeMs: CHUNK_QUEUE_MAX_AGE_MS,
        onDrop: (_task, reason) => {
          if (reason === "stopped") return;
          failSession({
            code: "renderer_error",
            message: `Realtime caption chunk queue stopped (${reason}).`,
          }, generation);
        },
        onTaskError: (_task, error) => {
          failSession(toRealtimeCaptionsFailure(error), generation);
        },
      });
      const recorder = new WavChunkRecorder({
        chunkDurationMs: 5000,
        onVolume: setInputLevel,
        onChunk: (chunk) => {
          if (sessionGenerationRef.current !== generation) return;
          queue.enqueue({
            id: chunk.requestId,
            sizeBytes: chunk.bytes.byteLength,
            run: async (signal) => {
              if (signal.aborted || sessionGenerationRef.current !== generation) {
                return;
              }
              const result = await transcribeRecordedAudioChunk({
                assignmentKey: "realtimeCaptions",
                requestId: chunk.requestId,
                audioBytes: chunk.bytes,
                mimeType: "audio/wav",
                responseFormat: "text",
                ...(normalized.language !== "auto"
                  ? { language: normalized.language }
                  : {}),
                startedAtMs: chunk.startedAtMs,
                endedAtMs: chunk.endedAtMs,
              });
              if (signal.aborted || sessionGenerationRef.current !== generation) {
                return;
              }
              if (!result.ok) {
                if (result.error.code === "aborted") return;
                throw result.error;
              }
              const text = result.data.text.trim();
              if (!text) return;
              addLine(
                createRealtimeCaptionLine({
                  id: result.data.requestId,
                  role: "user",
                  text,
                  startedAtMs: result.data.startedAtMs ?? chunk.startedAtMs,
                  endedAtMs: result.data.endedAtMs ?? chunk.endedAtMs,
                }),
              );
            },
            cancel: async () => {
              await cancelRecordedAudioChunkTranscription(chunk.requestId);
            },
          });
        },
        onError: (error) => {
          failSession({
            code: "renderer_error",
            message: error.message,
          }, generation);
        },
      });

      try {
        chunkQueueRef.current = queue;
        chunkRecorderRef.current = recorder;
        await recorder.start();
        if (
          sessionGenerationRef.current !== generation
          || controller.signal.aborted
        ) {
          await recorder.stop({ flushFinalChunk: false });
          await queue.abort();
          return;
        }
        abortControllerRef.current = null;
        setMicState("granted");
        setStatus("listening");
      } catch (error) {
        await recorder.stop({ flushFinalChunk: false }).catch(() => undefined);
        await queue.abort();
        if (sessionGenerationRef.current !== generation) return;
        failSession({
          code: isMicrophonePermissionError(error)
            ? "microphone_permission_denied"
            : "renderer_error",
          message: error instanceof Error
            ? error.message
            : t("audio:captions.errors.microphone_failed"),
        }, generation);
      }
      return;
    }

    const request = buildRealtimeCaptionsSessionConfig(
      normalized,
      context.configSummary.audioDialect,
    );
    setStatus("connecting");

    const result = await startOpenAIRealtimeWebRtcSession(request, {
      signal: controller.signal,
      onInputLevel: setInputLevel,
      handlers: {
        sessionStarted: (event) => {
          if (sessionGenerationRef.current !== generation) return;
          setSessionId(event.sessionId);
          setStatus("listening");
        },
        micState: (event) => {
          if (sessionGenerationRef.current !== generation) return;
          setMicState(event.state);
        },
        transcriptDelta: (event) => {
          if (sessionGenerationRef.current !== generation) return;
          if (event.role === "assistant" && !normalized.showAssistantTranscript) {
            return;
          }
          const partialKey = getRealtimePartialKey(event);
          const elapsed = getElapsedMs();
          if (partialStartedAtRef.current[partialKey] === undefined) {
            partialStartedAtRef.current[partialKey] = elapsed;
          }
          const current =
            useRealtimeCaptionsStore.getState().partial[partialKey]?.text ?? "";
          setPartial(partialKey, event.role, `${current}${event.text}`);
        },
        transcriptFinal: (event) => {
          if (sessionGenerationRef.current !== generation) return;
          if (event.role === "assistant" && !normalized.showAssistantTranscript) {
            clearPartial(getRealtimePartialKey(event));
            return;
          }
          const endedAtMs = getElapsedMs();
          const partialKey = getRealtimePartialKey(event);
          const startedAtMsForLine =
            partialStartedAtRef.current[partialKey] ?? Math.max(0, endedAtMs - 1000);
          addLine(
            createRealtimeCaptionLine({
              id: event.itemId,
              role: event.role,
              text: event.text,
              startedAtMs: startedAtMsForLine,
              endedAtMs,
            }),
          );
          delete partialStartedAtRef.current[partialKey];
          clearPartial(partialKey);
        },
        error: (event) => {
          if (event.fatal) {
            failSession(toRealtimeCaptionsUiError(event.error), generation);
          } else if (sessionGenerationRef.current === generation) {
            setLastError(toRealtimeCaptionsUiError(event.error));
          }
        },
        sessionClosed: (event) => {
          if (sessionGenerationRef.current !== generation) return;
          sessionHandleRef.current = null;
          abortControllerRef.current = null;
          setStatus(getRealtimeSessionCloseStatus(event.reason));
          setMicState("idle");
          setSessionId(null);
        },
      },
    });

    if (
      sessionGenerationRef.current !== generation
      || controller.signal.aborted
    ) {
      if (result.ok && !result.data.closed) {
        await result.data.stop("page_unload");
      }
      return;
    }
    abortControllerRef.current = null;
    if (!result.ok) {
      if (result.error.code !== "aborted") {
        failSession(toRealtimeCaptionsUiError(result.error), generation);
      }
      return;
    }

    sessionHandleRef.current = result.data;
    setSessionId(result.data.sessionId ?? null);
    setStatus("listening");
  }, [
    addLine,
    canStart,
    clearPartial,
    context.configSummary.audioDialect,
    failSession,
    getElapsedMs,
    mode,
    preferences,
    releaseOwnedResources,
    resetSessionState,
    setLastError,
    setMicState,
    setPartial,
    setSessionId,
    setStartedAtMs,
    setStatus,
    t,
  ]);

  const handleStop = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const flushFinalChunk = Boolean(chunkRecorderRef.current);
    if (!flushFinalChunk) {
      sessionGenerationRef.current += 1;
    }
    setStatus("stopping");
    await releaseOwnedResources("user", { flushFinalChunk });
    if (flushFinalChunk) {
      if (sessionGenerationRef.current !== generation) return;
      sessionGenerationRef.current += 1;
    }
    setStatus("completed");
    setMicState("idle");
    setSessionId(null);
  }, [releaseOwnedResources, setMicState, setSessionId, setStatus]);

  const handlePause = useCallback(() => {
    const nextPaused = !paused;
    chunkRecorderRef.current?.setPaused(nextPaused);
    sessionHandleRef.current?.setMuted(nextPaused);
    setPaused(nextPaused);
    setMicState(nextPaused ? "muted" : "granted");
  }, [paused, setMicState]);

  const transcriptText = useMemo(
    () => formatRealtimeCaptionLines(
      [
        ...displayLines,
        ...Object.entries(partial)
          .filter(([, value]) => value.role === "user" && value.text.trim())
          .map(([key, value]) => ({
            id: `partial-${key}`,
            role: value.role,
            text: value.text,
            startedAtMs: partialStartedAtRef.current[key] ?? elapsedMs,
            endedAtMs: elapsedMs,
          })),
      ],
      preferences.outputFormat,
    ),
    [displayLines, elapsedMs, partial, preferences.outputFormat],
  );

  const handleCopy = useCallback(async () => {
    if (!transcriptText.trim()) {
      showToast(t("audio:captions.errors.no_transcript"), "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(transcriptText);
      showToast(t("audio:captions.messages.copied"), "success");
    } catch {
      showToast(t("audio:captions.errors.copy_failed"), "error");
    }
  }, [t, transcriptText]);

  const handleSave = useCallback(async () => {
    if (!transcriptText.trim()) {
      showToast(t("audio:captions.errors.no_transcript"), "error");
      return;
    }
    const extension = preferences.outputFormat;
    const response = await saveAudioTextOutput({
      defaultName: `fusionkit-realtime-captions-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.${extension}`,
      content: transcriptText,
      extension,
    });
    if (!response.ok) {
      showToast(response.error.message, "error");
    } else if (response.data.saved) {
      showToast(t("audio:captions.messages.saved"), "success");
    }
  }, [preferences.outputFormat, t, transcriptText]);

  return (
    <ToolPanel
      icon={Captions}
      title={t("audio:pages.captions.workspace")}
      badge={
        <Badge variant="outline" className={resolveStatusBadgeClass(status)}>
          {t(`audio:captions.status.${status}`)}
        </Badge>
      }
      bodyClassName="space-y-4 p-4"
    >
      <div className="grid gap-3 md:grid-cols-5">
        <CaptionStat
          label={t("audio:captions.stats.mode")}
          value={t(`audio:captions.mode.${mode}`)}
        />
        <CaptionStat
          label={t("audio:captions.stats.mic")}
          value={t(`audio:captions.mic_state.${micState}`)}
        />
        <CaptionStat
          label={t("audio:captions.stats.lines")}
          value={String(displayLines.length)}
        />
        <CaptionStat
          label={t("audio:captions.stats.elapsed")}
          value={formatDuration(elapsedMs)}
        />
        <CaptionStat
          label={t("audio:captions.stats.session")}
          value={sessionId ?? "-"}
        />
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={t("audio:captions.stats.input_level")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(inputLevel * 100)}
      >
        <div
          className="h-full bg-emerald-500 transition-[width] duration-100"
          style={{ width: `${Math.round(inputLevel * 100)}%` }}
        />
      </div>

      {mode === "chunked_near_realtime" ? (
        <Alert className="border-sky-500/30 bg-sky-500/5">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("audio:captions.chunked.title")}</AlertTitle>
          <AlertDescription>
            {t("audio:captions.chunked.description")}
          </AlertDescription>
        </Alert>
      ) : null}

      {lastError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("audio:captions.errors.title")}</AlertTitle>
          <AlertDescription>
            {getAudioErrorMessage(t, lastError, lastError.message)}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="gap-2"
          disabled={isRunning || !canStart}
          onClick={handleStart}
        >
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
          {isRunning
            ? t("audio:captions.actions.listening")
            : t("audio:captions.actions.start")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!canStop}
          onClick={handleStop}
        >
          <Square className="h-4 w-4" />
          {t("audio:captions.actions.stop")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!isRunning || status === "stopping"}
          onClick={handlePause}
          aria-pressed={paused}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {t(`audio:captions.actions.${paused ? "resume" : "pause"}`)}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!transcriptText.trim()}
          onClick={handleCopy}
        >
          <Clipboard className="h-4 w-4" />
          {t("audio:captions.actions.copy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!transcriptText.trim()}
          onClick={handleSave}
        >
          <Save className="h-4 w-4" />
          {t("audio:captions.actions.save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="gap-2"
          disabled={displayLines.length === 0 && Object.keys(partial).length === 0}
          onClick={clearTranscript}
        >
          <Trash2 className="h-4 w-4" />
          {t("audio:captions.actions.clear")}
        </Button>
      </div>

      <TranscriptStream
        lines={visibleLines}
        partial={partial}
        showAssistant={false}
        isRunning={isRunning}
      />
    </ToolPanel>
  );
}

function TranscriptStream({
  lines,
  partial,
  showAssistant,
  isRunning,
}: {
  lines: ReturnType<typeof useRealtimeCaptionsStore.getState>["lines"];
  partial: ReturnType<typeof useRealtimeCaptionsStore.getState>["partial"];
  showAssistant: boolean;
  isRunning: boolean;
}) {
  const { t } = useTranslation(["audio"]);
  const partialEntries = Object.entries(partial)
    .filter(([, value]) => value.text && (showAssistant || value.role === "user"));

  if (lines.length === 0 && partialEntries.length === 0) {
    return (
      <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
        <div className="max-w-md space-y-3">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
            {isRunning ? (
              <Radio className="h-4 w-4 animate-pulse" />
            ) : (
              <MicOff className="h-4 w-4" />
            )}
          </div>
          <div className="text-sm font-medium">
            {isRunning
              ? t("audio:captions.empty.running")
              : t("audio:captions.empty.title")}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {isRunning
              ? t("audio:captions.empty.running_description")
              : t("audio:captions.empty.description")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-[280px] space-y-3 rounded-lg border bg-background p-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {lines.map((line) => (
        <TranscriptLine
          key={line.id}
          role={line.role}
          text={line.text}
          startedAtMs={line.startedAtMs}
          endedAtMs={line.endedAtMs}
          final
        />
      ))}
      {partialEntries.map(([key, value]) => (
        <TranscriptLine key={key} role={value.role} text={value.text} />
      ))}
    </div>
  );
}

function TranscriptLine({
  role,
  text,
  final,
  startedAtMs,
  endedAtMs,
}: {
  role: AudioRole;
  text: string;
  final?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
}) {
  const { t } = useTranslation(["audio"]);
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm leading-relaxed",
        final ? "bg-card" : "border-dashed bg-muted/30 text-muted-foreground",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase text-muted-foreground">
        {final ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {t(`audio:captions.role.${role}`)}
        {startedAtMs !== undefined && endedAtMs !== undefined ? (
          <span className="font-mono font-normal normal-case">
            {formatDuration(startedAtMs)}–{formatDuration(endedAtMs)}
          </span>
        ) : null}
      </div>
      <div>{text}</div>
    </div>
  );
}

function CaptionStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/10 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function resolveModeBadgeClass(mode: RealtimeCaptionsMode): string {
  if (mode === "openai_realtime") {
    return "border-emerald-500/25 text-emerald-700 dark:text-emerald-300";
  }
  if (mode === "chunked_near_realtime") {
    return "border-amber-500/25 text-amber-700 dark:text-amber-300";
  }
  return "border-muted-foreground/25 text-muted-foreground";
}

function resolveStatusBadgeClass(status: string): string {
  if (status === "listening") {
    return "gap-1 border-emerald-500/25 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "failed") {
    return "gap-1 border-destructive/25 text-destructive";
  }
  return "gap-1 border-muted-foreground/25 text-muted-foreground";
}

function toRealtimeCaptionsUiError(error: AudioIpcError) {
  return {
    code: error.code,
    message: error.message,
    field: error.field,
    details: error.details,
  };
}

function getRealtimePartialKey(
  event: Extract<
    AudioRealtimeSessionEvent,
    { type: "transcript_delta" | "transcript_final" }
  >,
): string {
  return event.itemId ?? [
    event.role,
    event.responseId ?? "input",
    event.outputIndex ?? 0,
    event.contentIndex ?? 0,
  ].join(":");
}

function toRealtimeCaptionsFailure(error: unknown): RealtimeCaptionsUiError {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error
    && typeof error.code === "string"
    && typeof error.message === "string"
  ) {
    return error as RealtimeCaptionsUiError;
  }
  return {
    code: "renderer_error",
    message: error instanceof Error
      ? error.message
      : "Realtime caption chunk processing failed.",
  };
}

function isMicrophonePermissionError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "NotAllowedError" || error.name === "SecurityError"
    : error instanceof Error
      && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
}
