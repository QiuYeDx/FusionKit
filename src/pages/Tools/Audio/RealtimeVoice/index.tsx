import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToolField, ToolPanel } from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { showToast } from "@/utils/toast";
import type { AudioRole } from "@/type/audio";
import type { AudioIpcError } from "@/type/audioIpc";
import {
  startOpenAIRealtimeWebRtcSession,
  type AudioRealtimeSessionHandle,
} from "@/services/audio/audioRealtimeService";
import AudioToolShell, {
  type AudioToolShellContext,
} from "../shared/AudioToolShell";
import {
  OPENAI_REALTIME_VOICE_PRESETS,
  buildRealtimeVoiceSessionConfig,
  canStartRealtimeVoice,
  createRealtimeVoiceLine,
  getRealtimeVoiceCloseStatus,
} from "@/store/tools/audio/realtimeVoiceConfig";
import useRealtimeVoiceStore from "@/store/tools/audio/useRealtimeVoiceStore";

export default function RealtimeVoice() {
  return (
    <AudioToolShell
      toolKey="realtimeVoice"
      assignmentKey="realtimeVoice"
      titleKey="audio:pages.voice.title"
      descriptionKey="audio:pages.voice.description"
      workspaceTitleKey="audio:pages.voice.workspace"
      asideExtra={(context) => <RealtimeVoiceConfig context={context} />}
    >
      {(context) => <RealtimeVoiceWorkspace context={context} />}
    </AudioToolShell>
  );
}

function RealtimeVoiceConfig({ context }: { context: AudioToolShellContext }) {
  const { t } = useTranslation(["audio"]);
  const preferences = useRealtimeVoiceStore((state) => state.preferences);
  const updatePreferences = useRealtimeVoiceStore(
    (state) => state.updatePreferences,
  );
  const enabled = canStartRealtimeVoice(
    context.configSummary.audioDialect,
    context.configSummary.capabilities,
  );

  return (
    <div className="space-y-4">
      <ToolField
        label={t("audio:voice.fields.voice")}
        hint={t("audio:voice.hints.voice")}
      >
        <Input
          value={preferences.voice}
          disabled={!enabled}
          className="h-8 text-xs"
          placeholder={t("audio:voice.placeholders.voice")}
          onChange={(event) =>
            updatePreferences({ voice: event.currentTarget.value })
          }
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {OPENAI_REALTIME_VOICE_PRESETS.map((voice) => (
            <Button
              key={voice}
              type="button"
              variant={preferences.voice === voice ? "default" : "outline"}
              size="sm"
              disabled={!enabled}
              className="h-7 px-2 text-[11px]"
              onClick={() => updatePreferences({ voice })}
            >
              {voice}
            </Button>
          ))}
        </div>
      </ToolField>

      <ToolField
        label={t("audio:voice.fields.turn_detection")}
        hint={t("audio:voice.hints.turn_detection")}
      >
        <ButtonGroup className="w-full">
          {(["server_vad", "manual"] as const).map((turnDetection) => (
            <Button
              key={turnDetection}
              type="button"
              size="sm"
              className="flex-1"
              disabled={!enabled}
              variant={preferences.turnDetection === turnDetection ? "default" : "outline"}
              onClick={() => updatePreferences({ turnDetection })}
            >
              {t(`audio:voice.turn_detection.${turnDetection}`)}
            </Button>
          ))}
        </ButtonGroup>
      </ToolField>

      <ToolField
        label={t("audio:voice.fields.input_audio_format")}
        hint={t("audio:voice.hints.input_audio_format")}
      >
        <ButtonGroup className="w-full">
          {(["pcm16", "opus"] as const).map((format) => (
            <Button
              key={format}
              type="button"
              size="sm"
              className="flex-1"
              disabled={!enabled}
              variant={preferences.inputAudioFormat === format ? "default" : "outline"}
              onClick={() => updatePreferences({ inputAudioFormat: format })}
            >
              {t(`audio:voice.audio_format.${format}`)}
            </Button>
          ))}
        </ButtonGroup>
      </ToolField>

      <ToolField
        label={t("audio:voice.fields.output_audio_format")}
        hint={t("audio:voice.hints.output_audio_format")}
      >
        <ButtonGroup className="w-full">
          {(["pcm16", "opus"] as const).map((format) => (
            <Button
              key={format}
              type="button"
              size="sm"
              className="flex-1"
              disabled={!enabled}
              variant={preferences.outputAudioFormat === format ? "default" : "outline"}
              onClick={() => updatePreferences({ outputAudioFormat: format })}
            >
              {t(`audio:voice.audio_format.${format}`)}
            </Button>
          ))}
        </ButtonGroup>
      </ToolField>

      <ToolField
        label={t("audio:voice.fields.instructions")}
        hint={t("audio:voice.hints.instructions")}
      >
        <Textarea
          value={enabled ? preferences.instructions : ""}
          disabled={!enabled}
          rows={4}
          className="resize-none text-xs"
          placeholder={
            enabled
              ? t("audio:voice.placeholders.instructions")
              : t("audio:voice.placeholders.instructions_disabled")
          }
          onChange={(event) =>
            updatePreferences({ instructions: event.currentTarget.value })
          }
        />
      </ToolField>
    </div>
  );
}

function RealtimeVoiceWorkspace({
  context,
}: {
  context: AudioToolShellContext;
}) {
  const { t } = useTranslation(["audio"]);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const sessionHandleRef = useRef<AudioRealtimeSessionHandle | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const preferences = useRealtimeVoiceStore((state) => state.preferences);
  const status = useRealtimeVoiceStore((state) => state.status);
  const micState = useRealtimeVoiceStore((state) => state.micState);
  const sessionId = useRealtimeVoiceStore((state) => state.sessionId);
  const startedAtMs = useRealtimeVoiceStore((state) => state.startedAtMs);
  const assistantSpeaking = useRealtimeVoiceStore(
    (state) => state.assistantSpeaking,
  );
  const activeResponseId = useRealtimeVoiceStore(
    (state) => state.activeResponseId,
  );
  const muted = useRealtimeVoiceStore((state) => state.muted);
  const lines = useRealtimeVoiceStore((state) => state.lines);
  const partial = useRealtimeVoiceStore((state) => state.partial);
  const lastError = useRealtimeVoiceStore((state) => state.lastError);
  const setStatus = useRealtimeVoiceStore((state) => state.setStatus);
  const setMicState = useRealtimeVoiceStore((state) => state.setMicState);
  const setSessionId = useRealtimeVoiceStore((state) => state.setSessionId);
  const setStartedAtMs = useRealtimeVoiceStore((state) => state.setStartedAtMs);
  const setAssistantSpeaking = useRealtimeVoiceStore(
    (state) => state.setAssistantSpeaking,
  );
  const setActiveResponseId = useRealtimeVoiceStore(
    (state) => state.setActiveResponseId,
  );
  const setMuted = useRealtimeVoiceStore((state) => state.setMuted);
  const setLastError = useRealtimeVoiceStore((state) => state.setLastError);
  const setPartial = useRealtimeVoiceStore((state) => state.setPartial);
  const clearPartial = useRealtimeVoiceStore((state) => state.clearPartial);
  const addLine = useRealtimeVoiceStore((state) => state.addLine);
  const clearConversation = useRealtimeVoiceStore(
    (state) => state.clearConversation,
  );
  const resetSessionState = useRealtimeVoiceStore(
    (state) => state.resetSessionState,
  );
  const canStart =
    context.configSummary.status === "ready" &&
    canStartRealtimeVoice(
      context.configSummary.audioDialect,
      context.configSummary.capabilities,
    );
  const isRunning = ["requesting", "connecting", "connected", "stopping"].includes(
    status,
  );
  const elapsedMs = startedAtMs ? Date.now() - startedAtMs : 0;

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      const handle = sessionHandleRef.current;
      sessionHandleRef.current = null;
      if (handle && !handle.closed) {
        void handle.stop("page_unload");
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
      }
    };
  }, []);

  const handleConnect = useCallback(async () => {
    if (!canStart) {
      setLastError({
        code: "renderer_error",
        message: t("audio:voice.errors.unsupported_profile"),
      });
      setStatus("failed");
      return;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    resetSessionState();
    setStatus("requesting");
    setMicState("requesting");
    setStartedAtMs(Date.now());
    setLastError(null);

    const request = buildRealtimeVoiceSessionConfig(preferences);
    setStatus("connecting");
    const result = await startOpenAIRealtimeWebRtcSession(request, {
      signal: abortControllerRef.current.signal,
      remoteAudioElement: remoteAudioRef.current ?? undefined,
      handlers: {
        sessionStarted: (event) => {
          setSessionId(event.sessionId);
          setStatus("connected");
        },
        micState: (event) => {
          setMicState(event.state);
          setMuted(event.state === "muted");
        },
        transcriptDelta: (event) => {
          const current =
            useRealtimeVoiceStore.getState().partial[event.role] ?? "";
          setPartial(event.role, `${current}${event.text}`);
        },
        transcriptFinal: (event) => {
          addLine(
            createRealtimeVoiceLine({
              id: event.itemId,
              role: event.role,
              text: event.text,
              final: true,
            }),
          );
          clearPartial(event.role);
        },
        audioStarted: () => {
          setAssistantSpeaking(true);
        },
        audioStopped: () => {
          setAssistantSpeaking(false);
        },
        responseStarted: (event) => {
          setActiveResponseId(event.responseId);
        },
        responseCompleted: () => {
          setActiveResponseId(null);
          setAssistantSpeaking(false);
        },
        error: (event) => {
          setLastError(toRealtimeVoiceUiError(event.error));
          setStatus("failed");
        },
        sessionClosed: (event) => {
          setStatus(getRealtimeVoiceCloseStatus(event.reason));
          setMicState("idle");
          setSessionId(null);
          setActiveResponseId(null);
          setAssistantSpeaking(false);
        },
      },
    });

    if (!result.ok) {
      setLastError(toRealtimeVoiceUiError(result.error));
      setStatus("failed");
      setMicState(result.error.code === "microphone_permission_denied" ? "denied" : "idle");
      return;
    }

    sessionHandleRef.current = result.data;
    setSessionId(result.data.sessionId ?? null);
    setStatus("connected");
  }, [
    addLine,
    canStart,
    clearPartial,
    preferences,
    resetSessionState,
    setActiveResponseId,
    setAssistantSpeaking,
    setLastError,
    setMicState,
    setMuted,
    setPartial,
    setSessionId,
    setStartedAtMs,
    setStatus,
    t,
  ]);

  const handleDisconnect = useCallback(async () => {
    setStatus("stopping");
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const handle = sessionHandleRef.current;
    sessionHandleRef.current = null;
    if (handle && !handle.closed) {
      await handle.stop("user");
    } else {
      setStatus("completed");
      setMicState("idle");
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  }, [setMicState, setStatus]);

  const handleMute = useCallback(() => {
    const nextMuted = !muted;
    const handle = sessionHandleRef.current;
    if (!handle || handle.closed) return;
    handle.setMuted(nextMuted);
    setMuted(nextMuted);
    setMicState(nextMuted ? "muted" : "granted");
  }, [muted, setMicState, setMuted]);

  const handleInterrupt = useCallback(() => {
    const sent = sessionHandleRef.current?.sendClientEvent({
      type: "response.cancel",
    });
    if (sent) {
      setActiveResponseId(null);
      setAssistantSpeaking(false);
      showToast(t("audio:voice.messages.interrupted"), "success");
    } else {
      showToast(t("audio:voice.errors.interrupt_failed"), "error");
    }
  }, [setActiveResponseId, setAssistantSpeaking, t]);

  return (
    <ToolPanel
      icon={PhoneCall}
      title={t("audio:pages.voice.workspace")}
      badge={
        <Badge variant="outline" className={resolveStatusBadgeClass(status)}>
          {t(`audio:voice.status.${status}`)}
        </Badge>
      }
      bodyClassName="space-y-4 p-4"
    >
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <div className="grid gap-3 md:grid-cols-4">
        <VoiceStat
          label={t("audio:voice.stats.mic")}
          value={t(`audio:voice.mic_state.${micState}`)}
        />
        <VoiceStat
          label={t("audio:voice.stats.audio")}
          value={
            assistantSpeaking
              ? t("audio:voice.audio_state.speaking")
              : t("audio:voice.audio_state.idle")
          }
        />
        <VoiceStat
          label={t("audio:voice.stats.session")}
          value={sessionId ?? "-"}
        />
        <VoiceStat
          label={t("audio:voice.stats.elapsed")}
          value={formatDuration(elapsedMs)}
        />
      </div>

      {!canStart ? (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("audio:voice.unsupported.title")}</AlertTitle>
          <AlertDescription>
            {t("audio:voice.unsupported.description")}
          </AlertDescription>
        </Alert>
      ) : null}

      {lastError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("audio:voice.errors.title")}</AlertTitle>
          <AlertDescription>{lastError.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="gap-2"
          disabled={isRunning || !canStart}
          onClick={handleConnect}
        >
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PhoneCall className="h-4 w-4" />
          )}
          {isRunning
            ? t("audio:voice.actions.connected")
            : t("audio:voice.actions.connect")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!isRunning}
          onClick={handleDisconnect}
        >
          <PhoneOff className="h-4 w-4" />
          {t("audio:voice.actions.disconnect")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={status !== "connected"}
          onClick={handleMute}
        >
          {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {muted ? t("audio:voice.actions.unmute") : t("audio:voice.actions.mute")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={status !== "connected" || !activeResponseId}
          onClick={handleInterrupt}
        >
          <Square className="h-4 w-4" />
          {t("audio:voice.actions.interrupt")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="gap-2"
          disabled={lines.length === 0 && !partial.user && !partial.assistant}
          onClick={clearConversation}
        >
          <Trash2 className="h-4 w-4" />
          {t("audio:voice.actions.clear")}
        </Button>
      </div>

      <VoiceTimeline
        lines={lines}
        partial={partial}
        isRunning={isRunning}
        assistantSpeaking={assistantSpeaking}
      />
    </ToolPanel>
  );
}

function VoiceTimeline({
  lines,
  partial,
  isRunning,
  assistantSpeaking,
}: {
  lines: ReturnType<typeof useRealtimeVoiceStore.getState>["lines"];
  partial: ReturnType<typeof useRealtimeVoiceStore.getState>["partial"];
  isRunning: boolean;
  assistantSpeaking: boolean;
}) {
  const { t } = useTranslation(["audio"]);
  const partialEntries = Object.entries(partial) as Array<[AudioRole, string]>;
  const visiblePartial = partialEntries.filter(([, text]) => text);

  if (lines.length === 0 && visiblePartial.length === 0) {
    return (
      <div className="flex min-h-[300px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
        <div className="max-w-md space-y-3">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
            {isRunning ? (
              <Radio className="h-4 w-4 animate-pulse" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
          </div>
          <div className="text-sm font-medium">
            {isRunning
              ? t("audio:voice.empty.running")
              : t("audio:voice.empty.title")}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {isRunning
              ? t("audio:voice.empty.running_description")
              : t("audio:voice.empty.description")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[300px] space-y-3 rounded-lg border bg-background p-3">
      {lines.map((line) => (
        <VoiceLine
          key={line.id}
          role={line.role}
          text={line.text}
          final={line.final}
        />
      ))}
      {visiblePartial.map(([role, text]) => (
        <VoiceLine key={role} role={role} text={text} final={false} />
      ))}
      {assistantSpeaking ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Volume2 className="h-3.5 w-3.5 animate-pulse" />
          {t("audio:voice.audio_state.speaking")}
        </div>
      ) : null}
    </div>
  );
}

function VoiceLine({
  role,
  text,
  final,
}: {
  role: AudioRole;
  text: string;
  final: boolean;
}) {
  const { t } = useTranslation(["audio"]);
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm leading-relaxed",
        role === "assistant" ? "bg-sky-500/5" : "bg-card",
        !final && "border-dashed text-muted-foreground",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase text-muted-foreground">
        {final ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {t(`audio:voice.role.${role}`)}
      </div>
      <div>{text}</div>
    </div>
  );
}

function VoiceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/10 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function resolveStatusBadgeClass(status: string): string {
  if (status === "connected") {
    return "gap-1 border-emerald-500/25 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "failed") {
    return "gap-1 border-destructive/25 text-destructive";
  }
  return "gap-1 border-muted-foreground/25 text-muted-foreground";
}

function toRealtimeVoiceUiError(error: AudioIpcError) {
  return {
    code: error.code,
    message: error.message,
    field: error.field,
    details: error.details,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
}
