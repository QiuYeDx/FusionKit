import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  loadDocuments,
  loadToolchainReports,
  validateDocuments,
  validateToolchainReports,
  verifySampleInventory,
} from "./validate-manifests.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("repository PRE-001 manifests are ready for development", () => {
  const result = validateDocuments(loadDocuments(), { strict: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("PRE-001 acceptance scope is exactly the three current ja/zh real samples", () => {
  const { benchmark } = loadDocuments();
  const realSamples = benchmark.samples.filter((sample) => sample.sampleKind === "real");
  assert.equal(benchmark.status, "ready_for_development");
  assert.equal(realSamples.length, 3);
  assert.deepEqual([...new Set(realSamples.map((sample) => sample.language))].sort(), [
    "ja",
    "zh",
  ]);
  assert.deepEqual(
    [...new Set(realSamples.map((sample) => sample.containerKind))].sort(),
    ["audio", "video"],
  );
  assert.deepEqual(
    [...new Set(realSamples.map((sample) => sample.comparisonSubtitle.format))].sort(),
    ["lrc", "srt"],
  );
  assert.equal(benchmark.acceptanceScope.textAccuracyGate, false);
});

test("sample subtitle timelines must stay within the media duration", () => {
  const documents = clone(loadDocuments());
  documents.benchmark.samples[0].comparisonSubtitle.lastEndMs =
    documents.benchmark.samples[0].durationMs + 1;
  const result = validateDocuments(documents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "comparison_subtitle"));
});

test("ready evidence must satisfy the declared duration class", () => {
  const documents = clone(loadDocuments());
  documents.benchmark.samples[0].durationMs = 3_600_000;
  const result = validateDocuments(documents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "duration_class_mismatch"));
});

test("target matrix supports macOS arm64 but rejects a stale macOS x64 profile", () => {
  const documents = clone(loadDocuments());
  assert.deepEqual(documents.benchmark.requiredTargetProfiles, [
    "mac-arm64-metal",
    "windows-x64-cpu",
    "windows-x64-cuda",
  ]);
  documents.benchmark.requiredTargetProfiles.push("mac-x64-cpu");
  const result = validateDocuments(documents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "target_profiles"));
});

test("toolchain report matrix accepts every PRE-001 target in its declared scope", () => {
  const documents = loadDocuments();
  const reports = loadToolchainReports();
  const result = validateToolchainReports(
    reports,
    documents.benchmark.requiredTargetProfiles,
    { strict: true },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.warnings.length, 0);
  const windowsReports = reports.filter(({ report }) =>
    report.target.id.startsWith("windows-"),
  );
  assert.equal(windowsReports.every(({ report }) => report.ready), true);
  assert.equal(
    windowsReports.every(({ report }) => report.sourceBuild.requiredForPoc === false),
    true,
  );
});

test("Windows reports reject a changed official prebuilt artifact digest", () => {
  const documents = loadDocuments();
  const reports = clone(loadToolchainReports());
  const windowsCpu = reports.find(
    ({ report }) => report.target.id === "windows-x64-cpu",
  );
  windowsCpu.report.pocArtifact.sha256 = "0".repeat(64);
  const result = validateToolchainReports(
    reports,
    documents.benchmark.requiredTargetProfiles,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "report_poc_artifact"));
});

test("toolchain reports reject private path fields even when privacy flags claim safety", () => {
  const documents = loadDocuments();
  const reports = clone(loadToolchainReports());
  reports[0].report.host.cwd = "/Users/example/private-project";
  const result = validateToolchainReports(
    reports,
    documents.benchmark.requiredTargetProfiles,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "report_privacy"));
});

test("metrics contract does not require research baseline or independent ground truth", () => {
  const { metrics } = loadDocuments();
  const metricIds = new Set(metrics.requiredMetricIds);
  assert.equal(metricIds.has("raw_transcript_validity"), true);
  assert.equal(metricIds.has("longest_consecutive_repeat_cue_count"), true);
  assert.equal(metricIds.has("invalid_raw_timeline_segment_count"), true);
  assert.equal(metricIds.has("word_timeline_fallback_count"), true);
  assert.equal(metricIds.has("window_execution_coverage"), true);
  assert.equal(metricIds.has("cer"), false);
  assert.equal(metricIds.has("wer"), false);
  assert.equal(metricIds.has("cue_boundary_mae_ms"), false);
  assert.equal(metrics.runRecord.requiredIdentityFields.includes("baseline_profile_id"), false);
  assert.equal(metrics.runRecord.requiredIdentityFields.includes("model_sha256"), false);
});

test("PRE-004 keeps the whole-file failure while accepting the bounded strategy", () => {
  const report = JSON.parse(fs.readFileSync(path.resolve(
    "docs/v0.2.11/local-subtitle-transcriber/poc/pre004-macos-arm64-results.json",
  ), "utf8"));
  assert.equal(report.status, "completed");
  assert.equal(report.wholeFileTranscriptValidityStatus, "failed");
  assert.equal(report.boundedWindowTranscriptValidityStatus, "passed");
  assert.equal(report.outputValidation.rawTranscriptValidityPassed, true);
  assert.equal(report.remainingBlockers.length, 0);
  assert.equal(report.transcriptStrategy.vadTimelinePolicy,
    "mapped-segment-timestamps-only");
  assert.equal(report.transcriptStrategy.tokenTimestampsEnabledWithVad, false);

  for (const backend of [report.metalResult, report.cpuResult]) {
    assert.equal(backend.backendVerified, true);
    assert.equal(backend.realtimeFactorRange.every((value) => value < 1), true);
    assert.equal(backend.samples.every(
      (sample) => sample.invalidRawTimelineSegmentCount === 0 &&
        sample.longestConsecutiveRepeatCueCount <= 2,
    ), true);
  }
  assert.equal(report.packagedLikeRuntime.packagedLikeReady, true);
  assert.equal(report.packagedLikeRuntime.gatekeeper.pre004Gate, false);
  assert.equal(report.deferredReleaseGate, "QA-004");
});

test("local inventory verifies media and sample subtitle without exposing their paths", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusionkit-local-subtitle-samples-"));
  try {
    const mediaPath = path.join(tmpRoot, "sample-样本.wav");
    const subtitlePath = path.join(tmpRoot, "sample.srt");
    fs.writeFileSync(mediaPath, "media-fixture");
    fs.writeFileSync(subtitlePath, "subtitle fixture");

    const benchmark = clone(loadDocuments().benchmark);
    benchmark.samples = [
      {
        ...benchmark.samples[0],
        durationMs: 1_000,
        durationClass: "short",
        byteSize: fs.statSync(mediaPath).size,
        sha256: sha256("media-fixture"),
        comparisonSubtitle: {
          ...benchmark.samples[0].comparisonSubtitle,
          byteSize: fs.statSync(subtitlePath).size,
          sha256: sha256("subtitle fixture"),
          firstStartMs: 0,
          lastEndMs: 1_000,
        },
      },
    ];
    const inventory = {
      schemaVersion: 1,
      manifestId: benchmark.manifestId,
      files: [
        {
          sampleId: benchmark.samples[0].sampleId,
          mediaPath,
          subtitlePath,
        },
      ],
    };
    const result = await verifySampleInventory(benchmark, inventory);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

    fs.writeFileSync(mediaPath, "changed");
    const changed = await verifySampleInventory(benchmark, inventory);
    assert.equal(changed.ok, false);
    assert.equal(JSON.stringify(changed).includes(tmpRoot), false);
    assert.ok(changed.errors.some((error) => error.code === "size_mismatch"));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
