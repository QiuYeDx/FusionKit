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
  pre003: "pre003-windows-x64-results.json",
  pre004: "pre004-macos-arm64-results.json",
  pre005Macos: "pre005-macos-arm64-results.json",
  pre005Windows: "pre005-windows-x64-results.json",
  pre006: "pre006-production-decision.json",
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
const PRE006_DECISION_KEYS = Object.freeze([
  "engineRuntime",
  "platformSupport",
  "mediaRuntime",
  "modelAndVadManifest",
  "qualityPerformanceAndFootprint",
]);
const PRE006_CANDIDATE_DECISIONS = Object.freeze({
  "whisper-cpp-v1.9.1":
    "production_selected_whisper_cpp_v1_9_1_node_managed_server",
  "whisper-large-v3-ggml-family":
    "production_selected_large_v3_q5_0_launch_default",
  "silero-vad-v6.2.0-ggml":
    "production_selected_silero_v6_2_0_launch_default",
  "ffmpeg-n8.1.2-source":
    "production_selected_platform_specific_ffmpeg_8_1_2",
  "nvidia-cuda-runtime":
    "production_selected_optional_cuda_12_4_accelerator_pack",
});
const PRE006_CANDIDATE_SOURCES = Object.freeze({
  "whisper-cpp-v1.9.1":
    "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1",
  "whisper-large-v3-ggml-family":
    "https://huggingface.co/ggerganov/whisper.cpp/blob/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3-q5_0.bin",
  "silero-vad-v6.2.0-ggml":
    "https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/models/for-tests-silero-v6.2.0-ggml.bin",
  "ffmpeg-n8.1.2-source":
    "https://github.com/FFmpeg/FFmpeg/tree/n8.1.2",
  "nvidia-cuda-runtime":
    "https://docs.nvidia.com/cuda/archive/12.4.0/eula/index.html",
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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
    if (!Array.isArray(candidate.openQuestions)) {
      addIssue(errors, name, "candidate_open_questions", candidate.id);
    } else if (
      String(candidate.decisionStatus).startsWith("production_selected_") &&
      candidate.openQuestions.length !== 0
    ) {
      addIssue(
        errors,
        name,
        "candidate_open_questions",
        `${candidate.id}: a production-selected candidate cannot retain PRE questions.`,
      );
    } else if (
      !String(candidate.decisionStatus).startsWith("production_selected_") &&
      candidate.openQuestions.length === 0
    ) {
      addIssue(errors, name, "candidate_open_questions", candidate.id);
    }
    if (
      String(candidate.decisionStatus).startsWith("production_selected_") &&
      (!Array.isArray(candidate.releaseGates) || candidate.releaseGates.length === 0)
    ) {
      addIssue(errors, name, "candidate_release_gates", candidate.id);
    }
  }
  for (const category of ["engine", "model", "vad", "media", "gpu_runtime"]) {
    if (!categories.has(category)) {
      addIssue(errors, name, "candidate_category_missing", category);
    }
  }
}

function validatePre006Decision(document, thirdParty, evidence, errors) {
  const name = DOCUMENTS.pre006;
  if (document.schemaVersion !== 1) {
    addIssue(errors, name, "schema_version", "schemaVersion must be 1.");
  }
  if (
    document.decisionId !== "local-subtitle-production-freeze-v1" ||
    document.status !== "go" ||
    document.observedAt !== "2026-07-18"
  ) {
    addIssue(
      errors,
      name,
      "decision_identity",
      "PRE-006 must be the dated v1 production freeze with a go decision.",
    );
  }
  if (!hasExactMembers(document.evidenceReports, [
    "pre003-windows-x64-results.json",
    "pre004-macos-arm64-results.json",
    "pre005-macos-arm64-results.json",
    "pre005-windows-x64-results.json",
  ])) {
    addIssue(errors, name, "evidence_reports", "PRE-003 through PRE-005 evidence is required.");
  }
  if (!Array.isArray(document.openPreBlockers) || document.openPreBlockers.length !== 0) {
    addIssue(errors, name, "pre_blockers", "A go decision cannot retain PRE blockers.");
  }
  if (!hasExactMembers(document.nextWorkPackages, ["CORE-001", "CORE-002"])) {
    addIssue(errors, name, "next_work_packages", "PRE-006 must unlock CORE-001 and CORE-002.");
  }

  const decisions = document.decisions;
  if (
    !isObject(decisions) ||
    !hasExactMembers(Object.keys(decisions), PRE006_DECISION_KEYS)
  ) {
    addIssue(errors, name, "decision_sections", "All five PRE-006 decision sections are required.");
    return;
  }
  for (const key of PRE006_DECISION_KEYS) {
    if (decisions[key]?.status !== "go") {
      addIssue(errors, name, "decision_status", `${key} must be go.`);
    }
  }

  validatePre006Engine(decisions.engineRuntime, errors);
  validatePre006Platforms(decisions.platformSupport, errors);
  validatePre006Media(decisions.mediaRuntime, errors);
  validatePre006Models(decisions.modelAndVadManifest, errors);
  validatePre006Quality(decisions.qualityPerformanceAndFootprint, errors);
  validatePre006Evidence(decisions, evidence, errors);

  const releaseGates = new Map(
    asArray(document.releaseGates).map((gate) => [gate?.id, gate]),
  );
  if (
    releaseGates.get("QA-003")?.requiredForSelectedPersonalProfile !== false ||
    releaseGates.get("QA-005")?.requiredBeforeShippingArtifactsToOthers !== true
  ) {
    addIssue(
      errors,
      name,
      "release_gates",
      "Windows signing must stay optional for the personal profile while QA-005 remains a distribution gate.",
    );
  }

  const candidates = new Map(
    asArray(thirdParty?.candidates).map((candidate) => [candidate.id, candidate]),
  );
  for (const [candidateId, expectedDecision] of Object.entries(
    PRE006_CANDIDATE_DECISIONS,
  )) {
    const candidate = candidates.get(candidateId);
    if (
      candidate?.decisionStatus !== expectedDecision ||
      candidate?.sourceUrl !== PRE006_CANDIDATE_SOURCES[candidateId]
    ) {
      addIssue(
        errors,
        name,
        "candidate_decision_mismatch",
        `${candidateId} must match the PRE-006 production decision.`,
      );
    }
  }
}

function validatePre006Evidence(decisions, evidence, errors) {
  const name = DOCUMENTS.pre006;
  const pre003 = evidence?.pre003;
  const pre004 = evidence?.pre004;
  const pre005Macos = evidence?.pre005Macos;
  const pre005Windows = evidence?.pre005Windows;
  const launchModel = decisions?.modelAndVadManifest?.launchModels?.[0];
  const windowsProfile = asArray(decisions?.platformSupport?.profiles).find(
    (profile) => profile?.id === "windows-x64",
  );
  const macX64Profile = asArray(decisions?.platformSupport?.profiles).find(
    (profile) => profile?.id === "macos-x64",
  );
  const macRuntimeBytes = asArray(pre005Macos?.stagedRuntime?.artifacts).reduce(
    (total, artifact) => total + (Number.isInteger(artifact?.sizeBytes) ? artifact.sizeBytes : 0),
    0,
  );
  if (
    pre003?.status !== "passed" ||
    pre004?.status !== "completed" ||
    pre004?.boundedWindowTranscriptValidityStatus !== "passed" ||
    pre005Macos?.status !== "completed" ||
    pre005Windows?.status !== "completed" ||
    pre003?.engine?.commit !== decisions?.engineRuntime?.engine?.commit ||
    pre004?.engine?.commit !== decisions?.engineRuntime?.engine?.commit ||
    pre003?.model?.sha256 !== launchModel?.sha256 ||
    pre004?.model?.sha256 !== launchModel?.sha256 ||
    pre005Macos?.ffmpegBuild?.sourceArchiveSha256 !==
      decisions?.mediaRuntime?.macosArm64?.sourceArchiveSha256 ||
    pre005Windows?.ffmpegCandidate?.assetSha256 !==
      decisions?.mediaRuntime?.windowsX64?.assetSha256 ||
    pre005Windows?.distributionProfile !== windowsProfile?.distributionProfile ||
    pre004?.fallbackContract?.macosX64Result !== macX64Profile?.errorCode ||
    pre005Windows?.builderSpike?.positivePackage?.unpackedSizeBytes !==
      decisions?.qualityPerformanceAndFootprint?.footprintBudgets
        ?.windowsBasePackageUnpacked?.observedByteSize ||
    pre003?.artifacts?.cuda?.expandedSizeBytes !==
      decisions?.qualityPerformanceAndFootprint?.footprintBudgets
        ?.windowsCudaPackExpanded?.observedByteSize ||
    launchModel?.byteSize !==
      decisions?.qualityPerformanceAndFootprint?.footprintBudgets
        ?.launchModelInstalled?.observedByteSize ||
    macRuntimeBytes !==
      decisions?.qualityPerformanceAndFootprint?.footprintBudgets
        ?.macosNativeRuntime?.observedByteSize
  ) {
    addIssue(
      errors,
      name,
      "evidence_mismatch",
      "The PRE-006 pins or footprint observations no longer match PRE-003 through PRE-005 evidence.",
    );
  }
}

function validatePre006Engine(decision, errors) {
  const name = DOCUMENTS.pre006;
  const engine = decision?.engine;
  const contract = decision?.httpContract;
  if (
    engine?.id !== "whisper.cpp" ||
    engine?.version !== "v1.9.1" ||
    engine?.commit !== "f049fff95a089aa9969deb009cdd4892b3e74916" ||
    engine?.releaseUrl !==
      "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1" ||
    engine?.license !== "MIT"
  ) {
    addIssue(errors, name, "engine_pin", "The exact whisper.cpp v1.9.1 commit must stay pinned.");
  }
  if (
    contract?.version !== 1 ||
    contract?.adapter !== "node-managed-official-server" ||
    contract?.listenHost !== "127.0.0.1" ||
    contract?.privatePathEntropyBits !== 192 ||
    contract?.responseFormat !== "verbose_json" ||
    contract?.maxActiveRequests !== 1 ||
    contract?.progressContract !== "phase-only" ||
    contract?.nativeBridgeRequired !== false
  ) {
    addIssue(errors, name, "http_contract", "The v1 Node-managed official server contract changed.");
  }
  const artifacts = new Map(
    asArray(decision?.artifacts).map((artifact) => [artifact?.id, artifact]),
  );
  const cpu = artifacts.get("whisper-server-win-x64-cpu");
  const cuda = artifacts.get("whisper-server-win-x64-cuda-12.4");
  const mac = artifacts.get("whisper-server-mac-arm64-metal-cpu");
  if (
    artifacts.size !== 3 ||
    cpu?.archiveSha256 !== "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539" ||
    cpu?.downloadUrl !==
      "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip" ||
    cpu?.sourceBuildRequired !== false ||
    cuda?.archiveSha256 !== "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b" ||
    cuda?.downloadUrl !==
      "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip" ||
    cuda?.sourceBuildRequired !== false ||
    mac?.acquisition !== "exact-commit-source-build" ||
    mac?.sourceBuildRequired !== true ||
    mac?.buildFlags?.CMAKE_OSX_ARCHITECTURES !== "arm64" ||
    mac?.buildFlags?.BUILD_SHARED_LIBS !== false ||
    mac?.buildFlags?.GGML_NATIVE !== false ||
    mac?.buildFlags?.GGML_METAL !== true ||
    mac?.buildFlags?.GGML_METAL_EMBED_LIBRARY !== true ||
    mac?.buildFlags?.WHISPER_BUILD_SERVER !== true
  ) {
    addIssue(errors, name, "engine_artifacts", "The three selected server artifact contracts changed.");
  }
}

function validatePre006Platforms(decision, errors) {
  const name = DOCUMENTS.pre006;
  const profiles = new Map(
    asArray(decision?.profiles).map((profile) => [profile?.id, profile]),
  );
  const windows = profiles.get("windows-x64");
  const macArm64 = profiles.get("macos-arm64");
  const macX64 = profiles.get("macos-x64");
  if (
    profiles.size !== 3 ||
    windows?.support !== "supported" ||
    windows?.baseBackend !== "cpu" ||
    windows?.autoPreferenceOrder?.[0] !== "cuda" ||
    windows?.autoPreferenceOrder?.[1] !== "cpu" ||
    windows?.autoPreferenceOrder?.length !== 2 ||
    !hasExactMembers(windows?.optionalBackends, ["cuda"]) ||
    windows?.acceleratorDelivery !== "on-demand-pack" ||
    windows?.cudaToolkitRequired !== false ||
    windows?.nvidiaDriverRequired !== true ||
    windows?.minimumNvidiaDriverVersion !== "551.61" ||
    windows?.validatedNvidiaDriverVersion !== "610.62" ||
    windows?.distributionProfile !== "unsigned_personal_distribution" ||
    windows?.operatingSystemCodeSigningRequired !== false ||
    windows?.trustStoreChangeAllowed !== false ||
    macArm64?.support !== "supported" ||
    macArm64?.defaultBackend !== "metal" ||
    macArm64?.autoPreferenceOrder?.[0] !== "metal" ||
    macArm64?.autoPreferenceOrder?.[1] !== "cpu" ||
    macArm64?.autoPreferenceOrder?.length !== 2 ||
    !hasExactMembers(macArm64?.optionalBackends, ["cpu"]) ||
    macX64?.support !== "unsupported" ||
    macX64?.errorCode !== "unsupported_architecture" ||
    macX64?.artifactCount !== 0 ||
    macX64?.rosettaFallbackAllowed !== false
  ) {
    addIssue(errors, name, "platform_matrix", "The PRE-006 platform or distribution profile changed.");
  }
  const fallback = decision?.fallbackContract;
  if (
    fallback?.autoResolvesBeforeBatchCommit !== true ||
    fallback?.resolvedBackendVisibleBeforeStart !== true ||
    fallback?.explicitGpuFallbackAllowed !== false ||
    fallback?.postCommitGpuFailureRequiresUserConfirmedCpuGeneration !== true ||
    fallback?.unverifiedGpuErrorCode !== "backend_unverified"
  ) {
    addIssue(errors, name, "fallback_contract", "GPU fallback must remain explicit and pre-commit.");
  }
}

function validatePre006Media(decision, errors) {
  const name = DOCUMENTS.pre006;
  const mac = decision?.macosArm64;
  const windows = decision?.windowsX64;
  const staging = decision?.stagingContract;
  if (
    decision?.versionFamily !== "8.1.2" ||
    mac?.acquisition !== "pinned-source-build" ||
    mac?.sourceArchiveUrl !== "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz" ||
    mac?.sourceArchiveSha256 !== "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c" ||
    mac?.detachedSignatureUrl !==
      "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc" ||
    mac?.detachedSignatureFingerprint !== "FCF986EA15E6E293A5644F10B4322F04D67658D8" ||
    mac?.detachedSignatureVerified !== true ||
    mac?.license !== "LGPL-2.1-or-later" ||
    mac?.gplEnabled !== false ||
    mac?.nonfreeEnabled !== false ||
    !hasExactMembers(mac?.externalLibraries, [])
  ) {
    addIssue(errors, name, "macos_media", "The pinned minimal macOS FFmpeg contract changed.");
  }
  if (
    windows?.acquisition !== "immutable-prebuilt-release-asset" ||
    windows?.releaseTag !== "autobuild-2026-06-30-13-34" ||
    windows?.releaseUrl !==
      "https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-13-34" ||
    windows?.assetUrl !==
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-n8.1.2-21-gce3c09c101-win64-lgpl-8.1.zip" ||
    windows?.assetSha256 !== "3b9eceb438016b647e0755a51ce3a388cd4ed5679e2427cb83a01e1ae2cd0eba" ||
    windows?.configurationSha256 !== "942a04ca7fafc83bb5ffaa5e40a4c74682b77e353b5d3e597d77219c54d04dc6" ||
    windows?.license !== "LGPL-3.0-or-later" ||
    windows?.gplEnabled !== false ||
    windows?.nonfreeEnabled !== false ||
    windows?.externalLibraryFlagCount !== 51 ||
    windows?.selection !== "accepted-initial-personal-distribution-baseline" ||
    windows?.sourceBuildToolchainRequired !== false ||
    windows?.licenseClosureGate !== "QA-005"
  ) {
    addIssue(errors, name, "windows_media", "The immutable Windows FFmpeg baseline changed.");
  }
  if (
    staging?.outsideAsar !== true ||
    staging?.artifactNameIncludesArchitecture !== true ||
    staging?.automation !== "auditable-local-release-scripts-first" ||
    staging?.networkAccessDuringElectronBuilder !== false ||
    staging?.acquireAuditAndHashBeforeStaging !== true ||
    staging?.packagedPathFallbackAllowed !== false ||
    staging?.beforePackRequiresRuntimeManifestAndLicenseEvidence !== true ||
    staging?.macosHashAfterFinalNestedSigning !== true ||
    staging?.windowsIntegrityProfile !== "unsigned-final-bytes-size-sha256"
  ) {
    addIssue(errors, name, "staging_contract", "The production staging contract changed.");
  }
}

function validatePre006Models(decision, errors) {
  const name = DOCUMENTS.pre006;
  const launchModels = decision?.launchModels;
  const model = launchModels?.[0];
  const vad = decision?.vad;
  if (
    decision?.schemaVersion !== 1 ||
    !hasExactMembers(decision?.requiredCommonFields, [
      "id",
      "resourceType",
      "fileName",
      "format",
      "engineCompatibility",
      "sourceRevision",
      "downloadUrl",
      "byteSize",
      "sha256",
      "license",
      "bundledInInstaller",
    ]) ||
    !hasExactMembers(decision?.requiredModelFields, [
      "multilingual",
      "quantization",
      "defaultRecommended",
      "qualityLabel",
    ]) ||
    !hasExactMembers(decision?.requiredVadFields, [
      "defaultEnabled",
      "tokenTimestampsAllowed",
      "timelinePolicy",
    ]) ||
    !Array.isArray(launchModels) ||
    launchModels.length !== 1 ||
    model?.id !== "large-v3-q5_0" ||
    model?.resourceType !== "model" ||
    model?.format !== "ggml" ||
    model?.engineCompatibility !== "whisper.cpp-v1.9.1" ||
    model?.sourceRevision !== "c521a4b02f422512d734391fdf08bb08c0862f68" ||
    model?.downloadUrl !==
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3-q5_0.bin?download=true" ||
    model?.byteSize !== 1081140203 ||
    model?.sha256 !== "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1" ||
    model?.multilingual !== true ||
    model?.quantization !== "q5_0" ||
    model?.defaultRecommended !== true ||
    model?.bundledInInstaller !== false
  ) {
    addIssue(errors, name, "launch_model", "large-v3-q5_0 must remain the sole verified launch model.");
  }
  if (!hasExactMembers(
    asArray(decision?.deferredBuiltInModels).map((entry) => entry?.id),
    ["large-v3", "large-v3-turbo", "large-v3-turbo-q5_0"],
  )) {
    addIssue(errors, name, "deferred_models", "Unverified model variants must remain deferred.");
  }
  if (
    vad?.id !== "silero-vad-v6.2.0-ggml" ||
    vad?.resourceType !== "vad" ||
    vad?.format !== "ggml" ||
    vad?.engineCompatibility !== "whisper.cpp-v1.9.1" ||
    vad?.sourceRevision !== "f049fff95a089aa9969deb009cdd4892b3e74916" ||
    vad?.downloadUrl !==
      "https://raw.githubusercontent.com/ggml-org/whisper.cpp/f049fff95a089aa9969deb009cdd4892b3e74916/models/for-tests-silero-v6.2.0-ggml.bin" ||
    vad?.byteSize !== 885098 ||
    vad?.sha256 !== "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987" ||
    vad?.defaultEnabled !== true ||
    vad?.tokenTimestampsAllowed !== false ||
    vad?.timelinePolicy !== "mapped-segment-timestamps-only" ||
    vad?.bundledInInstaller !== false
  ) {
    addIssue(errors, name, "vad_pin", "The verified Silero VAD and mapped-segment policy changed.");
  }
  const install = decision?.installationPolicy;
  if (
    install?.automaticDownloadOnInstallOrPageOpen !== false ||
    install?.allowlistedHttpsSourcesOnly !== true ||
    install?.expectedSizeAndSha256Required !== true ||
    install?.loadSmokeBeforeReady !== true ||
    install?.managedUserDataDirectoryOnly !== true ||
    install?.partialDownloadAndAtomicCommitRequired !== true
  ) {
    addIssue(errors, name, "model_installation", "The managed model installation policy changed.");
  }
}

function validatePre006Quality(decision, errors) {
  const name = DOCUMENTS.pre006;
  const strategy = decision?.transcriptStrategy;
  if (
    strategy?.wholeFileSingleRequestAllowed !== false ||
    strategy?.pcmWindowMs !== 30000 ||
    strategy?.overlapMs !== 5000 ||
    strategy?.vadEnabled !== true ||
    strategy?.rawQualityGateBeforeFormatting !== true ||
    strategy?.boundedRetryDepth !== 3
  ) {
    addIssue(errors, name, "transcript_strategy", "The verified bounded-window strategy changed.");
  }
  const ranges = decision?.observedRealtimeFactorRanges;
  for (const backend of ["windowsCuda", "windowsCpu", "macosMetal", "macosCpu"]) {
    const range = ranges?.[backend];
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      range.some((value) => typeof value !== "number" || value < 0 || value >= 1) ||
      range[0] > range[1]
    ) {
      addIssue(errors, name, "performance_range", backend);
    }
  }
  const budgets = decision?.footprintBudgets;
  const expectedObserved = Object.freeze({
    windowsBasePackageUnpacked: 789147424,
    windowsCudaPackExpanded: 1209487872,
    launchModelInstalled: 1081140203,
    macosNativeRuntime: 8970336,
  });
  for (const [budgetId, expectedBytes] of Object.entries(expectedObserved)) {
    const budget = budgets?.[budgetId];
    if (
      budget?.observedByteSize !== expectedBytes ||
      !Number.isInteger(budget?.guardByteSize) ||
      budget.guardByteSize < budget.observedByteSize
    ) {
      addIssue(errors, name, "footprint_budget", budgetId);
    }
  }
  if (
    decision?.qualityGate?.rawTranscriptValidityRequired !== true ||
    decision?.qualityGate?.srtAndLrcParseBackRequired !== true ||
    decision?.qualityGate?.supportedGpuRealtimeFactorMustBeBelow !== 1 ||
    decision?.qualityGate?.textAccuracyResearchBaselineRequired !== false ||
    decision?.decision !==
      "accept-observed-footprint-for-personal-distribution-and-show-disk-requirements"
  ) {
    addIssue(errors, name, "quality_gate", "The PRE-006 go/no-go criteria changed.");
  }
}

export function validateDocuments(documents, options = {}) {
  const errors = [];
  const warnings = [];
  const strict = options.strict ?? false;
  validateBenchmarkManifest(documents.benchmark, strict, errors, warnings);
  validateMetricsContract(documents.metrics, errors);
  validateThirdPartyCandidates(documents.thirdParty, errors);
  validatePre006Decision(
    documents.pre006,
    documents.thirdParty,
    {
      pre003: documents.pre003,
      pre004: documents.pre004,
      pre005Macos: documents.pre005Macos,
      pre005Windows: documents.pre005Windows,
    },
    errors,
  );
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
