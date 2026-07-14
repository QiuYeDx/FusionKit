import { describe, expect, it } from "vitest";
import type { AudioApiProfile, AudioTaskAssignment } from "@/type/audio";
import {
  DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
  buildAudioTranscriptionRequest,
  getAudioTranscriberBase64ByteLength,
  inferAudioTranscriberMimeType,
  normalizeAudioTranscriberPreferences,
  resolveAudioTranscriberFieldVisibility,
  resolveAudioTranscriptionConfigSummary,
  sanitizeAudioTranscriberPreferences,
  validateAudioTranscriberFile,
  type SelectedAudioInput,
} from "./audioTranscriberConfig";

describe("audio transcriber config helpers", () => {
  const sourceFile = new File(["sample"], "sample.wav", {
    type: "audio/wav",
  });
  const file: SelectedAudioInput & { fileToken: string } = {
    sourceFile,
    fileName: "sample.wav",
    fileToken: "file_token_sample",
    mimeType: "audio/wav",
    sizeBytes: sourceFile.size,
    expiresAt: Date.now() + 60_000,
  };

  it("infers audio MIME types from browser MIME and file extension", () => {
    expect(inferAudioTranscriberMimeType("voice.bin", "audio/x-wav")).toBe(
      "audio/wav",
    );
    expect(inferAudioTranscriberMimeType("voice.m4a", "")).toBe("audio/mp4");
    expect(inferAudioTranscriberMimeType("voice.unknown", "")).toBeUndefined();
  });

  it("applies transport-specific file format and size rules before submit", () => {
    expect(
      validateAudioTranscriberFile(
        { name: "clip.m4a", type: "", size: 1024 },
        "mimo_chat_audio",
      ),
    ).toMatchObject({
      ok: false,
      issue: { code: "unsupported_file_for_mimo" },
    });

    const mimoRawLimit = Math.floor((10 * 1024 * 1024) / 4) * 3 + 1;
    expect(getAudioTranscriberBase64ByteLength(mimoRawLimit)).toBeGreaterThan(
      10 * 1024 * 1024,
    );
    expect(
      validateAudioTranscriberFile(
        { name: "clip.mp3", type: "", size: mimoRawLimit },
        "mimo_chat_audio",
      ),
    ).toMatchObject({
      ok: false,
      issue: { code: "file_too_large" },
    });
  });

  it("resolves Whisper fields from its standalone route definition", () => {
    const summary = resolveAudioTranscriptionConfigSummary(
      createState("openai", "openai_audio", "whisper-1"),
    );

    expect(summary).toMatchObject({
      status: "ready",
      routeFamily: "openai_whisper",
      capabilities: ["file_transcription"],
      constraints: {
        responseFormats: ["json", "text", "srt", "verbose_json", "vtt"],
        supportsPrompt: true,
        supportsStreaming: false,
        supportsTimestampGranularities: true,
      },
    });
    expect(resolveAudioTranscriberFieldVisibility(
      summary.constraints!,
      "verbose_json",
    )).toEqual({
      language: true,
      prompt: true,
      timestampGranularities: true,
      stream: false,
      responseFormatSelect: true,
      responseFormatSummary: false,
    });
    expect(resolveAudioTranscriberFieldVisibility(
      summary.constraints!,
      "json",
    ).timestampGranularities).toBe(false);
  });

  it("adds streaming capability only when the route definition supports it", () => {
    const gptSummary = resolveAudioTranscriptionConfigSummary(
      createState("openai", "openai_audio", "gpt-4o-transcribe"),
    );
    const mimoSummary = resolveAudioTranscriptionConfigSummary(
      createState("mimo", "mimo_chat_audio", "mimo-v2.5-asr"),
    );

    expect(gptSummary.capabilities).toEqual([
      "file_transcription",
      "streaming_transcription",
    ]);
    expect(mimoSummary.capabilities).toEqual([
      "file_transcription",
      "streaming_transcription",
    ]);
    expect(resolveAudioTranscriberFieldVisibility(
      gptSummary.constraints!,
      "json",
    ))
      .toMatchObject({
        prompt: true,
        timestampGranularities: false,
        stream: true,
        responseFormatSelect: false,
        responseFormatSummary: true,
      });
  });

  it("fails closed when an assigned route has no registry definition", () => {
    const summary = resolveAudioTranscriptionConfigSummary(
      createState("openai", "openai_audio", "unknown-openai-asr"),
    );

    expect(summary).toMatchObject({
      status: "audio_route_not_configured",
      profileId: "audio_profile",
      modelKey: "unknown-openai-asr",
      capabilities: [],
    });
    expect(summary.constraints).toBeUndefined();
  });

  it("normalizes MiMo-only ASR controls from route constraints", () => {
    const summary = resolveAudioTranscriptionConfigSummary(
      createState("mimo", "mimo_chat_audio", "mimo-v2.5-asr"),
    );
    const normalized = normalizeAudioTranscriberPreferences(
      {
        ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
        language: "ja",
        responseFormat: "srt",
        prompt: "domain terms",
        timestampGranularities: ["word"],
        stream: true,
      },
      summary.constraints!,
    );

    expect(normalized).toMatchObject({
      language: "auto",
      responseFormat: "json",
      prompt: "",
      timestampGranularities: [],
      stream: true,
    });
  });

  it("builds Whisper requests without legacy provider or model context", () => {
    const summary = resolveAudioTranscriptionConfigSummary(
      createState("openai", "openai_audio", "whisper-1"),
    );
    const request = buildAudioTranscriptionRequest({
      requestId: "asr_req_001",
      file,
      outputDirectoryAuthorization: null,
      constraints: summary.constraints!,
      preferences: {
        ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
        language: "zh",
        responseFormat: "verbose_json",
        prompt: "names",
        stream: true,
        timestampGranularities: ["segment"],
        outputMode: "source_dir",
      },
    });

    expect(request).toEqual({
      assignmentKey: "transcription",
      requestId: "asr_req_001",
      fileToken: "file_token_sample",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      language: "zh",
      responseFormat: "verbose_json",
      prompt: "names",
      timestampGranularities: ["segment"],
      outputPathMode: "source_dir",
    });
    expect(request).not.toHaveProperty("stream");
    expect(request).not.toHaveProperty("apiKey");
    expect(request).not.toHaveProperty("baseUrl");
    expect(request).not.toHaveProperty("modelKey");
  });

  it("builds MiMo requests with only route-supported ASR options", () => {
    const summary = resolveAudioTranscriptionConfigSummary(
      createState("mimo", "mimo_chat_audio", "mimo-v2.5-asr"),
    );
    const request = buildAudioTranscriptionRequest({
      requestId: "asr_req_002",
      file,
      outputDirectoryAuthorization: {
        outputDirToken: "output_dir_token_mimo",
        directoryName: "out",
        expiresAt: Date.now() + 60_000,
      },
      constraints: summary.constraints!,
      preferences: {
        ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
        language: "en",
        responseFormat: "verbose_json",
        prompt: "must be stripped",
        timestampGranularities: ["word"],
        outputMode: "custom_dir",
        outputDir: "out",
      },
    });

    expect(request).toEqual({
      assignmentKey: "transcription",
      requestId: "asr_req_002",
      fileToken: "file_token_sample",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      language: "en",
      responseFormat: "json",
      outputPathMode: "custom_dir",
      outputDirToken: "output_dir_token_mimo",
    });
    expect(request).not.toHaveProperty("outputDir");
  });

  it("sanitizes persisted preferences without carrying unknown state", () => {
    expect(
      sanitizeAudioTranscriberPreferences({
        language: 42,
        responseFormat: "invalid",
        timestampGranularities: ["segment", "invalid", "word"],
        prompt: "Keep prompt",
        stream: "yes",
        outputMode: "custom_dir",
        outputDir: "/private/exports/",
      }),
    ).toEqual({
      ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
      timestampGranularities: ["segment", "word"],
      prompt: "Keep prompt",
      outputMode: "custom_dir",
      outputDir: "exports",
    });
  });
});

function createState(
  providerPreset: AudioApiProfile["providerPreset"],
  transport: NonNullable<AudioApiProfile["routes"]["transcription"]>["transport"],
  model: string,
): { profiles: AudioApiProfile[]; assignment: AudioTaskAssignment } {
  return {
    profiles: [
      {
        id: "audio_profile",
        name: "Audio profile",
        providerPreset,
        baseUrl: "https://audio.example.com/v1",
        apiKey: "audio-secret",
        routes: {
          transcription: { transport, model, enabled: true },
          speechSynthesis: {},
        },
      },
    ],
    assignment: {
      transcription: "audio_profile",
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: null,
    },
  };
}
