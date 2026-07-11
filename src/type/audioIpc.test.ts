import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT_CHANNELS,
  AUDIO_IPC_CHANNELS,
  isAudioRealtimeSessionEventPayload,
  isSpeechSynthesisStreamEventPayload,
  validateAudioRealtimeSessionIpcRequest,
  validateCancelAudioTranscriptionIpcRequest,
  validateCancelRecordedAudioChunkTranscriptionIpcRequest,
  validateCancelSpeechSynthesisIpcRequest,
  validateCancelSpeechSynthesisStreamIpcRequest,
  validateCreateAudioTranscriptionIpcRequest,
  validateCreateSpeechSynthesisIpcRequest,
  validateCreateSpeechSynthesisStreamIpcRequest,
  validateRevealAudioOutputIpcRequest,
  validateSyncAudioRuntimeConfigIpcRequest,
  validateTranscribeRecordedAudioChunkIpcRequest,
} from "@/type/audioIpc";
import { Model } from "@/type/model";

describe("audio IPC contract", () => {
  it("keeps every command and event under the audio namespace", () => {
    const channels = [
      ...Object.values(AUDIO_IPC_CHANNELS),
      ...Object.values(AUDIO_EVENT_CHANNELS),
    ];

    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every((channel) => channel.startsWith("audio:"))).toBe(true);
    expect(channels).not.toContain("transcribe");
    expect(channels).not.toContain("session-event");
  });

  it("accepts transcription requests that only pass task parameters and an authorized file token", () => {
    const result = validateCreateAudioTranscriptionIpcRequest({
      assignmentKey: "transcription",
      fileToken: "authorized-file-token",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      language: "zh",
      responseFormat: "json",
      timestampGranularities: ["segment"],
      stream: true,
      requestId: "asr_req_001",
      outputPathMode: "custom_dir",
      outputDir: "/audio/out",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        assignmentKey: "transcription",
        fileToken: "authorized-file-token",
        requestId: "asr_req_001",
        responseFormat: "json",
        stream: true,
      });
    }
  });

  it("validates transcription cancellation requests", () => {
    expect(
      validateCancelAudioTranscriptionIpcRequest({
        requestId: "asr_req_001",
      }).ok,
    ).toBe(true);

    const invalid = validateCancelAudioTranscriptionIpcRequest({});
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.field).toBe("requestId");
    }
  });

  it("rejects transcription requests that try to pass local API config", () => {
    const result = validateCreateAudioTranscriptionIpcRequest({
      assignmentKey: "transcription",
      filePath: "/audio/sample.wav",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      responseFormat: "json",
      apiKey: "sk-must-not-cross-ipc",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_ipc_request");
      expect(result.error.field).toBe("apiKey");
      expect(JSON.stringify(result.error)).not.toContain("sk-must-not-cross-ipc");
    }
  });

  it("rejects requests that send raw audio instead of file paths", () => {
    const result = validateCreateAudioTranscriptionIpcRequest({
      assignmentKey: "transcription",
      filePath: "/audio/sample.wav",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      responseFormat: "json",
      audioBase64: "UklGRg==",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("audioBase64");
      expect(JSON.stringify(result.error)).not.toContain("UklGRg==");
    }
  });

  it("accepts recorded chunk transcription through the dedicated binary chunk channel", () => {
    const valid = validateTranscribeRecordedAudioChunkIpcRequest({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_001",
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      language: "zh",
      responseFormat: "text",
      startedAtMs: 0,
      endedAtMs: 5000,
    });

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data.audioBytes.byteLength).toBe(4);
      expect(valid.data.language).toBe("zh");
    }

    const base64 = validateTranscribeRecordedAudioChunkIpcRequest({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_002",
      audioBytes: "UklGRg==",
      mimeType: "audio/wav",
      responseFormat: "text",
    });
    expect(base64.ok).toBe(false);
    if (!base64.ok) {
      expect(base64.error.field).toBe("audioBytes");
      expect(JSON.stringify(base64.error)).not.toContain("UklGRg==");
    }

    const leakedConfig = validateTranscribeRecordedAudioChunkIpcRequest({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_003",
      audioBytes: new Uint8Array([1]),
      mimeType: "audio/wav",
      responseFormat: "text",
      apiKey: "sk-nope",
    });
    expect(leakedConfig.ok).toBe(false);
    if (!leakedConfig.ok) {
      expect(leakedConfig.error.field).toBe("apiKey");
      expect(JSON.stringify(leakedConfig.error)).not.toContain("sk-nope");
    }

    expect(
      validateCancelRecordedAudioChunkTranscriptionIpcRequest({
        requestId: "chunk_req_001",
      }).ok,
    ).toBe(true);
  });

  it("accepts MiMo voice clone by sample token and rejects sample base64", () => {
    const valid = validateCreateSpeechSynthesisIpcRequest({
      assignmentKey: "speechSynthesis",
      requestId: "speech_req_001",
      input: "你好，FusionKit。",
      responseFormat: "pcm16",
      stream: true,
      mimoOptions: {
        mode: "voice_clone",
        voiceSampleToken: "authorized-voice-sample-token",
        voiceSampleMime: "audio/wav",
      },
    });

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data.requestId).toBe("speech_req_001");
    }

    const invalid = validateCreateSpeechSynthesisIpcRequest({
      assignmentKey: "speechSynthesis",
      input: "你好，FusionKit。",
      responseFormat: "pcm16",
      mimoOptions: {
        mode: "voice_clone",
        voiceSampleBase64: "UklGRg==",
      },
    });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.field).toBe("mimoOptions.voiceSampleBase64");
    }
  });

  it("validates global runtime config sync separately from task payloads", () => {
    const result = validateSyncAudioRuntimeConfigIpcRequest({
      connectionProfiles: [
        {
          id: "profile_mimo",
          provider: Model.Other,
          apiKey: "mimo-secret-key",
          baseUrl: "https://api.xiaomimimo.com/v1",
        },
      ],
      audioProfiles: [
        {
          id: "audio_mimo_speech",
          name: "MiMo Speech",
          connectionProfileId: "profile_mimo",
          audioDialect: "mimo_chat_audio",
          capabilities: ["speech_synthesis", "streaming_speech_synthesis"],
          models: { speechSynthesis: "mimo-v2.5-tts" },
          defaults: {},
        },
      ],
      audioAssignment: {
        transcription: null,
        speechSynthesis: "audio_mimo_speech",
        realtimeCaptions: null,
        realtimeVoice: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.connectionProfiles[0].apiKey).toBe("mimo-secret-key");
    }

    const taskPayload = validateCreateSpeechSynthesisIpcRequest({
      assignmentKey: "speechSynthesis",
      input: "hello",
      responseFormat: "wav",
      apiKey: "mimo-secret-key",
    });
    expect(taskPayload.ok).toBe(false);
    if (!taskPayload.ok) {
      expect(taskPayload.error.field).toBe("apiKey");
    }
  });

  it("validates stream wrapper requests and cancellation requests", () => {
    const streamRequest = validateCreateSpeechSynthesisStreamIpcRequest({
      requestId: "speech_req_001",
      payload: {
        assignmentKey: "speechSynthesis",
        input: "你好，FusionKit。",
        responseFormat: "pcm16",
        stream: true,
      },
    });
    expect(streamRequest.ok).toBe(true);

    const missingStream = validateCreateSpeechSynthesisStreamIpcRequest({
      requestId: "speech_req_002",
      payload: {
        assignmentKey: "speechSynthesis",
        input: "你好，FusionKit。",
        responseFormat: "pcm16",
      },
    });
    expect(missingStream.ok).toBe(false);
    if (!missingStream.ok) {
      expect(missingStream.error.field).toBe("payload.stream");
    }

    expect(
      validateCancelSpeechSynthesisStreamIpcRequest({
        requestId: "speech_req_001",
      }).ok,
    ).toBe(true);
  });

  it("validates non-stream speech cancellation requests", () => {
    expect(
      validateCancelSpeechSynthesisIpcRequest({
        requestId: "speech_req_001",
      }).ok,
    ).toBe(true);

    const invalid = validateCancelSpeechSynthesisIpcRequest({});
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.field).toBe("requestId");
    }
  });

  it("requires a voice design prompt unless optimized preview is enabled", () => {
    const missingPrompt = validateCreateSpeechSynthesisIpcRequest({
      assignmentKey: "speechSynthesis",
      input: "这是一段试听文本。",
      responseFormat: "wav",
      mimoOptions: {
        mode: "voice_design",
      },
    });

    expect(missingPrompt.ok).toBe(false);
    if (!missingPrompt.ok) {
      expect(missingPrompt.error.field).toBe("mimoOptions.voiceDesignPrompt");
    }

    const optimized = validateCreateSpeechSynthesisIpcRequest({
      assignmentKey: "speechSynthesis",
      input: "",
      responseFormat: "wav",
      mimoOptions: {
        mode: "voice_design",
        optimizeTextPreview: true,
      },
    });

    expect(optimized.ok).toBe(true);
  });

  it("validates realtime session requests and reveal-output requests", () => {
    const captions = validateAudioRealtimeSessionIpcRequest({
      assignmentKey: "realtimeCaptions",
      mode: "caption",
      language: "zh",
      inputAudioFormat: "pcm16",
    });
    expect(captions.ok).toBe(true);

    const invalidVoice = validateAudioRealtimeSessionIpcRequest({
      assignmentKey: "realtimeVoice",
      mode: "caption",
    });
    expect(invalidVoice.ok).toBe(false);
    if (!invalidVoice.ok) {
      expect(invalidVoice.error.field).toBe("mode");
    }

    expect(
      validateRevealAudioOutputIpcRequest({ outputToken: "authorized-output-token" }).ok,
    ).toBe(true);
  });

  it("recognizes stream and realtime event payloads", () => {
    expect(
      isSpeechSynthesisStreamEventPayload({
        type: "audio_delta",
        requestId: "req_001",
        pcmBytes: new Uint8Array([1, 2, 3]),
      }),
    ).toBe(true);
    expect(
      isSpeechSynthesisStreamEventPayload({
        type: "audio_delta",
        requestId: "req_001",
        pcmBase64: "AQID",
      }),
    ).toBe(false);

    expect(
      isAudioRealtimeSessionEventPayload({
        type: "transcript_final",
        role: "assistant",
        text: "你好。",
      }),
    ).toBe(true);
    expect(
      isAudioRealtimeSessionEventPayload({
        type: "audio_started",
        role: "user",
      }),
    ).toBe(false);
  });
});
