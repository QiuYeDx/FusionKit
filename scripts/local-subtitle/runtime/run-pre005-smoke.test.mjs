import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  PRE005_FORMAT_CASES,
  createZeroDurationPcm16Wav,
  findExecutableOnSanitizedPath,
  mutateBinaryArchitecture,
  summarizeMediaProbe,
} from "./run-pre005-smoke.mjs";

test("freezes the exact PRE-005 media container matrix", () => {
  assert.deepEqual(
    PRE005_FORMAT_CASES.map((entry) => entry.id),
    ["mp3", "wav", "flac", "aac", "m4a", "mp4", "mkv", "mov", "webm"],
  );
  assert.deepEqual(
    PRE005_FORMAT_CASES.filter((entry) => entry.video).map((entry) => entry.id),
    ["mp4", "mkv", "mov", "webm"],
  );
});

test("checks a sanitized Windows PATH without spawning where.exe", async () => {
  assert.equal(
    await findExecutableOnSanitizedPath(
      "where.exe",
      { PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32` },
      "win32",
    ),
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
  );
  assert.equal(
    await findExecutableOnSanitizedPath(
      "fusionkit-definitely-missing.exe",
      { PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32` },
      "win32",
    ),
    null,
  );
});

test("mutates the PE machine field for the Windows wrong-architecture fault", () => {
  const pe = Buffer.alloc(128);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\0\0", 64, "binary");
  pe.writeUInt16LE(0x8664, 68);
  mutateBinaryArchitecture(pe, "win32");
  assert.equal(pe.readUInt16LE(68), 0xaa64);
});

test("creates a valid zero-duration PCM16 WAV fixture", () => {
  const wav = createZeroDurationPcm16Wav();
  assert.equal(wav.length, 44);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 0);
});

test("summarizes audio/video/default tracks without retaining metadata text", () => {
  assert.deepEqual(
    summarizeMediaProbe({
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          tags: { title: "untrusted title" },
        },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "aac",
          disposition: { default: 1 },
          tags: { language: "jpn" },
        },
        {
          index: 2,
          codec_type: "audio",
          codec_name: "aac",
          disposition: { default: 0 },
        },
      ],
      format: { duration: "2.005" },
    }),
    {
      audioStreamCount: 2,
      videoStreamCount: 1,
      defaultAudioStreamCount: 1,
      durationMs: 2_005,
    },
  );
  assert.equal(summarizeMediaProbe({ format: {} }).durationMs, 0);
});
