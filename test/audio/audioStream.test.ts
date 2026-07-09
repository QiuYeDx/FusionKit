import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAudioStreamStats,
  createPcm16WavBuffer,
  writePcm16WavFile,
} from "../../electron/main/audio/audio-stream";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-audio-stream-test-"),
  );
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, { recursive: true, force: true }),
    ),
  );
});

describe("audio stream helpers", () => {
  it("wraps PCM16 chunks in a valid WAV header", () => {
    const first = Uint8Array.from([0x01, 0x00, 0xff, 0x7f]);
    const second = Uint8Array.from([0x00, 0x80, 0x00, 0x00]);
    const wav = createPcm16WavBuffer([first, second], {
      sampleRate: 44_100,
      channels: 2,
    });

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + first.byteLength + second.byteLength);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(44_100);
    expect(wav.readUInt32LE(28)).toBe(44_100 * 2 * 2);
    expect(wav.readUInt16LE(32)).toBe(4);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(first.byteLength + second.byteLength);
    expect([...wav.subarray(44)]).toEqual([...first, ...second]);
  });

  it("uses 24kHz mono defaults for MiMo PCM16 streams", () => {
    const wav = createPcm16WavBuffer([Uint8Array.from([1, 2])]);

    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(2);
  });

  it("writes WAV files to disk", async () => {
    const tempRoot = await createTempRoot();
    const outputPath = path.join(tempRoot, "speech.wav");

    await expect(
      writePcm16WavFile(outputPath, [Uint8Array.from([1, 2, 3, 4])]),
    ).resolves.toEqual({
      outputPath,
      sizeBytes: 48,
    });
    await expect(stat(outputPath)).resolves.toMatchObject({ size: 48 });
  });

  it("computes stream stats with first chunk latency and defaults", () => {
    expect(
      createAudioStreamStats({
        startedAtMs: 100,
        firstChunkAtMs: 145,
        chunkCount: 3,
        totalBytes: 1024,
        streamMode: "incremental",
      }),
    ).toEqual({
      firstChunkLatencyMs: 45,
      chunkCount: 3,
      totalBytes: 1024,
      sampleRate: 24_000,
      channels: 1,
      streamMode: "incremental",
    });

    expect(
      createAudioStreamStats({
        startedAtMs: 100,
        chunkCount: 1,
        totalBytes: 256,
        sampleRate: 48_000,
        channels: 2,
      }),
    ).toEqual({
      chunkCount: 1,
      totalBytes: 256,
      sampleRate: 48_000,
      channels: 2,
    });
  });

  it("rejects invalid WAV metadata", () => {
    expect(() =>
      createPcm16WavBuffer([], { sampleRate: 0 }),
    ).toThrow("sampleRate");
    expect(() =>
      createPcm16WavBuffer([], { channels: 0 }),
    ).toThrow("channels");
  });
});
