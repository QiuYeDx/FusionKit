import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPcm16SilenceWav } from "../benchmark/generate-synthetic-fixtures.mjs";
import { inspectPcm16Wav } from "./pcm-windowing.mjs";
import {
  analyzeTranscriptSegments,
  mergeWindowTranscripts,
} from "./transcript-quality.mjs";
import { transcribePcmInWindows } from "./windowed-transcription.mjs";

test("raw quality gate rejects long repetition and invalid timeline segments", () => {
  const repeated = Array.from({ length: 10 }, (_, index) => ({
    startMs: index * 2_000,
    endMs: (index + 1) * 2_000,
    text: "同一句话！",
  }));
  const analysis = analyzeTranscriptSegments([
    ...repeated,
    { startMs: 20_000, endMs: 20_000, text: "zero" },
    { startMs: 31_000, endMs: 32_000, text: "outside" },
    { startMs: 3_000, endMs: 28_000, text: "one implausibly long cue" },
  ], { durationMs: 30_000 });

  assert.equal(analysis.valid, false);
  assert.equal(analysis.repetitionDegenerate, true);
  assert.equal(analysis.longestConsecutiveRepeatCueCount, 10);
  assert.equal(analysis.longestConsecutiveRepeatDurationMs, 20_000);
  assert.equal(analysis.zeroOrNegativeDurationSegmentCount, 1);
  assert.equal(analysis.outOfBoundsSegmentCount, 1);
  assert.equal(analysis.overlongSegmentCount, 1);
  assert.equal(analysis.longestSegmentDurationMs, 25_000);

  const legitimate = analyzeTranscriptSegments([
    { startMs: 0, endMs: 1_000, text: "はい" },
    { startMs: 1_000, endMs: 2_000, text: "はい" },
    { startMs: 2_000, endMs: 3_000, text: "次へ" },
  ], { durationMs: 3_000 });
  assert.equal(legitimate.valid, true);
});

test("owned word cores merge overlap without duplicating boundary speech", () => {
  const merged = mergeWindowTranscripts([
    {
      window: {
        key: "w000",
        depth: 0,
        startMs: 0,
        endMs: 30_000,
        coreStartMs: 0,
        coreEndMs: 27_500,
        coreEndFrame: 440_000,
        endFrame: 480_000,
      },
      result: {
        language: "Japanese",
        segments: [{
          startMs: 26_000,
          endMs: 29_000,
          text: "前重",
          words: [
            { text: "前", startMs: 26_000, endMs: 27_000 },
            { text: "重", startMs: 27_600, endMs: 28_000 },
          ],
        }],
      },
    },
    {
      window: {
        key: "w001",
        depth: 0,
        startMs: 25_000,
        endMs: 55_000,
        coreStartMs: 27_500,
        coreEndMs: 55_000,
        coreEndFrame: 880_000,
        endFrame: 880_000,
      },
      result: {
        language: "Japanese",
        segments: [{
          startMs: 1_000,
          endMs: 3_000,
          text: "前重",
          words: [
            { text: "前", startMs: 1_000, endMs: 2_000 },
            { text: "重", startMs: 2_600, endMs: 3_000 },
          ],
        }],
      },
    },
  ], { durationMs: 55_000 });

  assert.deepEqual(
    merged.segments.map((segment) => [segment.startMs, segment.endMs, segment.text]),
    [
      [26_000, 27_000, "前"],
      [27_600, 28_000, "重"],
    ],
  );
});

test("trims only an adjacent cross-window text prefix repeated at the boundary", () => {
  const merged = mergeWindowTranscripts([
    {
      window: {
        key: "w000",
        depth: 0,
        startMs: 0,
        endMs: 30_000,
        coreStartMs: 0,
        coreEndMs: 27_500,
        coreEndFrame: 440_000,
        endFrame: 480_000,
      },
      result: {
        language: "Japanese",
        segments: [{ startMs: 20_000, endMs: 27_500, text: "そういえばさ" }],
      },
    },
    {
      window: {
        key: "w001",
        depth: 0,
        startMs: 25_000,
        endMs: 55_000,
        coreStartMs: 27_500,
        coreEndMs: 55_000,
        coreEndFrame: 880_000,
        endFrame: 880_000,
      },
      result: {
        language: "Japanese",
        segments: [{
          startMs: 2_500,
          endMs: 8_000,
          text: "えばさ、お風呂どうする?",
        }],
      },
    },
  ], { durationMs: 55_000 });

  assert.deepEqual(merged.segments.map((segment) => segment.text), [
    "そういえばさ",
    "お風呂どうする?",
  ]);
  assert.equal(merged.mergeDiagnostics.trimmedBoundaryPrefixCount, 1);
});

test("drops punctuation-only boundary fragments and reconciles cue overlap", () => {
  const merged = mergeWindowTranscripts([
    {
      window: {
        key: "w000",
        depth: 0,
        startMs: 0,
        endMs: 10_000,
        coreStartMs: 0,
        coreEndMs: 10_000,
        coreEndFrame: 160_000,
        endFrame: 160_000,
      },
      result: {
        language: "Japanese",
        segments: [
          { startMs: 0, endMs: 4_000, text: "前半" },
          { startMs: 3_500, endMs: 6_000, text: "後半" },
          { startMs: 6_000, endMs: 6_100, text: "…!?" },
        ],
      },
    },
  ], { durationMs: 10_000 });

  assert.deepEqual(
    merged.segments.map((segment) => [segment.startMs, segment.endMs, segment.text]),
    [
      [0, 3_750, "前半"],
      [3_750, 6_000, "後半"],
    ],
  );
  assert.equal(merged.mergeDiagnostics.overlapAdjustmentCount, 1);
  assert.equal(merged.mergeDiagnostics.punctuationOnlyBoundarySegmentCount, 1);
});

test("falls back to mapped segment time when VAD word time is compressed", () => {
  const merged = mergeWindowTranscripts([{
    window: {
      key: "w025",
      depth: 0,
      startMs: 625_000,
      endMs: 655_000,
      coreStartMs: 627_500,
      coreEndMs: 652_500,
      startFrame: 10_000_000,
      endFrame: 10_480_000,
      coreStartFrame: 10_040_000,
      coreEndFrame: 10_440_000,
    },
    result: {
      language: "Japanese",
      segments: [{
        startMs: 13_700,
        endMs: 17_280,
        text: "そういえばさ、お風呂どうする?",
        words: [{ text: "そう", startMs: 0, endMs: 440 }],
      }],
    },
  }], { durationMs: 753_390 });

  assert.deepEqual(
    merged.segments.map((segment) => [segment.startMs, segment.endMs, segment.text]),
    [[638_700, 642_280, "そういえばさ、お風呂どうする?"]],
  );
  assert.equal(merged.mergeDiagnostics.wordTimelineFallbackCount, 1);
});

test("degenerate windows retry as shorter independent requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fusionkit-window-retry-test-"));
  const sourcePath = path.join(directory, "source.wav");
  try {
    await writeFile(sourcePath, createPcm16SilenceWav({
      durationMs: 6_500,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
    }));
    const metadata = await inspectPcm16Wav(sourcePath);
    const result = await transcribePcmInWindows({
      wavPath: sourcePath,
      metadata,
      workingDirectory: path.join(directory, "windows"),
      windowMs: 3_000,
      overlapMs: 500,
      retryOverlapMs: 500,
      minRetryWindowMs: 1_000,
      maxRetryDepth: 1,
      repeatCueThreshold: 4,
      repeatDurationMs: 1_000,
      transcribeFile: async (_filePath, window) => {
        if (window.depth === 0 && window.key === "w000") {
          return {
            language: "Japanese",
            segments: Array.from({ length: 4 }, (_, index) => ({
              startMs: index * 750,
              endMs: (index + 1) * 750,
              text: "loop",
            })),
          };
        }
        return {
          language: "Japanese",
          segments: [{
            startMs: 0,
            endMs: window.durationMs,
            text: `speech-${window.key}`,
          }],
        };
      },
    });

    assert.equal(result.quality.valid, true);
    assert.equal(result.quality.rootWindowCount, 3);
    assert.equal(result.quality.retryCount, 1);
    assert.equal(result.quality.attemptedRequestCount, 5);
    assert.equal(result.quality.windowExecutionCoverage, 1);
    assert.equal(result.result.segments.length > 0, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
