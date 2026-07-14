import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localStorageItems = vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  return storage;
});

import useAudioApiStore from "@/store/useAudioApiStore";
import { AUDIO_EVENT_CHANNELS, AUDIO_IPC_CHANNELS } from "@/type/audioIpc";
import {
  cancelAudioTranscriptionBounded,
  cancelAudioTranscription,
  flushPendingAudioTranscriptionCancellations,
  queueAudioTranscriptionCancellation,
  resetAudioTranscriptionCancellationQueueForTests,
  settleAudioTranscriptionCancellation,
  transcribeAudio,
} from "./audioTranscriptionService";
import {
  cancelRecordedAudioChunkTranscription,
  createAudioRealtimeSessionHandle,
  createRealtimeEphemeralSession,
  mapOpenAIRealtimeServerEvent,
  startOpenAIRealtimeWebRtcSession,
  transcribeRecordedAudioChunk,
} from "./audioRealtimeService";
import {
  cancelSpeechSynthesis,
  revealSpeechOutput,
  synthesizeSpeech,
  cancelSpeechSynthesisStream,
  synthesizeSpeechStream,
} from "./speechSynthesisService";
import {
  flushPendingAudioInputFileRevocations,
  flushPendingAudioOutputDirectoryRevocations,
  queueAudioInputFileRevocation,
  queueAudioOutputDirectoryRevocation,
  resetAudioRuntimeConfigCacheForTests,
} from "./audioRuntimeConfigService";

describe("audio renderer services", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let on: ReturnType<typeof vi.fn>;
  let off: ReturnType<typeof vi.fn>;
  let revokeInputFile: ReturnType<typeof vi.fn>;
  let revokeOutputDirectory: ReturnType<typeof vi.fn>;
  let streamListener: ((event: unknown, payload: unknown) => void) | undefined;

  beforeEach(() => {
    resetAudioRuntimeConfigCacheForTests();
    resetAudioTranscriptionCancellationQueueForTests();
    localStorageItems.clear();
    useAudioApiStore.setState({
      profiles: [
        {
          id: "audio_openai",
          name: "OpenAI Audio",
          providerPreset: "openai",
          apiKey: "sk-renderer-audio",
          baseUrl: "https://api.openai.com/v1",
          routes: {
            transcription: {
              transport: "openai_audio",
              model: "gpt-4o-transcribe",
              enabled: true,
            },
            speechSynthesis: {
              preset_voice: {
                transport: "openai_audio",
                model: "gpt-4o-mini-tts",
                enabled: true,
              },
            },
            realtimeCaptions: {
              transport: "openai_realtime",
              model: "gpt-realtime-whisper",
              enabled: true,
            },
            realtimeVoice: {
              transport: "openai_realtime",
              model: "gpt-realtime",
              enabled: true,
            },
          },
        },
      ],
      assignment: {
        transcription: "audio_openai",
        speechSynthesis: "audio_openai",
        realtimeCaptions: "audio_openai",
        realtimeVoice: "audio_openai",
      },
    });

    streamListener = undefined;
    invoke = vi.fn(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        return {
          ok: true,
          data: {
            synced: true,
            audioProfileCount: 1,
            revision: "runtime_revision_test",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        return {
          ok: true,
          data: {
            text: "hello audio",
            responseFormat: "json",
            model: "gpt-4o-transcribe",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelTranscription) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "asr_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribeRecordedChunk) {
        return {
          ok: true,
          data: {
            requestId: "chunk_req_001",
            text: "chunk transcript",
            responseFormat: "text",
            startedAtMs: 0,
            endedAtMs: 5000,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "chunk_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.synthesizeSpeech) {
        return {
          ok: true,
          data: {
            outputToken: "output_token_speech",
            mimeType: "audio/mpeg",
            responseFormat: "mp3",
            sizeBytes: 32,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelSpeechSynthesis) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "speech_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.synthesizeSpeechStream) {
        return {
          ok: true,
          data: {
            outputToken: "output_token_stream",
            mimeType: "audio/wav",
            responseFormat: "pcm16",
            sizeBytes: 44,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelSpeechSynthesisStream) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "speech_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession) {
        return {
          ok: true,
          data: {
            sessionId: "sess_renderer_realtime",
            clientSecret: "ek-renderer-realtime",
            realtimeCallsUrl: "https://api.openai.com/v1/realtime/calls",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.realtimeStopSession) {
        return {
          ok: true,
          data: {
            stopped: true,
            sessionId: "sess_renderer_realtime",
            reason: "user",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.revealOutput) {
        return {
          ok: true,
          data: { revealed: true },
        };
      }
      return { ok: false, error: { code: "invalid_ipc_request", message: "bad" } };
    });
    on = vi.fn((_channel: string, listener: typeof streamListener) => {
      streamListener = listener;
    });
    off = vi.fn();
    revokeInputFile = vi.fn();
    revokeOutputDirectory = vi.fn();
    vi.stubGlobal("window", {
      audioApi: {
        invoke: (
          channel: string,
          payload: unknown,
          options?: { configRevision?: string },
        ) => options === undefined
          ? invoke(channel, payload)
          : invoke(channel, payload, options),
        authorizeInputFile: vi.fn(),
        revokeInputFile,
        selectOutputDirectory: vi.fn(),
        revokeOutputDirectory,
        on,
        off,
      },
    });
  });

  afterEach(() => {
    resetAudioRuntimeConfigCacheForTests();
    resetAudioTranscriptionCancellationQueueForTests();
    vi.useRealTimers();
  });

  it("syncs global audio config before transcription without putting API config in task payload", async () => {
    const result = await transcribeAudio({
      assignmentKey: "transcription",
      fileToken: "file_token_speech",
      fileName: "speech.wav",
      mimeType: "audio/wav",
      responseFormat: "json",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { text: "hello audio" },
    });
    expectRuntimeSyncCall(invoke, 1);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_test",
    );
  });

  it("maps runtime sync and task IPC rejections to structured network errors", async () => {
    invoke.mockRejectedValueOnce(new Error("sync IPC disconnected"));
    await expect(
      transcribeAudio(createTranscriptionRequest("asr_sync_reject")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "network_error", message: "sync IPC disconnected" },
    });

    resetAudioRuntimeConfigCacheForTests();
    invoke
      .mockResolvedValueOnce({
        ok: true,
        data: {
          synced: true,
          audioProfileCount: 1,
          revision: "runtime_revision_task_reject",
        },
      })
      .mockRejectedValueOnce(new Error("task IPC disconnected"));
    await expect(
      transcribeAudio(createTranscriptionRequest("asr_task_reject")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "network_error", message: "task IPC disconnected" },
    });
  });

  it("maps direct cancellation IPC rejection to a structured network error", async () => {
    invoke.mockRejectedValueOnce(new Error("cancel IPC disconnected"));

    await expect(cancelAudioTranscription("asr_cancel_reject"))
      .resolves.toMatchObject({
        ok: false,
        error: { code: "network_error", message: "cancel IPC disconnected" },
      });
  });

  it("bounds a hung foreground transcription cancellation", async () => {
    vi.useFakeTimers();
    invoke.mockReturnValue(new Promise(() => undefined));

    const pending = cancelAudioTranscriptionBounded("asr_cancel_hung", 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBeUndefined();
  });

  it("stops an audio task after runtime sync when its preflight is cancelled", async () => {
    let resolveSync: ((value: unknown) => void) | undefined;
    const sync = new Promise((resolve) => {
      resolveSync = resolve;
    });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) return sync;
      throw new Error(`Unexpected task dispatch: ${channel}`);
    });
    const abortController = new AbortController();
    const onDispatch = vi.fn();

    const pending = transcribeAudio(
      createTranscriptionRequest("asr_preflight_cancelled"),
      { signal: abortController.signal, onDispatch },
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    abortController.abort();
    resolveSync?.({
      ok: true,
      data: {
        synced: true,
        audioProfileCount: 1,
        revision: "runtime_revision_cancelled",
      },
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(onDispatch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not redispatch a stale task when cancellation arrives during resync", async () => {
    let resolveResync: ((value: unknown) => void) | undefined;
    const resync = new Promise((resolve) => {
      resolveResync = resolve;
    });
    let syncCount = 0;
    let taskCount = 0;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        syncCount += 1;
        if (syncCount === 2) return resync;
        return {
          ok: true,
          data: {
            synced: true,
            audioProfileCount: 1,
            revision: "runtime_revision_initial",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        taskCount += 1;
        return {
          ok: false,
          error: { code: "stale_audio_config", message: "stale" },
        };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const abortController = new AbortController();
    const onDispatch = vi.fn();

    const pending = transcribeAudio(
      createTranscriptionRequest("asr_resync_cancelled"),
      { signal: abortController.signal, onDispatch },
    );
    await vi.waitFor(() => expect(syncCount).toBe(2));
    abortController.abort();
    resolveResync?.({
      ok: true,
      data: {
        synced: true,
        audioProfileCount: 1,
        revision: "runtime_revision_resynced",
      },
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(taskCount).toBe(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("retains lifecycle cancellation until main confirms it", async () => {
    invoke
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "network_error", message: "cancel disconnected" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { cancelled: false, requestId: "asr_cleanup_retry" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { cancelled: true, requestId: "asr_cleanup_retry" },
      });

    await expect(
      queueAudioTranscriptionCancellation("asr_cleanup_retry"),
    ).resolves.toBe(false);
    await flushPendingAudioTranscriptionCancellations();
    await flushPendingAudioTranscriptionCancellations();

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      AUDIO_IPC_CHANNELS.cancelTranscription,
      { requestId: "asr_cleanup_retry" },
      {},
    );
    await flushPendingAudioTranscriptionCancellations();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("stops retrying a lifecycle cancellation when the task settles", async () => {
    invoke.mockResolvedValue({
      ok: true,
      data: { cancelled: false, requestId: "asr_cleanup_settled" },
    });

    await expect(
      queueAudioTranscriptionCancellation("asr_cleanup_settled"),
    ).resolves.toBe(false);
    settleAudioTranscriptionCancellation("asr_cleanup_settled");
    await flushPendingAudioTranscriptionCancellations();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retains failed input-file revocations and accepts idempotent retry success", async () => {
    revokeInputFile
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "network_error", message: "revoke disconnected" },
      })
      .mockResolvedValueOnce({ ok: true, data: { revoked: false } });

    await expect(
      queueAudioInputFileRevocation(
        "file_token_pending_revoke",
        Date.now() + 60_000,
      ),
    ).resolves.toBe(false);
    expect(revokeInputFile).toHaveBeenCalledTimes(1);

    await flushPendingAudioInputFileRevocations();
    expect(revokeInputFile).toHaveBeenCalledTimes(2);
    expect(revokeInputFile).toHaveBeenLastCalledWith(
      "file_token_pending_revoke",
    );

    await flushPendingAudioInputFileRevocations();
    expect(revokeInputFile).toHaveBeenCalledTimes(2);
  });

  it("retries input-file revocation after a rejected preload call", async () => {
    revokeInputFile
      .mockRejectedValueOnce(new Error("preload unavailable"))
      .mockResolvedValueOnce({ ok: true, data: { revoked: true } });

    await expect(
      queueAudioInputFileRevocation(
        "file_token_rejected_revoke",
        Date.now() + 60_000,
      ),
    ).resolves.toBe(false);
    await flushPendingAudioInputFileRevocations();

    expect(revokeInputFile).toHaveBeenCalledTimes(2);
  });

  it("retains failed output-directory revocations until idempotent success", async () => {
    revokeOutputDirectory
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "network_error", message: "revoke disconnected" },
      })
      .mockResolvedValueOnce({ ok: true, data: { revoked: false } });

    await expect(
      queueAudioOutputDirectoryRevocation(
        "output_dir_token_pending_revoke",
        Date.now() + 60_000,
      ),
    ).resolves.toBe(false);
    await flushPendingAudioOutputDirectoryRevocations();

    expect(revokeOutputDirectory).toHaveBeenCalledTimes(2);
    expect(revokeOutputDirectory).toHaveBeenLastCalledWith(
      "output_dir_token_pending_revoke",
    );
    await flushPendingAudioOutputDirectoryRevocations();
    expect(revokeOutputDirectory).toHaveBeenCalledTimes(2);
  });

  it("retries output-directory revocation after a rejected preload call", async () => {
    revokeOutputDirectory
      .mockRejectedValueOnce(new Error("preload unavailable"))
      .mockResolvedValueOnce({ ok: true, data: { revoked: true } });

    await expect(
      queueAudioOutputDirectoryRevocation(
        "output_dir_token_rejected_revoke",
        Date.now() + 60_000,
      ),
    ).resolves.toBe(false);
    await flushPendingAudioOutputDirectoryRevocations();

    expect(revokeOutputDirectory).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung capability revocation attempt before scheduling retry", async () => {
    vi.useFakeTimers();
    revokeInputFile.mockReturnValue(new Promise(() => undefined));
    const pending = queueAudioInputFileRevocation(
      "file_token_hung_revoke",
      Date.now() + 60_000,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(false);
    resetAudioRuntimeConfigCacheForTests();
    vi.useRealTimers();
  });

  it("invalidates, resyncs, and retries a stale audio task exactly once", async () => {
    let syncCount = 0;
    let taskCount = 0;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        syncCount += 1;
        return {
          ok: true,
          data: {
            synced: true,
            audioProfileCount: 1,
            revision: `runtime_revision_${syncCount}`,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        taskCount += 1;
        if (taskCount === 1) {
          return {
            ok: false,
            error: {
              code: "stale_audio_config",
              message: "stale",
            },
          };
        }
        return {
          ok: true,
          data: {
            text: "retried transcript",
            responseFormat: "json",
          },
        };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    const result = await transcribeAudio(createTranscriptionRequest());

    expect(result).toMatchObject({
      ok: true,
      data: { text: "retried transcript" },
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    expectRuntimeSyncCall(invoke, 1);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_1",
    );
    expectRuntimeSyncCall(invoke, 3);
    expectAudioTaskCall(
      invoke,
      4,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_2",
    );
  });

  it("returns a second stale error without retrying the task again", async () => {
    let syncCount = 0;
    let taskCount = 0;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        syncCount += 1;
        return {
          ok: true,
          data: {
            synced: true,
            audioProfileCount: 1,
            revision: `runtime_revision_${syncCount}`,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        taskCount += 1;
        return {
          ok: false,
          error: {
            code: "stale_audio_config",
            message: `stale ${taskCount}`,
          },
        };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    const result = await transcribeAudio(createTranscriptionRequest());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "stale_audio_config", message: "stale 2" },
    });
    expect(taskCount).toBe(2);
    expect(syncCount).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(4);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_1",
    );
    expectAudioTaskCall(
      invoke,
      4,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_2",
    );
  });

  it("deduplicates concurrent syncs for the same snapshot and shares the revision", async () => {
    let resolveSync: ((value: unknown) => void) | undefined;
    const pendingSync = new Promise((resolve) => {
      resolveSync = resolve;
    });
    invoke.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        return pendingSync;
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        return {
          ok: true,
          data: {
            text: `transcript:${String((payload as { requestId?: string }).requestId)}`,
            responseFormat: "json",
          },
        };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    const first = transcribeAudio(createTranscriptionRequest("asr_concurrent_1"));
    const second = transcribeAudio(createTranscriptionRequest("asr_concurrent_2"));
    await vi.waitFor(() => {
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig,
        ),
      ).toHaveLength(1);
    });

    resolveSync?.({
      ok: true,
      data: {
        synced: true,
        audioProfileCount: 1,
        revision: "runtime_revision_shared",
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(invoke).toHaveBeenCalledTimes(3);
    expectRuntimeSyncCall(invoke, 1);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_shared",
    );
    expectAudioTaskCall(
      invoke,
      3,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_shared",
    );
  });

  it("syncs the latest store snapshot before invoking a task when settings change in flight", async () => {
    let resolveFirstSync: ((value: unknown) => void) | undefined;
    const firstSync = new Promise((resolve) => {
      resolveFirstSync = resolve;
    });
    let syncCount = 0;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        syncCount += 1;
        if (syncCount === 1) return firstSync;
        return {
          ok: true,
          data: {
            synced: true,
            audioProfileCount: 1,
            revision: "runtime_revision_latest",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        return {
          ok: true,
          data: { text: "latest transcript", responseFormat: "json" },
        };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    const pending = transcribeAudio(createTranscriptionRequest("asr_latest"));
    await vi.waitFor(() => expect(syncCount).toBe(1));
    useAudioApiStore.setState((state) => ({
      profiles: state.profiles.map((profile) => ({
        ...profile,
        baseUrl: "https://latest.example.com/v1",
      })),
    }));
    resolveFirstSync?.({
      ok: true,
      data: {
        synced: true,
        audioProfileCount: 1,
        revision: "runtime_revision_superseded",
      },
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(syncCount).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[1]?.[0]).toBe(AUDIO_IPC_CHANNELS.syncRuntimeConfig);
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({
      profiles: [{ baseUrl: "https://latest.example.com/v1" }],
    });
    expectAudioTaskCall(
      invoke,
      3,
      AUDIO_IPC_CHANNELS.transcribe,
      "runtime_revision_latest",
    );
    expect(invoke.mock.calls[2]?.[2]).not.toEqual({
      configRevision: "runtime_revision_superseded",
    });
  });

  it("exposes transcription cancellation without syncing runtime config again", async () => {
    const result = await cancelAudioTranscription("asr_req_001");

    expect(result).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "asr_req_001" },
    });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.cancelTranscription,
      { requestId: "asr_req_001" },
      {},
    );
    expect(invoke).not.toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.anything(),
    );
  });

  it("syncs global audio config before transcribing recorded chunks", async () => {
    const result = await transcribeRecordedAudioChunk({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_001",
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      responseFormat: "text",
      startedAtMs: 0,
      endedAtMs: 5000,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { text: "chunk transcript" },
    });
    expectRuntimeSyncCall(invoke, 1);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.transcribeRecordedChunk,
      "runtime_revision_test",
    );
  });

  it("exposes recorded chunk cancellation without syncing runtime config again", async () => {
    await expect(cancelRecordedAudioChunkTranscription("chunk_req_001"))
      .resolves.toMatchObject({
        ok: true,
        data: { cancelled: true, requestId: "chunk_req_001" },
      });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription,
      { requestId: "chunk_req_001" },
      {},
    );
    expect(invoke).not.toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.anything(),
    );
  });

  it("syncs global audio config before non-stream speech synthesis", async () => {
    const result = await synthesizeSpeech({
      assignmentKey: "speechSynthesis",
      requestId: "speech_req_001",
      input: "hello",
      intent: { mode: "preset_voice", voice: "alloy" },
      responseFormat: "mp3",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { outputToken: "output_token_speech" },
    });
    expectRuntimeSyncCall(invoke, 1);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.synthesizeSpeech,
      "runtime_revision_test",
    );
  });

  it("exposes non-stream speech cancellation and output reveal helpers", async () => {
    await expect(cancelSpeechSynthesis("speech_req_001"))
      .resolves.toMatchObject({
        ok: true,
        data: { cancelled: true, requestId: "speech_req_001" },
      });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.cancelSpeechSynthesis,
      { requestId: "speech_req_001" },
      {},
    );
    expect(invoke).not.toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.anything(),
    );

    await expect(revealSpeechOutput({ outputToken: "output_token_speech" }))
      .resolves.toMatchObject({
        ok: true,
        data: { revealed: true },
      });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.revealOutput,
      { outputToken: "output_token_speech" },
      {},
    );
  });

  it("subscribes to matching speech stream events and exposes cancellation", async () => {
    const audioDelta = vi.fn();
    const any = vi.fn();
    const handle = synthesizeSpeechStream(
      {
        assignmentKey: "speechSynthesis",
        input: "hello",
        intent: { mode: "preset_voice", voice: "alloy" },
        responseFormat: "pcm16",
      },
      { audioDelta, any },
      { requestId: "speech_req_001" },
    );

    expect(on).toHaveBeenCalledWith(
      AUDIO_EVENT_CHANNELS.speechSynthesisStream,
      expect.any(Function),
    );
    streamListener?.({}, {
      type: "audio_delta",
      requestId: "other",
      pcmBytes: new Uint8Array([9]),
    });
    streamListener?.({}, {
      type: "audio_delta",
      requestId: "speech_req_001",
      pcmBytes: new Uint8Array([1, 2, 3]),
    });

    expect(audioDelta).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
    await expect(handle.result).resolves.toMatchObject({ ok: true });
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.synthesizeSpeechStream,
      "runtime_revision_test",
    );
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({
      requestId: "speech_req_001",
      payload: {
        assignmentKey: "speechSynthesis",
        stream: true,
      },
    });

    await expect(cancelSpeechSynthesisStream({ requestId: "speech_req_001" }))
      .resolves.toMatchObject({
        ok: true,
        data: { cancelled: true, requestId: "speech_req_001" },
      });
    handle.unsubscribe();
    expect(off).toHaveBeenCalledWith(
      AUDIO_EVENT_CHANNELS.speechSynthesisStream,
      expect.any(Function),
    );
  });

  it("syncs global audio config before creating a realtime ephemeral session", async () => {
    const result = await createRealtimeEphemeralSession({
      assignmentKey: "realtimeVoice",
      mode: "duplex_voice",
      voice: "marin",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { sessionId: "sess_renderer_realtime" },
    });
    expectRuntimeSyncCall(invoke, 1);
    expectAudioTaskCall(
      invoke,
      2,
      AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession,
      "runtime_revision_test",
    );
  });

  it("maps OpenAI Realtime server events into FusionKit realtime events", () => {
    expect(mapOpenAIRealtimeServerEvent(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello",
    }))).toEqual([
      { type: "transcript_delta", role: "user", text: "hello" },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "response.created",
      response: { id: "resp_001" },
    })).toEqual([
      { type: "response_started", responseId: "resp_001" },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "response.output_audio_transcript.done",
      item_id: "item_001",
      response_id: "resp_001",
      content_index: 0,
      transcript: "hi there",
    })).toEqual([
      {
        type: "transcript_final",
        role: "assistant",
        text: "hi there",
        itemId: "item_001",
        responseId: "resp_001",
        contentIndex: 0,
      },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "error",
      error: { message: "session failed" },
    })).toEqual([
      {
        type: "error",
        fatal: false,
        error: {
          code: "realtime_session_failed",
          message: "session failed",
        },
      },
    ]);
  });

  it("cleans up realtime browser resources idempotently", async () => {
    const dataChannelClose = vi.fn();
    const peerConnectionClose = vi.fn();
    const trackStop = vi.fn();
    const stopRemoteSession = vi.fn(async () => ({
      ok: true as const,
      data: {
        stopped: true,
        sessionId: "sess_renderer_realtime",
        reason: "page_unload" as const,
      },
    }));
    const events: unknown[] = [];
    const handle = createAudioRealtimeSessionHandle({
      sessionId: "sess_renderer_realtime",
      dataChannel: { close: dataChannelClose },
      peerConnection: { close: peerConnectionClose },
      mediaStream: {
        getTracks: () => [{ stop: trackStop } as unknown as MediaStreamTrack],
      },
      onEvent: (event) => events.push(event),
      stopRemoteSession,
    });

    await handle.stop("page_unload");
    await handle.stop("user");

    expect(handle.closed).toBe(true);
    expect(dataChannelClose).toHaveBeenCalledTimes(1);
    expect(peerConnectionClose).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(stopRemoteSession).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "session_closed", reason: "page_unload" },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "response.done",
      response: { id: "resp_failed", status: "failed" },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "response_completed",
        responseId: "resp_failed",
        status: "failed",
      }),
      expect.objectContaining({ type: "error", fatal: false }),
    ]));
  });

  it("releases a late microphone stream when realtime start was aborted", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const trackStop = vi.fn();
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    }));
    const peerConnectionFactory = vi.fn();
    const controller = new AbortController();
    const startPromise = startOpenAIRealtimeWebRtcSession(
      { assignmentKey: "realtimeVoice", mode: "duplex_voice" },
      { signal: controller.signal, getUserMedia, peerConnectionFactory },
    );

    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveStream({
      getTracks: () => [{ stop: trackStop } as unknown as MediaStreamTrack],
    } as MediaStream);

    await expect(startPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(peerConnectionFactory).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.realtimeStopSession,
      expect.objectContaining({
        sessionId: "sess_renderer_realtime",
        reason: "page_unload",
      }),
      { configRevision: "runtime_revision_test" },
    );
  });

  it("tears down realtime media when the data channel fails", async () => {
    const dataChannelListeners = new Map<string, EventListener>();
    const peerConnectionListeners = new Map<string, EventListener>();
    const dataChannelClose = vi.fn();
    const peerConnectionClose = vi.fn();
    const trackStop = vi.fn();
    const error = vi.fn();
    const sessionClosed = vi.fn();
    const dataChannel = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        dataChannelListeners.set(type, listener);
      }),
      close: dataChannelClose,
      send: vi.fn(),
    };
    const peerConnection = {
      connectionState: "connected",
      iceConnectionState: "connected",
      createDataChannel: vi.fn(() => dataChannel),
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        peerConnectionListeners.set(type, listener);
      }),
      addTrack: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      close: peerConnectionClose,
    };
    const stream = {
      getAudioTracks: () => [{ stop: trackStop } as unknown as MediaStreamTrack],
      getTracks: () => [{ stop: trackStop } as unknown as MediaStreamTrack],
    } as MediaStream;

    const result = await startOpenAIRealtimeWebRtcSession(
      { assignmentKey: "realtimeVoice", mode: "duplex_voice" },
      {
        getUserMedia: async () => stream,
        peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
        fetchSdp: async () => ({
          ok: true,
          status: 200,
          text: async () => "answer-sdp",
        }),
        handlers: { error, sessionClosed },
      },
    );
    expect(result.ok).toBe(true);

    dataChannelListeners.get("error")?.(new Event("error"));
    await vi.waitFor(() => {
      expect(result.ok && result.data.closed).toBe(true);
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(sessionClosed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "error" }),
    );
    expect(dataChannelClose).toHaveBeenCalledTimes(1);
    expect(peerConnectionClose).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(peerConnectionListeners.has("connectionstatechange")).toBe(true);
    expect(peerConnectionListeners.has("iceconnectionstatechange")).toBe(true);
  });
});

function createTranscriptionRequest(requestId = "asr_req_001") {
  return {
    assignmentKey: "transcription" as const,
    requestId,
    fileToken: "file_token_speech",
    fileName: "speech.wav",
    mimeType: "audio/wav",
    responseFormat: "json" as const,
  };
}

function expectRuntimeSyncCall(
  invoke: ReturnType<typeof vi.fn>,
  callNumber: number,
): void {
  const call = invoke.mock.calls[callNumber - 1];
  expect(call?.[0]).toBe(AUDIO_IPC_CHANNELS.syncRuntimeConfig);
  expect(call?.[2]).toBeUndefined();
  expect(call?.[1]).toMatchObject({
    profiles: [
      {
        id: "audio_openai",
        providerPreset: "openai",
        apiKey: "sk-renderer-audio",
        baseUrl: "https://api.openai.com/v1",
        routes: {
          transcription: {
            transport: "openai_audio",
            model: "gpt-4o-transcribe",
            enabled: true,
          },
          speechSynthesis: {
            preset_voice: {
              transport: "openai_audio",
              model: "gpt-4o-mini-tts",
              enabled: true,
            },
          },
        },
      },
    ],
    assignment: {
      transcription: "audio_openai",
      speechSynthesis: "audio_openai",
      realtimeCaptions: "audio_openai",
      realtimeVoice: "audio_openai",
    },
  });
  expect(call?.[1]).not.toHaveProperty("connectionProfiles");
  expect(call?.[1]).not.toHaveProperty("audioProfiles");
  expect(call?.[1]).not.toHaveProperty("audioAssignment");
}

function expectAudioTaskCall(
  invoke: ReturnType<typeof vi.fn>,
  callNumber: number,
  channel: string,
  revision: string,
): void {
  const call = invoke.mock.calls[callNumber - 1];
  expect(call?.[0]).toBe(channel);
  expect(call?.[2]).toEqual({ configRevision: revision });
  expectTaskPayloadWithoutRuntimeConfig(call?.[1]);
}

function expectTaskPayloadWithoutRuntimeConfig(payload: unknown): void {
  const forbiddenFields = new Set([
    "apiKey",
    "baseUrl",
    "providerPreset",
    "transport",
    "model",
    "modelKey",
    "profileId",
    "audioProfileId",
  ]);

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      expect(forbiddenFields.has(key), `task payload contains ${key}`).toBe(false);
      visit(child);
    }
  };

  visit(payload);
}
