import { describe, expect, it } from "vitest";
import {
  AudioRuntimeClientError,
  createAudioRuntimeError,
  sanitizeAudioErrorDetails,
} from "../../electron/main/audio/audio-errors";

describe("audio runtime errors", () => {
  it("redacts API keys, request bodies, audio payloads, and binary chunks", () => {
    const sanitized = sanitizeAudioErrorDetails({
      apiKey: "sk-test-12345678901234567890",
      authorization: "Bearer sk-test-12345678901234567890",
      safeMessage: "format is unsupported",
      sizeBytes: 1234,
      base64EncodedBytes: 5678,
      nested: {
        audioDataUri: "data:audio/wav;base64,UklGRg==",
        requestBody: {
          model: "mimo-v2.5-tts",
          audio: { data: "not-for-logs" },
        },
        list: ["plain", "A".repeat(100)],
      },
      pcmBytes: Uint8Array.from([1, 2, 3]),
      buffer: Buffer.from([4, 5, 6]),
    });

    expect(sanitized).toMatchObject({
      apiKey: "[redacted]",
      authorization: "[redacted]",
      safeMessage: "format is unsupported",
      sizeBytes: 1234,
      base64EncodedBytes: 5678,
      nested: {
        audioDataUri: "[redacted]",
        requestBody: "[redacted]",
        list: ["plain", "[redacted]"],
      },
      pcmBytes: "[redacted]",
      buffer: "[redacted]",
    });
  });

  it("truncates very long non-sensitive strings", () => {
    const sanitized = sanitizeAudioErrorDetails({
      message: "safe text ".repeat(80),
    });

    expect(typeof sanitized?.message).toBe("string");
    expect(String(sanitized?.message)).toHaveLength(503);
    expect(String(sanitized?.message).endsWith("...")).toBe(true);
  });

  it("creates typed runtime errors with sanitized details and causes", () => {
    const cause = new Error("network failed");
    const error = createAudioRuntimeError({
      code: "http_unauthorized",
      message: "Authentication failed.",
      field: "apiKey",
      details: {
        apiKey: "sk-test-12345678901234567890",
        status: 401,
      },
      cause,
    });

    expect(error).toBeInstanceOf(AudioRuntimeClientError);
    expect(error).toMatchObject({
      name: "AudioRuntimeClientError",
      code: "http_unauthorized",
      field: "apiKey",
      details: {
        apiKey: "[redacted]",
        status: 401,
      },
    });
    expect(error.cause).toBe(cause);
  });
});
