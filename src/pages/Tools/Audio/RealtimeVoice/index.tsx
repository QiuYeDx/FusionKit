import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  Settings2,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ToolField,
  ToolPanel,
  ToolRadioButtonGroup,
} from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { showToast } from "@/utils/toast";
import type { AudioApiProfile, AudioRole } from "@/type/audio";
import type { AudioIpcError, AudioRealtimeSessionEvent } from "@/type/audioIpc";
import {
  flushPendingAudioRealtimeSessionStops,
  startOpenAIRealtimeWebRtcSession,
  type AudioRealtimeSessionHandle,
} from "@/services/audio/audioRealtimeService";
import AudioToolShell from "../shared/AudioToolShell";
import {
  buildRealtimeVoiceSessionConfig,
  createRealtimeVoiceLine,
  getRealtimeVoiceCloseStatus,
  getRealtimeVoiceRouteIdentity,
  normalizeRealtimeVoicePreferences,
  resolveRealtimeVoiceConfigSummary,
  type RealtimeVoiceConfigSummary,
} from "@/store/tools/audio/realtimeVoiceConfig";
import useRealtimeVoiceStore from "@/store/tools/audio/useRealtimeVoiceStore";
import useAudioApiStore from "@/store/useAudioApiStore";
import { useElapsedMs } from "../shared/useElapsedMs";
import { getAudioErrorMessage } from "../shared/audioErrorMessage";

const VOICE_SETTINGS_PATH =
  "/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Frealtime-voice";

interface PendingRealtimeVoiceInterrupt {
  responseId: string | null;
}

export default function RealtimeVoice() {
  const profiles = useAudioApiStore((state) => state.profiles);
  const assignment = useAudioApiStore((state) => state.assignment);
  const summary = useMemo(
    () => resolveRealtimeVoiceConfigSummary({ profiles, assignment }),
    [assignment, profiles],
  );
  const routeIdentity = getRealtimeVoiceRouteIdentity(summary);
  const assignedProfile = useMemo(
    () => profiles.find((profile) => profile.id === summary.profileId),
    [profiles, summary.profileId],
  );

  return (
    <div data-testid="realtime-voice">
      <AudioToolShell
        toolKey="realtimeVoice"
        titleKey="audio:pages.voice.title"
        descriptionKey="audio:pages.voice.description"
        workspaceTitleKey="audio:pages.voice.workspace"
        configSummary={summary}
        settingsPath={VOICE_SETTINGS_PATH}
        asideExtra={() =>
          summary.status === "ready" && summary.constraints ? (
            <RealtimeVoiceConfig summary={summary} />
          ) : null
        }
      >
        {() => (
          <RealtimeVoiceWorkspace
            summary={summary}
            assignedProfile={assignedProfile}
            routeIdentity={routeIdentity}
          />
        )}
      </AudioToolShell>
    </div>
  );
}

function RealtimeVoiceConfig({
  summary,
}: {
  summary: RealtimeVoiceConfigSummary;
}) {
  const { t } = useTranslation(["audio"]);
  const preferences = useRealtimeVoiceStore((state) => state.preferences);
  const status = useRealtimeVoiceStore((state) => state.status);
  const updatePreferences = useRealtimeVoiceStore(
    (state) => state.updatePreferences,
  );
  const normalized = useMemo(
    () => normalizeRealtimeVoicePreferences(preferences, summary.constraints),
    [preferences, summary.constraints],
  );
  const configLocked = ["requesting", "connecting", "connected", "stopping"]
    .includes(status);

  return (
    <fieldset
      data-testid="voice-config"
      className="space-y-4"
      disabled={configLocked}
    >
      <ToolField
        testId="voice-field-voice"
        label={t("audio:voice.fields.voice")}
        htmlFor="realtime-voice-name"
        hint={t("audio:voice.hints.voice")}
      >
        {summary.voices.length > 0 ? (
          <Select
            value={normalized.voice}
            onValueChange={(voice) => updatePreferences({ voice })}
          >
            <SelectTrigger
              id="realtime-voice-name"
              data-testid="voice-select"
              size="sm"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {summary.voices.map((voice) => (
                <SelectItem key={voice} value={voice}>
                  {voice}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="realtime-voice-name"
            data-testid="voice-input"
            value={normalized.voice}
            className="h-8 text-xs"
            placeholder={t("audio:voice.placeholders.voice")}
            onChange={(event) =>
              updatePreferences({ voice: event.currentTarget.value })
            }
          />
        )}
      </ToolField>

      <ToolField
        testId="voice-input-audio-format"
        label={t("audio:voice.fields.input_audio_format")}
        hint={t("audio:voice.hints.input_audio_format")}
      >
        <RealtimeAudioFormatGroup
          testIdPrefix="voice-input-format"
          label={t("audio:voice.fields.input_audio_format")}
          formats={summary.inputAudioFormats}
          value={normalized.inputAudioFormat}
          onValueChange={(inputAudioFormat) =>
            updatePreferences({ inputAudioFormat })
          }
        />
      </ToolField>

      <ToolField
        testId="voice-output-audio-format"
        label={t("audio:voice.fields.output_audio_format")}
        hint={t("audio:voice.hints.output_audio_format")}
      >
        <RealtimeAudioFormatGroup
          testIdPrefix="voice-output-format"
          label={t("audio:voice.fields.output_audio_format")}
          formats={summary.outputAudioFormats}
          value={normalized.outputAudioFormat}
          onValueChange={(outputAudioFormat) =>
            updatePreferences({ outputAudioFormat })
          }
        />
      </ToolField>

      {summary.constraints?.supportsInstructions ? (
        <ToolField
          testId="voice-field-instructions"
          label={t("audio:voice.fields.instructions")}
          htmlFor="realtime-voice-instructions"
          hint={t("audio:voice.hints.instructions")}
        >
          <Textarea
            id="realtime-voice-instructions"
            value={normalized.instructions}
            rows={4}
            className="resize-none text-xs"
            placeholder={t("audio:voice.placeholders.instructions")}
            onChange={(event) =>
              updatePreferences({ instructions: event.currentTarget.value })
            }
          />
        </ToolField>
      ) : null}
    </fieldset>
  );
}

function RealtimeAudioFormatGroup({
  testIdPrefix,
  label,
  formats,
  value,
  onValueChange,
}: {
  testIdPrefix: string;
  label: string;
  formats: RealtimeVoiceConfigSummary["inputAudioFormats"];
  value: RealtimeVoiceConfigSummary["inputAudioFormats"][number];
  onValueChange: (
    value: RealtimeVoiceConfigSummary["inputAudioFormats"][number],
  ) => void;
}) {
  const { t } = useTranslation(["audio"]);
  return (
    <ToolRadioButtonGroup
      value={value}
      ariaLabel={label}
      options={formats.map((format) => ({
        value: format,
        label: format.toUpperCase(),
        ariaLabel: t(`audio:voice.audio_format.${format}`),
        testId: `${testIdPrefix}-${format}`,
      }))}
      onValueChange={(nextValue) =>
        onValueChange(nextValue)
      }
    />
  );
}

function RealtimeVoiceWorkspace({
  summary,
  assignedProfile,
  routeIdentity,
}: {
  summary: RealtimeVoiceConfigSummary;
  assignedProfile: AudioApiProfile | undefined;
  routeIdentity: string;
}) {
  const { t } = useTranslation(["audio"]);
  const navigate = useNavigate();
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const sessionHandleRef = useRef<AudioRealtimeSessionHandle | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionGenerationRef = useRef(0);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const previousAssignedProfileRef = useRef(assignedProfile);
  const previousRouteIdentityRef = useRef(routeIdentity);
  const completedResponseIdRef = useRef<string | null>(null);
  const pendingInterruptRef = useRef<PendingRealtimeVoiceInterrupt | null>(null);
  const interruptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    summary.status === "ready" && Boolean(summary.constraints);
  const isRunning = ["requesting", "connecting", "connected", "stopping"].includes(
    status,
  );
  const canStop = ["requesting", "connecting", "connected"].includes(status);
  const elapsedMs = useElapsedMs(startedAtMs, isRunning);

  const clearRemoteAudio = useCallback(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  }, []);

  const releaseOwnedSession = useCallback(async (
    reason: "user" | "error" | "page_unload",
  ) => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const handle = sessionHandleRef.current;
    sessionHandleRef.current = null;
    clearRemoteAudio();
    completedResponseIdRef.current = null;
    pendingInterruptRef.current = null;
    if (interruptTimeoutRef.current) {
      clearTimeout(interruptTimeoutRef.current);
      interruptTimeoutRef.current = null;
    }
    if (handle && !handle.closed) {
      await handle.stop(reason);
    }
  }, [clearRemoteAudio]);

  const failSession = useCallback((
    error: AudioIpcError,
    generation: number,
  ) => {
    if (sessionGenerationRef.current !== generation) return;
    sessionGenerationRef.current += 1;
    setLastError(toRealtimeVoiceUiError(error));
    setStatus("failed");
    setMicState(error.code === "microphone_permission_denied" ? "denied" : "idle");
    setSessionId(null);
    setActiveResponseId(null);
    setAssistantSpeaking(false);
    setMuted(false);
    void releaseOwnedSession("error");
  }, [
    releaseOwnedSession,
    setActiveResponseId,
    setAssistantSpeaking,
    setLastError,
    setMicState,
    setMuted,
    setSessionId,
    setStatus,
  ]);

  useEffect(() => {
    void flushPendingAudioRealtimeSessionStops();
    return () => {
      sessionGenerationRef.current += 1;
      void releaseOwnedSession("page_unload");
      useRealtimeVoiceStore.getState().resetSessionState();
    };
  }, [releaseOwnedSession]);

  useEffect(() => {
    if (
      previousAssignedProfileRef.current === assignedProfile &&
      previousRouteIdentityRef.current === routeIdentity
    ) {
      return;
    }
    previousAssignedProfileRef.current = assignedProfile;
    previousRouteIdentityRef.current = routeIdentity;
    sessionGenerationRef.current += 1;
    void releaseOwnedSession("page_unload");
    resetSessionState();
  }, [
    assignedProfile,
    releaseOwnedSession,
    resetSessionState,
    routeIdentity,
  ]);

  const isRouteSnapshotCurrent = useCallback(() => {
    const latestState = useAudioApiStore.getState();
    const latestSummary = resolveRealtimeVoiceConfigSummary(latestState);
    const latestProfile = latestState.profiles.find(
      (profile) => profile.id === latestSummary.profileId,
    );
    return (
      latestProfile === assignedProfile &&
      getRealtimeVoiceRouteIdentity(latestSummary) === routeIdentity
    );
  }, [assignedProfile, routeIdentity]);

  const runConnect = useCallback(async () => {
    const constraints = summary.constraints;
    if (!canStart || !constraints) {
      setLastError({
        code: "renderer_error",
        message: t("audio:voice.errors.unsupported_profile"),
      });
      setStatus("failed");
      return;
    }

    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    await releaseOwnedSession("user");
    if (
      sessionGenerationRef.current !== generation ||
      !isRouteSnapshotCurrent()
    ) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    resetSessionState();
    setStatus("requesting");
    setMicState("requesting");
    setStartedAtMs(Date.now());
    setLastError(null);

    const request = buildRealtimeVoiceSessionConfig(preferences, constraints);
    setStatus("connecting");
    const isCurrentSession = () =>
      sessionGenerationRef.current === generation &&
      isRouteSnapshotCurrent();
    const result = await startOpenAIRealtimeWebRtcSession(request, {
      signal: controller.signal,
      remoteAudioElement: remoteAudioRef.current ?? undefined,
      handlers: {
        sessionStarted: (event) => {
          if (!isCurrentSession()) return;
          setSessionId(event.sessionId);
          setStatus("connected");
        },
        micState: (event) => {
          if (!isCurrentSession()) return;
          setMicState(event.state);
          setMuted(event.state === "muted");
        },
        transcriptDelta: (event) => {
          if (!isCurrentSession()) return;
          const partialKey = getRealtimePartialKey(event);
          const current =
            useRealtimeVoiceStore.getState().partial[partialKey]?.text ?? "";
          setPartial(partialKey, event.role, `${current}${event.text}`);
        },
        transcriptFinal: (event) => {
          if (!isCurrentSession()) return;
          addLine(
            createRealtimeVoiceLine({
              id: event.itemId,
              role: event.role,
              text: event.text,
              final: true,
            }),
          );
          clearPartial(getRealtimePartialKey(event));
        },
        audioStarted: (event) => {
          if (!isCurrentSession()) return;
          const currentResponseId =
            useRealtimeVoiceStore.getState().activeResponseId;
          if (
            event.responseId &&
            currentResponseId &&
            event.responseId !== currentResponseId
          ) {
            return;
          }
          if (event.responseId) {
            setActiveResponseId(event.responseId);
          }
          setAssistantSpeaking(true);
        },
        audioStopped: (event) => {
          if (!isCurrentSession()) return;
          if (event.source === "response") return;
          const currentResponseId =
            useRealtimeVoiceStore.getState().activeResponseId;
          const pendingInterrupt = pendingInterruptRef.current;
          if (
            event.responseId &&
            currentResponseId &&
            event.responseId !== currentResponseId
          ) {
            return;
          }
          setAssistantSpeaking(false);
          if (
            !event.responseId ||
            !currentResponseId ||
            event.responseId === currentResponseId
          ) {
            setActiveResponseId(null);
            completedResponseIdRef.current = null;
          }
          if (
            pendingInterrupt &&
            (
              !event.responseId ||
              !pendingInterrupt.responseId ||
              event.responseId === pendingInterrupt.responseId
            )
          ) {
            pendingInterruptRef.current = null;
            if (interruptTimeoutRef.current) {
              clearTimeout(interruptTimeoutRef.current);
              interruptTimeoutRef.current = null;
            }
            showToast(t("audio:voice.messages.interrupted"), "success");
          }
        },
        responseStarted: (event) => {
          if (!isCurrentSession()) return;
          completedResponseIdRef.current = null;
          setActiveResponseId(event.responseId);
        },
        responseCompleted: (event) => {
          if (!isCurrentSession()) return;
          const voiceState = useRealtimeVoiceStore.getState();
          const currentResponseId = voiceState.activeResponseId;
          if (currentResponseId === event.responseId) {
            completedResponseIdRef.current = event.responseId;
            if (!voiceState.assistantSpeaking) {
              setActiveResponseId(null);
            }
          }
        },
        error: (event) => {
          if (event.fatal) {
            failSession(event.error, generation);
          } else if (isCurrentSession()) {
            setLastError(toRealtimeVoiceUiError(event.error));
          }
        },
        sessionClosed: (event) => {
          if (!isCurrentSession()) return;
          sessionHandleRef.current = null;
          abortControllerRef.current = null;
          setStatus(getRealtimeVoiceCloseStatus(event.reason));
          setMicState("idle");
          setSessionId(null);
          setActiveResponseId(null);
          setAssistantSpeaking(false);
          completedResponseIdRef.current = null;
          pendingInterruptRef.current = null;
        },
      },
    });

    if (
      !isCurrentSession()
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
        failSession(result.error, generation);
      }
      return;
    }

    sessionHandleRef.current = result.data;
    setSessionId(result.data.sessionId ?? null);
    setStatus("connected");
  }, [
    addLine,
    canStart,
    clearPartial,
    failSession,
    isRouteSnapshotCurrent,
    preferences,
    releaseOwnedSession,
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
    summary.constraints,
    t,
  ]);

  const handleConnect = useCallback(() => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    void runConnect().finally(() => {
      startLockRef.current = false;
    });
  }, [runConnect]);

  const runDisconnect = useCallback(async () => {
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    setStatus("stopping");
    await releaseOwnedSession("user");
    if (sessionGenerationRef.current !== generation) return;
    setStatus("completed");
    setMicState("idle");
    setSessionId(null);
    setActiveResponseId(null);
    setAssistantSpeaking(false);
    setMuted(false);
  }, [
    releaseOwnedSession,
    setActiveResponseId,
    setAssistantSpeaking,
    setMicState,
    setMuted,
    setSessionId,
    setStatus,
  ]);

  const handleDisconnect = useCallback(() => {
    if (stopLockRef.current) return;
    stopLockRef.current = true;
    void runDisconnect().finally(() => {
      stopLockRef.current = false;
    });
  }, [runDisconnect]);

  const handleMute = useCallback(() => {
    const nextMuted = !muted;
    const handle = sessionHandleRef.current;
    if (!handle || handle.closed) return;
    handle.setMuted(nextMuted);
    setMuted(nextMuted);
    setMicState(nextMuted ? "muted" : "granted");
  }, [muted, setMicState, setMuted]);

  const handleInterrupt = useCallback(() => {
    const handle = sessionHandleRef.current;
    const voiceState = useRealtimeVoiceStore.getState();
    const responseId = voiceState.activeResponseId;
    if (
      !handle ||
      handle.closed ||
      (!responseId && !voiceState.assistantSpeaking) ||
      pendingInterruptRef.current
    ) {
      showToast(t("audio:voice.errors.interrupt_failed"), "error");
      return;
    }
    const cancelRequired = Boolean(
      responseId && completedResponseIdRef.current !== responseId,
    );
    const cancelSent = !cancelRequired || handle.sendClientEvent({
      type: "response.cancel",
      response_id: responseId,
    });
    const clearSent = handle.sendClientEvent({
      type: "output_audio_buffer.clear",
    });
    if (cancelSent && clearSent) {
      pendingInterruptRef.current = { responseId };
      if (interruptTimeoutRef.current) clearTimeout(interruptTimeoutRef.current);
      interruptTimeoutRef.current = setTimeout(() => {
        if (pendingInterruptRef.current?.responseId !== responseId) return;
        pendingInterruptRef.current = null;
        interruptTimeoutRef.current = null;
        showToast(t("audio:voice.errors.interrupt_failed"), "error");
      }, 2000);
    } else {
      showToast(t("audio:voice.errors.interrupt_failed"), "error");
    }
  }, [t]);

  if (summary.status !== "ready" || !summary.constraints) {
    return (
      <ToolPanel
        icon={PhoneCall}
        title={t("audio:pages.voice.workspace")}
        badge={
          <Badge variant="outline" className={resolveStatusBadgeClass("idle")}>
            {t("audio:voice.status.idle")}
          </Badge>
        }
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
              data-testid="voice-config-cta"
              type="button"
              className="gap-1.5"
              onClick={() => navigate(VOICE_SETTINGS_PATH)}
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
      <div data-testid="voice-workspace" className="scroll-mt-20 space-y-4">

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

      {lastError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("audio:voice.errors.title")}</AlertTitle>
          <AlertDescription>
            {getAudioErrorMessage(t, lastError, lastError.message)}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="voice-connect"
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
          data-testid="voice-disconnect"
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!canStop}
          onClick={handleDisconnect}
        >
          <PhoneOff className="h-4 w-4" />
          {t("audio:voice.actions.disconnect")}
        </Button>
        <Button
          data-testid="voice-mute"
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
          data-testid="voice-interrupt"
          type="button"
          variant="outline"
          className="gap-2"
          disabled={
            status !== "connected" ||
            (!activeResponseId && !assistantSpeaking)
          }
          onClick={handleInterrupt}
        >
          <Square className="h-4 w-4" />
          {t("audio:voice.actions.interrupt")}
        </Button>
        <Button
          data-testid="voice-clear"
          type="button"
          variant="ghost"
          className="gap-2"
          disabled={lines.length === 0 && Object.keys(partial).length === 0}
          onClick={clearConversation}
        >
          <Trash2 className="h-4 w-4" />
          {t("audio:voice.actions.clear")}
        </Button>
      </div>

      <VoiceTimeline
        lines={lines.slice(-300)}
        partial={partial}
        isRunning={isRunning}
        assistantSpeaking={assistantSpeaking}
      />
      </div>
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
  const visiblePartial = Object.entries(partial).filter(([, value]) => value.text);

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
    <div
      className="min-h-[300px] space-y-3 rounded-lg border bg-background p-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {lines.map((line) => (
        <VoiceLine
          key={line.id}
          role={line.role}
          text={line.text}
          final={line.final}
        />
      ))}
      {visiblePartial.map(([key, value]) => (
        <VoiceLine key={key} role={value.role} text={value.text} final={false} />
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
