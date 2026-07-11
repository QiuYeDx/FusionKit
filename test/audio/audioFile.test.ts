import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_MAX_UPLOAD_BYTES,
  MIMO_MAX_BASE64_AUDIO_BYTES,
  createRealtimeCaptionsFileNameHint,
  createSpeechOutputFileNameHint,
  createTranscriptOutputFileNameHint,
  ensureUniqueOutputPath,
  getBase64EncodedByteLength,
  inferAudioMimeType,
  isAudioMimeTypeAllowedForDialect,
  readAudioFileAsDataUri,
  resolveAudioInputFile,
  resolveAudioOutputPath,
  writeAudioOutputFile,
} from "../../electron/main/audio/audio-file";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-audio-file-test-"),
  );
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function createSparseFile(filePath: string, sizeBytes: number): Promise<void> {
  const handle = await open(filePath, "w");
  try {
    await handle.truncate(sizeBytes);
  } finally {
    await handle.close();
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, { recursive: true, force: true }),
    ),
  );
});

describe("audio file helpers", () => {
  it("infers supported audio MIME types from extensions and explicit values", () => {
    expect(inferAudioMimeType("voice.wav")).toBe("audio/wav");
    expect(inferAudioMimeType("voice.wave")).toBe("audio/wav");
    expect(inferAudioMimeType("voice.mp3")).toBe("audio/mpeg");
    expect(inferAudioMimeType("voice.mpeg")).toBe("audio/mpeg");
    expect(inferAudioMimeType("voice.m4a")).toBe("audio/mp4");
    expect(inferAudioMimeType("voice.mp4")).toBe("audio/mp4");
    expect(inferAudioMimeType("voice.flac")).toBe("audio/flac");
    expect(inferAudioMimeType("voice.ogg")).toBe("audio/ogg");
    expect(inferAudioMimeType("voice.webm")).toBe("audio/webm");
    expect(inferAudioMimeType("voice.bin", "audio/x-wav; charset=binary")).toBe(
      "audio/wav",
    );
    expect(inferAudioMimeType("voice.bin", "audio/mp3")).toBe("audio/mp3");
    expect(inferAudioMimeType("voice.bin")).toBeUndefined();
  });

  it("uses OpenAI and MiMo dialect-specific MIME allow lists", () => {
    expect(isAudioMimeTypeAllowedForDialect("audio/mp4", "openai_audio")).toBe(
      true,
    );
    expect(isAudioMimeTypeAllowedForDialect("audio/webm", "openai_audio")).toBe(
      true,
    );
    expect(isAudioMimeTypeAllowedForDialect("audio/wav", "mimo_chat_audio")).toBe(
      true,
    );
    expect(
      isAudioMimeTypeAllowedForDialect("audio/mpeg", "mimo_chat_audio"),
    ).toBe(true);
    expect(isAudioMimeTypeAllowedForDialect("audio/mp4", "mimo_chat_audio")).toBe(
      false,
    );
  });

  it("resolves audio file metadata and data URIs without exposing raw bytes", async () => {
    const tempRoot = await createTempRoot();
    const filePath = path.join(tempRoot, "sample.wav");
    const wavBytes = createTestWav([1, 2, 3, 4]);
    await writeFile(filePath, wavBytes);

    const fileInfo = await resolveAudioInputFile({
      filePath,
      dialect: "mimo_chat_audio",
    });

    expect(fileInfo).toMatchObject({
      filePath,
      fileName: "sample.wav",
      extension: "wav",
      mimeType: "audio/wav",
      sizeBytes: wavBytes.byteLength,
      base64EncodedBytes: getBase64EncodedByteLength(wavBytes.byteLength),
    });
    await expect(readAudioFileAsDataUri(fileInfo)).resolves.toBe(
      `data:audio/wav;base64,${wavBytes.toString("base64")}`,
    );
  });

  it("rejects unsupported formats and dialect-specific size limits", async () => {
    const tempRoot = await createTempRoot();
    const m4aPath = path.join(tempRoot, "sample.m4a");
    await writeFile(m4aPath, "m4a");

    await expect(
      resolveAudioInputFile({
        filePath: m4aPath,
        dialect: "mimo_chat_audio",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_audio_format",
      field: "mimeType",
    });

    const openaiTooLargePath = path.join(tempRoot, "openai-too-large.wav");
    await createSparseFile(openaiTooLargePath, AUDIO_MAX_UPLOAD_BYTES + 1);
    await expect(
      resolveAudioInputFile({
        filePath: openaiTooLargePath,
        dialect: "openai_audio",
      }),
    ).rejects.toMatchObject({
      code: "file_too_large",
      details: {
        sizeBytes: AUDIO_MAX_UPLOAD_BYTES + 1,
        maxBytes: AUDIO_MAX_UPLOAD_BYTES,
      },
    });

    const mimoTooLargePath = path.join(tempRoot, "mimo-too-large.mp3");
    const rawBytesOverMimoBase64Limit =
      Math.floor(MIMO_MAX_BASE64_AUDIO_BYTES / 4) * 3 + 1;
    await createSparseFile(mimoTooLargePath, rawBytesOverMimoBase64Limit);
    await expect(
      resolveAudioInputFile({
        filePath: mimoTooLargePath,
        dialect: "mimo_chat_audio",
      }),
    ).rejects.toMatchObject({
      code: "file_too_large",
      details: {
        sizeBytes: rawBytesOverMimoBase64Limit,
        base64EncodedBytes: getBase64EncodedByteLength(
          rawBytesOverMimoBase64Limit,
        ),
        maxBase64EncodedBytes: MIMO_MAX_BASE64_AUDIO_BYTES,
      },
    });
  });

  it("creates unique output paths without overwriting existing files", async () => {
    const tempRoot = await createTempRoot();
    const first = await resolveAudioOutputPath({
      outputPathMode: "custom_dir",
      outputDir: tempRoot,
      fileNameHint: "speech",
      extension: ".wav",
    });
    expect(first).toBe(path.join(tempRoot, "speech.wav"));

    await writeFile(first, "first");
    expect(
      await ensureUniqueOutputPath(path.join(tempRoot, "speech.wav")),
    ).toBe(path.join(tempRoot, "speech-1.wav"));

    await writeFile(path.join(tempRoot, "speech-1.wav"), "second");
    const third = await resolveAudioOutputPath({
      outputPathMode: "custom_dir",
      outputDir: tempRoot,
      fileNameHint: "speech",
      extension: "wav",
    });
    expect(third).toBe(path.join(tempRoot, "speech-2.wav"));
  });

  it("supports temp/source output modes and file name hint helpers", async () => {
    const tempRoot = await createTempRoot();
    const sourcePath = path.join(tempRoot, "source", "clip.mp3");
    await writeAudioOutputFile(sourcePath, "source-bytes");

    await expect(
      resolveAudioOutputPath({
        outputPathMode: "source_dir",
        sourcePath,
        fileNameHint: createTranscriptOutputFileNameHint(sourcePath),
        extension: "txt",
      }),
    ).resolves.toBe(path.join(tempRoot, "source", "clip.transcript.txt"));

    const localDate = new Date(2026, 6, 9, 1, 2, 3);
    expect(createSpeechOutputFileNameHint(localDate)).toBe(
      "speech_20260709_010203",
    );
    expect(createRealtimeCaptionsFileNameHint(localDate)).toBe(
      "realtime_captions_20260709_010203",
    );

    const tempOutput = await resolveAudioOutputPath({
      tempRoot,
      fileNameHint: "",
      extension: "wav",
      now: localDate,
    });
    expect(tempOutput).toBe(
      path.join(tempRoot, "fusionkit-audio", "speech_20260709_010203.wav"),
    );
  });

  it("writes output files and reports byte size", async () => {
    const tempRoot = await createTempRoot();
    const outputPath = path.join(tempRoot, "nested", "speech.wav");

    await expect(
      writeAudioOutputFile(outputPath, Buffer.from([1, 2, 3])),
    ).resolves.toEqual({
      outputPath,
      sizeBytes: 3,
    });
    await expect(stat(outputPath)).resolves.toMatchObject({ size: 3 });
  });
});

function createTestWav(payload: number[]): Buffer {
  const bytes = Buffer.from(payload);
  const wav = Buffer.alloc(44 + bytes.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + bytes.byteLength, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(bytes.byteLength, 40);
  bytes.copy(wav, 44);
  return wav;
}
