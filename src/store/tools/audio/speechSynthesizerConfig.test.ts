import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
  MIMO_TTS_MODEL_BY_MODE,
  buildSpeechSynthesisRequest,
  canStreamSpeechSynthesis,
  clampSpeechSpeed,
  getMimoModeForModel,
  isMimoModeCompatibleWithModel,
  normalizeSpeechSynthesizerPreferences,
  sanitizeSpeechSynthesizerPreferences,
  validateVoiceSampleFile,
  type SelectedVoiceSample,
} from "./speechSynthesizerConfig";

describe("speech synthesizer config helpers", () => {
  const voiceSample: SelectedVoiceSample = {
    fileName: "voice.wav",
    filePath: "/tmp/voice.wav",
    mimeType: "audio/wav",
    sizeBytes: 128,
  };

  it("builds OpenAI speech requests without MiMo-only fields", () => {
    const request = buildSpeechSynthesisRequest({
      requestId: "speech_req_001",
      dialect: "openai_audio",
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "Hello",
        voice: "alloy",
        instructions: "Warm tone",
        responseFormat: "wav",
        speed: 1.1,
        mimoMode: "voice_clone",
        voiceDesignPrompt: "must not leak",
      },
    });

    expect(request).toEqual({
      assignmentKey: "speechSynthesis",
      requestId: "speech_req_001",
      input: "Hello",
      voice: "alloy",
      instructions: "Warm tone",
      responseFormat: "wav",
      outputPathMode: "temp",
      speed: 1.1,
    });
    expect(request).not.toHaveProperty("mimoOptions");
  });

  it("builds MiMo preset voice requests without OpenAI speed", () => {
    const request = buildSpeechSynthesisRequest({
      requestId: "speech_req_002",
      dialect: "mimo_chat_audio",
      capabilities: ["streaming_speech_synthesis"],
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "你好",
        voice: "冰糖",
        speed: 1.4,
        stream: true,
        responseFormat: "mp3",
        mimoMode: "preset_voice",
        mimoStyleInstruction: "温柔一些",
      },
    });

    expect(request).toEqual({
      assignmentKey: "speechSynthesis",
      requestId: "speech_req_002",
      input: "你好",
      voice: "冰糖",
      responseFormat: "pcm16",
      outputPathMode: "temp",
      stream: true,
      mimoOptions: {
        mode: "preset_voice",
        styleInstruction: "温柔一些",
      },
    });
    expect(request).not.toHaveProperty("speed");
  });

  it("builds stream requests for all three MiMo modes", () => {
    for (const mode of Object.keys(MIMO_TTS_MODEL_BY_MODE) as Array<
      keyof typeof MIMO_TTS_MODEL_BY_MODE
    >) {
      const request = buildSpeechSynthesisRequest({
        requestId: `speech_${mode}`,
        dialect: "mimo_chat_audio",
        capabilities: ["streaming_speech_synthesis"],
        voiceSample,
        preferences: {
          ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
          input: mode === "voice_design" ? "" : "你好",
          stream: true,
          mimoMode: mode,
          voiceDesignPrompt:
            mode === "voice_design" ? "年轻、明亮的女声" : "",
          optimizeTextPreview: mode === "voice_design",
        },
      });

      expect(request.stream).toBe(true);
      expect(request.responseFormat).toBe("pcm16");
      expect(request.mimoOptions?.mode).toBe(mode);
      if (mode !== "voice_design") {
        expect(request.mimoOptions).not.toHaveProperty("optimizeTextPreview");
        expect(request.mimoOptions).not.toHaveProperty("voiceDesignPrompt");
      }
      expect(request.mimoOptions).not.toHaveProperty("audioTagsEnabled");
    }
  });

  it("whitelists MiMo fields by mode and clamps OpenAI speed", () => {
    const clone = buildSpeechSynthesisRequest({
      requestId: "speech_clone",
      dialect: "mimo_chat_audio",
      capabilities: ["streaming_speech_synthesis"],
      voiceSample,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "Hello",
        mimoMode: "voice_clone",
        voiceDesignPrompt: "must not leak",
        optimizeTextPreview: true,
        audioTagsEnabled: true,
      },
    });

    expect(clone.mimoOptions).toEqual({
      mode: "voice_clone",
      voiceSamplePath: "/tmp/voice.wav",
      voiceSampleMime: "audio/wav",
    });
    expect(clampSpeechSpeed(-2)).toBe(0.25);
    expect(clampSpeechSpeed(99)).toBe(4);
    expect(clampSpeechSpeed(Number.NaN)).toBe(1);
  });

  it("detects MiMo mode/model compatibility", () => {
    expect(getMimoModeForModel("mimo-v2.5-tts")).toBe("preset_voice");
    expect(
      isMimoModeCompatibleWithModel(
        "voice_clone",
        "mimo-v2.5-tts-voiceclone",
      ),
    ).toBe(true);
    expect(
      isMimoModeCompatibleWithModel("voice_clone", "mimo-v2.5-tts"),
    ).toBe(false);
  });

  it("normalizes stream and validates voice clone samples", () => {
    expect(canStreamSpeechSynthesis("openai_audio", [
      "streaming_speech_synthesis",
    ])).toBe(false);
    expect(
      normalizeSpeechSynthesizerPreferences(
        {
          ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
          stream: true,
          responseFormat: "mp3",
        },
        "mimo_chat_audio",
        ["streaming_speech_synthesis"],
      ),
    ).toMatchObject({ stream: true, responseFormat: "pcm16" });
    expect(
      validateVoiceSampleFile({ name: "voice.m4a", type: "", size: 10 }),
    ).toMatchObject({
      ok: false,
      issue: { code: "unsupported_voice_sample" },
    });
  });

  it("sanitizes persisted preferences and deep-fills new defaults", () => {
    expect(sanitizeSpeechSynthesizerPreferences({
      input: "kept",
      responseFormat: "not-a-format",
      speed: 99,
      mimoMode: "not-a-mode",
      audioTagsEnabled: true,
    })).toMatchObject({
      input: "kept",
      responseFormat: "mp3",
      speed: 4,
      mimoMode: "preset_voice",
      audioTagsEnabled: false,
      outputDir: "",
    });
  });
});
