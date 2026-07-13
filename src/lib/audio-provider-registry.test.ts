import { describe, expect, it } from "vitest";
import {
  MIMO_TTS_MODEL_BY_MODE,
  canAudioApiHandleTask,
  createDefaultAudioApiRoutes,
  getAudioProviderDefinition,
  getAvailableSpeechSynthesisModes,
  getRealtimeRouteConstraints,
  getSpeechRouteConstraints,
  getTranscriptionRouteConstraints,
  inferAudioProviderPresetFromLegacy,
  resolveAudioApiRoute,
} from "./audio-provider-registry";
import type { AudioApiProfile } from "@/type/audio";

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

  it("exposes cloned transcription and realtime constraints", () => {
    const transcription = getTranscriptionRouteConstraints("mimo")!;
    const realtime = getRealtimeRouteConstraints("openai", "realtimeCaptions")!;

    (transcription.responseFormats as string[])[0] = "text";
    (transcription.languages as string[])[0] = "fr";
    realtime.supportsLanguage = false;

    expect(getTranscriptionRouteConstraints("mimo")).toMatchObject({
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
