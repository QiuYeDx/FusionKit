import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sendAudioTranscription,
  sendSpeechSynthesis,
} from "../../electron/main/audio/audio-runtime-client";
import { AudioRuntimeClientError } from "../../electron/main/audio/audio-errors";
import {
  createAudioErrorBody,
  createMimoAsrBody,
  createMimoSpeechBody,
  createOpenAISpeechBuffer,
  createOpenAITranscriptionBody,
  startFakeAudioApiServer,
  type FakeAudioApiServer,
} from "./fakeAudioApiServer";
import { Model } from "@/type/model";
import type {
  AudioRuntimeModelConfig,
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
} from "@/type/audio";

describe("AudioRuntimeClient OpenAI adapter", () => {
  let server: FakeAudioApiServer | undefined;
  let tempRoot: string | undefined;

  beforeEach(async () => {
    server = await startFakeAudioApiServer();
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-audio-runtime-test-"),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("sends OpenAI multipart transcription requests and parses JSON results", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const filePath = path.join(activeTempRoot, "speech.wav");
    await writeFile(filePath, createOpenAISpeechBuffer("transcription"));
    activeServer.enqueueRoute("openai_transcriptions", {
      body: createOpenAITranscriptionBody({
        text: "hello audio",
        model: "whisper-1",
        segments: [{ id: 1, start: 0, end: 1.5, text: "hello audio" }],
        words: [{ word: "hello", start: 0, end: 0.5 }],
      }),
    });

    const result = await sendAudioTranscription({
      model: createOpenAIModel(activeServer.baseUrl, "whisper-1"),
      payload: createTranscriptionPayload(filePath, {
        responseFormat: "verbose_json",
        prompt: "product names",
        timestampGranularities: ["word", "segment"],
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      text: "hello audio",
      responseFormat: "verbose_json",
      model: "whisper-1",
      segments: [{ id: 1, start: 0, end: 1.5, text: "hello audio" }],
      words: [{ word: "hello", start: 0, end: 0.5 }],
    });
    expect(activeServer.requests[0].headers.authorization).toBe(
      "Bearer sk-audio-runtime",
    );
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      route: "openai_transcriptions",
      body: null,
    });
    const multipart = activeServer.requests[0].rawBody.toString("utf8");
    expect(multipart).toContain('name="model"');
    expect(multipart).toContain("whisper-1");
    expect(multipart).toContain('name="response_format"');
    expect(multipart).toContain("verbose_json");
    expect(multipart).toContain('name="timestamp_granularities[]"');
    expect(multipart).toContain("segment");
  });

  it("parses OpenAI text transcription and writes optional output", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const filePath = path.join(activeTempRoot, "lecture.mp3");
    await writeFile(filePath, Buffer.concat([
      Buffer.from("ID3", "ascii"),
      Buffer.from("audio", "utf8"),
    ]));
    activeServer.enqueueRoute("openai_transcriptions", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      rawBody: "plain transcript",
    });

    const result = await sendAudioTranscription({
      model: createOpenAIModel(activeServer.audioTranscriptionsUrl, "whisper-1"),
      payload: createTranscriptionPayload(filePath, {
        mimeType: "audio/mpeg",
        responseFormat: "text",
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      text: "plain transcript",
      responseFormat: "text",
      rawText: "plain transcript",
      outputPath: path.join(activeTempRoot, "lecture.transcript.txt"),
    });
    await expect(stat(result.outputPath ?? "")).resolves.toMatchObject({
      size: "plain transcript".length,
    });
  });

  it("sends OpenAI speech synthesis JSON and stores binary audio output", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const speechBytes = createOpenAISpeechBuffer("wav-bytes");
    activeServer.enqueueRoute("openai_speech", {
      headers: { "Content-Type": "audio/wav" },
      rawBody: speechBytes,
    });

    const result = await sendSpeechSynthesis({
      model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
      payload: createSpeechPayload({
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "spoken",
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      outputPath: path.join(activeTempRoot, "spoken.wav"),
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: speechBytes.length,
      model: "gpt-4o-mini-tts",
    });
    expect(result).not.toHaveProperty("audioBase64");
    await expect(stat(result.outputPath)).resolves.toMatchObject({
      size: speechBytes.length,
    });
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      route: "openai_speech",
      body: {
        model: "gpt-4o-mini-tts",
        input: "hello from FusionKit",
        voice: "alloy",
        response_format: "wav",
        instructions: "Warm and clear.",
        speed: 1.1,
      },
    });
    expect(activeServer.requests[0].headers.authorization).toBe(
      "Bearer sk-audio-runtime",
    );
  });

  it("retries OpenAI rate limits and keeps Retry-After metadata", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("openai_speech", {
      status: 429,
      headers: { "Retry-After": "0" },
      body: createAudioErrorBody("slow down", "rate_limit_exceeded"),
    });
    activeServer.enqueueRoute("openai_speech", {
      rawBody: createOpenAISpeechBuffer("recovered"),
    });

    const result = await sendSpeechSynthesis({
      model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
      payload: createSpeechPayload({
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
      }),
      retry: { maxRetries: 1, baseDelayMs: 1, jitterRatio: 0 },
    });

    expect(result.sizeBytes).toBe(createOpenAISpeechBuffer("recovered").length);
    expect(activeServer.requests).toHaveLength(2);
  });

  it("maps OpenAI HTTP auth failures without leaking API keys", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("openai_speech", {
      status: 401,
      body: createAudioErrorBody(
        "bad key sk-audio-runtime",
        "invalid_api_key",
        "authentication_error",
      ),
    });

    try {
      await sendSpeechSynthesis({
        model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
        payload: createSpeechPayload({
          outputPathMode: "custom_dir",
          outputDir: activeTempRoot,
        }),
        retry: { maxRetries: 1, baseDelayMs: 1, jitterRatio: 0 },
      });
      throw new Error("Expected speech synthesis to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "http_unauthorized",
        details: {
          status: 401,
          attempt: 0,
        },
      });
      expect(error).not.toHaveProperty("message", expect.stringContaining("sk-audio-runtime"));
    }
  });

  it("maps OpenAI speech timeouts", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute(
      "openai_speech",
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rawBody: "late" }), 30);
        }),
    );

    await expect(
      sendSpeechSynthesis({
        model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
        payload: createSpeechPayload({
          outputPathMode: "custom_dir",
          outputDir: activeTempRoot,
        }),
        timeoutMs: 1,
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("maps pre-aborted OpenAI speech requests", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const controller = new AbortController();
    controller.abort();
    await expect(
      sendSpeechSynthesis({
        model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
        payload: createSpeechPayload({
          outputPathMode: "custom_dir",
          outputDir: activeTempRoot,
        }),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects empty OpenAI speech responses", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("openai_speech", {
      rawBody: Buffer.alloc(0),
    });
    await expect(
      sendSpeechSynthesis({
        model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
        payload: createSpeechPayload({
          outputPathMode: "custom_dir",
          outputDir: activeTempRoot,
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: "empty_response" });
  });

  it("rejects unsupported OpenAI speech payloads", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    await expect(
      sendSpeechSynthesis({
        model: createOpenAIModel(activeServer.baseUrl, "gpt-4o-mini-tts"),
        payload: createSpeechPayload({
          responseFormat: "pcm16",
          outputPathMode: "custom_dir",
          outputDir: activeTempRoot,
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "responseFormat",
    });
  });
});

describe("AudioRuntimeClient MiMo non-stream adapter", () => {
  let server: FakeAudioApiServer | undefined;
  let tempRoot: string | undefined;

  beforeEach(async () => {
    server = await startFakeAudioApiServer();
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-mimo-runtime-test-"),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("MiMo non-stream ASR sends input_audio data URI and parses text", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const filePath = path.join(activeTempRoot, "sample.wav");
    const sampleWav = createOpenAISpeechBuffer("mimo-asr");
    await writeFile(filePath, sampleWav);
    activeServer.enqueueRoute("mimo_chat_completions", {
      body: createMimoAsrBody({
        text: "小米语音识别结果",
        model: "mimo-v2.5-asr",
      }),
    });

    const result = await sendAudioTranscription({
      model: createMimoModel(activeServer.chatCompletionsUrl, "mimo-v2.5-asr"),
      payload: createTranscriptionPayload(filePath, {
        language: "zh",
        responseFormat: "text",
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      text: "小米语音识别结果",
      rawText: "小米语音识别结果",
      responseFormat: "text",
      model: "mimo-v2.5-asr",
      outputPath: path.join(activeTempRoot, "sample.transcript.txt"),
    });
    expect(activeServer.requests[0].headers["api-key"]).toBe(
      "mimo-audio-runtime",
    );
    expect(activeServer.requests[0].headers.authorization).toBeUndefined();
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      route: "mimo_chat_completions",
      body: {
        model: "mimo-v2.5-asr",
        asr_options: { language: "zh" },
      },
    });
    const body = activeServer.requests[0].body;
    const message = (body?.messages as Array<Record<string, unknown>>)[0];
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "input_audio",
      input_audio: {
        data: `data:audio/wav;base64,${sampleWav.toString("base64")}`,
      },
    });
  });

  it("MiMo non-stream preset TTS stores decoded WAV audio", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("mimo_chat_completions", {
      body: createMimoSpeechBody({
        audioBase64: createOpenAISpeechBuffer("mimo-wav").toString("base64"),
        model: "mimo-v2.5-tts",
      }),
    });

    const result = await sendSpeechSynthesis({
      model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
      payload: createSpeechPayload({
        responseFormat: "wav",
        speed: undefined,
        voice: "Mia",
        instructions: "轻快自然",
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-preset",
        mimoOptions: {
          mode: "preset_voice",
          styleInstruction: "更亲切一点",
          audioTagsEnabled: true,
        },
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      outputPath: path.join(activeTempRoot, "mimo-preset.wav"),
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: createOpenAISpeechBuffer("mimo-wav").length,
      model: "mimo-v2.5-tts",
    });
    expect(result).not.toHaveProperty("audioBase64");
    await expect(stat(result.outputPath)).resolves.toMatchObject({
      size: createOpenAISpeechBuffer("mimo-wav").length,
    });
    expect(activeServer.requests[0].body).toMatchObject({
      model: "mimo-v2.5-tts",
      messages: [
        { role: "user", content: "更亲切一点" },
        { role: "assistant", content: "hello from FusionKit" },
      ],
      audio: {
        voice: "Mia",
        format: "wav",
      },
    });
  });

  it("uses the trusted MiMo route model without comparing it to mode defaults", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const routeModel = "mimo-custom-voice-design";
    activeServer.enqueueRoute("mimo_chat_completions", {
      body: createMimoSpeechBody({
        audioBase64: createOpenAISpeechBuffer("custom-route-wav").toString(
          "base64",
        ),
        model: routeModel,
      }),
    });

    const result = await sendSpeechSynthesis({
      model: createMimoModel(activeServer.baseUrl, routeModel),
      payload: createSpeechPayload({
        responseFormat: "wav",
        speed: undefined,
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-custom-route",
        mimoOptions: {
          mode: "voice_design",
          voiceDesignPrompt: "clear custom voice",
        },
      }),
      retry: { maxRetries: 0 },
    });

    expect(result.model).toBe(routeModel);
    expect(activeServer.requests[0].body).toMatchObject({
      model: routeModel,
      messages: [
        { role: "user", content: "clear custom voice" },
        { role: "assistant", content: "hello from FusionKit" },
      ],
    });
  });

  it("MiMo non-stream voice design maps prompt and optimizeTextPreview", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("mimo_chat_completions", {
      body: createMimoSpeechBody({
        audioBase64: createOpenAISpeechBuffer("voice-design-wav").toString("base64"),
        model: "mimo-v2.5-tts-voicedesign",
      }),
    });

    const result = await sendSpeechSynthesis({
      model: createMimoModel(
        activeServer.baseUrl,
        "mimo-v2.5-tts-voicedesign",
      ),
      payload: createSpeechPayload({
        input: "",
        responseFormat: "wav",
        speed: undefined,
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-design",
        mimoOptions: {
          mode: "voice_design",
          voiceDesignPrompt: "年轻女性，清澈，有科技感",
          optimizeTextPreview: true,
        },
      }),
      retry: { maxRetries: 0 },
    });

    expect(result.sizeBytes).toBe(
      createOpenAISpeechBuffer("voice-design-wav").length,
    );
    expect(activeServer.requests[0].body).toMatchObject({
      model: "mimo-v2.5-tts-voicedesign",
      messages: [
        { role: "user", content: "年轻女性，清澈，有科技感" },
        { role: "assistant", content: "" },
      ],
      audio: {
        format: "wav",
        optimize_text_preview: true,
      },
    });
  });

  it("MiMo non-stream voice clone sends reference audio as data URI", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const referencePath = path.join(activeTempRoot, "reference.mp3");
    const referenceBytes = Buffer.concat([
      Buffer.from("ID3", "ascii"),
      Buffer.from([5, 6, 7, 8]),
    ]);
    await writeFile(referencePath, referenceBytes);
    activeServer.enqueueRoute("mimo_chat_completions", {
      body: createMimoSpeechBody({
        audioBase64: `data:audio/wav;base64,${createOpenAISpeechBuffer("clone-wav").toString("base64")}`,
        model: "mimo-v2.5-tts-voiceclone",
      }),
    });

    const result = await sendSpeechSynthesis({
      model: createMimoModel(
        activeServer.baseUrl,
        "mimo-v2.5-tts-voiceclone",
      ),
      payload: createSpeechPayload({
        responseFormat: "wav",
        speed: undefined,
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-clone",
        mimoOptions: {
          mode: "voice_clone",
          voiceSamplePath: referencePath,
          voiceSampleMime: "audio/mpeg",
        },
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      outputPath: path.join(activeTempRoot, "mimo-clone.wav"),
      sizeBytes: createOpenAISpeechBuffer("clone-wav").length,
      model: "mimo-v2.5-tts-voiceclone",
    });
    expect(activeServer.requests[0].body).toMatchObject({
      model: "mimo-v2.5-tts-voiceclone",
      audio: {
        voice: `data:audio/mpeg;base64,${referenceBytes.toString("base64")}`,
        format: "wav",
      },
    });
  });

  it("MiMo non-stream validation blocks OpenAI-only or missing fields", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const filePath = path.join(activeTempRoot, "sample.wav");
    await writeFile(filePath, "audio");

    await expect(
      sendAudioTranscription({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-asr"),
        payload: createTranscriptionPayload(filePath, {
          language: "fr",
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: "invalid_ipc_request", field: "language" });

    await expect(
      sendAudioTranscription({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-asr"),
        payload: createTranscriptionPayload(filePath, {
          responseFormat: "srt",
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "responseFormat",
    });

    await expect(
      sendAudioTranscription({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-asr"),
        payload: createTranscriptionPayload(filePath, {
          responseFormat: "verbose_json",
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "responseFormat",
    });

    await expect(
      sendAudioTranscription({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-asr"),
        payload: createTranscriptionPayload(filePath, {
          prompt: "OpenAI-only prompt",
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_capability",
      field: "prompt",
    });

    await expect(
      sendAudioTranscription({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-asr"),
        payload: createTranscriptionPayload(filePath, {
          timestampGranularities: ["word"],
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_capability",
      field: "timestampGranularities",
    });

    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
        payload: createSpeechPayload({
          speed: 1.2,
          responseFormat: "wav",
          mimoOptions: { mode: "preset_voice" },
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_capability",
      field: "speed",
    });

    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
        payload: createSpeechPayload({
          speed: undefined,
          responseFormat: "mp3",
          mimoOptions: { mode: "preset_voice" },
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "responseFormat",
    });

    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
        payload: createSpeechPayload({
          speed: undefined,
          responseFormat: "wav",
          stream: true,
          mimoOptions: { mode: "preset_voice" },
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "responseFormat",
    });

    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(
          activeServer.baseUrl,
          "mimo-v2.5-tts-voicedesign",
        ),
        payload: createSpeechPayload({
          speed: undefined,
          responseFormat: "wav",
          mimoOptions: { mode: "voice_design" },
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "invalid_ipc_request",
      field: "mimoOptions.voiceDesignPrompt",
    });

    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(
          activeServer.baseUrl,
          "mimo-v2.5-tts-voiceclone",
        ),
        payload: createSpeechPayload({
          speed: undefined,
          responseFormat: "wav",
          mimoOptions: { mode: "voice_clone" },
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "invalid_ipc_request",
      field: "mimoOptions.voiceSamplePath",
    });

    const unsupportedReferencePath = path.join(activeTempRoot, "reference.m4a");
    await writeFile(unsupportedReferencePath, "m4a");
    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(
          activeServer.baseUrl,
          "mimo-v2.5-tts-voiceclone",
        ),
        payload: createSpeechPayload({
          speed: undefined,
          responseFormat: "wav",
          mimoOptions: {
            mode: "voice_clone",
            voiceSamplePath: unsupportedReferencePath,
          },
        }),
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "mimeType",
    });
  });
});

function createOpenAIModel(
  baseUrl: string,
  modelKey: string,
): AudioRuntimeModelConfig {
  return {
    audioProfileId: "audio_openai",
    connectionProfileId: "profile_openai",
    provider: Model.OpenAI,
    apiKey: "sk-audio-runtime",
    baseUrl,
    audioDialect: "openai_audio",
    modelKey,
    capabilities: [
      "file_transcription",
      "speech_synthesis",
      "streaming_speech_synthesis",
    ],
  };
}

function createMimoModel(
  baseUrl: string,
  modelKey: string,
): AudioRuntimeModelConfig {
  return {
    audioProfileId: "audio_mimo",
    connectionProfileId: "profile_mimo",
    provider: Model.Other,
    apiKey: "mimo-audio-runtime",
    baseUrl,
    audioDialect: "mimo_chat_audio",
    modelKey,
    capabilities: [
      "file_transcription",
      "speech_synthesis",
      "streaming_speech_synthesis",
      "mimo_voice_design",
      "mimo_voice_clone",
    ],
  };
}

function createTranscriptionPayload(
  filePath: string,
  overrides: Partial<CreateAudioTranscriptionRequest> = {},
): CreateAudioTranscriptionRequest {
  return {
    assignmentKey: "transcription",
    filePath,
    fileName: path.basename(filePath),
    mimeType: "audio/wav",
    language: "en",
    responseFormat: "json",
    ...overrides,
  };
}

function createSpeechPayload(
  overrides: Partial<CreateSpeechSynthesisRequest> = {},
): CreateSpeechSynthesisRequest {
  return {
    assignmentKey: "speechSynthesis",
    input: "hello from FusionKit",
    voice: "alloy",
    instructions: "Warm and clear.",
    responseFormat: "wav",
    speed: 1.1,
    ...overrides,
  };
}

function requireServer(
  server: FakeAudioApiServer | undefined,
): FakeAudioApiServer {
  if (!server) throw new AudioRuntimeClientError({
    code: "network_error",
    message: "Fake server was not initialized.",
  });
  return server;
}

function requireTempRoot(value: string | undefined): string {
  if (!value) {
    throw new Error("Temp root was not initialized.");
  }
  return value;
}
