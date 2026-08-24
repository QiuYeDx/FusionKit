import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPcm16SilenceWav } from "../benchmark/generate-synthetic-fixtures.mjs";
import {
  inspectPcm16Wav,
  planPcmWindows,
  writePcmWindow,
} from "./pcm-windowing.mjs";

test("plans overlapping PCM windows with continuous owned cores", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fusionkit-pcm-window-test-"));
  const sourcePath = path.join(directory, "source.wav");
  const windowPath = path.join(directory, "window.wav");
  try {
    await writeFile(sourcePath, createPcm16SilenceWav({
      durationMs: 6_500,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
    }));
    const metadata = await inspectPcm16Wav(sourcePath);
    const windows = planPcmWindows(metadata, {
      windowMs: 3_000,
      overlapMs: 500,
    });
    assert.deepEqual(
      windows.map((window) => [
        window.startMs,
        window.endMs,
        window.coreStartMs,
        window.coreEndMs,
      ]),
      [
        [0, 3_000, 0, 2_750],
        [2_500, 5_500, 2_750, 5_250],
        [5_000, 6_500, 5_250, 6_500],
      ],
    );

    await writePcmWindow({
      sourcePath,
      outputPath: windowPath,
      metadata,
      window: windows[1],
    });
    const sliced = await inspectPcm16Wav(windowPath);
    assert.equal(sliced.durationMs, 3_000);
    assert.equal(sliced.totalFrames, 48_000);
    assert.equal(sliced.dataSizeBytes, 96_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects overlap that is not smaller than the PCM window", async () => {
  const metadata = { sampleRate: 16_000, totalFrames: 160_000 };
  assert.throws(
    () => planPcmWindows(metadata, { windowMs: 5_000, overlapMs: 5_000 }),
    /overlap must be non-negative and smaller/u,
  );
});
