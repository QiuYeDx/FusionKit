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

test("repository PRE-001 manifests are structurally valid while evidence remains pending", () => {
  const result = validateDocuments(loadDocuments());
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.ok(result.warnings.some((warning) => warning.code === "sample_pending_evidence"));
  assert.ok(result.warnings.some((warning) => warning.code === "baseline_pending_evidence"));
});

test("strict readiness fails pending sample and baseline evidence", () => {
  const result = validateDocuments(loadDocuments(), { strict: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "sample_pending_evidence"));
  assert.ok(result.errors.some((error) => error.code === "baseline_pending_evidence"));
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

test("coverage validation catches a removed required scenario", () => {
  const documents = clone(loadDocuments());
  documents.benchmark.samples = documents.benchmark.samples.map((sample) => ({
    ...sample,
    acousticConditions: sample.acousticConditions.filter(
      (condition) => condition !== "low_volume",
    ),
  }));
  const result = validateDocuments(documents);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.code === "coverage_missing" &&
        error.detail === "acousticConditions:low_volume",
    ),
  );
});

test("ready evidence must satisfy the declared duration class", () => {
  const documents = clone(loadDocuments());
  documents.benchmark.samples[0] = {
    ...documents.benchmark.samples[0],
    evidenceStatus: "ready",
    durationMs: 3_600_000,
    byteSize: 10,
    sha256: "a".repeat(64),
    referenceTranscript: {
      ...documents.benchmark.samples[0].referenceTranscript,
      sha256: "b".repeat(64),
    },
    license: {
      evidenceStatus: "verified",
      classification: "user_owned_or_licensed",
      sourceDescription: "licensed test corpus",
      redistribution: "not_committed",
      evidenceRef: "license-record-v1",
    },
  };
  const result = validateDocuments(documents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "duration_class_mismatch"));
});

test("toolchain report matrix accepts macOS arm64 and exposes both missing Windows targets", () => {
  const documents = loadDocuments();
  const result = validateToolchainReports(
    loadToolchainReports(),
    documents.benchmark.requiredTargetProfiles,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.warnings.length, 2);
  assert.equal(
    result.warnings.some((warning) => warning.detail === "mac-arm64-metal"),
    false,
  );
  assert.equal(
    result.warnings.filter((warning) => warning.code === "target_report_missing").length,
    2,
  );
});

test("strict report matrix requires a ready report for every target", () => {
  const documents = loadDocuments();
  const result = validateToolchainReports(
    loadToolchainReports(),
    documents.benchmark.requiredTargetProfiles,
    { strict: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
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

test("local inventory verification checks physical files without returning their paths", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusionkit-local-subtitle-samples-"));
  try {
    const mediaPath = path.join(tmpRoot, "sample-\u6837\u672c.wav");
    const transcriptPath = path.join(tmpRoot, "sample.txt");
    fs.writeFileSync(mediaPath, "media-fixture");
    fs.writeFileSync(transcriptPath, "reference fixture");

    const benchmark = clone(loadDocuments().benchmark);
    benchmark.samples = [
      {
        ...benchmark.samples[0],
        evidenceStatus: "ready",
        durationMs: 1_000,
        byteSize: fs.statSync(mediaPath).size,
        sha256: sha256("media-fixture"),
        license: {
          ...benchmark.samples[0].license,
          evidenceStatus: "verified",
          sourceDescription: "deterministic test fixture",
          evidenceRef: "test-fixture-license-v1",
        },
        referenceTranscript: {
          ...benchmark.samples[0].referenceTranscript,
          sha256: sha256("reference fixture"),
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
          referenceTranscriptPath: transcriptPath,
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
