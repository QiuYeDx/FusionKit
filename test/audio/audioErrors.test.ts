import { describe, expect, it } from "vitest";
import {
  AudioRuntimeClientError,
  createAudioRuntimeError,
  sanitizeAudioErrorDetails,
} from "../../electron/main/audio/audio-errors";
import { runAudioRuntimeRequest } from "../../electron/main/audio/audio-http";

describe("audio runtime errors", () => {
  it("redacts credentials, payloads, filesystem paths, and binary chunks", () => {
    const sanitized = sanitizeAudioErrorDetails({
      apiKey: "sk-test-12345678901234567890",
      authorization: "Bearer sk-test-12345678901234567890",
      safeMessage: "format is unsupported",
      sizeBytes: 1234,
      base64EncodedBytes: 5678,
      path: "/Users/private/audio.wav",
      filePath: "/Users/private/input.wav",
      outputPath: "/Users/private/output.wav",
      directory: "/Users/private",
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
      path: "[redacted]",
      filePath: "[redacted]",
      outputPath: "[redacted]",
      directory: "[redacted]",
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

  it("does not promote unknown filesystem error messages into public runtime errors", async () => {
    const privatePath = "/private/audio/output.wav";

    await expect(runAudioRuntimeRequest(
      {
        apiKey: "sk-test-12345678901234567890",
        retry: { maxRetries: 0 },
      },
      async () => {
        throw new Error(`ENOENT: no such file, open '${privatePath}'`);
      },
    )).rejects.toMatchObject({
      code: "network_error",
      message: "Audio request failed.",
    });

    try {
      await runAudioRuntimeRequest(
        { apiKey: "test", retry: { maxRetries: 0 } },
        async () => {
          throw new Error(`EACCES: '${privatePath}'`);
        },
      );
    } catch (error) {
      expect(String(error)).not.toContain(privatePath);
    }
  });
});
