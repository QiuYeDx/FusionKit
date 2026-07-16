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
  baseline: "baseline-profile.json",
  metrics: "metrics-contract.json",
  thirdParty: "third-party-candidates.json",
});
const TARGET_PROFILE_FACTS = Object.freeze({
  "mac-arm64-metal": { platform: "darwin", arch: "arm64" },
  "windows-x64-cpu": { platform: "win32", arch: "x64" },
  "windows-x64-cuda": { platform: "win32", arch: "x64" },
});
const REQUIRED_TARGET_PROFILES = new Set(Object.keys(TARGET_PROFILE_FACTS));

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_SAMPLE_STATUS = new Set(["pending_evidence", "ready"]);
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

function validateBenchmarkManifest(document, strict, errors, warnings) {
  const name = DOCUMENTS.benchmark;
  if (document.schemaVersion !== 1) {
    addIssue(errors, name, "schema_version", "schemaVersion must be 1.");
  }
  requireString(errors, name, "manifest_id", document.manifestId);
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
  if (!isObject(document.requiredCoverage)) {
    addIssue(errors, name, "required_coverage", "requiredCoverage must be an object.");
    return;
  }
  if (!Array.isArray(document.samples) || document.samples.length === 0) {
    addIssue(errors, name, "samples", "At least one sample definition is required.");
    return;
  }
  if (!isObject(document.durationClassRules)) {
    addIssue(errors, name, "duration_rules", "durationClassRules must be an object.");
  }

  const sampleIds = new Set();
  const observed = {
    languages: new Set(),
    acousticConditions: new Set(),
    containerKinds: new Set(),
    durationClasses: new Set(),
    pathCases: new Set(),
  };

  for (const sample of document.samples) {
    const sampleId = sample?.sampleId;
    if (!requireString(errors, name, "sample_id", sampleId)) continue;
    if (sampleIds.has(sampleId)) {
      addIssue(errors, name, "duplicate_sample_id", sampleId);
    }
    sampleIds.add(sampleId);

    if (!ALLOWED_SAMPLE_STATUS.has(sample.evidenceStatus)) {
      addIssue(errors, name, "sample_status", `${sampleId}: invalid evidenceStatus.`);
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
    if (!Array.isArray(sample.acousticConditions) || sample.acousticConditions.length === 0) {
      addIssue(errors, name, "acoustic_conditions", `${sampleId}: conditions are required.`);
    }
    requireString(errors, name, "language", sample.language);
    requireString(errors, name, "local_storage_key", sample.localStorageKey);

    observed.languages.add(sample.language);
    observed.containerKinds.add(sample.containerKind);
    observed.durationClasses.add(sample.durationClass);
    observed.pathCases.add(sample.pathCase);
    for (const condition of sample.acousticConditions ?? []) {
      observed.acousticConditions.add(condition);
    }

    const licenseReady =
      isObject(sample.license) &&
      sample.license.evidenceStatus === "verified" &&
      sample.license.redistribution === "not_committed" &&
      typeof sample.license.sourceDescription === "string" &&
      sample.license.sourceDescription.trim() !== "" &&
      !/^pending\b/i.test(sample.license.sourceDescription) &&
      typeof sample.license.evidenceRef === "string" &&
      sample.license.evidenceRef.trim() !== "" &&
      !/^pending\b/i.test(sample.license.evidenceRef);
    const readyEvidence =
      Number.isInteger(sample.durationMs) &&
      sample.durationMs > 0 &&
      Number.isInteger(sample.byteSize) &&
      sample.byteSize > 0 &&
      SHA256_PATTERN.test(sample.sha256 ?? "") &&
      licenseReady;

    if (sample.evidenceStatus === "ready") {
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

    if (sample.referenceTranscript?.required) {
      if (!SHA256_PATTERN.test(sample.referenceTranscript.sha256 ?? "")) {
        if (sample.evidenceStatus === "ready") {
          addIssue(errors, name, "reference_hash", `${sampleId}: transcript hash is required.`);
        }
      }
    }

    if (sample.evidenceStatus === "ready" && !readyEvidence) {
      addIssue(errors, name, "ready_evidence", `${sampleId}: ready evidence is incomplete.`);
    }
    if (sample.evidenceStatus !== "ready") {
      const issue = {
        document: name,
        code: "sample_pending_evidence",
        detail: sampleId,
      };
      (strict ? errors : warnings).push(issue);
    }
  }

  for (const [coverageKey, requiredValues] of Object.entries(document.requiredCoverage)) {
    if (!Array.isArray(requiredValues) || !observed[coverageKey]) {
      addIssue(errors, name, "coverage_contract", `${coverageKey}: invalid coverage dimension.`);
      continue;
    }
    for (const requiredValue of requiredValues) {
      if (!observed[coverageKey].has(requiredValue)) {
        addIssue(
          errors,
          name,
          "coverage_missing",
          `${coverageKey}:${requiredValue}`,
        );
      }
    }
  }
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

function validateBaselineProfile(document, strict, errors, warnings) {
  const name = DOCUMENTS.baseline;
  if (document.schemaVersion !== 1) {
    addIssue(errors, name, "schema_version", "schemaVersion must be 1.");
  }
  requireString(errors, name, "profile_id", document.profileId);
  if (!isObject(document.engine) || document.engine.id !== "faster_whisper") {
    addIssue(errors, name, "engine", "The reference engine must be faster_whisper.");
  }
  if (document.model?.id !== "large-v3") {
    addIssue(errors, name, "model", "The PRE-001 reference model must be large-v3.");
  }
  if (!isObject(document.inference)) {
    addIssue(errors, name, "inference", "A fixed inference object is required.");
  } else {
    const fixedFields = [
      "task",
      "languageSource",
      "beamSize",
      "temperature",
      "wordTimestamps",
      "vadFilter",
      "conditionOnPreviousText",
    ];
    for (const field of fixedFields) {
      if (!(field in document.inference)) {
        addIssue(errors, name, "inference_field", `Missing inference.${field}.`);
      }
    }
  }

  const frozen =
    document.status === "frozen" &&
    SHA256_PATTERN.test(document.model?.sha256 ?? "") &&
    SHA256_PATTERN.test(document.referenceApplication?.snapshotSha256 ?? "");
  if (!frozen) {
    const issue = {
      document: name,
      code: "baseline_pending_evidence",
      detail: "Model and reference application hashes must be captured before benchmark runs.",
    };
    (strict ? errors : warnings).push(issue);
  }
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
    if (
      candidate.decisionStatus !== "reference_only" &&
      (!Array.isArray(candidate.openQuestions) || candidate.openQuestions.length === 0)
    ) {
      addIssue(errors, name, "candidate_open_questions", candidate.id);
    }
  }
  for (const category of ["engine", "reference", "model", "vad", "media", "gpu_runtime"]) {
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
  validateBaselineProfile(documents.baseline, strict, errors, warnings);
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
    const entry = entries.get(sample.sampleId);
    if (!entry) {
      addIssue(errors, "sample-inventory", "sample_missing", sample.sampleId);
      continue;
    }
    if (sample.evidenceStatus !== "ready") {
      addIssue(errors, "sample-inventory", "sample_evidence_incomplete", sample.sampleId);
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
    if (sample.referenceTranscript?.required) {
      await verifyInventoryFile({
        errors,
        sampleId: sample.sampleId,
        field: "reference",
        filePath: entry.referenceTranscriptPath,
        expectedHash: sample.referenceTranscript.sha256,
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
