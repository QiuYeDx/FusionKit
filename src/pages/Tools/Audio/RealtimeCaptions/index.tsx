import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Clipboard,
  Loader2,
  Mic,
  MicOff,
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
import type { AudioIpcError } from "@/type/audioIpc";
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
import useRealtimeCaptionsStore from "@/store/tools/audio/useRealtimeCaptionsStore";
import {
  WavChunkRecorder,
  type RecordedWavChunk,
} from "../shared/wavChunkRecorder";

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

  return (
    <div className="space-y-4">
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
        hint={t("audio:captions.hints.language")}
      >
        <Select
          value={normalized.language}
          onValueChange={(language) =>
            updatePreferences({ language: language as typeof normalized.language })
          }
        >
          <SelectTrigger size="sm" className="w-full">
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
        <ButtonGroup className="w-full">
          {(["pcm16", "opus"] as const).map((format) => (
            <Button
              key={format}
              type="button"
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
        <ButtonGroup className="w-full">
          {(["server_vad", "manual"] as const).map((turnDetection) => (
            <Button
              key={turnDetection}
              type="button"
              size="sm"
              className="flex-1"
              disabled={!isOpenAIRealtime}
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
          <SelectTrigger size="sm" className="w-full">
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
            disabled={!isOpenAIRealtime}
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
        hint={t("audio:captions.hints.instructions")}
      >
        <Textarea
          value={isOpenAIRealtime ? preferences.instructions : ""}
          disabled={!isOpenAIRealtime}
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
    </div>
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
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeChunkRequestIdsRef = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const partialStartedAtRef = useRef<Partial<Record<AudioRole, number>>>({});
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
  const displayLines = preferences.showAssistantTranscript
    ? lines
    : lines.filter((line) => line.role === "user");
  const elapsedMs = startedAtMs ? Date.now() - startedAtMs : 0;

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      void chunkRecorderRef.current?.stop();
      chunkRecorderRef.current = null;
      for (const requestId of activeChunkRequestIdsRef.current) {
        void cancelRecordedAudioChunkTranscription(requestId);
      }
      activeChunkRequestIdsRef.current.clear();
      const handle = sessionHandleRef.current;
      sessionHandleRef.current = null;
      if (handle && !handle.closed) {
        void handle.stop("page_unload");
      }
    };
  }, []);

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

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    resetSessionState();
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
      chunkQueueRef.current = Promise.resolve();
      const recorder = new WavChunkRecorder({
        chunkDurationMs: 5000,
        onChunk: (chunk) => {
          queueRecordedChunkTranscription({
            chunk,
            language: normalized.language,
            activeChunkRequestIds: activeChunkRequestIdsRef.current,
            enqueue: (task) => {
              chunkQueueRef.current = chunkQueueRef.current
                .catch(() => undefined)
                .then(task);
            },
            addLine,
            setLastError,
            setStatus,
          });
        },
        onError: (error) => {
          setLastError({
            code: "renderer_error",
            message: error.message,
          });
          setStatus("failed");
        },
      });

      try {
        chunkRecorderRef.current = recorder;
        await recorder.start();
        setMicState("granted");
        setStatus("listening");
      } catch (error) {
        chunkRecorderRef.current = null;
        setMicState("denied");
        setLastError({
          code: "microphone_permission_denied",
          message:
            error instanceof Error
              ? error.message
              : t("audio:captions.errors.microphone_failed"),
        });
        setStatus("failed");
      }
      return;
    }

    const request = buildRealtimeCaptionsSessionConfig(
      normalized,
      context.configSummary.audioDialect,
    );
    setStatus("connecting");

    const result = await startOpenAIRealtimeWebRtcSession(request, {
      signal: abortControllerRef.current.signal,
      handlers: {
        sessionStarted: (event) => {
          setSessionId(event.sessionId);
          setStatus("listening");
        },
        micState: (event) => {
          setMicState(event.state);
        },
        transcriptDelta: (event) => {
          if (event.role === "assistant" && !normalized.showAssistantTranscript) {
            return;
          }
          const elapsed = getElapsedMs();
          if (partialStartedAtRef.current[event.role] === undefined) {
            partialStartedAtRef.current[event.role] = elapsed;
          }
          const current =
            useRealtimeCaptionsStore.getState().partial[event.role] ?? "";
          setPartial(event.role, `${current}${event.text}`);
        },
        transcriptFinal: (event) => {
          if (event.role === "assistant" && !normalized.showAssistantTranscript) {
            clearPartial(event.role);
            return;
          }
          const endedAtMs = getElapsedMs();
          const startedAtMsForLine =
            partialStartedAtRef.current[event.role] ?? Math.max(0, endedAtMs - 1000);
          addLine(
            createRealtimeCaptionLine({
              id: event.itemId,
              role: event.role,
              text: event.text,
              startedAtMs: startedAtMsForLine,
              endedAtMs,
            }),
          );
          partialStartedAtRef.current[event.role] = undefined;
          clearPartial(event.role);
        },
        error: (event) => {
          setLastError(toRealtimeCaptionsUiError(event.error));
          setStatus("failed");
        },
        sessionClosed: (event) => {
          setStatus(getRealtimeSessionCloseStatus(event.reason));
          setMicState("idle");
          setSessionId(null);
        },
      },
    });

    if (!result.ok) {
      setLastError(toRealtimeCaptionsUiError(result.error));
      setStatus("failed");
      setMicState(result.error.code === "microphone_permission_denied" ? "denied" : "idle");
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
    getElapsedMs,
    mode,
    preferences,
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
    setStatus("stopping");
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const recorder = chunkRecorderRef.current;
    chunkRecorderRef.current = null;
    if (recorder) {
      await recorder.stop();
      await chunkQueueRef.current.catch(() => undefined);
      setStatus("completed");
      setMicState("idle");
      return;
    }
    const handle = sessionHandleRef.current;
    sessionHandleRef.current = null;
    if (handle && !handle.closed) {
      await handle.stop("user");
    } else {
      setStatus("completed");
      setMicState("idle");
    }
  }, [setMicState, setStatus]);

  const transcriptText = useMemo(
    () => formatRealtimeCaptionLines(displayLines, preferences.outputFormat),
    [displayLines, preferences.outputFormat],
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

  const handleSave = useCallback(() => {
    if (!transcriptText.trim()) {
      showToast(t("audio:captions.errors.no_transcript"), "error");
      return;
    }
    downloadTranscript(transcriptText, preferences.outputFormat);
    showToast(t("audio:captions.messages.saved"), "success");
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
      <div className="grid gap-3 md:grid-cols-4">
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
          <AlertDescription>{lastError.message}</AlertDescription>
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
          disabled={!isRunning}
          onClick={handleStop}
        >
          <Square className="h-4 w-4" />
          {t("audio:captions.actions.stop")}
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
          disabled={displayLines.length === 0 && !partial.user && !partial.assistant}
          onClick={clearTranscript}
        >
          <Trash2 className="h-4 w-4" />
          {t("audio:captions.actions.clear")}
        </Button>
      </div>

      <TranscriptStream
        lines={displayLines}
        partial={partial}
        showAssistant={preferences.showAssistantTranscript}
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
  const partialEntries = (Object.entries(partial) as Array<[AudioRole, string]>)
    .filter(([role, text]) => text && (showAssistant || role === "user"));

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
    <div className="min-h-[280px] space-y-3 rounded-lg border bg-background p-3">
      {lines.map((line) => (
        <TranscriptLine key={line.id} role={line.role} text={line.text} final />
      ))}
      {partialEntries.map(([role, text]) => (
        <TranscriptLine key={role} role={role} text={text} />
      ))}
    </div>
  );
}

function TranscriptLine({
  role,
  text,
  final,
}: {
  role: AudioRole;
  text: string;
  final?: boolean;
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

function queueRecordedChunkTranscription(args: {
  chunk: RecordedWavChunk;
  language: string;
  activeChunkRequestIds: Set<string>;
  enqueue: (task: () => Promise<void>) => void;
  addLine: ReturnType<typeof useRealtimeCaptionsStore.getState>["addLine"];
  setLastError: ReturnType<typeof useRealtimeCaptionsStore.getState>["setLastError"];
  setStatus: ReturnType<typeof useRealtimeCaptionsStore.getState>["setStatus"];
}) {
  args.activeChunkRequestIds.add(args.chunk.requestId);
  args.enqueue(async () => {
    try {
      const result = await transcribeRecordedAudioChunk({
        assignmentKey: "realtimeCaptions",
        requestId: args.chunk.requestId,
        audioBytes: args.chunk.bytes,
        mimeType: "audio/wav",
        responseFormat: "text",
        ...(args.language !== "auto" ? { language: args.language } : {}),
        startedAtMs: args.chunk.startedAtMs,
        endedAtMs: args.chunk.endedAtMs,
      });
      if (!result.ok) {
        if (result.error.code !== "aborted") {
          args.setLastError(toRealtimeCaptionsUiError(result.error));
          args.setStatus("failed");
        }
        return;
      }

      const text = result.data.text.trim();
      if (!text) return;
      args.addLine(
        createRealtimeCaptionLine({
          id: result.data.requestId,
          role: "user",
          text,
          startedAtMs: result.data.startedAtMs ?? args.chunk.startedAtMs,
          endedAtMs: result.data.endedAtMs ?? args.chunk.endedAtMs,
        }),
      );
    } finally {
      args.activeChunkRequestIds.delete(args.chunk.requestId);
    }
  });
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

function downloadTranscript(
  text: string,
  format: "txt" | "srt",
): void {
  const blob = new Blob([text], {
    type: format === "srt" ? "application/x-subrip" : "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fusionkit-realtime-captions-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
}
