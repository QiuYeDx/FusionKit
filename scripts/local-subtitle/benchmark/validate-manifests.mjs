#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");
const POC_ROOT = path.join(
  PROJECT_ROOT,
  "docs/v0.2.11/local-subtitle-transcriber/poc",
);

const DOCUMENTS = Object.freeze({
  benchmark: "benchmark-manifest.json",
  metrics: "metrics-contract.json",
  thirdParty: "third-party-candidates.json",
});
const TARGET_PROFILE_FACTS = Object.freeze({
  "mac-arm64-metal": {
    platform: "darwin",
    arch: "arm64",
    readinessScope: "source_build_poc",
    sourceBuildRequiredForPoc: true,
  },
  "windows-x64-cpu": {
    platform: "win32",
    arch: "x64",
    readinessScope: "official_prebuilt_release_asset",
    sourceBuildRequiredForPoc: false,
    pocArtifact: {
      version: "v1.9.1",
      sourceUrl: "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1",
      fileName: "whisper-bin-x64.zip",
      byteSize: 7_982_101,
      sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
      downloadUrl:
        "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
    },
  },
  "windows-x64-cuda": {
    platform: "win32",
    arch: "x64",
    readinessScope: "official_prebuilt_release_asset",
    sourceBuildRequiredForPoc: false,
    pocArtifact: {
      version: "v1.9.1",
      sourceUrl: "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1",
      fileName: "whisper-cublas-12.4.0-bin-x64.zip",
      byteSize: 677_887_125,
      sha256: "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
      downloadUrl:
        "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip",
    },
  },
});
const REQUIRED_TARGET_PROFILES = new Set(Object.keys(TARGET_PROFILE_FACTS));

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_SAMPLE_STATUS = new Set(["ready"]);
const ALLOWED_SAMPLE_KINDS = new Set(["real", "synthetic"]);
const ALLOWED_DURATION_CLASSES = new Set(["short", "medium", "long"]);
const ALLOWED_CONTAINER_KINDS = new Set(["audio", "video"]);
const ALLOWED_PATH_CASES = new Set(["ascii", "non_ascii"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addIssue(collection, document, code, detail) {
  collection.push({ document, code, detail });
}

function requireString(collection, document, code, value) {
  if (typeof value !== "string" || value.trim() === "") {
    addIssue(collection, document, code, "Expected a non-empty string.");
    return false;
  }
  return true;
}

function validateBenchmarkManifest(document, _strict, errors, _warnings) {
  const name = DOCUMENTS.benchmark;
  if (document.schemaVersion !== 1) {
    addIssue(errors, name, "schema_version", "schemaVersion must be 1.");
  }
  requireString(errors, name, "manifest_id", document.manifestId);
  if (document.status !== "ready_for_development") {
    addIssue(
      errors,
      name,
      "manifest_status",
      "PRE-001 must be marked ready_for_development.",
    );
  }
  if (
    !Array.isArray(document.requiredTargetProfiles) ||
    document.requiredTargetProfiles.length !== REQUIRED_TARGET_PROFILES.size ||
    new Set(document.requiredTargetProfiles).size !== REQUIRED_TARGET_PROFILES.size ||
    document.requiredTargetProfiles.some(
      (targetId) => !REQUIRED_TARGET_PROFILES.has(targetId),
    )
  ) {
    addIssue(
      errors,
      name,
      "target_profiles",
      "The three PRE-001 target profiles must be present exactly once.",
    );
  }
  const scope = document.acceptanceScope;
  if (!isObject(scope)) {
    addIssue(errors, name, "acceptance_scope", "acceptanceScope must be an object.");
    return;
  }
  if (
    scope.realSampleCount !== 3 ||
    !hasExactMembers(scope.languages, ["ja", "zh"]) ||
    !hasExactMembers(scope.containerKinds, ["audio", "video"]) ||
    !hasExactMembers(scope.subtitleFormats, ["srt", "lrc"]) ||
    scope.validationMode !== "development_smoke_and_manual_acceptance" ||
    scope.textAccuracyGate !== false
  ) {
    addIssue(
      errors,
      name,
      "acceptance_scope",
      "PRE-001 is limited to three real ja/zh audio/video samples with SRT/LRC smoke evidence and no text-accuracy gate.",
    );
  }
  if (!Array.isArray(document.samples) || document.samples.length === 0) {
    addIssue(errors, name, "samples", "At least one sample definition is required.");
    return;
  }
  if (!isObject(document.durationClassRules)) {
    addIssue(errors, name, "duration_rules", "durationClassRules must be an object.");
  }

  const sampleIds = new Set();
  const realSamples = [];

  for (const sample of document.samples) {
    const sampleId = sample?.sampleId;
    if (!requireString(errors, name, "sample_id", sampleId)) continue;
    if (sampleIds.has(sampleId)) {
      addIssue(errors, name, "duplicate_sample_id", sampleId);
    }
    sampleIds.add(sampleId);

    if (!ALLOWED_SAMPLE_STATUS.has(sample.evidenceStatus)) {
      addIssue(errors, name, "sample_status", `${sampleId}: evidenceStatus must be ready.`);
    }
    if (!ALLOWED_SAMPLE_KINDS.has(sample.sampleKind)) {
      addIssue(errors, name, "sample_kind", `${sampleId}: invalid sampleKind.`);
    }
    if (!ALLOWED_CONTAINER_KINDS.has(sample.containerKind)) {
      addIssue(errors, name, "container_kind", `${sampleId}: invalid containerKind.`);
    }
    if (!ALLOWED_DURATION_CLASSES.has(sample.durationClass)) {
      addIssue(errors, name, "duration_class", `${sampleId}: invalid durationClass.`);
    }
    if (!ALLOWED_PATH_CASES.has(sample.pathCase)) {
      addIssue(errors, name, "path_case", `${sampleId}: invalid pathCase.`);
    }
    requireString(errors, name, "language", sample.language);
    requireString(errors, name, "local_storage_key", sample.localStorageKey);

    const mediaReady =
      Number.isInteger(sample.durationMs) &&
      sample.durationMs > 0 &&
      Number.isInteger(sample.byteSize) &&
      sample.byteSize > 0 &&
      SHA256_PATTERN.test(sample.sha256 ?? "");
    if (!mediaReady) {
      addIssue(errors, name, "ready_evidence", `${sampleId}: media evidence is incomplete.`);
    } else {
      const durationRule = document.durationClassRules?.[sample.durationClass];
      if (!isObject(durationRule) || !durationMatches(sample.durationMs, durationRule)) {
        addIssue(
          errors,
          name,
          "duration_class_mismatch",
          `${sampleId}:${sample.durationClass}`,
        );
      }
    }

    if (sample.sampleKind === "real") {
      realSamples.push(sample);
      if (sample.mediaEvidence?.status !== "verified") {
        addIssue(
          errors,
          name,
          "media_probe_evidence",
          `${sampleId}: verified media probe evidence is required.`,
        );
      }
      validateComparisonSubtitle(sample.comparisonSubtitle, name, sample, errors);
    } else if (!isObject(sample.generator)) {
      addIssue(errors, name, "synthetic_generator", `${sampleId}: generator metadata is required.`);
    }
  }

  if (realSamples.length !== scope.realSampleCount) {
    addIssue(
      errors,
      name,
      "real_sample_count",
      `Expected ${scope.realSampleCount} real samples, found ${realSamples.length}.`,
    );
  }
  if (!covers(realSamples.map((sample) => sample.language), scope.languages)) {
    addIssue(errors, name, "scope_missing", "The real samples must cover Japanese and Chinese.");
  }
  if (!covers(realSamples.map((sample) => sample.containerKind), scope.containerKinds)) {
    addIssue(errors, name, "scope_missing", "The real samples must cover audio and video.");
  }
  if (
    !covers(
      realSamples.map((sample) => sample.comparisonSubtitle?.format),
      scope.subtitleFormats,
    )
  ) {
    addIssue(errors, name, "scope_missing", "The sample subtitles must cover SRT and LRC.");
  }
}

function validateComparisonSubtitle(output, document, sample, errors) {
  const sampleId = sample.sampleId;
  const cueCount =
    output?.format === "srt" ? output.cueCount : output?.timestampCount;
  const firstTimestamp =
    output?.format === "srt" ? output.firstStartMs : output?.firstTimestampMs;
  const lastTimestamp =
    output?.format === "srt" ? output.lastEndMs : output?.lastTimestampMs;
  if (
    !isObject(output) ||
    !Number.isInteger(output.byteSize) ||
    output.byteSize <= 0 ||
    !SHA256_PATTERN.test(output.sha256 ?? "") ||
    !["srt", "lrc"].includes(output.format) ||
    output.source !== "user_provided_existing_output" ||
    output.purpose !== "manual_smoke_reference_only" ||
    output.textAccuracyGate !== false ||
    !Number.isInteger(cueCount) ||
    cueCount <= 0 ||
    !Number.isInteger(firstTimestamp) ||
    firstTimestamp < 0 ||
    !Number.isInteger(lastTimestamp) ||
    lastTimestamp < firstTimestamp ||
    lastTimestamp > sample.durationMs ||
    output.timelineValid !== true
  ) {
    addIssue(
      errors,
      document,
      "comparison_subtitle",
      `${sampleId}: sample subtitle integrity or timeline evidence is invalid.`,
    );
  }
}

function hasExactMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function covers(actual, required) {
  return Array.isArray(required) && required.every((value) => actual.includes(value));
}

function durationMatches(durationMs, rule) {
  if (!Number.isInteger(durationMs)) return false;
  if (Number.isInteger(rule.minInclusiveMs) && durationMs < rule.minInclusiveMs) {
    return false;
  }
  if (Number.isInteger(rule.maxExclusiveMs) && durationMs >= rule.maxExclusiveMs) {
    return false;
  }
  return true;
}

function validateMetricsContract(document, errors) {
  const name = DOCUMENTS.metrics;
  if (document.schemaVersion !== 1) {
    addIssue(errors, name, "schema_version", "schemaVersion must be 1.");
  }
  requireString(errors, name, "contract_id", document.contractId);
  if (!Array.isArray(document.metrics)) {
    addIssue(errors, name, "metrics", "metrics must be an array.");
    return;
  }
  const ids = new Set();
  for (const metric of document.metrics) {
    if (!requireString(errors, name, "metric_id", metric?.id)) continue;
    if (ids.has(metric.id)) {
      addIssue(errors, name, "duplicate_metric", metric.id);
    }
    ids.add(metric.id);
    requireString(errors, name, "metric_unit", metric.unit);
    requireString(errors, name, "metric_formula", metric.formula);
  }
  for (const requiredId of document.requiredMetricIds ?? []) {
    if (!ids.has(requiredId)) {
      addIssue(errors, name, "required_metric_missing", requiredId);
    }
  }
  const prohibited = document.privacy?.prohibitedFields;
  if (!Array.isArray(prohibited) || !prohibited.includes("absolutePath")) {
    addIssue(errors, name, "privacy_contract", "absolutePath must be prohibited.");
  }
}

function validateThirdPartyCandidates(document, errors) {
  const name = DOCUMENTS.thirdParty;
  if (document.schemaVersion !== 1) {
    addIssue(errors, name, "schema_version", "schemaVersion must be 1.");
  }
  if (!Array.isArray(document.candidates)) {
    addIssue(errors, name, "candidates", "candidates must be an array.");
    return;
  }
  const ids = new Set();
  const categories = new Set();
  for (const candidate of document.candidates) {
    if (!requireString(errors, name, "candidate_id", candidate?.id)) continue;
    if (ids.has(candidate.id)) {
      addIssue(errors, name, "duplicate_candidate", candidate.id);
    }
    ids.add(candidate.id);
    categories.add(candidate.category);
    requireString(errors, name, "candidate_category", candidate.category);
    requireString(errors, name, "candidate_source", candidate.sourceUrl);
    requireString(errors, name, "candidate_license", candidate.declaredLicense);
    requireString(errors, name, "candidate_decision", candidate.decisionStatus);
    if (!String(candidate.sourceUrl ?? "").startsWith("https://")) {
      addIssue(errors, name, "candidate_source_scheme", candidate.id);
    }
    if (!Array.isArray(candidate.openQuestions) || candidate.openQuestions.length === 0) {
      addIssue(errors, name, "candidate_open_questions", candidate.id);
    }
  }
  for (const category of ["engine", "model", "vad", "media", "gpu_runtime"]) {
    if (!categories.has(category)) {
      addIssue(errors, name, "candidate_category_missing", category);
    }
  }
}

export function validateDocuments(documents, options = {}) {
  const errors = [];
  const warnings = [];
  const strict = options.strict ?? false;
  validateBenchmarkManifest(documents.benchmark, strict, errors, warnings);
  validateMetricsContract(documents.metrics, errors);
  validateThirdPartyCandidates(documents.thirdParty, errors);
  return { ok: errors.length === 0, errors, warnings };
}

export function loadDocuments(pocRoot = POC_ROOT) {
  return Object.fromEntries(
    Object.entries(DOCUMENTS).map(([key, fileName]) => [
      key,
      readJson(path.join(pocRoot, fileName)),
    ]),
  );
}

export function loadToolchainReports(pocRoot = POC_ROOT) {
  const reportsRoot = path.join(pocRoot, "reports");
  if (!fs.existsSync(reportsRoot)) return [];
  return fs
    .readdirSync(reportsRoot)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({ fileName, report: readJson(path.join(reportsRoot, fileName)) }));
}

export function validateToolchainReports(reports, requiredTargetProfiles, options = {}) {
  const errors = [];
  const warnings = [];
  const strict = options.strict ?? false;
  const requiredTargets = Array.isArray(requiredTargetProfiles)
    ? requiredTargetProfiles
    : [];
  const validReportsByTarget = new Map();

  for (const entry of reports) {
    const document = `reports/${entry.fileName}`;
    const report = entry.report;
    const targetId = report?.target?.id;
    let valid = true;
    if (
      report?.schemaVersion !== 1 ||
      report?.reportType !== "local_subtitle_toolchain_preflight"
    ) {
      addIssue(errors, document, "report_schema", "Invalid toolchain report identity.");
      valid = false;
    }
    if (!requiredTargets.includes(targetId)) {
      addIssue(errors, document, "report_target", "Unknown or missing target profile.");
      valid = false;
    }
    const targetFacts = TARGET_PROFILE_FACTS[targetId];
    if (
      targetFacts &&
      (report.target.expectedPlatform !== targetFacts.platform ||
        report.target.expectedArch !== targetFacts.arch)
    ) {
      addIssue(errors, document, "report_target", "Target platform/architecture is inconsistent.");
      valid = false;
    }
    if (targetFacts && report?.readinessScope !== targetFacts.readinessScope) {
      addIssue(errors, document, "report_scope", "Target readiness scope is inconsistent.");
      valid = false;
    }
    if (
      targetFacts &&
      (!isObject(report?.sourceBuild) ||
        report.sourceBuild.requiredForPoc !== targetFacts.sourceBuildRequiredForPoc ||
        typeof report.sourceBuild.ready !== "boolean" ||
        !Array.isArray(report.sourceBuild.checks) ||
        !Array.isArray(report.sourceBuild.blockers))
    ) {
      addIssue(errors, document, "report_source_build", "Source-build status is invalid.");
      valid = false;
    } else if (
      targetFacts &&
      report.sourceBuild.ready !==
        (report.sourceBuild.blockers.length === 0 &&
          report.sourceBuild.checks.every((item) => item?.passed === true))
    ) {
      addIssue(errors, document, "report_source_build", "Source-build readiness is inconsistent.");
      valid = false;
    }
    if (
      targetFacts?.pocArtifact &&
      !matchesExpectedArtifact(report?.pocArtifact, targetFacts.pocArtifact)
    ) {
      addIssue(errors, document, "report_poc_artifact", "Pinned PoC artifact is inconsistent.");
      valid = false;
    }
    if (
      report?.privacy?.hostnameRecorded !== false ||
      report?.privacy?.usernameRecorded !== false ||
      report?.privacy?.absolutePathsRecorded !== false ||
      report?.privacy?.environmentAllowlistOnly !== true ||
      containsForbiddenReportData(report)
    ) {
      addIssue(errors, document, "report_privacy", "Report contains or permits private host data.");
      valid = false;
    }
    if (
      typeof report?.ready !== "boolean" ||
      !Array.isArray(report?.blockers) ||
      !Array.isArray(report?.checks)
    ) {
      addIssue(errors, document, "report_status", "Report ready/blockers contract is invalid.");
      valid = false;
    }
    if (report?.ready && Array.isArray(report.blockers) && Array.isArray(report.checks)) {
      if (
        report.blockers.length !== 0 ||
        report.checks.some((item) => item?.passed !== true) ||
        (targetFacts &&
          (report.host?.platform !== targetFacts.platform ||
            report.host?.arch !== targetFacts.arch))
      ) {
        addIssue(errors, document, "report_status", "A ready report must pass on its target host.");
        valid = false;
      }
    }
    if (valid) {
      const targetReports = validReportsByTarget.get(targetId) ?? [];
      targetReports.push(report);
      validReportsByTarget.set(targetId, targetReports);
    }
  }

  for (const targetId of requiredTargets) {
    const targetReports = validReportsByTarget.get(targetId) ?? [];
    const hasReadyReport = targetReports.some((report) => report.ready);
    if (!hasReadyReport) {
      const issue = {
        document: "toolchain-report-matrix",
        code: targetReports.length === 0 ? "target_report_missing" : "target_report_not_ready",
        detail: targetId,
      };
      (strict ? errors : warnings).push(issue);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function matchesExpectedArtifact(actual, expected) {
  return (
    isObject(actual) &&
    actual.version === expected.version &&
    actual.sourceUrl === expected.sourceUrl &&
    actual.fileName === expected.fileName &&
    actual.byteSize === expected.byteSize &&
    actual.sha256 === expected.sha256 &&
    actual.downloadUrl === expected.downloadUrl
  );
}

function containsForbiddenReportData(value, key = "") {
  if (/^(hostname|username|cwd|home)$/i.test(key) || /path$/i.test(key)) {
    return true;
  }
  if (typeof value === "string") {
    return /(?:^|\s)\/[^\s]+|[A-Za-z]:\\/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenReportData(item));
  }
  if (isObject(value)) {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsForbiddenReportData(childValue, childKey),
    );
  }
  return false;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifySampleInventory(benchmark, inventory) {
  const errors = [];
  if (inventory.schemaVersion !== 1 || inventory.manifestId !== benchmark.manifestId) {
    addIssue(errors, "sample-inventory", "inventory_identity", "Inventory does not match manifest.");
    return { ok: false, errors };
  }
  const entries = new Map(
    (inventory.files ?? []).map((entry) => [entry.sampleId, entry]),
  );

  for (const sample of benchmark.samples) {
    if (sample.evidenceStatus !== "ready") continue;
    const entry = entries.get(sample.sampleId);
    if (!entry) {
      addIssue(errors, "sample-inventory", "sample_missing", sample.sampleId);
      continue;
    }
    await verifyInventoryFile({
      errors,
      sampleId: sample.sampleId,
      field: "media",
      filePath: entry.mediaPath,
      expectedBytes: sample.byteSize,
      expectedHash: sample.sha256,
      expectedPathCase: sample.pathCase,
    });
    if (sample.comparisonSubtitle !== undefined) {
      await verifyInventoryFile({
        errors,
        sampleId: sample.sampleId,
        field: "subtitle",
        filePath: entry.subtitlePath,
        expectedBytes: sample.comparisonSubtitle.byteSize,
        expectedHash: sample.comparisonSubtitle.sha256,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

async function verifyInventoryFile({
  errors,
  sampleId,
  field,
  filePath,
  expectedBytes,
  expectedHash,
  expectedPathCase,
}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    addIssue(errors, "sample-inventory", "path_required", `${sampleId}:${field}`);
    return;
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    addIssue(errors, "sample-inventory", "file_missing", `${sampleId}:${field}`);
    return;
  }
  if (!stats.isFile()) {
    addIssue(errors, "sample-inventory", "not_a_file", `${sampleId}:${field}`);
    return;
  }
  if (expectedPathCase) {
    const hasNonAsciiLeaf = /[^\x00-\x7f]/.test(path.basename(filePath));
    if (
      (expectedPathCase === "non_ascii" && !hasNonAsciiLeaf) ||
      (expectedPathCase === "ascii" && hasNonAsciiLeaf)
    ) {
      addIssue(errors, "sample-inventory", "path_case_mismatch", sampleId);
    }
  }
  if (expectedBytes !== undefined && stats.size !== expectedBytes) {
    addIssue(errors, "sample-inventory", "size_mismatch", `${sampleId}:${field}`);
    return;
  }
  if ((await hashFile(filePath)) !== expectedHash) {
    addIssue(errors, "sample-inventory", "hash_mismatch", `${sampleId}:${field}`);
  }
}

function parseArguments(argv) {
  const parsed = { strict: false, inventoryPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--strict") {
      parsed.strict = true;
    } else if (value === "--inventory") {
      parsed.inventoryPath = readArgumentValue(argv, ++index, value);
    } else if (value === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function readArgumentValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function printIssues(label, issues, writer) {
  if (issues.length === 0) return;
  writer(`${label}:`);
  for (const issue of issues) {
    writer(`  [${issue.code}] ${issue.document}: ${issue.detail}`);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log("Usage: node validate-manifests.mjs [--strict --inventory <inventory.json.local>]");
    return 0;
  }

  const documents = loadDocuments();
  const result = validateDocuments(documents, { strict: args.strict });
  const reportResult = validateToolchainReports(
    loadToolchainReports(),
    documents.benchmark.requiredTargetProfiles,
    { strict: args.strict },
  );
  result.errors.push(...reportResult.errors);
  result.warnings.push(...reportResult.warnings);
  result.ok = result.errors.length === 0;
  if (args.strict && !args.inventoryPath) {
    addIssue(
      result.errors,
      "sample-inventory",
      "inventory_required",
      "Strict readiness requires a local sample inventory.",
    );
    result.ok = false;
  }
  if (args.inventoryPath) {
    const inventory = readJson(path.resolve(args.inventoryPath));
    const inventoryResult = await verifySampleInventory(documents.benchmark, inventory);
    result.errors.push(...inventoryResult.errors);
    result.ok = result.errors.length === 0;
  }

  printIssues("Warnings", result.warnings, console.warn);
  printIssues("Errors", result.errors, console.error);
  console.log(
    `Manifest validation ${result.ok ? "passed" : "failed"}: ${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
  );
  return result.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
