import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
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
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToolField, ToolPanel } from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { showToast } from "@/utils/toast";
import type { AudioApiProfile, AudioRole } from "@/type/audio";
import type { AudioIpcError, AudioRealtimeSessionEvent } from "@/type/audioIpc";
import {
  flushPendingAudioRealtimeSessionStops,
  flushPendingRecordedAudioChunkTranscriptionCancellations,
  queueRecordedAudioChunkTranscriptionCancellation,
  settleRecordedAudioChunkTranscriptionCancellation,
  startOpenAIRealtimeWebRtcSession,
  transcribeRecordedAudioChunk,
  type AudioRealtimeSessionHandle,
} from "@/services/audio/audioRealtimeService";
import AudioToolShell from "../shared/AudioToolShell";
import {
  REALTIME_CAPTIONS_OUTPUT_FORMATS,
  buildRealtimeCaptionsSessionConfig,
  createRealtimeCaptionLine,
  formatRealtimeCaptionLines,
  getRealtimeCaptionsRouteIdentity,
  getRealtimeSessionCloseStatus,
  normalizeRealtimeCaptionsPreferences,
  resolveRealtimeCaptionsConfigSummary,
  type RealtimeCaptionsConfigSummary,
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
import useAudioApiStore from "@/store/useAudioApiStore";

const CHUNK_QUEUE_MAX_PENDING_ITEMS = 4;
const CHUNK_QUEUE_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const CHUNK_QUEUE_MAX_AGE_MS = 30_000;
const CHUNK_FINAL_DRAIN_TIMEOUT_MS = 15_000;
const CAPTIONS_SETTINGS_PATH =
  "/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Frealtime-captions";

export default function RealtimeCaptions() {
  const profiles = useAudioApiStore((state) => state.profiles);
  const assignment = useAudioApiStore((state) => state.assignment);
  const summary = useMemo(
    () => resolveRealtimeCaptionsConfigSummary({ profiles, assignment }),
    [assignment, profiles],
  );
  const routeIdentity = getRealtimeCaptionsRouteIdentity(summary);
  const assignedProfile = useMemo(
    () => profiles.find((profile) => profile.id === summary.profileId),
    [profiles, summary.profileId],
  );

  return (
    <div data-testid="realtime-captions">
      <AudioToolShell
        toolKey="realtimeCaptions"
        titleKey="audio:pages.captions.title"
        descriptionKey="audio:pages.captions.description"
        workspaceTitleKey="audio:pages.captions.workspace"
        configSummary={summary}
        settingsPath={CAPTIONS_SETTINGS_PATH}
        asideExtra={() =>
          summary.status === "ready" && summary.constraints ? (
            <RealtimeCaptionsConfig summary={summary} />
          ) : null
        }
      >
        {() => (
          <RealtimeCaptionsWorkspace
            summary={summary}
            assignedProfile={assignedProfile}
            routeIdentity={routeIdentity}
          />
        )}
      </AudioToolShell>
    </div>
  );
}

function RealtimeCaptionsConfig({
  summary,
}: {
  summary: RealtimeCaptionsConfigSummary;
}) {
  const { t } = useTranslation(["audio"]);
  const preferences = useRealtimeCaptionsStore((state) => state.preferences);
  const status = useRealtimeCaptionsStore((state) => state.status);
  const updatePreferences = useRealtimeCaptionsStore(
    (state) => state.updatePreferences,
  );
  const mode = summary.mode;
  const normalized = useMemo(
    () =>
      normalizeRealtimeCaptionsPreferences(
        preferences,
        summary.constraints,
      ),
    [preferences, summary.constraints],
  );
  const isOpenAIRealtime = mode === "openai_realtime";
  const configLocked = ["requesting", "connecting", "listening", "stopping"].includes(status);

  return (
    <fieldset
      data-testid="captions-config"
      className="space-y-4"
      disabled={configLocked}
    >
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
            {summary.languages.map((language) => (
              <SelectItem key={language} value={language}>
                {t(`audio:captions.languages.${language}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>

      {isOpenAIRealtime && summary.inputAudioFormats.length > 0 ? (
        <ToolField
          testId="captions-input-audio-format"
          label={t("audio:captions.fields.input_audio_format")}
          hint={t("audio:captions.hints.input_audio_format")}
        >
          <RadioGroup
            className="grid w-full grid-cols-3 gap-0"
            value={normalized.inputAudioFormat}
            aria-label={t("audio:captions.fields.input_audio_format")}
            onValueChange={(inputAudioFormat) =>
              updatePreferences({
                inputAudioFormat: inputAudioFormat as typeof normalized.inputAudioFormat,
              })
            }
            onKeyDownCapture={(event) => {
              if (event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              const inputAudioFormat = event.key === "Home"
                ? summary.inputAudioFormats[0]
                : summary.inputAudioFormats.at(-1)!;
              updatePreferences({ inputAudioFormat });
              event.currentTarget
                .querySelector<HTMLElement>(
                  `[data-testid="captions-input-format-${inputAudioFormat}"]`,
                )
                ?.focus();
            }}
          >
            {summary.inputAudioFormats.map((format) => (
              <RadioGroupItem
                key={format}
                value={format}
                data-testid={`captions-input-format-${format}`}
                className={cn(
                  "h-auto min-h-9 min-w-0 w-full aspect-auto rounded-none px-1.5 py-1.5 text-center text-[11px] font-medium first:rounded-l-md last:rounded-r-md [&:not(:first-child)]:border-l-0",
                  "whitespace-normal data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=unchecked]:bg-background data-[state=unchecked]:hover:bg-accent data-[state=unchecked]:hover:text-accent-foreground",
                  "[&>[data-slot=radio-group-indicator]]:hidden",
                )}
              >
                <span className="pointer-events-none min-w-0 break-words leading-tight">
                  {t(`audio:captions.input_audio_format.${format}`)}
                </span>
              </RadioGroupItem>
            ))}
          </RadioGroup>
        </ToolField>
      ) : null}

      <ToolField
        testId="captions-output-format"
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
    </fieldset>
  );
}

function RealtimeCaptionsWorkspace({
  summary,
  assignedProfile,
  routeIdentity,
}: {
  summary: RealtimeCaptionsConfigSummary;
  assignedProfile: AudioApiProfile | undefined;
  routeIdentity: string;
}) {
  const { t } = useTranslation(["audio"]);
  const navigate = useNavigate();
  const sessionHandleRef = useRef<AudioRealtimeSessionHandle | null>(null);
  const chunkRecorderRef = useRef<WavChunkRecorder | null>(null);
  const chunkQueueRef = useRef<BoundedAsyncQueue | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionGenerationRef = useRef(0);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const previousAssignedProfileRef = useRef(assignedProfile);
  const previousRouteIdentityRef = useRef(routeIdentity);
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
  const mode = summary.mode;
  const canStart = summary.status === "ready" && Boolean(summary.constraints);
  const isRunning = ["requesting", "connecting", "listening", "stopping"].includes(
    status,
  );
  const canStop = ["requesting", "connecting", "listening"].includes(status);
  const displayLines = lines.filter((line) => line.role === "user");
  const visibleLines = displayLines.slice(-300);
  const elapsedMs = useElapsedMs(startedAtMs, isRunning);

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
    if (handle && !handle.closed) {
      void handle.stop(reason);
    }
    try {
      await recorder?.stop({ flushFinalChunk });
    } catch {
      // Recorder teardown still releases tracks in finally.
    }
    if (flushFinalChunk) {
      const drained = await waitForPromise(queue?.seal(), CHUNK_FINAL_DRAIN_TIMEOUT_MS);
      if (!drained) void queue?.abort();
    } else {
      void queue?.abort();
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
    void flushPendingRecordedAudioChunkTranscriptionCancellations();
    void flushPendingAudioRealtimeSessionStops();
    return () => {
      sessionGenerationRef.current += 1;
      void releaseOwnedResources("page_unload");
      useRealtimeCaptionsStore.getState().resetSessionState();
    };
  }, [releaseOwnedResources]);

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
    void releaseOwnedResources("page_unload");
    resetSessionState();
    setPaused(false);
    setInputLevel(0);
    partialStartedAtRef.current = {};
  }, [
    assignedProfile,
    releaseOwnedResources,
    resetSessionState,
    routeIdentity,
  ]);

  const isRouteSnapshotCurrent = useCallback(() => {
    const latestState = useAudioApiStore.getState();
    const latestSummary = resolveRealtimeCaptionsConfigSummary(latestState);
    const latestProfile = latestState.profiles.find(
      (profile) => profile.id === latestSummary.profileId,
    );
    return (
      latestProfile === assignedProfile &&
      getRealtimeCaptionsRouteIdentity(latestSummary) === routeIdentity
    );
  }, [assignedProfile, routeIdentity]);

  const getElapsedMs = useCallback(() => {
    const state = useRealtimeCaptionsStore.getState();
    return Math.max(0, Date.now() - (state.startedAtMs ?? Date.now()));
  }, []);

  const runStart = useCallback(async () => {
    const constraints = summary.constraints;
    if (!canStart || !constraints) {
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
    if (
      sessionGenerationRef.current !== generation ||
      !isRouteSnapshotCurrent()
    ) return;
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
      constraints,
    );
    const isCurrentSession = () =>
      sessionGenerationRef.current === generation &&
      isRouteSnapshotCurrent();
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
          if (!isCurrentSession()) return;
          let dispatched = false;
          queue.enqueue({
            id: chunk.requestId,
            sizeBytes: chunk.bytes.byteLength,
            run: async (signal) => {
              if (signal.aborted || sessionGenerationRef.current !== generation) {
                return;
              }
              try {
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
                }, {
                  signal,
                  onDispatch: () => {
                    dispatched = true;
                  },
                });
                if (
                  signal.aborted ||
                  sessionGenerationRef.current !== generation ||
                  !isRouteSnapshotCurrent()
                ) {
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
              } finally {
                // After dispatch, invokeAudioTaskIpc resolves only when main has
                // settled the request. Renderer abort alone does not resolve it.
                settleRecordedAudioChunkTranscriptionCancellation(
                  chunk.requestId,
                );
              }
            },
            cancel: () => {
              if (dispatched) {
                void queueRecordedAudioChunkTranscriptionCancellation(
                  chunk.requestId,
                );
              }
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
          !isCurrentSession() ||
          controller.signal.aborted
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
        if (!isCurrentSession()) return;
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
      constraints,
    );
    setStatus("connecting");

    const result = await startOpenAIRealtimeWebRtcSession(request, {
      signal: controller.signal,
      onInputLevel: setInputLevel,
      handlers: {
        sessionStarted: (event) => {
          if (!isCurrentSession()) return;
          setSessionId(event.sessionId);
          setStatus("listening");
        },
        micState: (event) => {
          if (!isCurrentSession()) return;
          setMicState(event.state);
        },
        transcriptDelta: (event) => {
          if (!isCurrentSession()) return;
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
          if (!isCurrentSession()) return;
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
          } else if (isCurrentSession()) {
            setLastError(toRealtimeCaptionsUiError(event.error));
          }
        },
        sessionClosed: (event) => {
          if (!isCurrentSession()) return;
          sessionHandleRef.current = null;
          abortControllerRef.current = null;
          setStatus(getRealtimeSessionCloseStatus(event.reason));
          setMicState("idle");
          setSessionId(null);
        },
      },
    });

    if (
      !isCurrentSession() ||
      controller.signal.aborted
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
    failSession,
    getElapsedMs,
    isRouteSnapshotCurrent,
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
    summary.constraints,
    t,
  ]);

  const handleStart = useCallback(() => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    void runStart().finally(() => {
      startLockRef.current = false;
    });
  }, [runStart]);

  const runStop = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const flushFinalChunk = Boolean(chunkRecorderRef.current);
    let completionGeneration = generation;
    if (!flushFinalChunk) {
      completionGeneration = generation + 1;
      sessionGenerationRef.current = completionGeneration;
    }
    setStatus("stopping");
    await releaseOwnedResources("user", { flushFinalChunk });
    if (flushFinalChunk) {
      if (sessionGenerationRef.current !== generation) return;
      sessionGenerationRef.current += 1;
    } else if (sessionGenerationRef.current !== completionGeneration) {
      return;
    }
    setStatus("completed");
    setMicState("idle");
    setSessionId(null);
  }, [releaseOwnedResources, setMicState, setSessionId, setStatus]);

  const handleStop = useCallback(() => {
    if (stopLockRef.current) return;
    stopLockRef.current = true;
    void runStop().finally(() => {
      stopLockRef.current = false;
    });
  }, [runStop]);

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

  if (summary.status !== "ready" || !summary.constraints) {
    return (
      <ToolPanel
        icon={Captions}
        title={t("audio:pages.captions.workspace")}
        badge={
          <Badge variant="outline" className={resolveStatusBadgeClass("idle")}>
            {t("audio:captions.status.idle")}
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
              data-testid="captions-config-cta"
              type="button"
              className="gap-1.5"
              onClick={() => navigate(CAPTIONS_SETTINGS_PATH)}
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
      icon={Captions}
      title={t("audio:pages.captions.workspace")}
      badge={
        <Badge variant="outline" className={resolveStatusBadgeClass(status)}>
          {t(`audio:captions.status.${status}`)}
        </Badge>
      }
      bodyClassName="space-y-4 p-4"
    >
      <div
        data-testid="captions-workspace"
        className="scroll-mt-20 space-y-4"
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
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
        <Alert
          data-testid="captions-chunked-notice"
          className="border-sky-500/30 bg-sky-500/5"
        >
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
          data-testid="captions-start"
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
          data-testid="captions-stop"
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
          data-testid="captions-pause"
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
      </div>
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
    <div className="min-w-0 rounded-lg border bg-muted/10 px-3 py-2">
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

async function waitForPromise(
  promise: Promise<void> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!promise) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
}
