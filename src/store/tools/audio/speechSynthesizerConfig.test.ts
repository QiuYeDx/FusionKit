import { describe, expect, it } from "vitest";
import {
  createDefaultAudioApiRoutes,
  getSpeechRouteConstraints,
} from "@/lib/audio-provider-registry";
import {
  AUDIO_SPEECH_MAX_INPUT_CHARS,
  AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS,
  type AudioApiProfile,
  type AudioTaskAssignment,
  type SpeechSynthesisMode,
} from "@/type/audio";
import {
  DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
  buildSpeechSynthesisRequest,
  clampSpeechSpeed,
  createSpeechSynthesisSubmissionSnapshot,
  isSpeechSynthesisSubmissionSnapshotCurrent,
  normalizeSpeechSynthesizerPreferences,
  resolveAvailableSpeechMode,
  resolveSpeechSynthesisConfigSummary,
  resolveSpeechSynthesisFieldVisibility,
  resolveSpeechSynthesisSubmitIssue,
  sanitizeSpeechSynthesizerPreferences,
  validateVoiceSampleFile,
  type SelectedVoiceSample,
} from "./speechSynthesizerConfig";

describe("speech synthesizer config helpers", () => {
  const voiceSample: SelectedVoiceSample = {
    fileToken: "voice_sample_token",
    fileName: "voice.wav",
    mimeType: "audio/wav",
    sizeBytes: 128,
    expiresAt: Date.now() + 60_000,
  };

  it("resolves enabled routes and falls back without exposing credentials", () => {
    const profile = createProfile("mimo");
    const state = createState(profile);

    const kept = resolveSpeechSynthesisConfigSummary(state, "voice_clone");
    expect(kept).toMatchObject({
      status: "ready",
      profileName: "MiMo audio",
      providerPreset: "mimo",
      availableModes: ["preset_voice", "voice_design", "voice_clone"],
      activeMode: "voice_clone",
      route: { model: "mimo-v2.5-tts-voiceclone" },
    });
    expect(JSON.stringify(kept)).not.toContain("secret-key");

    profile.routes.speechSynthesis.voice_clone = undefined;
    const fallback = resolveSpeechSynthesisConfigSummary(state, "voice_clone");
    expect(fallback.activeMode).toBe("preset_voice");
    expect(fallback.availableModes).toEqual(["preset_voice", "voice_design"]);
  });

  it("reports actionable configuration states", () => {
    expect(
      resolveSpeechSynthesisConfigSummary(
        { profiles: [], assignment: emptyAssignment() },
        "preset_voice",
      ).status,
    ).toBe("audio_api_not_configured");

    const profile = createProfile("custom_openai_compatible");
    profile.routes.speechSynthesis = {};
    expect(
      resolveSpeechSynthesisConfigSummary(
        createState(profile),
        "preset_voice",
      ).status,
    ).toBe("audio_route_not_configured");
  });

  it("uses stable mode fallback priority", () => {
    expect(resolveAvailableSpeechMode(["voice_clone"], "voice_design"))
      .toBe("voice_clone");
    expect(
      resolveAvailableSpeechMode(
        ["voice_design", "preset_voice"],
        "voice_clone",
      ),
    ).toBe("preset_voice");
    expect(resolveAvailableSpeechMode([], "preset_voice")).toBeUndefined();
  });

  it("invalidates a pending submission when its route or source file changes", () => {
    const profile = createProfile("mimo");
    const state = createState(profile);
    const sourceFile = new File(["voice"], "voice.wav", { type: "audio/wav" });
    const selected = { ...voiceSample, sourceFile };
    const summary = resolveSpeechSynthesisConfigSummary(state, "voice_clone");
    const snapshot = createSpeechSynthesisSubmissionSnapshot(summary, selected);

    expect(
      isSpeechSynthesisSubmissionSnapshotCurrent(snapshot, summary, selected),
    ).toBe(true);
    expect(
      isSpeechSynthesisSubmissionSnapshotCurrent(
        snapshot,
        resolveSpeechSynthesisConfigSummary(state, "voice_design"),
        selected,
      ),
    ).toBe(false);
    expect(
      isSpeechSynthesisSubmissionSnapshotCurrent(snapshot, summary, {
        ...selected,
        sourceFile: new File(["other"], "other.wav", { type: "audio/wav" }),
      }),
    ).toBe(false);

    profile.routes.speechSynthesis.voice_clone = {
      ...profile.routes.speechSynthesis.voice_clone!,
      model: "mimo-v2.5-tts-voiceclone-next",
    };
    expect(
      isSpeechSynthesisSubmissionSnapshotCurrent(
        snapshot,
        resolveSpeechSynthesisConfigSummary(state, "voice_clone"),
        selected,
      ),
    ).toBe(false);
  });

  it("builds exact provider-neutral intents for every mode", () => {
    const cases: Array<{
      mode: SpeechSynthesisMode;
      patch: Partial<typeof DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES>;
      expectedIntent: Record<string, unknown>;
    }> = [
      {
        mode: "preset_voice",
        patch: { voice: "mimo_default", styleInstruction: "Warm" },
        expectedIntent: {
          mode: "preset_voice",
          voice: "mimo_default",
          styleInstruction: "Warm",
        },
      },
      {
        mode: "voice_design",
        patch: {
          voiceDesignPrompt: "Bright voice",
          optimizeTextPreview: true,
          styleInstruction: "must not leak",
        },
        expectedIntent: {
          mode: "voice_design",
          voiceDesignPrompt: "Bright voice",
          optimizeTextPreview: true,
        },
      },
      {
        mode: "voice_clone",
        patch: {
          voiceDesignPrompt: "must not leak",
          styleInstruction: "Calm",
        },
        expectedIntent: {
          mode: "voice_clone",
          voiceSampleToken: "voice_sample_token",
          styleInstruction: "Calm",
        },
      },
    ];

    for (const entry of cases) {
      const constraints = getSpeechRouteConstraints("mimo", entry.mode)!;
      const request = buildSpeechSynthesisRequest({
        requestId: `speech_${entry.mode}`,
        constraints,
        outputDirectoryAuthorization: null,
        voiceSample,
        preferences: {
          ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
          input: entry.mode === "voice_design" ? "" : "Hello",
          speechMode: entry.mode,
          stream: true,
          ...entry.patch,
        },
      });

      expect(request.intent).toEqual(entry.expectedIntent);
      expect(request.responseFormat).toBe("pcm16");
      expect(request.stream).toBe(true);
      expect(request).not.toHaveProperty("model");
      expect(request).not.toHaveProperty("providerPreset");
      expect(request).not.toHaveProperty("baseUrl");
      expect(request).not.toHaveProperty("apiKey");
      expect(JSON.stringify(request)).not.toContain("/tmp/");
    }
  });

  it("builds OpenAI requests only from supported fields", () => {
    const constraints = getSpeechRouteConstraints("openai", "preset_voice")!;
    const request = buildSpeechSynthesisRequest({
      requestId: "speech_openai",
      constraints,
      outputDirectoryAuthorization: null,
      voiceSample,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "Hello",
        voice: "alloy",
        instructions: "Warm tone",
        responseFormat: "wav",
        speed: 1.1,
        styleInstruction: "must not leak",
        voiceDesignPrompt: "must not leak",
      },
    });

    expect(request).toEqual({
      assignmentKey: "speechSynthesis",
      requestId: "speech_openai",
      input: "Hello",
      intent: { mode: "preset_voice", voice: "alloy" },
      instructions: "Warm tone",
      responseFormat: "wav",
      outputPathMode: "temp",
      speed: 1.1,
    });
  });

  it("derives submit issues from visible route constraints", () => {
    const preset = getSpeechRouteConstraints("mimo", "preset_voice")!;
    const design = getSpeechRouteConstraints("mimo", "voice_design")!;
    const clone = getSpeechRouteConstraints("mimo", "voice_clone")!;
    const baseOptions = {
      voiceSample: null,
      voiceSampleAuthorizationPending: false,
      outputDirectoryAuthorization: null,
    };
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: preset,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "MiMo speech",
        voice: "alloy",
      },
    })).toBe("invalid_voice");
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: preset,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "MiMo speech",
        voice: "mimo_default",
      },
    })).toBeNull();
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: design,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        speechMode: "voice_design",
        input: "",
        voiceDesignPrompt: "Bright voice",
        optimizeTextPreview: true,
      },
    })).toBeNull();
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: design,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        speechMode: "voice_design",
        input: "",
        voiceDesignPrompt: "",
        optimizeTextPreview: true,
      },
    })).toBe("voice_design_prompt_required");
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: clone,
      voiceSampleAuthorizationPending: true,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        speechMode: "voice_clone",
        input: "Clone me",
      },
    })).toBe("voice_sample_authorizing");

    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: clone,
      voiceSample: {
        ...voiceSample,
        sourceFile: new File(["sample"], "voice.wav", {
          type: "audio/wav",
        }),
        fileToken: null,
      },
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        speechMode: "voice_clone",
        input: "Clone me",
      },
    })).toBeNull();
  });

  it("enforces route text limits at the renderer submission boundary", () => {
    const baseOptions = {
      voiceSample: null,
      voiceSampleAuthorizationPending: false,
      outputDirectoryAuthorization: null,
    };
    const mimo = getSpeechRouteConstraints("mimo", "preset_voice")!;
    const openai = getSpeechRouteConstraints("openai", "preset_voice")!;

    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: mimo,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "m".repeat(AUDIO_SPEECH_MAX_INPUT_CHARS),
        voice: "mimo_default",
      },
    })).toBeNull();
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: mimo,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "m".repeat(AUDIO_SPEECH_MAX_INPUT_CHARS + 1),
        voice: "mimo_default",
      },
    })).toBe("input_too_long");

    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: openai,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "o".repeat(AUDIO_SPEECH_MAX_INPUT_CHARS),
        instructions: "i".repeat(AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS),
      },
    })).toBeNull();
    expect(resolveSpeechSynthesisSubmitIssue({
      ...baseOptions,
      constraints: openai,
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "openai",
        instructions: "i".repeat(AUDIO_SPEECH_MAX_INSTRUCTIONS_CHARS + 1),
      },
    })).toBe("instructions_too_long");
  });

  it("derives the complete field matrix from route constraints", () => {
    const openai = resolveSpeechSynthesisFieldVisibility(
      getSpeechRouteConstraints("openai", "preset_voice")!,
      false,
    );
    expect(openai).toEqual({
      voice: true,
      instructions: true,
      speed: true,
      styleInstruction: false,
      voiceDesignPrompt: false,
      optimizeTextPreview: false,
      referenceAudio: false,
      responseFormatSelect: true,
      responseFormatSummary: false,
      stream: false,
    });

    const preset = resolveSpeechSynthesisFieldVisibility(
      getSpeechRouteConstraints("mimo", "preset_voice")!,
      false,
    );
    expect(preset).toMatchObject({
      voice: true,
      styleInstruction: true,
      voiceDesignPrompt: false,
      referenceAudio: false,
      responseFormatSelect: false,
      responseFormatSummary: true,
      stream: true,
    });

    const design = resolveSpeechSynthesisFieldVisibility(
      getSpeechRouteConstraints("mimo", "voice_design")!,
      false,
    );
    expect(design).toMatchObject({
      voice: false,
      styleInstruction: false,
      voiceDesignPrompt: true,
      optimizeTextPreview: true,
      referenceAudio: false,
    });

    const clone = resolveSpeechSynthesisFieldVisibility(
      getSpeechRouteConstraints("mimo", "voice_clone")!,
      true,
    );
    expect(clone).toMatchObject({
      voice: false,
      styleInstruction: true,
      voiceDesignPrompt: false,
      optimizeTextPreview: false,
      referenceAudio: true,
      responseFormatSelect: false,
      responseFormatSummary: true,
    });
  });

  it("normalizes route formats and migrates legacy preference names", () => {
    const streaming = normalizeSpeechSynthesizerPreferences(
      {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        speechMode: "voice_clone",
        stream: true,
        responseFormat: "mp3",
      },
      getSpeechRouteConstraints("mimo", "voice_clone")!,
    );
    expect(streaming).toMatchObject({
      speechMode: "voice_clone",
      stream: true,
      responseFormat: "pcm16",
    });

    expect(sanitizeSpeechSynthesizerPreferences({
      input: "kept",
      mimoMode: "voice_design",
      mimoStyleInstruction: "legacy style",
      responseFormat: "not-a-format",
      speed: 99,
    })).toMatchObject({
      input: "kept",
      speechMode: "voice_design",
      styleInstruction: "legacy style",
      responseFormat: "mp3",
      speed: 4,
      modeInputDrafts: { voice_design: "kept" },
    });
  });

  it("validates voice samples and custom-directory tokens", () => {
    expect(
      validateVoiceSampleFile({ name: "voice.m4a", type: "", size: 10 }),
    ).toMatchObject({
      ok: false,
      issue: { code: "unsupported_voice_sample" },
    });

    const request = buildSpeechSynthesisRequest({
      requestId: "speech_custom_dir",
      constraints: getSpeechRouteConstraints("openai", "preset_voice")!,
      outputDirectoryAuthorization: {
        outputDirToken: "output_dir_token_speech",
        directoryName: "Exports",
        expiresAt: Date.now() + 60_000,
      },
      preferences: {
        ...DEFAULT_SPEECH_SYNTHESIZER_PREFERENCES,
        input: "Hello",
        outputMode: "custom_dir",
        outputDir: "Exports",
      },
    });
    expect(request).toMatchObject({
      outputPathMode: "custom_dir",
      outputDirToken: "output_dir_token_speech",
    });
    expect(request).not.toHaveProperty("outputDir");
  });

  it("clamps speed values", () => {
    expect(clampSpeechSpeed(-2)).toBe(0.25);
    expect(clampSpeechSpeed(99)).toBe(4);
    expect(clampSpeechSpeed(Number.NaN)).toBe(1);
  });
});

function createProfile(
  providerPreset: AudioApiProfile["providerPreset"],
): AudioApiProfile {
  return {
    id: `profile_${providerPreset}`,
    name: providerPreset === "mimo" ? "MiMo audio" : "Audio API",
    providerPreset,
    baseUrl: "https://audio.example.test/v1",
    apiKey: "secret-key",
    routes: createDefaultAudioApiRoutes(providerPreset),
  };
}

function createState(profile: AudioApiProfile): {
  profiles: AudioApiProfile[];
  assignment: AudioTaskAssignment;
} {
  return {
    profiles: [profile],
    assignment: {
      ...emptyAssignment(),
      speechSynthesis: profile.id,
    },
  };
}

function emptyAssignment(): AudioTaskAssignment {
  return {
    transcription: null,
    speechSynthesis: null,
    realtimeCaptions: null,
    realtimeVoice: null,
  };
}
