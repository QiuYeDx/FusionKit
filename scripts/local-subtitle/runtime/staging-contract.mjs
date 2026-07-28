import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_CONTRACT_SCHEMA_VERSION = 1;
export const STAGING_RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
export const STAGING_RUNTIME_CONTRACT_VERSION = 1;
export const DEVELOPMENT_RUNTIME_ROOT =
  "build/local-subtitle-resources/local-subtitle";
export const PACKAGED_RUNTIME_ROOT = "local-subtitle";
export const STAGING_RUNTIME_MANIFEST_RELATIVE_PATH =
  "manifests/local-subtitle-runtime.v1.json";
export const STAGING_ARTIFACT_NAME_PATTERN =
  "${productName}_${version}_${arch}.${ext}";
export const STAGING_LIMITS = Object.freeze({
  maxIdChars: 128,
  maxManifestBytes: 2 * 1024 * 1024,
  maxArtifacts: 256,
  maxLicenses: 64,
  maxSources: 64,
  maxEvidenceFiles: 256,
  maxRelativePathChars: 512,
});

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_SUBTITLE_STAGING_CONTRACT_PATH = path.resolve(
  MODULE_DIRECTORY,
  "../../../resources/local-subtitle/manifests/local-subtitle-staging.v1.json",
);

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "runtimeManifestSchemaVersion",
  "runtimeContractVersion",
  "developmentRuntimeRoot",
  "packagedRuntimeRoot",
  "runtimeManifestRelativePath",
  "artifactNamePattern",
  "limits",
  "targets",
]);
const TARGET_KEYS = Object.freeze([
  "id",
  "platform",
  "arch",
  "integrityProfile",
  "integrity",
  "allowedSignatureKinds",
  "artifactVersions",
  "requiredArtifacts",
  "requiredLicenses",
  "requiredSources",
]);
const INTEGRITY_KEYS = Object.freeze([
  "algorithm",
  "binaryHashPhase",
  "outerSignatureCoverage",
]);
const LIMIT_KEYS = Object.freeze(Object.keys(STAGING_LIMITS));
const ARTIFACT_VERSION_KEYS = Object.freeze(["runner", "media"]);
const REQUIRED_ARTIFACT_KEYS = Object.freeze([
  "id",
  "kind",
  "backend",
  "relativePath",
  "licenseRef",
  "sourceRef",
  "executable",
]);
const REQUIRED_LICENSE_KEYS = Object.freeze([
  "id",
  "component",
  "spdxExpression",
  "licenseFiles",
  "noticeFiles",
]);
const REQUIRED_SOURCE_KEYS = Object.freeze([
  "id",
  "component",
  "version",
  "evidenceFile",
]);

const EVIDENCE_FILES = deepFreeze({
  whisperLicense: {
    relativePath: "licenses/whisper.cpp-MIT.txt",
    byteSize: 1_078,
    sha256: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
  },
  ffmpegLgpl21: {
    relativePath: "licenses/FFmpeg-COPYING.LGPLv2.1.txt",
    byteSize: 26_517,
    sha256: "246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30",
  },
  ffmpegLgpl3: {
    relativePath: "licenses/FFmpeg-COPYING.LGPLv3.txt",
    byteSize: 7_651,
    sha256: "da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768",
  },
  ffmpegNotice: {
    relativePath: "licenses/FFmpeg-LICENSE.md",
    byteSize: 4_346,
    sha256: "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af",
  },
  thirdPartyNotices: {
    relativePath: "licenses/THIRD_PARTY_NOTICES.local-subtitle.md",
    byteSize: 1_968,
    sha256: "3febd4b011d5176e3f304c39aac46ca3b9be6b0654ec1249c6d1cc98106d87b6",
  },
  whisperSource: {
    relativePath: "licenses/whisper.cpp-v1.9.1-source.json",
    byteSize: 1_720,
    sha256: "711a66a5934ffa3a5dac2fdebcae9d95d07bb97270671d298bfad10753b3f275",
  },
  ffmpegMacSource: {
    relativePath: "licenses/FFmpeg-8.1.2-source-offer.json",
    byteSize: 2_038,
    sha256: "9d5e17026e5acd24f188362ad61fb4f05291c1231b372e83f5f311e91ec7e068",
  },
  ffmpegWindowsSource: {
    relativePath: "licenses/FFmpeg-n8.1.2-windows-x64-btbn-source.json",
    byteSize: 2_112,
    sha256: "4ffb9eaaa28c32e7a2a82243a81df72b5b02bc3e445a782f466d0716d50f4510",
  },
});

const WHISPER_LICENSE = deepFreeze({
  id: "whisper-cpp-mit",
  component: "whisper.cpp",
  spdxExpression: "MIT",
  licenseFiles: [EVIDENCE_FILES.whisperLicense],
  noticeFiles: [],
});
const WHISPER_SOURCE = deepFreeze({
  id: "whisper-cpp-v1.9.1",
  component: "whisper.cpp",
  version: "v1.9.1",
  evidenceFile: EVIDENCE_FILES.whisperSource,
});
const WHISPER_ARTIFACT_REFERENCES = Object.freeze({
  licenseRef: WHISPER_LICENSE.id,
  sourceRef: WHISPER_SOURCE.id,
});

const WINDOWS_CPU_DEPENDENCIES = Object.freeze([
  "ggml-base.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml.dll",
  "whisper.dll",
]);

function dependencyId(fileName) {
  return `whisper-dependency-${fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;
}

const EXPECTED_TARGETS = deepFreeze({
  "darwin-arm64": {
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    integrityProfile: "macos_nested_signed_final_bytes_sha256",
    integrity: {
      algorithm: "sha256",
      binaryHashPhase:
        "after_nested_code_signing_before_outer_bundle_signing",
      outerSignatureCoverage: "required",
    },
    allowedSignatureKinds: ["adhoc", "developer_id"],
    artifactVersions: {
      runner: "v1.9.1+f049fff",
      media: "8.1.2",
    },
    requiredArtifacts: [
      {
        id: "whisper-server-mac-arm64-metal-cpu",
        kind: "server",
        backend: "metal_cpu",
        relativePath: "mac-arm64/metal/whisper-server",
        ...WHISPER_ARTIFACT_REFERENCES,
        executable: true,
      },
      {
        id: "ffmpeg-mac-arm64",
        kind: "ffmpeg",
        backend: "media",
        relativePath: "mac-arm64/media/ffmpeg",
        licenseRef: "ffmpeg-lgpl-2.1-or-later",
        sourceRef: "ffmpeg-8.1.2",
        executable: true,
      },
      {
        id: "ffprobe-mac-arm64",
        kind: "ffprobe",
        backend: "media",
        relativePath: "mac-arm64/media/ffprobe",
        licenseRef: "ffmpeg-lgpl-2.1-or-later",
        sourceRef: "ffmpeg-8.1.2",
        executable: true,
      },
    ],
    requiredLicenses: [
      WHISPER_LICENSE,
      {
        id: "ffmpeg-lgpl-2.1-or-later",
        component: "FFmpeg",
        spdxExpression: "LGPL-2.1-or-later",
        licenseFiles: [EVIDENCE_FILES.ffmpegLgpl21],
        noticeFiles: [
          EVIDENCE_FILES.ffmpegNotice,
          EVIDENCE_FILES.thirdPartyNotices,
        ],
      },
    ],
    requiredSources: [
      WHISPER_SOURCE,
      {
        id: "ffmpeg-8.1.2",
        component: "FFmpeg",
        version: "8.1.2",
        evidenceFile: EVIDENCE_FILES.ffmpegMacSource,
      },
    ],
  },
  "win32-x64": {
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    integrityProfile: "windows_unsigned_personal_final_bytes_sha256",
    integrity: {
      algorithm: "sha256",
      binaryHashPhase: "unsigned_final_bytes_before_outer_packaging",
      outerSignatureCoverage: "not_required_personal_distribution",
    },
    allowedSignatureKinds: ["unsigned"],
    artifactVersions: {
      runner: "v1.9.1+f049fff",
      media: "n8.1.2-21-gce3c09c101-20260630",
    },
    requiredArtifacts: [
      {
        id: "whisper-server-win-x64-cpu",
        kind: "server",
        backend: "cpu",
        relativePath: "win-x64/cpu/whisper-server.exe",
        ...WHISPER_ARTIFACT_REFERENCES,
        executable: true,
      },
      ...WINDOWS_CPU_DEPENDENCIES.map((fileName) => ({
        id: dependencyId(fileName),
        kind: "dynamic_library",
        backend: "cpu",
        relativePath: `win-x64/cpu/${fileName}`,
        ...WHISPER_ARTIFACT_REFERENCES,
        executable: false,
      })),
      {
        id: "ffmpeg-win-x64",
        kind: "ffmpeg",
        backend: "media",
        relativePath: "win-x64/media/ffmpeg.exe",
        licenseRef: "ffmpeg-windows-lgpl-3.0-or-later",
        sourceRef: "ffmpeg-windows-n8.1.2-btbn",
        executable: true,
      },
      {
        id: "ffprobe-win-x64",
        kind: "ffprobe",
        backend: "media",
        relativePath: "win-x64/media/ffprobe.exe",
        licenseRef: "ffmpeg-windows-lgpl-3.0-or-later",
        sourceRef: "ffmpeg-windows-n8.1.2-btbn",
        executable: true,
      },
    ],
    requiredLicenses: [
      WHISPER_LICENSE,
      {
        id: "ffmpeg-windows-lgpl-3.0-or-later",
        component: "FFmpeg Windows candidate",
        spdxExpression: "LGPL-3.0-or-later",
        licenseFiles: [EVIDENCE_FILES.ffmpegLgpl3],
        noticeFiles: [
          EVIDENCE_FILES.ffmpegNotice,
          EVIDENCE_FILES.thirdPartyNotices,
        ],
      },
    ],
    requiredSources: [
      WHISPER_SOURCE,
      {
        id: "ffmpeg-windows-n8.1.2-btbn",
        component: "FFmpeg Windows candidate",
        version: "n8.1.2-21-gce3c09c101-20260630",
        evidenceFile: EVIDENCE_FILES.ffmpegWindowsSource,
      },
    ],
  },
});

export function validateLocalSubtitleStagingContract(value) {
  assertPlainObject(value, "staging contract");
  assertExactKeys(value, TOP_LEVEL_KEYS, "staging contract");
  assertEqual(
    value.schemaVersion,
    STAGING_CONTRACT_SCHEMA_VERSION,
    "staging contract schemaVersion",
  );
  assertEqual(
    value.runtimeManifestSchemaVersion,
    STAGING_RUNTIME_MANIFEST_SCHEMA_VERSION,
    "runtime manifest schemaVersion",
  );
  assertEqual(
    value.runtimeContractVersion,
    STAGING_RUNTIME_CONTRACT_VERSION,
    "runtime contract version",
  );
  assertEqual(
    value.developmentRuntimeRoot,
    DEVELOPMENT_RUNTIME_ROOT,
    "development runtime root",
  );
  assertEqual(
    value.packagedRuntimeRoot,
    PACKAGED_RUNTIME_ROOT,
    "packaged runtime root",
  );
  assertEqual(
    value.runtimeManifestRelativePath,
    STAGING_RUNTIME_MANIFEST_RELATIVE_PATH,
    "runtime manifest relative path",
  );
  assertEqual(
    value.artifactNamePattern,
    STAGING_ARTIFACT_NAME_PATTERN,
    "artifact name pattern",
  );
  assertPlainObject(value.limits, "staging limits");
  assertExactKeys(value.limits, LIMIT_KEYS, "staging limits");
  for (const key of LIMIT_KEYS) {
    assertEqual(value.limits[key], STAGING_LIMITS[key], `staging limits.${key}`);
  }

  if (!Array.isArray(value.targets) || value.targets.length !== 2) {
    throw invalidContract("The staging contract must define exactly two targets.");
  }
  const targetsById = new Map();
  const globalArtifactPaths = new Set();
  for (const target of value.targets) {
    validateTarget(target, globalArtifactPaths);
    if (targetsById.has(target.id)) {
      throw invalidContract("Staging target IDs must be unique.");
    }
    targetsById.set(target.id, target);
  }
  for (const targetId of Object.keys(EXPECTED_TARGETS)) {
    if (!targetsById.has(targetId)) {
      throw invalidContract(`The staging contract is missing ${targetId}.`);
    }
  }
  return value;
}

export function loadLocalSubtitleStagingContract(
  contractPath = LOCAL_SUBTITLE_STAGING_CONTRACT_PATH,
) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    throw invalidContract("The staging contract is not valid JSON.");
  }
  validateLocalSubtitleStagingContract(parsed);
  return deepFreeze(parsed);
}

export function getLocalSubtitleStagingTarget(
  platform,
  arch,
  contract = LOCAL_SUBTITLE_STAGING_CONTRACT,
) {
  const target = contract.targets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (target) return target;
  const error = new Error("The local subtitle staging target is unsupported.");
  error.code = platform === "darwin" || platform === "win32"
    ? "unsupported_architecture"
    : "unsupported_platform";
  throw error;
}

export function resolveDevelopmentRuntimeRoot(
  projectRoot,
  contract = LOCAL_SUBTITLE_STAGING_CONTRACT,
) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("projectRoot must be a non-empty string.");
  }
  return path.resolve(
    projectRoot,
    ...contract.developmentRuntimeRoot.split("/"),
  );
}

export function resolveRuntimeStagingOutputParent(
  projectRoot,
  contract = LOCAL_SUBTITLE_STAGING_CONTRACT,
) {
  return path.dirname(resolveDevelopmentRuntimeRoot(projectRoot, contract));
}

function validateTarget(target, globalArtifactPaths) {
  assertPlainObject(target, "staging target");
  assertExactKeys(target, TARGET_KEYS, "staging target");
  const expected = EXPECTED_TARGETS[target.id];
  if (!expected) {
    throw invalidContract("The staging contract contains an unknown target.");
  }
  for (const key of ["id", "platform", "arch", "integrityProfile"]) {
    assertEqual(target[key], expected[key], `staging target ${target.id}.${key}`);
  }
  assertPlainObject(target.integrity, `staging target ${target.id}.integrity`);
  assertExactKeys(
    target.integrity,
    INTEGRITY_KEYS,
    `staging target ${target.id}.integrity`,
  );
  for (const key of INTEGRITY_KEYS) {
    assertEqual(
      target.integrity[key],
      expected.integrity[key],
      `staging target ${target.id}.integrity.${key}`,
    );
  }
  assertExactStringSet(
    target.allowedSignatureKinds,
    expected.allowedSignatureKinds,
    `staging target ${target.id}.allowedSignatureKinds`,
  );
  assertPlainObject(
    target.artifactVersions,
    `staging target ${target.id}.artifactVersions`,
  );
  assertExactKeys(
    target.artifactVersions,
    ARTIFACT_VERSION_KEYS,
    `staging target ${target.id}.artifactVersions`,
  );
  for (const key of ARTIFACT_VERSION_KEYS) {
    assertEqual(
      target.artifactVersions[key],
      expected.artifactVersions[key],
      `staging target ${target.id}.artifactVersions.${key}`,
    );
  }
  assertCanonicalRecords(
    target.requiredArtifacts,
    expected.requiredArtifacts,
    REQUIRED_ARTIFACT_KEYS,
    `staging target ${target.id}.requiredArtifacts`,
    (record) => {
      const pathKey = record.relativePath.toLowerCase();
      if (globalArtifactPaths.has(pathKey)) {
        throw invalidContract(
          "Staging artifact paths must be globally unique ignoring case.",
        );
      }
      globalArtifactPaths.add(pathKey);
    },
  );
  assertCanonicalRecords(
    target.requiredLicenses,
    expected.requiredLicenses,
    REQUIRED_LICENSE_KEYS,
    `staging target ${target.id}.requiredLicenses`,
  );
  assertCanonicalRecords(
    target.requiredSources,
    expected.requiredSources,
    REQUIRED_SOURCE_KEYS,
    `staging target ${target.id}.requiredSources`,
  );
}

function assertCanonicalRecords(actual, expected, keys, label, onRecord) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw invalidContract(`${label} does not contain the required records.`);
  }
  const expectedById = new Map(expected.map((record) => [record.id, record]));
  const actualIds = new Set();
  for (const record of actual) {
    assertPlainObject(record, `${label} record`);
    assertExactKeys(record, keys, `${label} record`);
    if (typeof record.id !== "string" || actualIds.has(record.id)) {
      throw invalidContract(`${label} IDs must be unique non-empty strings.`);
    }
    actualIds.add(record.id);
    const expectedRecord = expectedById.get(record.id);
    if (!expectedRecord) {
      throw invalidContract(`${label} contains an unexpected record.`);
    }
    for (const key of keys) {
      assertEqual(record[key], expectedRecord[key], `${label}.${record.id}.${key}`);
    }
    onRecord?.(record);
  }
}

function assertExactStringSet(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== "string") ||
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((value) => !actual.includes(value))
  ) {
    throw invalidContract(`${label} does not match the selected profile.`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContract(`${label} must be an object.`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidContract(`${label} has missing or unknown fields.`);
  }
}

function assertEqual(actual, expected, label) {
  const equal =
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object"
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
  if (!equal) {
    throw invalidContract(`${label} does not match the canonical contract.`);
  }
}

function invalidContract(message) {
  const error = new Error(message);
  error.code = "invalid_staging_contract";
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const LOCAL_SUBTITLE_STAGING_CONTRACT =
  loadLocalSubtitleStagingContract();
