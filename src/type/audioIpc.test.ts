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
import {
  AUDIO_SPEECH_MAX_INPUT_CHARS,
  AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
  type SpeechSynthesisIntent,
} from "@/type/audio";

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

  it("accepts standalone profiles, routes, verification, and assignment", () => {
    const result = validateSyncAudioRuntimeConfigIpcRequest(
      createRuntimeSnapshot(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      profiles: [
        {
          id: "audio_mimo",
          providerPreset: "mimo",
          apiKey: "mimo-secret-key",
          baseUrl: "https://api.xiaomimimo.com/v1",
          routes: {
            transcription: enabledRoute(
              "mimo_chat_audio",
              "mimo-v2.5-asr",
            ),
            speechSynthesis: {
              preset_voice: enabledRoute(
                "mimo_chat_audio",
                "mimo-v2.5-tts",
              ),
              voice_design: enabledRoute(
                "mimo_chat_audio",
                "mimo-v2.5-tts-voicedesign",
              ),
              voice_clone: enabledRoute(
                "mimo_chat_audio",
                "mimo-v2.5-tts-voiceclone",
              ),
            },
            realtimeCaptions: enabledRoute(
              "mimo_chat_audio",
              "mimo-v2.5-asr",
            ),
          },
          verification: {
            transcription: {
              status: "verified",
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
            "speechSynthesis.voice_design": { status: "degraded" },
          },
        },
      ],
      assignment: {
        transcription: "audio_mimo",
        speechSynthesis: "audio_mimo",
        realtimeCaptions: "audio_mimo",
        realtimeVoice: null,
      },
    });
  });

  it("rejects legacy snapshot fields and text-model coupling", () => {
    const legacyRoot = validateSyncAudioRuntimeConfigIpcRequest({
      ...createRuntimeSnapshot(),
      connectionProfiles: [],
    });
    expectFailureField(legacyRoot, "connectionProfiles");

    const legacyProfile = createRuntimeSnapshot();
    Object.assign(legacyProfile.profiles[0], {
      connectionProfileId: "text-profile",
    });
    expectFailureField(
      validateSyncAudioRuntimeConfigIpcRequest(legacyProfile),
      "profiles.0.connectionProfileId",
    );
  });

  it("rejects duplicate profile ids and unknown assignment keys", () => {
    const duplicate = createRuntimeSnapshot();
    duplicate.profiles.push({
      ...duplicate.profiles[0],
      id: " audio_mimo ",
    });
    expectFailureField(
      validateSyncAudioRuntimeConfigIpcRequest(duplicate),
      "profiles.1.id",
    );

    const unknownAssignment = createRuntimeSnapshot();
    Object.assign(unknownAssignment.assignment, { unknownTask: "audio_mimo" });
    expectFailureField(
      validateSyncAudioRuntimeConfigIpcRequest(unknownAssignment),
      "assignment.unknownTask",
    );
  });

  it("strictly validates route keys, transports, models, and enabled flags", () => {
    const invalidCases: Array<{
      mutate: (snapshot: ReturnType<typeof createRuntimeSnapshot>) => void;
      field: string;
    }> = [
      {
        mutate: (snapshot) => {
          Object.assign(snapshot.profiles[0].routes, { unknownTask: {} });
        },
        field: "profiles.0.routes.unknownTask",
      },
      {
        mutate: (snapshot) => {
          Object.assign(snapshot.profiles[0].routes.speechSynthesis, {
            unknown_mode: enabledRoute("mimo_chat_audio", "mimo-unknown"),
          });
        },
        field: "profiles.0.routes.speechSynthesis.unknown_mode",
      },
      {
        mutate: (snapshot) => {
          snapshot.profiles[0].routes.transcription.transport = "invalid";
        },
        field: "profiles.0.routes.transcription.transport",
      },
      {
        mutate: (snapshot) => {
          snapshot.profiles[0].routes.transcription.model = "   ";
        },
        field: "profiles.0.routes.transcription.model",
      },
      {
        mutate: (snapshot) => {
          snapshot.profiles[0].routes.transcription.enabled = "yes";
        },
        field: "profiles.0.routes.transcription.enabled",
      },
      {
        mutate: (snapshot) => {
          Object.assign(snapshot.profiles[0].routes.transcription, {
            endpoint: "https://should-not-cross.example",
          });
        },
        field: "profiles.0.routes.transcription.endpoint",
      },
    ];

    for (const testCase of invalidCases) {
      const snapshot = createRuntimeSnapshot();
      testCase.mutate(snapshot);
      expectFailureField(
        validateSyncAudioRuntimeConfigIpcRequest(snapshot),
        testCase.field,
      );
    }
  });

  it("strictly validates route verification keys, values, and fields", () => {
    const invalidCases: Array<{
      verification: Record<string, unknown>;
      field: string;
    }> = [
      {
        verification: { "speechSynthesis.unknown": { status: "verified" } },
        field: "profiles.0.verification.speechSynthesis.unknown",
      },
      {
        verification: { transcription: { status: "unknown" } },
        field: "profiles.0.verification.transcription.status",
      },
      {
        verification: {
          transcription: { status: "verified", updatedAt: 123 },
        },
        field: "profiles.0.verification.transcription.updatedAt",
      },
      {
        verification: {
          transcription: { status: "verified", apiKey: "must-not-hide-here" },
        },
        field: "profiles.0.verification.transcription.apiKey",
      },
    ];

    for (const testCase of invalidCases) {
      const snapshot = createRuntimeSnapshot();
      snapshot.profiles[0].verification = testCase.verification;
      const result = validateSyncAudioRuntimeConfigIpcRequest(snapshot);
      expectFailureField(result, testCase.field);
      if (!result.ok) {
        expect(JSON.stringify(result.error)).not.toContain("must-not-hide-here");
      }
    }
  });

  it("accepts transcription requests with task parameters and a file token", () => {
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
      outputDirToken: "authorized-output-directory-token",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        assignmentKey: "transcription",
        fileToken: "authorized-file-token",
        requestId: "asr_req_001",
        responseFormat: "json",
        stream: true,
        outputDirToken: "authorized-output-directory-token",
      });
    }
  });

  it("requires directory tokens only for custom output and rejects raw paths", () => {
    const transcription = {
      assignmentKey: "transcription",
      fileToken: "authorized-file-token",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      responseFormat: "json",
    };
    expectFailureField(
      validateCreateAudioTranscriptionIpcRequest({
        ...transcription,
        outputPathMode: "custom_dir",
        outputDir: "/private/output",
      }),
      "outputDir",
    );
    expectFailureField(
      validateCreateAudioTranscriptionIpcRequest({
        ...transcription,
        outputPathMode: "custom_dir",
      }),
      "outputDirToken",
    );
    expectFailureField(
      validateCreateAudioTranscriptionIpcRequest({
        ...transcription,
        outputPathMode: "source_dir",
        outputDirToken: "unexpected-token",
      }),
      "outputDirToken",
    );

    const speech = createSpeechRequest({ mode: "preset_voice", voice: "alloy" });
    expectFailureField(
      validateCreateSpeechSynthesisIpcRequest({
        ...speech,
        outputPathMode: "custom_dir",
        outputDir: "/private/output",
      }),
      "outputDir",
    );
    expectFailureField(
      validateCreateSpeechSynthesisIpcRequest({
        ...speech,
        outputPathMode: "custom_dir",
      }),
      "outputDirToken",
    );
    expectFailureField(
      validateCreateSpeechSynthesisIpcRequest({
        ...speech,
        outputPathMode: "temp",
        outputDirToken: "unexpected-token",
      }),
      "outputDirToken",
    );
  });

  it("rejects runtime route and profile overrides in task payloads", () => {
    const forbiddenFields: Array<[string, unknown]> = [
      ["apiKey", "sk-must-not-cross-ipc"],
      ["baseUrl", "https://override.example/v1"],
      ["provider", "OpenAI"],
      ["providerPreset", "openai"],
      ["transport", "openai_audio"],
      ["model", "attacker-model"],
      ["modelKey", "attacker-model"],
      ["route", enabledRoute("openai_audio", "attacker-model")],
      ["routes", { speechSynthesis: {} }],
      ["profileId", "attacker-profile"],
      ["audioProfileId", "attacker-profile"],
      ["connectionProfileId", "attacker-connection"],
    ];

    for (const [field, value] of forbiddenFields) {
      const result = validateCreateSpeechSynthesisIpcRequest({
        ...createSpeechRequest({ mode: "preset_voice", voice: "alloy" }),
        [field]: value,
      });
      expectFailureField(result, field);
      if (!result.ok) {
        expect(JSON.stringify(result.error)).not.toContain("sk-must-not-cross-ipc");
        expect(JSON.stringify(result.error)).not.toContain("attacker-model");
      }
    }

    const nested = validateCreateSpeechSynthesisIpcRequest({
      ...createSpeechRequest({ mode: "preset_voice", voice: "alloy" }),
      metadata: { route: enabledRoute("openai_audio", "nested-model") },
    });
    expectFailureField(nested, "metadata.route");
  });

  it("accepts and canonicalizes every speech synthesis intent", () => {
    const cases: Array<{
      intent: SpeechSynthesisIntent;
      input?: string;
      expected: SpeechSynthesisIntent;
    }> = [
      {
        intent: {
          mode: "preset_voice",
          voice: " alloy ",
          styleInstruction: " calm ",
        },
        expected: {
          mode: "preset_voice",
          voice: "alloy",
          styleInstruction: " calm ",
        },
      },
      {
        intent: {
          mode: "voice_design",
          voiceDesignPrompt: " warm narrator ",
          optimizeTextPreview: true,
        },
        input: "",
        expected: {
          mode: "voice_design",
          voiceDesignPrompt: "warm narrator",
          optimizeTextPreview: true,
        },
      },
      {
        intent: {
          mode: "voice_clone",
          voiceSampleToken: "authorized-voice-token",
          styleInstruction: " restrained ",
        },
        expected: {
          mode: "voice_clone",
          voiceSampleToken: "authorized-voice-token",
          styleInstruction: " restrained ",
        },
      },
    ];

    for (const testCase of cases) {
      const result = validateCreateSpeechSynthesisIpcRequest(
        createSpeechRequest(
          testCase.intent,
          testCase.input === undefined ? {} : { input: testCase.input },
        ),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.intent).toEqual(testCase.expected);
    }
  });

  it("requires each intent mode's own fields", () => {
    const cases: Array<{ intent: Record<string, unknown>; field: string }> = [
      { intent: { mode: "preset_voice" }, field: "intent.voice" },
      {
        intent: { mode: "voice_design", optimizeTextPreview: true },
        field: "intent.voiceDesignPrompt",
      },
      { intent: { mode: "voice_clone" }, field: "intent.voiceSampleToken" },
      { intent: { mode: "unknown" }, field: "intent.mode" },
    ];

    for (const testCase of cases) {
      expectFailureField(
        validateCreateSpeechSynthesisIpcRequest(
          createSpeechRequest(testCase.intent),
        ),
        testCase.field,
      );
    }
  });

  it("rejects fields belonging to a different intent mode", () => {
    const cases: Array<{ intent: Record<string, unknown>; field: string }> = [
      {
        intent: {
          mode: "preset_voice",
          voice: "alloy",
          voiceDesignPrompt: "wrong",
        },
        field: "intent.voiceDesignPrompt",
      },
      {
        intent: {
          mode: "voice_design",
          voiceDesignPrompt: "warm",
          styleInstruction: "wrong",
        },
        field: "intent.styleInstruction",
      },
      {
        intent: {
          mode: "voice_clone",
          voiceSampleToken: "authorized-token",
          voice: "wrong",
        },
        field: "intent.voice",
      },
      {
        intent: {
          mode: "voice_clone",
          voiceSampleToken: "authorized-token",
          voiceSamplePath: "/private/reference.wav",
        },
        field: "intent.voiceSamplePath",
      },
      {
        intent: {
          mode: "voice_clone",
          voiceSampleToken: "authorized-token",
          voiceSampleBase64: "UklGRg==",
        },
        field: "intent.voiceSampleBase64",
      },
    ];

    for (const testCase of cases) {
      const result = validateCreateSpeechSynthesisIpcRequest(
        createSpeechRequest(testCase.intent),
      );
      expectFailureField(result, testCase.field);
      if (!result.ok) {
        expect(JSON.stringify(result.error)).not.toContain("/private/reference.wav");
        expect(JSON.stringify(result.error)).not.toContain("UklGRg==");
      }
    }
  });

  it("allows empty input only for optimized voice design with a prompt", () => {
    const optimized = validateCreateSpeechSynthesisIpcRequest(
      createSpeechRequest(
        {
          mode: "voice_design",
          voiceDesignPrompt: "warm narrator",
          optimizeTextPreview: true,
        },
        { input: "" },
      ),
    );
    expect(optimized.ok).toBe(true);

    const preset = validateCreateSpeechSynthesisIpcRequest(
      createSpeechRequest(
        { mode: "preset_voice", voice: "alloy" },
        { input: "" },
      ),
    );
    expectFailureField(preset, "input");

    const designWithoutOptimization = validateCreateSpeechSynthesisIpcRequest(
      createSpeechRequest(
        { mode: "voice_design", voiceDesignPrompt: "warm narrator" },
        { input: "" },
      ),
    );
    expectFailureField(designWithoutOptimization, "input");
  });

  it("enforces the shared public speech text limits", () => {
    const boundary = validateCreateSpeechSynthesisIpcRequest(
      createSpeechRequest(
        { mode: "preset_voice", voice: "alloy" },
        {
          input: "i".repeat(AUDIO_SPEECH_MAX_INPUT_CHARS),
          instructions: "n".repeat(AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS),
        },
      ),
    );
    expect(boundary.ok).toBe(true);

    expectFailureField(
      validateCreateSpeechSynthesisIpcRequest(
        createSpeechRequest(
          { mode: "preset_voice", voice: "alloy" },
          { input: "i".repeat(AUDIO_SPEECH_MAX_INPUT_CHARS + 1) },
        ),
      ),
      "input",
    );
    expectFailureField(
      validateCreateSpeechSynthesisIpcRequest(
        createSpeechRequest(
          { mode: "preset_voice", voice: "alloy" },
          {
            instructions: "n".repeat(
              AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS + 1,
            ),
          },
        ),
      ),
      "instructions",
    );
  });

  it("validates speech stream wrappers and cancellation requests", () => {
    const streamRequest = validateCreateSpeechSynthesisStreamIpcRequest({
      requestId: "speech_req_001",
      payload: createSpeechRequest(
        { mode: "preset_voice", voice: "alloy" },
        { stream: true },
      ),
    });
    expect(streamRequest.ok).toBe(true);

    const missingStream = validateCreateSpeechSynthesisStreamIpcRequest({
      requestId: "speech_req_002",
      payload: createSpeechRequest({ mode: "preset_voice", voice: "alloy" }),
    });
    expectFailureField(missingStream, "payload.stream");

    expect(
      validateCancelSpeechSynthesisStreamIpcRequest({
        requestId: "speech_req_001",
      }).ok,
    ).toBe(true);
    expect(
      validateCancelSpeechSynthesisIpcRequest({
        requestId: "speech_req_001",
      }).ok,
    ).toBe(true);
  });

  it("validates transcription cancellation and recorded binary chunks", () => {
    expect(
      validateCancelAudioTranscriptionIpcRequest({
        requestId: "asr_req_001",
      }).ok,
    ).toBe(true);
    expectFailureField(
      validateCancelAudioTranscriptionIpcRequest({}),
      "requestId",
    );

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

    const base64 = validateTranscribeRecordedAudioChunkIpcRequest({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_002",
      audioBytes: "UklGRg==",
      mimeType: "audio/wav",
      responseFormat: "text",
    });
    expectFailureField(base64, "audioBytes");
    if (!base64.ok) {
      expect(JSON.stringify(base64.error)).not.toContain("UklGRg==");
    }

    expect(
      validateCancelRecordedAudioChunkTranscriptionIpcRequest({
        requestId: "chunk_req_001",
      }).ok,
    ).toBe(true);
  });

  it("validates realtime sessions and reveal-output requests", () => {
    expect(
      validateAudioRealtimeSessionIpcRequest({
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        language: "zh",
        inputAudioFormat: "pcm16",
      }).ok,
    ).toBe(true);

    const invalidVoice = validateAudioRealtimeSessionIpcRequest({
      assignmentKey: "realtimeVoice",
      mode: "caption",
    });
    expectFailureField(invalidVoice, "mode");

    expect(
      validateRevealAudioOutputIpcRequest({
        outputToken: "authorized-output-token",
      }).ok,
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
      isSpeechSynthesisStreamEventPayload({
        type: "completed",
        requestId: "req_001",
        result: {
          outputToken: "authorized-output-token",
          mimeType: "audio/wav",
          responseFormat: "wav",
          sizeBytes: 42,
        },
      }),
    ).toBe(true);
    expect(
      isSpeechSynthesisStreamEventPayload({
        type: "completed",
        requestId: "req_001",
        result: {
          outputPath: "/private/output.wav",
          mimeType: "audio/wav",
          responseFormat: "wav",
          sizeBytes: 42,
        },
      }),
    ).toBe(false);

    expect(
      isAudioRealtimeSessionEventPayload({
        type: "transcript_final",
        role: "assistant",
        text: "hello",
      }),
    ).toBe(true);
    expect(
      isAudioRealtimeSessionEventPayload({
        type: "audio_started",
        role: "user",
      }),
    ).toBe(false);
    expect(
      isAudioRealtimeSessionEventPayload({
        type: "audio_stopped",
        role: "assistant",
        source: "output_buffer",
        cleared: true,
      }),
    ).toBe(true);
    expect(
      isAudioRealtimeSessionEventPayload({
        type: "audio_stopped",
        role: "assistant",
        source: "unknown",
      }),
    ).toBe(false);
  });
});

function createRuntimeSnapshot() {
  return {
    profiles: [
      {
        id: "audio_mimo",
        providerPreset: "mimo",
        apiKey: "mimo-secret-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        routes: {
          transcription: enabledRoute(
            "mimo_chat_audio",
            "mimo-v2.5-asr",
          ),
          speechSynthesis: {
            preset_voice: enabledRoute(
              "mimo_chat_audio",
              "mimo-v2.5-tts",
            ),
            voice_design: enabledRoute(
              "mimo_chat_audio",
              "mimo-v2.5-tts-voicedesign",
            ),
            voice_clone: enabledRoute(
              "mimo_chat_audio",
              "mimo-v2.5-tts-voiceclone",
            ),
          },
          realtimeCaptions: enabledRoute(
            "mimo_chat_audio",
            "mimo-v2.5-asr",
          ),
        },
        verification: {
          transcription: {
            status: "verified",
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
          "speechSynthesis.voice_design": { status: "degraded" },
        } as Record<string, unknown>,
      },
    ],
    assignment: {
      transcription: "audio_mimo",
      speechSynthesis: "audio_mimo",
      realtimeCaptions: "audio_mimo",
      realtimeVoice: null,
    } as Record<string, string | null>,
  };
}

function enabledRoute(transport: string, model: string) {
  return { transport, model, enabled: true as boolean | string };
}

function createSpeechRequest(
  intent: SpeechSynthesisIntent | Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    assignmentKey: "speechSynthesis",
    requestId: "speech_req_001",
    input: "Hello, FusionKit.",
    intent,
    responseFormat: "wav",
    ...overrides,
  };
}

function expectFailureField(
  result: { ok: true } | { ok: false; error: { field?: string } },
  field: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe(field);
}
