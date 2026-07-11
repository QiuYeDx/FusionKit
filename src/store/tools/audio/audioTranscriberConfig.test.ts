import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
  buildAudioTranscriptionRequest,
  getAudioTranscriberBase64ByteLength,
  inferAudioTranscriberMimeType,
  normalizeAudioTranscriberPreferencesForDialect,
  validateAudioTranscriberFile,
  type SelectedAudioInput,
} from "./audioTranscriberConfig";

describe("audio transcriber config helpers", () => {
  const file: SelectedAudioInput = {
    fileName: "sample.wav",
    filePath: "/tmp/sample.wav",
    fileToken: "file_token_sample",
    mimeType: "audio/wav",
    sizeBytes: 100,
  };

  it("infers audio MIME types from browser MIME and file extension", () => {
    expect(inferAudioTranscriberMimeType("voice.bin", "audio/x-wav")).toBe(
      "audio/wav",
    );
    expect(inferAudioTranscriberMimeType("voice.m4a", "")).toBe("audio/mp4");
    expect(inferAudioTranscriberMimeType("voice.unknown", "")).toBeUndefined();
  });

  it("applies dialect-specific file format and size rules before submit", () => {
    expect(
      validateAudioTranscriberFile(
        { name: "clip.m4a", type: "", size: 1024 },
        "mimo_chat_audio",
      ),
    ).toMatchObject({
      ok: false,
      issue: { code: "unsupported_file_for_mimo" },
    });

    const mimoRawLimit =
      Math.floor((10 * 1024 * 1024) / 4) * 3 + 1;
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

  it("normalizes MiMo-only ASR controls so OpenAI-only fields cannot leak", () => {
    const normalized = normalizeAudioTranscriberPreferencesForDialect(
      {
        ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
        language: "ja",
        responseFormat: "srt",
        prompt: "domain terms",
        timestampGranularities: ["word"],
        stream: true,
      },
      "mimo_chat_audio",
    );

    expect(normalized).toMatchObject({
      language: "auto",
      responseFormat: "json",
      prompt: "",
      timestampGranularities: [],
      stream: true,
    });
  });

  it("builds OpenAI-shaped requests without local API config", () => {
    const request = buildAudioTranscriptionRequest({
      requestId: "asr_req_001",
      file,
      dialect: "openai_audio",
      modelKey: "whisper-1",
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

  it("builds MiMo requests with only MiMo-supported ASR options", () => {
    const request = buildAudioTranscriptionRequest({
      requestId: "asr_req_002",
      file,
      dialect: "mimo_chat_audio",
      preferences: {
        ...DEFAULT_AUDIO_TRANSCRIBER_PREFERENCES,
        language: "en",
        responseFormat: "verbose_json",
        prompt: "must be stripped",
        timestampGranularities: ["word"],
        outputMode: "custom_dir",
        outputDir: "/tmp/out",
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
      outputDir: "/tmp/out",
    });
  });
});
