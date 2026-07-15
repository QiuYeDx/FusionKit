import { describe, expect, it } from "vitest";
import {
  MIMO_SPEECH_VOICE_PRESETS,
  MIMO_TTS_MODEL_BY_MODE,
  OPENAI_REALTIME_VOICE_PRESETS,
  canAudioApiHandleTask,
  createDefaultAudioApiRoutes,
  getAudioProviderDefinition,
  getAvailableSpeechSynthesisModes,
  getRealtimeRouteConstraints,
  getSpeechRouteConstraints,
  inferAudioProviderPresetFromLegacy,
  resolveAudioApiRoute,
  resolveRealtimeRouteDefinition,
  resolveTranscriptionRouteDefinition,
} from "./audio-provider-registry";
import {
  AUDIO_SPEECH_MAX_INPUT_CHARS,
  AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
  type AudioApiProfile,
} from "@/type/audio";

describe("audio provider registry", () => {
  it("defines OpenAI file audio and realtime routes on one API", () => {
    const definition = getAudioProviderDefinition("openai");

    expect(definition.defaultBaseUrl).toBe("https://api.openai.com/v1");
    expect(definition.routes).toMatchObject({
      transcription: {
        transport: "openai_audio",
        model: "gpt-4o-transcribe",
      },
      speechSynthesis: {
        preset_voice: {
          transport: "openai_audio",
          model: "gpt-4o-mini-tts",
        },
      },
      realtimeCaptions: {
        transport: "openai_realtime",
        model: "gpt-realtime-whisper",
      },
      realtimeVoice: {
        transport: "openai_realtime",
        model: "gpt-realtime",
      },
    });
  });

  it("keeps all MiMo speech mode models in the shared registry", () => {
    const routes = createDefaultAudioApiRoutes("mimo");

    expect(getAvailableSpeechSynthesisModes(routes)).toEqual([
      "preset_voice",
      "voice_design",
      "voice_clone",
    ]);
    for (const [mode, model] of Object.entries(MIMO_TTS_MODEL_BY_MODE)) {
      expect(routes.speechSynthesis[mode as keyof typeof MIMO_TTS_MODEL_BY_MODE])
        .toMatchObject({ transport: "mimo_chat_audio", model, enabled: true });
    }
    expect(routes.realtimeVoice).toBeUndefined();
  });

  it("describes mode-specific fields and streaming constraints", () => {
    expect(getSpeechRouteConstraints("mimo", "preset_voice")).toMatchObject({
      voices: MIMO_SPEECH_VOICE_PRESETS,
      supportsStreaming: true,
      streamResponseFormat: "pcm16",
      finalResponseFormat: "wav",
      fields: {
        voice: "required",
        styleInstruction: "optional",
        referenceAudio: "unsupported",
      },
    });
    expect(getSpeechRouteConstraints("mimo", "voice_design")).toMatchObject({
      allowEmptyInputWhenOptimizeTextPreview: true,
      fields: {
        voice: "unsupported",
        voiceDesignPrompt: "required",
        optimizeTextPreview: "optional",
      },
    });
    expect(getSpeechRouteConstraints("mimo", "voice_clone")).toMatchObject({
      fields: {
        referenceAudio: "required",
        styleInstruction: "optional",
      },
    });
  });

  it("defines explicit text limits for every speech route", () => {
    const routes = [
      ["openai", "preset_voice"],
      ["mimo", "preset_voice"],
      ["mimo", "voice_design"],
      ["mimo", "voice_clone"],
      ["custom_openai_compatible", "preset_voice"],
    ] as const;

    for (const [preset, mode] of routes) {
      const constraints = getSpeechRouteConstraints(preset, mode)!;
      expect(constraints.maxInputChars).toBe(AUDIO_SPEECH_MAX_INPUT_CHARS);
      if (constraints.fields.instructions === "unsupported") {
        expect(constraints.maxInstructionsChars).toBeUndefined();
      } else {
        expect(constraints.maxInstructionsChars).toBe(
          AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
        );
      }
    }
  });

  it("exposes cloned transcription and realtime constraints", () => {
    const transcription = resolveTranscriptionRouteDefinition({
      providerPreset: "mimo",
      transport: "mimo_chat_audio",
      model: "mimo-v2.5-asr",
    })!.constraints;
    const realtime = getRealtimeRouteConstraints("openai", "realtimeCaptions")!;
    const realtimeVoice = getRealtimeRouteConstraints("openai", "realtimeVoice")!;

    (transcription.responseFormats as string[])[0] = "text";
    (transcription.languages as string[])[0] = "fr";
    realtime.supportsLanguage = false;
    (realtimeVoice.inputAudioFormats as string[])[0] = "changed";
    (realtimeVoice.outputAudioFormats as string[])[0] = "changed";
    (realtimeVoice.voices as string[])[0] = "changed";

    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "mimo",
      transport: "mimo_chat_audio",
      model: "mimo-v2.5-asr",
    })?.constraints).toMatchObject({
        responseFormats: ["json", "text"],
        languages: ["auto", "zh", "en"],
        supportsPrompt: false,
        supportsStreaming: true,
      });
    expect(
      getRealtimeRouteConstraints("openai", "realtimeCaptions"),
    ).toMatchObject({
      mode: "caption",
      supportsInstructions: false,
      supportsLanguage: true,
      supportsVoice: false,
    });
    expect(
      getRealtimeRouteConstraints("openai", "realtimeVoice"),
    ).toMatchObject({
      mode: "duplex_voice",
      inputAudioFormats: ["pcm16", "pcmu", "pcma"],
      outputAudioFormats: ["pcm16", "pcmu", "pcma"],
      voices: OPENAI_REALTIME_VOICE_PRESETS,
    });
  });

  it("resolves realtime execution constraints from the complete route", () => {
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "openai",
      assignmentKey: "realtimeCaptions",
      transport: "openai_realtime",
      model: "gpt-realtime-whisper",
    })).toMatchObject({
      constraints: {
        mode: "caption",
        languages: ["auto", "zh", "en", "ja", "ko", "fr", "de", "es"],
        inputAudioFormats: ["pcm16", "pcmu", "pcma"],
      },
    });
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "mimo",
      assignmentKey: "realtimeCaptions",
      transport: "mimo_chat_audio",
      model: "mimo-v2.5-asr",
    })).toMatchObject({
      constraints: {
        mode: "chunked_near_realtime",
        languages: ["auto", "zh", "en"],
      },
    });
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "custom_openai_compatible",
      assignmentKey: "realtimeCaptions",
      transport: "openai_realtime",
      model: "vendor-live-transcriber",
    })?.constraints.mode).toBe("caption");
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "openai",
      assignmentKey: "realtimeCaptions",
      transport: "openai_realtime",
      model: "gpt-realtime-unknown",
    })).toBeUndefined();
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "openai",
      assignmentKey: "realtimeVoice",
      transport: "openai_realtime",
      model: "gpt-realtime-whisper",
    })).toBeUndefined();
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "openai",
      assignmentKey: "realtimeVoice",
      transport: "openai_realtime",
      model: "gpt-realtime",
    })).toMatchObject({
      constraints: {
        mode: "duplex_voice",
        inputAudioFormats: ["pcm16", "pcmu", "pcma"],
        outputAudioFormats: ["pcm16", "pcmu", "pcma"],
        voices: OPENAI_REALTIME_VOICE_PRESETS,
      },
    });
    expect(resolveRealtimeRouteDefinition({
      providerPreset: "custom_openai_compatible",
      assignmentKey: "realtimeVoice",
      transport: "openai_realtime",
      model: "vendor-live-voice",
    })).toMatchObject({
      constraints: {
        mode: "duplex_voice",
        inputAudioFormats: ["pcm16", "pcmu", "pcma"],
        outputAudioFormats: ["pcm16", "pcmu", "pcma"],
        voices: OPENAI_REALTIME_VOICE_PRESETS,
      },
    });
  });

  it("resolves transcription constraints from preset, transport, and model", () => {
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "openai",
      transport: "openai_audio",
      model: "gpt-4o-mini-transcribe-2026-01-01",
    })).toMatchObject({
      family: "openai_gpt_transcribe",
      constraints: {
        responseFormats: ["json"],
        supportsPrompt: true,
        supportsStreaming: true,
        supportsTimestampGranularities: false,
      },
    });
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "openai",
      transport: "openai_audio",
      model: "whisper-1-2026-01-01",
    })).toMatchObject({
      family: "openai_whisper",
      constraints: {
        responseFormats: ["json", "text", "srt", "verbose_json", "vtt"],
        supportsPrompt: true,
        supportsStreaming: false,
        supportsTimestampGranularities: true,
      },
    });
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "mimo",
      transport: "mimo_chat_audio",
      model: "mimo-v2.5-asr",
    })).toMatchObject({
      family: "mimo_asr",
      constraints: {
        responseFormats: ["json", "text"],
        languages: ["auto", "zh", "en"],
        supportsPrompt: false,
        supportsStreaming: true,
      },
    });
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "custom_openai_compatible",
      transport: "openai_audio",
      model: "vendor-asr-v3",
    })).toMatchObject({
      family: "openai_compatible_unknown",
      constraints: {
        responseFormats: ["json"],
        supportsPrompt: true,
        supportsStreaming: false,
        supportsTimestampGranularities: false,
      },
    });
  });

  it("fails closed for unknown built-in models and transport mismatches", () => {
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "openai",
      transport: "openai_audio",
      model: "unknown-openai-asr",
    })).toBeUndefined();
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "mimo",
      transport: "mimo_chat_audio",
      model: "unknown-mimo-asr",
    })).toBeUndefined();
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "openai",
      transport: "openai_realtime",
      model: "gpt-4o-transcribe",
    })).toBeUndefined();
    expect(resolveTranscriptionRouteDefinition({
      providerPreset: "custom_openai_compatible",
      transport: "mimo_chat_audio",
      model: "vendor-asr-v3",
    })).toBeUndefined();
  });

  it("keeps custom presets conservative until routes are configured", () => {
    const custom = profile("custom", "custom_openai_compatible");

    expect(createDefaultAudioApiRoutes("custom_openai_compatible")).toEqual({
      speechSynthesis: {},
    });
    expect(canAudioApiHandleTask(custom, "transcription")).toBe(false);
    expect(canAudioApiHandleTask(custom, "speechSynthesis")).toBe(false);

    custom.routes.speechSynthesis.preset_voice = {
      transport: "openai_audio",
      model: "provider-tts-model",
      enabled: true,
    };
    expect(canAudioApiHandleTask(custom, "speechSynthesis")).toBe(true);
    expect(
      getSpeechRouteConstraints(
        "custom_openai_compatible",
        "preset_voice",
      ),
    ).toMatchObject({
      responseFormats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
      supportsStreaming: false,
      fields: {
        voice: "required",
        instructions: "optional",
        speed: "optional",
      },
    });
  });

  it("freezes legacy provider inference without depending on text model types", () => {
    expect(
      inferAudioProviderPresetFromLegacy({
        transport: "mimo_chat_audio",
      }),
    ).toEqual({ preset: "mimo", needsAttention: false });
    expect(
      inferAudioProviderPresetFromLegacy({
        transport: "openai_realtime",
        connectionProvider: "OpenAI",
      }),
    ).toEqual({ preset: "openai", needsAttention: false });
    expect(
      inferAudioProviderPresetFromLegacy({
        transport: "openai_audio",
        connectionProvider: "Other",
      }),
    ).toEqual({
      preset: "custom_openai_compatible",
      needsAttention: true,
    });
  });

  it("derives task eligibility and resolves only enabled routes", () => {
    const mimo = profile("mimo", "mimo");

    expect(canAudioApiHandleTask(mimo, "transcription")).toBe(true);
    expect(canAudioApiHandleTask(mimo, "speechSynthesis")).toBe(true);
    expect(canAudioApiHandleTask(mimo, "realtimeCaptions")).toBe(true);
    expect(canAudioApiHandleTask(mimo, "realtimeVoice")).toBe(false);
    expect(
      resolveAudioApiRoute(mimo, "speechSynthesis", "voice_clone"),
    ).toMatchObject({ model: "mimo-v2.5-tts-voiceclone" });

    mimo.routes.speechSynthesis.voice_clone!.enabled = false;
    expect(
      resolveAudioApiRoute(mimo, "speechSynthesis", "voice_clone"),
    ).toBeUndefined();
  });

  it("returns clones so callers cannot mutate provider defaults", () => {
    const first = createDefaultAudioApiRoutes("mimo");
    first.speechSynthesis.preset_voice!.model = "changed";
    first.transcription!.enabled = false;

    const second = createDefaultAudioApiRoutes("mimo");
    expect(second.speechSynthesis.preset_voice?.model).toBe(
      "mimo-v2.5-tts",
    );
    expect(second.transcription?.enabled).toBe(true);
  });
});

function profile(
  id: string,
  preset: AudioApiProfile["providerPreset"],
): AudioApiProfile {
  return {
    id,
    name: id,
    providerPreset: preset,
    baseUrl: "",
    apiKey: "",
    routes: createDefaultAudioApiRoutes(preset),
  };
}
