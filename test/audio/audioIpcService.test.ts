import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AudioIpcService,
  type AudioIpcClientContext,
  type AudioInputFileAuthorizations,
  type AudioIpcServiceOptions,
  type AudioOutputDirectoryAuthorizations,
  type AudioRuntimeInvoker,
} from "../../electron/main/audio/ipc";
import { createAudioRuntimeError } from "../../electron/main/audio/audio-errors";
import type {
  AudioTranscriptionResult,
  SpeechSynthesisResult,
} from "@/type/audio";
import type {
  CreateAudioTranscriptionIpcRequest,
  CreateSpeechSynthesisIpcRequest,
  SyncAudioRuntimeConfigRequest,
} from "@/type/audioIpc";

const TEST_OWNER_ID = 17;

const electronMock = vi.hoisted(() => ({
  shell: { showItemInFolder: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("electron", () => electronMock);

describe("AudioIpcService", () => {
  it("returns a not-configured error before global audio config is synced", async () => {
    const service = createService(createRuntimeInvoker());

    const result = await service.transcribe(
      createTranscriptionPayload(),
      { senderId: TEST_OWNER_ID, configRevision: "missing_revision" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "stale_audio_config",
      },
    });
  });

  it("returns authorized transcription results without API keys or output paths", async () => {
    const runtime = createRuntimeInvoker();
    const service = createService(runtime);
    const context = await syncService(service);

    const result = await service.transcribe(createTranscriptionPayload(), context);

    expect(result).toMatchObject({
      ok: true,
      data: {
        text: "transcribed",
        responseFormat: "json",
        model: "gpt-4o-transcribe",
        outputToken: expect.any(String),
      },
    });
    expect(runtime.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentKey: "transcription" }),
      expect.objectContaining({
        model: expect.objectContaining({
          apiKey: "sk-audio-ipc",
          modelKey: "gpt-4o-transcribe",
          audioDialect: "openai_audio",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("sk-audio-ipc");
    expect(JSON.stringify(result)).not.toContain("/tmp/transcript.json");
    expectNoPathKeys(result);
  });

  it("returns authorized speech output and reveals it without exposing the path", async () => {
    const runtime = createRuntimeInvoker();
    const revealOutput = vi.fn();
    const service = createService(runtime, { revealOutput });
    const context = await syncService(service);

    const speechResult = await service.synthesizeSpeech(
      createSpeechPayload(),
      context,
    );

    expect(speechResult).toMatchObject({
      ok: true,
      data: {
        outputToken: expect.any(String),
        mimeType: "audio/wav",
        responseFormat: "wav",
      },
    });
    expectNoPathKeys(speechResult);
    expect(JSON.stringify(speechResult)).not.toContain("/tmp/speech.wav");
    if (!speechResult.ok) throw new Error(speechResult.error.message);

    const revealResult = await service.revealOutput(
      { outputToken: speechResult.data.outputToken },
      context,
    );

    expect(revealOutput).toHaveBeenCalledWith("/tmp/speech.wav");
    expect(revealResult).toEqual({
      ok: true,
      data: { revealed: true },
    });
    expectNoPathKeys(revealResult);
  });

  it("returns a public directory selection while keeping its path in main", async () => {
    const privateDirectory = "/private/audio/exports";
    const outputDirectoryAuthorizations =
      createOutputDirectoryAuthorizations();
    const selectOutputDirectory = vi.fn(async () => ({
      canceled: false,
      filePaths: [privateDirectory],
    }));
    const service = createService(createRuntimeInvoker(), {
      outputDirectoryAuthorizations,
      selectOutputDirectory,
    });

    const result = await service.selectOutputDirectory(
      { title: "Choose output", buttonLabel: "Select" },
      { senderId: TEST_OWNER_ID },
    );

    expect(selectOutputDirectory).toHaveBeenCalledWith({
      title: "Choose output",
      buttonLabel: "Select",
    });
    expect(outputDirectoryAuthorizations.authorize).toHaveBeenCalledWith(
      TEST_OWNER_ID,
      privateDirectory,
    );
    expect(result).toEqual({
      ok: true,
      data: {
        cancelled: false,
        outputDirToken: "output_dir_token_1",
        directoryName: "exports",
        expiresAt: 31_000,
      },
    });
    expectNoPathKeys(result);
    expect(JSON.stringify(result)).not.toContain(privateDirectory);
  });

  it("does not mint a file token after the selecting renderer is released", async () => {
    const pendingAuthorization = createDeferred<{
      fileToken: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      expiresAt: number;
    }>();
    const fileAuthorizations = createFileAuthorizations();
    vi.mocked(fileAuthorizations.authorize).mockImplementationOnce(
      () => pendingAuthorization.promise,
    );
    const service = createService(createRuntimeInvoker(), {
      fileAuthorizations,
    });

    const pending = service.authorizeInputFile(
      { filePath: "/private/audio/input.wav", mimeType: "audio/wav" },
      { senderId: TEST_OWNER_ID },
    );
    await waitFor(() => expect(fileAuthorizations.authorize).toHaveBeenCalled());
    service.releaseOwner(TEST_OWNER_ID);
    pendingAuthorization.resolve({
      fileToken: "late_file_token",
      fileName: "input.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      expiresAt: 31_000,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(fileAuthorizations.revoke).toHaveBeenCalledWith(
      TEST_OWNER_ID,
      "late_file_token",
    );
  });

  it("revokes only a stale generation token without clearing a new generation", async () => {
    const staleAuthorization = createDeferred<{
      fileToken: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      expiresAt: number;
    }>();
    const fileAuthorizations = createFileAuthorizations();
    vi.mocked(fileAuthorizations.authorize)
      .mockImplementationOnce(() => staleAuthorization.promise)
      .mockResolvedValueOnce({
        fileToken: "current_file_token",
        fileName: "current.wav",
        mimeType: "audio/wav",
        sizeBytes: 64,
        expiresAt: 32_000,
      });
    const service = createService(createRuntimeInvoker(), {
      fileAuthorizations,
    });

    const stalePending = service.authorizeInputFile(
      { filePath: "/private/audio/stale.wav" },
      { senderId: TEST_OWNER_ID },
    );
    await waitFor(() => expect(fileAuthorizations.authorize).toHaveBeenCalled());
    service.releaseOwner(TEST_OWNER_ID);
    const currentResult = await service.authorizeInputFile(
      { filePath: "/private/audio/current.wav" },
      { senderId: TEST_OWNER_ID },
    );
    staleAuthorization.resolve({
      fileToken: "stale_file_token",
      fileName: "stale.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      expiresAt: 31_000,
    });

    expect(currentResult).toMatchObject({
      ok: true,
      data: { fileToken: "current_file_token" },
    });
    await expect(stalePending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(fileAuthorizations.releaseOwner).toHaveBeenCalledTimes(1);
    expect(fileAuthorizations.revoke).toHaveBeenCalledWith(
      TEST_OWNER_ID,
      "stale_file_token",
    );
    expect(fileAuthorizations.revoke).not.toHaveBeenCalledWith(
      TEST_OWNER_ID,
      "current_file_token",
    );
  });

  it("does not mint a directory token after the selecting renderer is released", async () => {
    const pendingSelection = createDeferred<{
      canceled: boolean;
      filePaths: string[];
    }>();
    const outputDirectoryAuthorizations =
      createOutputDirectoryAuthorizations();
    const selectOutputDirectory = vi.fn(() => pendingSelection.promise);
    const service = createService(createRuntimeInvoker(), {
      outputDirectoryAuthorizations,
      selectOutputDirectory,
    });

    const pending = service.selectOutputDirectory(
      {},
      { senderId: TEST_OWNER_ID },
    );
    await waitFor(() => expect(selectOutputDirectory).toHaveBeenCalled());
    service.releaseOwner(TEST_OWNER_ID);
    pendingSelection.resolve({
      canceled: false,
      filePaths: ["/private/audio/late-output"],
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(outputDirectoryAuthorizations.authorize).not.toHaveBeenCalled();
  });

  it("resolves custom output directory tokens only into trusted runtime payloads", async () => {
    const privateDirectory = "/private/audio/custom-exports";
    const outputDirToken = "custom_output_dir_token";
    const outputDirectoryAuthorizations =
      createOutputDirectoryAuthorizations();
    outputDirectoryAuthorizations.seed(
      TEST_OWNER_ID,
      outputDirToken,
      privateDirectory,
    );
    const runtime = createRuntimeInvoker();
    const service = createService(runtime, { outputDirectoryAuthorizations });
    const context = await syncService(service);

    const transcriptionResult = await service.transcribe(
      createTranscriptionPayload({
        outputPathMode: "custom_dir",
        outputDirToken,
      }),
      context,
    );
    const speechResult = await service.synthesizeSpeech(
      createSpeechPayload({
        outputPathMode: "custom_dir",
        outputDirToken,
      }),
      context,
    );

    expect(runtime.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPathMode: "custom_dir",
        outputDir: privateDirectory,
      }),
      expect.any(Object),
    );
    expect(runtime.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPathMode: "custom_dir",
        outputDir: privateDirectory,
      }),
      expect.any(Object),
    );
    const transcriptionRuntimePayload = vi.mocked(runtime.transcribe).mock
      .calls[0]![0];
    const speechRuntimePayload = vi.mocked(runtime.synthesize).mock.calls[0]![0];
    expect(transcriptionRuntimePayload).not.toHaveProperty("outputDirToken");
    expect(speechRuntimePayload).not.toHaveProperty("outputDirToken");
    expect(outputDirectoryAuthorizations.resolve).toHaveBeenNthCalledWith(
      1,
      TEST_OWNER_ID,
      outputDirToken,
    );
    expect(outputDirectoryAuthorizations.resolve).toHaveBeenNthCalledWith(
      2,
      TEST_OWNER_ID,
      outputDirToken,
    );
    for (const publicResult of [transcriptionResult, speechResult]) {
      expect(publicResult).toMatchObject({
        ok: true,
        data: { outputToken: expect.any(String) },
      });
      expectNoPathKeys(publicResult);
      expect(JSON.stringify(publicResult)).not.toContain(privateDirectory);
    }
  });

  it("rejects wrong-owner and invalid directory tokens before runtime or controllers", async () => {
    const outputDirectoryAuthorizations =
      createOutputDirectoryAuthorizations();
    outputDirectoryAuthorizations.seed(
      TEST_OWNER_ID,
      "owned_output_dir_token",
      "/private/audio/owned",
    );
    const runtime = createRuntimeInvoker();
    const service = createService(runtime, { outputDirectoryAuthorizations });
    const wrongOwnerContext = await syncService(
      service,
      createRuntimeConfigSnapshot(),
      TEST_OWNER_ID + 1,
    );
    const ownerContext = await syncService(service);

    const wrongOwnerResult = await service.synthesizeSpeech(
      createSpeechPayload({
        requestId: "speech_wrong_owner",
        outputPathMode: "custom_dir",
        outputDirToken: "owned_output_dir_token",
      }),
      wrongOwnerContext,
    );
    const invalidTokenResult = await service.synthesizeSpeech(
      createSpeechPayload({
        requestId: "speech_invalid_token",
        outputPathMode: "custom_dir",
        outputDirToken: "missing_output_dir_token",
      }),
      ownerContext,
    );

    for (const result of [wrongOwnerResult, invalidTokenResult]) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_ipc_request",
          field: "outputDirToken",
        },
      });
      expectNoPathKeys(result);
    }
    expect(runtime.synthesize).not.toHaveBeenCalled();
    await expect(
      service.cancelSpeechSynthesis(
        { requestId: "speech_wrong_owner" },
        wrongOwnerContext,
      ),
    ).resolves.toMatchObject({ ok: true, data: { cancelled: false } });
    await expect(
      service.cancelSpeechSynthesis(
        { requestId: "speech_invalid_token" },
        ownerContext,
      ),
    ).resolves.toMatchObject({ ok: true, data: { cancelled: false } });
  });

  it("releases output directory tokens with their renderer owner", async () => {
    const outputDirectoryAuthorizations =
      createOutputDirectoryAuthorizations();
    outputDirectoryAuthorizations.seed(
      TEST_OWNER_ID,
      "released_output_dir_token",
      "/private/audio/released",
    );
    const runtime = createRuntimeInvoker();
    const service = createService(runtime, { outputDirectoryAuthorizations });

    service.releaseOwner(TEST_OWNER_ID);
    const context = await syncService(service);
    const result = await service.synthesizeSpeech(
      createSpeechPayload({
        outputPathMode: "custom_dir",
        outputDirToken: "released_output_dir_token",
      }),
      context,
    );

    expect(outputDirectoryAuthorizations.releaseOwner).toHaveBeenCalledWith(
      TEST_OWNER_ID,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request", field: "outputDirToken" },
    });
    expect(runtime.synthesize).not.toHaveBeenCalled();
  });

  it("publicizes stream completion before sending it and reuses its output token", async () => {
    const privateOutputPath = "/private/audio/streamed-speech.wav";
    const send = vi.fn();
    const webContents = {
      isDestroyed: vi.fn(() => false),
      send,
    } as unknown as WebContents;
    const completedResult = {
      outputPath: privateOutputPath,
      mimeType: "audio/wav",
      responseFormat: "pcm16" as const,
      sizeBytes: 128,
    };
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn(),
      synthesize: vi.fn(async (_payload, options) => {
        await options.onStreamEvent?.({
          type: "completed",
          requestId: options.requestId ?? "missing",
          result: completedResult,
        });
        expect(send).toHaveBeenCalledTimes(1);
        expectNoPathKeys(send.mock.calls[0]![1]);
        expect(JSON.stringify(send.mock.calls[0]![1])).not.toContain(
          privateOutputPath,
        );
        return completedResult;
      }),
    };
    const service = createService(runtime);
    const context = await syncService(service);

    const result = await service.synthesizeSpeechStream(
      {
        requestId: "stream_completed_001",
        payload: createSpeechPayload({
          stream: true,
          responseFormat: "pcm16",
        }),
      },
      webContents,
      context,
    );

    expect(send).toHaveBeenCalledWith(
      "audio:speech-synthesis-stream",
      expect.objectContaining({
        type: "completed",
        result: expect.objectContaining({ outputToken: expect.any(String) }),
      }),
    );
    const publicEvent = send.mock.calls[0]![1] as {
      result: { outputToken: string };
    };
    expect(result).toMatchObject({
      ok: true,
      data: { outputToken: publicEvent.result.outputToken },
    });
    expectNoPathKeys(publicEvent);
    expectNoPathKeys(result);
    expect(JSON.stringify([publicEvent, result])).not.toContain(
      privateOutputPath,
    );
  });

  it("removes nested sensitive fields from provider raw results", async () => {
    const runtime = createRuntimeInvoker();
    vi.mocked(runtime.transcribe).mockResolvedValueOnce({
      text: "transcribed",
      responseFormat: "json",
      outputPath: "/private/audio/transcript.json",
      rawJson: {
        text: "transcribed",
        nested: {
          outputPath: "/private/audio/nested.json",
          authorization: "Bearer provider-secret",
          segmentCount: 2,
        },
        value: "Bearer provider-secret",
        debug: "/private/audio/output.wav",
      },
    });
    const service = createService(runtime);
    const context = await syncService(service);

    const result = await service.transcribe(createTranscriptionPayload(), context);

    expect(result).toMatchObject({
      ok: true,
      data: {
        rawJson: {
          text: "transcribed",
          nested: { segmentCount: 2 },
          value: "[redacted]",
          debug: "[redacted]",
        },
      },
    });
    expectNoPathKeys(result);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("/private/audio");
  });

  it("rejects a wrong output owner without revoking the legitimate token", async () => {
    const revealOutput = vi.fn();
    const service = createService(createRuntimeInvoker(), { revealOutput });
    const ownerContext = await syncService(service);
    const otherContext = await syncService(
      service,
      createRuntimeConfigSnapshot(),
      TEST_OWNER_ID + 1,
    );
    const speechResult = await service.synthesizeSpeech(
      createSpeechPayload(),
      ownerContext,
    );
    if (!speechResult.ok) throw new Error(speechResult.error.message);

    await expect(service.revealOutput(
      { outputToken: speechResult.data.outputToken },
      otherContext,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request", field: "outputToken" },
    });
    await expect(service.revealOutput(
      { outputToken: speechResult.data.outputToken },
      ownerContext,
    )).resolves.toEqual({ ok: true, data: { revealed: true } });
    expect(revealOutput).toHaveBeenCalledTimes(1);
  });

  it("revokes result tokens when their renderer owner is released", async () => {
    const revealOutput = vi.fn();
    const service = createService(createRuntimeInvoker(), { revealOutput });
    const context = await syncService(service);
    const speechResult = await service.synthesizeSpeech(
      createSpeechPayload(),
      context,
    );
    if (!speechResult.ok) throw new Error(speechResult.error.message);

    service.releaseOwner(TEST_OWNER_ID);
    const result = await service.revealOutput(
      { outputToken: speechResult.data.outputToken },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request", field: "outputToken" },
    });
    expect(revealOutput).not.toHaveBeenCalled();
  });

  it("does not expose an output path when reading a missing authorized file", async () => {
    const privateOutputPath = "/private/audio/missing-output.wav";
    const runtime = createRuntimeInvoker();
    vi.mocked(runtime.synthesize).mockResolvedValueOnce({
      outputPath: privateOutputPath,
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: 12,
    });
    const service = createService(runtime);
    const context = await syncService(service);
    const speechResult = await service.synthesizeSpeech(
      createSpeechPayload(),
      context,
    );
    if (!speechResult.ok) throw new Error(speechResult.error.message);

    const result = await service.readOutput(
      { outputToken: speechResult.data.outputToken },
      context,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "network_error",
        message: "Audio IPC handler failed.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateOutputPath);
  });

  it("rejects unsupported OpenAI transcription fields before file authorization", async () => {
    const runtime = createRuntimeInvoker();
    const fileAuthorizations = createFileAuthorizations();
    const service = createService(runtime, { fileAuthorizations });
    const context = await syncService(service);

    for (const [payload, field] of [
      [createTranscriptionPayload({ responseFormat: "text" }), "responseFormat"],
      [
        createTranscriptionPayload({ timestampGranularities: ["word"] }),
        "timestampGranularities",
      ],
    ] as const) {
      await expect(service.transcribe(payload, context)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_task_parameters", field },
      });
    }

    expect(fileAuthorizations.resolve).not.toHaveBeenCalled();
    expect(runtime.transcribe).not.toHaveBeenCalled();
  });

  it("rejects unsupported MiMo transcription prompt and language before file authorization", async () => {
    const runtime = createRuntimeInvoker();
    const fileAuthorizations = createFileAuthorizations();
    const service = createService(runtime, { fileAuthorizations });
    const snapshot = createRuntimeConfigSnapshot();
    snapshot.assignment.transcription = "audio_mimo";
    const context = await syncService(service, snapshot);

    for (const [payload, field] of [
      [createTranscriptionPayload({ prompt: "Meeting context" }), "prompt"],
      [createTranscriptionPayload({ language: "fr" }), "language"],
    ] as const) {
      await expect(service.transcribe(payload, context)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_task_parameters", field },
      });
    }

    expect(fileAuthorizations.resolve).not.toHaveBeenCalled();
    expect(runtime.transcribe).not.toHaveBeenCalled();
  });

  it("rejects streaming for custom compatible transcription before file authorization", async () => {
    const runtime = createRuntimeInvoker();
    const fileAuthorizations = createFileAuthorizations();
    const service = createService(runtime, { fileAuthorizations });
    const snapshot = createRuntimeConfigSnapshot();
    snapshot.profiles[0]!.providerPreset = "custom_openai_compatible";
    const context = await syncService(service, snapshot);

    const result = await service.transcribe(
      createTranscriptionPayload({ stream: true }),
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_task_parameters", field: "stream" },
    });
    expect(fileAuthorizations.resolve).not.toHaveBeenCalled();
    expect(runtime.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    { stream: true, responseFormat: "wav" as const },
    { stream: false, responseFormat: "pcm16" as const },
  ])(
    "rejects MiMo stream=$stream with $responseFormat before runtime work",
    async ({ stream, responseFormat }) => {
      const runtime = createRuntimeInvoker();
      const fileAuthorizations = createFileAuthorizations();
      const outputDirectoryAuthorizations =
        createOutputDirectoryAuthorizations();
      const service = createService(runtime, {
        fileAuthorizations,
        outputDirectoryAuthorizations,
      });
      const context = await syncService(service);

      const result = await service.synthesizeSpeech(
        createSpeechPayload({ stream, responseFormat }),
        context,
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_task_parameters", field: "responseFormat" },
      });
      expect(fileAuthorizations.resolve).not.toHaveBeenCalled();
      expect(fileAuthorizations.consume).not.toHaveBeenCalled();
      expect(outputDirectoryAuthorizations.resolve).not.toHaveBeenCalled();
      expect(runtime.synthesize).not.toHaveBeenCalled();
    },
  );

  it("maps all MiMo speech intents to trusted models and adapter payloads", async () => {
    const cases: Array<{
      intent: CreateSpeechSynthesisIpcRequest["intent"];
      model: string;
      expectedOptions: Record<string, unknown>;
    }> = [
      {
        intent: {
          mode: "preset_voice",
          voice: "mimo_default",
          styleInstruction: "calm",
        },
        model: "mimo-v2.5-tts",
        expectedOptions: { mode: "preset_voice", styleInstruction: "calm" },
      },
      {
        intent: {
          mode: "voice_design",
          voiceDesignPrompt: "warm narrator",
          optimizeTextPreview: true,
        },
        model: "mimo-v2.5-tts-voicedesign",
        expectedOptions: {
          mode: "voice_design",
          voiceDesignPrompt: "warm narrator",
          optimizeTextPreview: true,
        },
      },
      {
        intent: {
          mode: "voice_clone",
          voiceSampleToken: "single_use_voice_sample",
          styleInstruction: "steady",
        },
        model: "mimo-v2.5-tts-voiceclone",
        expectedOptions: {
          mode: "voice_clone",
          styleInstruction: "steady",
          voiceSamplePath: "/tmp/speech.wav",
          voiceSampleMime: "audio/wav",
        },
      },
    ];

    for (const testCase of cases) {
      const runtime = createRuntimeInvoker();
      const fileAuthorizations = createFileAuthorizations();
      const service = createService(runtime, { fileAuthorizations });
      const context = await syncService(service);

      await expect(service.synthesizeSpeech(
        createSpeechPayload({ intent: testCase.intent }),
        context,
      )).resolves.toMatchObject({ ok: true });
      expect(runtime.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({
          mimoOptions: expect.objectContaining(testCase.expectedOptions),
        }),
        expect.objectContaining({
          model: expect.objectContaining({ modelKey: testCase.model }),
        }),
      );
      if (testCase.intent.mode === "voice_clone") {
        expect(fileAuthorizations.consume).toHaveBeenCalledWith(
          TEST_OWNER_ID,
          testCase.intent.voiceSampleToken,
          "mimo_chat_audio",
        );
      } else {
        expect(fileAuthorizations.consume).not.toHaveBeenCalled();
      }
    }
  });

  it.each([{ stream: false }, { stream: true }])(
    "rejects duplicate voice-clone stream=$stream before consuming another token",
    async ({ stream }) => {
      const runtime: AudioRuntimeInvoker = {
        transcribe: vi.fn(),
        synthesize: vi.fn((_payload, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              reject(createAudioRuntimeError({
                code: "aborted",
                message: "Speech synthesis was aborted.",
              }));
            });
          })),
      };
      const fileAuthorizations = createFileAuthorizations();
      const service = createService(runtime, { fileAuthorizations });
      const context = await syncService(service);
      const requestId = stream ? "duplicate_clone_stream" : "duplicate_clone";
      const payload = createSpeechPayload({
        requestId,
        stream,
        responseFormat: stream ? "pcm16" : "wav",
        intent: {
          mode: "voice_clone",
          voiceSampleToken: "single_use_duplicate",
        },
      });
      const webContents = createWebContentsMock();

      const first = stream
        ? service.synthesizeSpeechStream(
            { requestId, payload },
            webContents,
            context,
          )
        : service.synthesizeSpeech(payload, context);
      await waitFor(() => expect(runtime.synthesize).toHaveBeenCalledTimes(1));
      const duplicate = stream
        ? await service.synthesizeSpeechStream(
            { requestId, payload },
            webContents,
            context,
          )
        : await service.synthesizeSpeech(payload, context);

      expect(duplicate).toMatchObject({
        ok: false,
        error: { code: "invalid_ipc_request", field: "requestId" },
      });
      expect(fileAuthorizations.consume).toHaveBeenCalledTimes(1);
      service.releaseOwner(TEST_OWNER_ID);
      await expect(first).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
    },
  );

  it("does not revive transcription after its owner is released during file authorization", async () => {
    const fileAuthorization = createDeferred<{
      filePath: string;
      fileName: string;
      extension: string;
      mimeType: "audio/wav";
      sizeBytes: number;
      base64EncodedBytes: number;
    }>();
    const fileAuthorizations = createFileAuthorizations();
    vi.mocked(fileAuthorizations.resolve).mockImplementationOnce(
      () => fileAuthorization.promise,
    );
    const runtime = createRuntimeInvoker();
    const service = createService(runtime, { fileAuthorizations });
    const context = await syncService(service);

    const pending = service.transcribe(createTranscriptionPayload(), context);
    await waitFor(() => expect(fileAuthorizations.resolve).toHaveBeenCalled());
    service.releaseOwner(TEST_OWNER_ID);
    fileAuthorization.resolve({
      filePath: "/private/audio/input.wav",
      fileName: "input.wav",
      extension: "wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      base64EncodedBytes: 172,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(runtime.transcribe).not.toHaveBeenCalled();
    expect(fileAuthorizations.releaseOwner).toHaveBeenCalledWith(TEST_OWNER_ID);
  });

  it.each([{ stream: false }, { stream: true }])(
    "does not revive speech stream=$stream after owner release during directory authorization",
    async ({ stream }) => {
      const directoryAuthorization = createDeferred<string>();
      const outputDirectoryAuthorizations =
        createOutputDirectoryAuthorizations();
      vi.mocked(outputDirectoryAuthorizations.resolve).mockImplementationOnce(
        () => directoryAuthorization.promise,
      );
      const runtime = createRuntimeInvoker();
      const service = createService(runtime, {
        outputDirectoryAuthorizations,
      });
      const context = await syncService(service);
      const payload = createSpeechPayload({
        outputPathMode: "custom_dir",
        outputDirToken: "pending_output_dir_token",
        stream,
        responseFormat: stream ? "pcm16" : "wav",
      });
      const webContents = createWebContentsMock();

      const pending = stream
        ? service.synthesizeSpeechStream(
            { requestId: "pending_stream", payload },
            webContents,
            context,
          )
        : service.synthesizeSpeech(payload, context);
      await waitFor(() =>
        expect(outputDirectoryAuthorizations.resolve).toHaveBeenCalled());
      service.releaseOwner(TEST_OWNER_ID);
      directoryAuthorization.resolve("/private/audio/late-output");

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      expect(runtime.synthesize).not.toHaveBeenCalled();
      expect(webContents.send).not.toHaveBeenCalled();
    },
  );

  it("cancels transcription while input authorization is pending", async () => {
    const fileAuthorization = createDeferred<{
      filePath: string;
      fileName: string;
      extension: string;
      mimeType: "audio/wav";
      sizeBytes: number;
      base64EncodedBytes: number;
    }>();
    const fileAuthorizations = createFileAuthorizations();
    vi.mocked(fileAuthorizations.resolve).mockImplementationOnce(
      () => fileAuthorization.promise,
    );
    const runtime = createRuntimeInvoker();
    const service = createService(runtime, { fileAuthorizations });
    const context = await syncService(service);

    const pending = service.transcribe(
      createTranscriptionPayload({ requestId: "pending_asr_cancel" }),
      context,
    );
    await waitFor(() => expect(fileAuthorizations.resolve).toHaveBeenCalled());

    await expect(service.cancelTranscription(
      { requestId: "pending_asr_cancel" },
      context,
    )).resolves.toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "pending_asr_cancel" },
    });
    fileAuthorization.resolve({
      filePath: "/private/audio/input.wav",
      fileName: "input.wav",
      extension: "wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      base64EncodedBytes: 172,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(runtime.transcribe).not.toHaveBeenCalled();
  });

  it.each([{ stream: false }, { stream: true }])(
    "cancels speech stream=$stream while directory authorization is pending",
    async ({ stream }) => {
      const directoryAuthorization = createDeferred<string>();
      const outputDirectoryAuthorizations =
        createOutputDirectoryAuthorizations();
      vi.mocked(outputDirectoryAuthorizations.resolve).mockImplementationOnce(
        () => directoryAuthorization.promise,
      );
      const runtime = createRuntimeInvoker();
      const service = createService(runtime, {
        outputDirectoryAuthorizations,
      });
      const context = await syncService(service);
      const requestId = stream
        ? "pending_stream_cancel"
        : "pending_speech_cancel";
      const payload = createSpeechPayload({
        requestId,
        outputPathMode: "custom_dir",
        outputDirToken: "pending_output_dir_token",
        stream,
        responseFormat: stream ? "pcm16" : "wav",
      });
      const webContents = createWebContentsMock();

      const pending = stream
        ? service.synthesizeSpeechStream(
            { requestId, payload },
            webContents,
            context,
          )
        : service.synthesizeSpeech(payload, context);
      await waitFor(() =>
        expect(outputDirectoryAuthorizations.resolve).toHaveBeenCalled());

      const cancelResult = stream
        ? await service.cancelSpeechSynthesisStream({ requestId }, context)
        : await service.cancelSpeechSynthesis({ requestId }, context);
      expect(cancelResult).toMatchObject({
        ok: true,
        data: { cancelled: true, requestId },
      });
      directoryAuthorization.resolve("/private/audio/cancelled-output");

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      expect(runtime.synthesize).not.toHaveBeenCalled();
      expect(webContents.send).not.toHaveBeenCalled();
    },
  );

  it("returns aborted when cancelled transcription authorization rejects", async () => {
    const fileAuthorization = createDeferred<{
      filePath: string;
      fileName: string;
      extension: string;
      mimeType: "audio/wav";
      sizeBytes: number;
      base64EncodedBytes: number;
    }>();
    const fileAuthorizations = createFileAuthorizations();
    vi.mocked(fileAuthorizations.resolve).mockImplementationOnce(
      () => fileAuthorization.promise,
    );
    const runtime = createRuntimeInvoker();
    const service = createService(runtime, { fileAuthorizations });
    const context = await syncService(service);
    const requestId = "pending_asr_reject_cancel";

    const pending = service.transcribe(
      createTranscriptionPayload({ requestId }),
      context,
    );
    await waitFor(() => expect(fileAuthorizations.resolve).toHaveBeenCalled());
    await service.cancelTranscription({ requestId }, context);
    fileAuthorization.reject(createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "Late file authorization failure.",
    }));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(runtime.transcribe).not.toHaveBeenCalled();
  });

  it.each([{ stream: false }, { stream: true }])(
    "returns aborted when cancelled speech stream=$stream authorization rejects",
    async ({ stream }) => {
      const directoryAuthorization = createDeferred<string>();
      const outputDirectoryAuthorizations =
        createOutputDirectoryAuthorizations();
      vi.mocked(outputDirectoryAuthorizations.resolve).mockImplementationOnce(
        () => directoryAuthorization.promise,
      );
      const runtime = createRuntimeInvoker();
      const service = createService(runtime, {
        outputDirectoryAuthorizations,
      });
      const context = await syncService(service);
      const requestId = stream
        ? "pending_stream_reject_cancel"
        : "pending_speech_reject_cancel";
      const payload = createSpeechPayload({
        requestId,
        outputPathMode: "custom_dir",
        outputDirToken: "pending_output_dir_token",
        stream,
        responseFormat: stream ? "pcm16" : "wav",
      });
      const webContents = createWebContentsMock();

      const pending = stream
        ? service.synthesizeSpeechStream(
            { requestId, payload },
            webContents,
            context,
          )
        : service.synthesizeSpeech(payload, context);
      await waitFor(() =>
        expect(outputDirectoryAuthorizations.resolve).toHaveBeenCalled());
      if (stream) {
        await service.cancelSpeechSynthesisStream({ requestId }, context);
      } else {
        await service.cancelSpeechSynthesis({ requestId }, context);
      }
      directoryAuthorization.reject(createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "Late output directory authorization failure.",
      }));

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      expect(runtime.synthesize).not.toHaveBeenCalled();
      expect(webContents.send).not.toHaveBeenCalled();
    },
  );

  it("tracks and aborts runtime work even when requestId is omitted", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(createAudioRuntimeError({
              code: "aborted",
              message: "Audio transcription was aborted.",
            }));
          });
        });
      }),
      synthesize: vi.fn(),
    };
    const service = createService(runtime);
    const context = await syncService(service);

    const pending = service.transcribe(createTranscriptionPayload(), context);
    await waitFor(() => expect(abortSignal).toBeDefined());
    service.releaseOwner(TEST_OWNER_ID);

    expect(abortSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it.each(["transcription", "speech", "stream"] as const)(
    "removes late %s output when runtime ignores owner abort",
    async (kind) => {
      const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), "fusionkit-late-audio-output-"),
      );
      const outputPath = path.join(tempRoot, "late-output.wav");
      await writeFile(outputPath, "late output");
      const deferred = createDeferred<
        AudioTranscriptionResult | SpeechSynthesisResult
      >();
      const runtime: AudioRuntimeInvoker = {
        transcribe: vi.fn(async () =>
          deferred.promise as Promise<AudioTranscriptionResult>),
        synthesize: vi.fn(async (_payload, options) => {
          const result = await deferred.promise as SpeechSynthesisResult;
          if (kind === "stream") {
            await options.onStreamEvent?.({
              type: "completed",
              requestId: options.requestId ?? "missing",
              result,
            });
          }
          return result;
        }),
      };
      const service = createService(runtime);
      const context = await syncService(service);
      const webContents = createWebContentsMock();

      const pending = kind === "transcription"
        ? service.transcribe(createTranscriptionPayload(), context)
        : kind === "stream"
          ? service.synthesizeSpeechStream(
              {
                requestId: "late_stream",
                payload: createSpeechPayload({
                  stream: true,
                  responseFormat: "pcm16",
                }),
              },
              webContents,
              context,
            )
          : service.synthesizeSpeech(createSpeechPayload(), context);
      await waitFor(() => {
        const callCount = kind === "transcription"
          ? vi.mocked(runtime.transcribe).mock.calls.length
          : vi.mocked(runtime.synthesize).mock.calls.length;
        expect(callCount).toBe(1);
      });
      service.releaseOwner(TEST_OWNER_ID);
      deferred.resolve(kind === "transcription"
        ? {
            text: "late transcript",
            responseFormat: "json",
            outputPath,
          }
        : {
            outputPath,
            mimeType: "audio/wav",
            responseFormat: kind === "stream" ? "pcm16" : "wav",
            sizeBytes: 11,
          });

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(webContents.send).not.toHaveBeenCalled();
      await rm(tempRoot, { recursive: true, force: true });
    },
  );

  it("emits streaming speech events and supports request cancellation", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn(),
      synthesize: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.onStreamEvent?.({
            type: "started",
            requestId: options.requestId ?? "missing",
            sampleRate: 24000,
            channels: 1,
          });
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Audio request was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              outputPath: "/tmp/speech.wav",
              mimeType: "audio/wav",
              responseFormat: "pcm16",
              sizeBytes: 44,
            });
          }, 100);
        });
      }),
    };
    const service = createService(runtime);
    const context = await syncService(service);
    const webContents = createWebContentsMock();

    const streamPromise = service.synthesizeSpeechStream(
      {
        requestId: "stream_req_001",
        payload: createSpeechPayload({ stream: true, responseFormat: "pcm16" }),
      },
      webContents,
      context,
    );
    await waitFor(() => expect(webContents.send).toHaveBeenCalledTimes(1));
    expect(webContents.send).toHaveBeenCalledWith(
      "audio:speech-synthesis-stream",
      expect.objectContaining({
        type: "started",
        requestId: "stream_req_001",
      }),
    );

    const cancelResult = await service.cancelSpeechSynthesisStream(
      { requestId: "stream_req_001" },
      context,
    );
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "stream_req_001" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(streamPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it("supports cancelling active transcription requests", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Audio transcription was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              text: "late transcription",
              responseFormat: "json",
            });
          }, 100);
        });
      }),
      synthesize: vi.fn(),
    };
    const service = createService(runtime);
    const context = await syncService(service);

    const transcriptionPromise = service.transcribe(
      createTranscriptionPayload({ requestId: "asr_req_001" }),
      context,
    );
    await waitFor(() => expect(abortSignal).toBeDefined());

    const cancelResult = await service.cancelTranscription(
      { requestId: "asr_req_001" },
      context,
    );
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "asr_req_001" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(transcriptionPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it("transcribes recorded chunks through the realtime captions assignment", async () => {
    const runtime = createRuntimeInvoker();
    const service = createService(runtime);
    const context = await syncService(service);

    const result = await service.transcribeRecordedChunk(
      {
        assignmentKey: "realtimeCaptions",
        requestId: "chunk_req_001",
        audioBytes: new Uint8Array([82, 73, 70, 70]),
        mimeType: "audio/wav",
        responseFormat: "text",
        language: "zh",
        startedAtMs: 0,
        endedAtMs: 5000,
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        requestId: "chunk_req_001",
        text: "transcribed",
        responseFormat: "text",
        startedAtMs: 0,
        endedAtMs: 5000,
      },
    });
    expect(runtime.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentKey: "transcription",
        requestId: "chunk_req_001",
        mimeType: "audio/wav",
        responseFormat: "text",
        language: "zh",
      }),
      expect.objectContaining({
        model: expect.objectContaining({
          modelKey: "mimo-v2.5-asr",
          audioDialect: "mimo_chat_audio",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("sk-audio-ipc");
  });

  it("rejects unsupported recorded chunk language before runtime work", async () => {
    const runtime = createRuntimeInvoker();
    const service = createService(runtime);
    const context = await syncService(service);

    const result = await service.transcribeRecordedChunk(
      {
        assignmentKey: "realtimeCaptions",
        requestId: "chunk_invalid_language",
        audioBytes: new Uint8Array([82, 73, 70, 70]),
        mimeType: "audio/wav",
        responseFormat: "text",
        language: "fr",
      },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_task_parameters", field: "language" },
    });
    expect(runtime.transcribe).not.toHaveBeenCalled();
  });

  it("supports cancelling active recorded chunk transcription requests", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Recorded chunk transcription was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              text: "late chunk",
              responseFormat: "text",
            });
          }, 100);
        });
      }),
      synthesize: vi.fn(),
    };
    const service = createService(runtime);
    const context = await syncService(service);

    const chunkPromise = service.transcribeRecordedChunk(
      {
        assignmentKey: "realtimeCaptions",
        requestId: "chunk_req_002",
        audioBytes: new Uint8Array([82, 73, 70, 70]),
        mimeType: "audio/wav",
        responseFormat: "text",
      },
      context,
    );
    await waitFor(() => expect(abortSignal).toBeDefined());

    const cancelResult = await service.cancelRecordedChunkTranscription(
      { requestId: "chunk_req_002" },
      context,
    );
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "chunk_req_002" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(chunkPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it("supports cancelling active non-stream speech requests", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn(),
      synthesize: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Speech synthesis was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              outputPath: "/tmp/speech.wav",
              mimeType: "audio/wav",
              responseFormat: "wav",
              sizeBytes: 44,
            });
          }, 100);
        });
      }),
    };
    const service = createService(runtime);
    const context = await syncService(service);

    const speechPromise = service.synthesizeSpeech(
      createSpeechPayload({ requestId: "speech_req_001" }),
      context,
    );
    await waitFor(() => expect(abortSignal).toBeDefined());

    const cancelResult = await service.cancelSpeechSynthesis(
      { requestId: "speech_req_001" },
      context,
    );
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "speech_req_001" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(speechPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });
});

function createRuntimeInvoker(): AudioRuntimeInvoker {
  return {
    transcribe: vi.fn(async (_payload, options) => ({
      text: "transcribed",
      responseFormat: "json",
      outputPath: "/tmp/transcript.json",
      model: options.model.modelKey,
    })),
    synthesize: vi.fn(async (_payload, options) => ({
      outputPath: "/tmp/speech.wav",
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: 12,
      model: options.model.modelKey,
    })),
  };
}

function createRuntimeConfigSnapshot(): SyncAudioRuntimeConfigRequest {
  return {
    profiles: [
      {
        id: "audio_openai",
        providerPreset: "openai",
        apiKey: "sk-audio-ipc",
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
      {
        id: "audio_mimo",
        providerPreset: "mimo",
        apiKey: "sk-mimo-ipc",
        baseUrl: "https://api.xiaomimimo.com/v1",
        routes: {
          transcription: {
            transport: "mimo_chat_audio",
            model: "mimo-v2.5-asr",
            enabled: true,
          },
          speechSynthesis: {
            preset_voice: {
              transport: "mimo_chat_audio",
              model: "mimo-v2.5-tts",
              enabled: true,
            },
            voice_design: {
              transport: "mimo_chat_audio",
              model: "mimo-v2.5-tts-voicedesign",
              enabled: true,
            },
            voice_clone: {
              transport: "mimo_chat_audio",
              model: "mimo-v2.5-tts-voiceclone",
              enabled: true,
            },
          },
          realtimeCaptions: {
            transport: "mimo_chat_audio",
            model: "mimo-v2.5-asr",
            enabled: true,
          },
        },
      },
    ],
    assignment: {
      transcription: "audio_openai",
      speechSynthesis: "audio_mimo",
      realtimeCaptions: "audio_mimo",
      realtimeVoice: null,
    },
  };
}

function createTranscriptionPayload(
  overrides: Partial<CreateAudioTranscriptionIpcRequest> = {},
): CreateAudioTranscriptionIpcRequest {
  return {
    assignmentKey: "transcription",
    fileToken: "file_token_test",
    fileName: "speech.wav",
    mimeType: "audio/wav",
    responseFormat: "json",
    ...overrides,
  };
}

function createService(
  runtime: AudioRuntimeInvoker,
  options: Omit<AudioIpcServiceOptions, "runtime" | "configStore"> = {},
): AudioIpcService {
  return new AudioIpcService({
    runtime,
    fileAuthorizations: createFileAuthorizations(),
    ...options,
  });
}

function createFileAuthorizations(): AudioInputFileAuthorizations {
  const resolve = vi.fn(async () => ({
    filePath: "/tmp/speech.wav",
    fileName: "speech.wav",
    extension: "wav",
    mimeType: "audio/wav" as const,
    sizeBytes: 128,
    base64EncodedBytes: 172,
  }));
  return {
    authorize: vi.fn(),
    resolve,
    consume: vi.fn((ownerId, fileToken, dialect) =>
      resolve(ownerId, fileToken, dialect)),
    revoke: vi.fn(),
    releaseOwner: vi.fn(),
  };
}

function createOutputDirectoryAuthorizations() {
  const entries = new Map<
    string,
    { ownerId: number; directoryPath: string }
  >();
  let tokenSequence = 0;

  const authorizations = {
    authorize: vi.fn(async (ownerId: number, directoryPath: string) => {
      tokenSequence += 1;
      const outputDirToken = `output_dir_token_${tokenSequence}`;
      entries.set(outputDirToken, { ownerId, directoryPath });
      return {
        outputDirToken,
        directoryName: directoryPath.split("/").filter(Boolean).at(-1) ?? "/",
        expiresAt: 31_000,
      };
    }),
    resolve: vi.fn(async (ownerId: number, outputDirToken: string) => {
      const entry = entries.get(outputDirToken);
      if (!entry || entry.ownerId !== ownerId) {
        throw createAudioRuntimeError({
          code: "invalid_ipc_request",
          message: "Audio output directory authorization is invalid or expired.",
          field: "outputDirToken",
        });
      }
      return entry.directoryPath;
    }),
    revoke: vi.fn((ownerId: number, outputDirToken: string) => {
      const entry = entries.get(outputDirToken);
      if (entry?.ownerId === ownerId) entries.delete(outputDirToken);
    }),
    releaseOwner: vi.fn((ownerId: number) => {
      for (const [token, entry] of entries) {
        if (entry.ownerId === ownerId) entries.delete(token);
      }
    }),
    seed(ownerId: number, outputDirToken: string, directoryPath: string) {
      entries.set(outputDirToken, { ownerId, directoryPath });
    },
  };

  return authorizations satisfies AudioOutputDirectoryAuthorizations & {
    seed(
      ownerId: number,
      outputDirToken: string,
      directoryPath: string,
    ): void;
  };
}

function createSpeechPayload(
  overrides: Partial<CreateSpeechSynthesisIpcRequest> = {},
): CreateSpeechSynthesisIpcRequest {
  return {
    assignmentKey: "speechSynthesis",
    input: "hello",
    intent: { mode: "preset_voice", voice: "alloy" },
    responseFormat: "wav",
    ...overrides,
  };
}

async function syncService(
  service: AudioIpcService,
  snapshot: SyncAudioRuntimeConfigRequest = createRuntimeConfigSnapshot(),
  senderId = TEST_OWNER_ID,
): Promise<AudioIpcClientContext> {
  const result = await service.syncRuntimeConfig(
    snapshot,
    { senderId },
  );
  if (!result.ok) throw new Error(result.error.message);
  return {
    senderId,
    configRevision: result.data.revision,
  };
}

function expectNoPathKeys(value: unknown): void {
  expect(findPathKey(value)).toBeUndefined();
}

function findPathKey(value: unknown, prefix = "root"): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPathKey(item, `${prefix}.${index}`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  for (const [key, item] of Object.entries(value)) {
    const field = `${prefix}.${key}`;
    if (key === "outputPath" || key === "path") return field;
    const found = findPathKey(item, field);
    if (found) return found;
  }
  return undefined;
}

function createWebContentsMock(): WebContents {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents;
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
