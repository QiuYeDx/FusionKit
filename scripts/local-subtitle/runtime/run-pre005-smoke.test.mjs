import assert from "node:assert/strict";
import test from "node:test";
import {
  PRE005_FORMAT_CASES,
  createZeroDurationPcm16Wav,
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
