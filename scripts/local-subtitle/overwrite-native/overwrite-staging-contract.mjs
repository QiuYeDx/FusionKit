import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(MODULE_PATH), "../../..");

export const OVERWRITE_STAGING_CONTRACT_PATH = path.join(
  PROJECT_ROOT,
  "resources/local-subtitle/manifests/local-subtitle-overwrite-staging.v1.json",
);

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const NODE_VERSION = /^\d+\.\d+\.\d+$/u;
const SDK_VERSION = /^\d+(?:\.\d+){1,2}$/u;
const WORK_PACKAGE_PROVENANCE = /^FS-TXN-001[A-Z]$/u;
const TOP_LEVEL_CONTRACT_KEYS = Object.freeze([
  "schemaVersion",
  "component",
  "developmentRuntimeRoot",
  "packagedRuntimeRoot",
  "stagingSubtree",
  "manifestRelativePath",
  "buildReceiptRelativePath",
  "artifactLeafPattern",
  "targets",
]);
const TARGET_KEYS = Object.freeze([
  "id",
  "platform",
  "arch",
  "compatibility",
  "build",
  "artifact",
  "integrity",
]);
const COMPATIBILITY_KEYS = Object.freeze([
  "napiVersion",
  "nativeProtocolVersion",
  "journalVersion",
]);
const ARTIFACT_POLICY_KEYS = Object.freeze([
  "relativeDirectory",
  "format",
  "architecture",
  "minimumOsVersion",
  "requiresLoadCommandUuid",
]);
const INTEGRITY_POLICY_KEYS = Object.freeze([
  "algorithm",
  "binaryHashPhase",
  "allowedSignatureKinds",
]);

const EXPECTED_TARGETS = deepFreeze({
  "darwin-arm64": {
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    compatibility: {
      napiVersion: 8,
      nativeProtocolVersion: 4,
      journalVersion: 3,
    },
    build: {
      recipe:
        "scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs",
      source: "native/local-subtitle-overwrite/src/addon.cc",
      cxxStandard: "c++17",
      deploymentTarget: "11.0",
    },
    artifact: {
      relativeDirectory: "native/darwin-arm64",
      format: "mach-o",
      architecture: "arm64",
      minimumOsVersion: "11.0.0",
      requiresLoadCommandUuid: true,
    },
    integrity: {
      algorithm: "sha256",
      binaryHashPhase:
        "after_nested_code_signing_before_outer_bundle_signing",
      allowedSignatureKinds: ["adhoc", "developer_id"],
    },
  },
  "win32-x64": {
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    compatibility: {
      napiVersion: 8,
      nativeProtocolVersion: 4,
      journalVersion: 3,
    },
    build: {
      recipe:
        "scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs",
      source: "native/local-subtitle-overwrite/src/addon-win32.cc",
      delayLoadHook:
        "native/local-subtitle-overwrite/src/win-delay-load-hook.cc",
      nodeImportMode: "delay-load-current-host",
      delayedHostBinary: "node.exe",
      cxxStandard: "c++17",
      minimumWindowsVersion: "10.0",
    },
    artifact: {
      relativeDirectory: "native/win32-x64",
      format: "pe",
      architecture: "x64",
      minimumOsVersion: null,
      requiresLoadCommandUuid: false,
    },
    integrity: {
      algorithm: "sha256",
      binaryHashPhase: "unsigned_final_bytes_before_outer_packaging",
      allowedSignatureKinds: ["unsigned"],
    },
  },
});

export function loadOverwriteStagingContract(
  contractPath = OVERWRITE_STAGING_CONTRACT_PATH,
) {
  let value;
  try {
    value = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    throw invalidContract("The overwrite staging contract is not valid JSON.");
  }
  return parseOverwriteStagingContract(value);
}

export function parseOverwriteStagingContract(value) {
  assertPlainObject(value, "staging contract");
  assertExactKeys(value, TOP_LEVEL_CONTRACT_KEYS, "staging contract");
  assertEqual(value.schemaVersion, 1, "staging contract schemaVersion");
  assertEqual(
    value.component,
    "local-subtitle-overwrite",
    "staging component",
  );
  assertEqual(
    value.developmentRuntimeRoot,
    "build/local-subtitle-resources/local-subtitle",
    "development runtime root",
  );
  assertEqual(value.packagedRuntimeRoot, "local-subtitle", "packaged root");
  assertEqual(value.stagingSubtree, "overwrite/v1", "staging subtree");
  assertEqual(
    value.manifestRelativePath,
    "overwrite/v1/local-subtitle-overwrite.v1.json",
    "manifest path",
  );
  assertEqual(
    value.buildReceiptRelativePath,
    "build-receipt.v1.json",
    "build receipt path",
  );
  assertEqual(
    value.artifactLeafPattern,
    "local-subtitle-overwrite.<sha256>.node",
    "artifact leaf pattern",
  );
  if (!Array.isArray(value.targets) || value.targets.length !== 2) {
    throw invalidContract("The staging contract must define exactly two targets.");
  }
  const observed = new Set();
  for (const target of value.targets) {
    assertPlainObject(target, "staging target");
    assertExactKeys(target, TARGET_KEYS, "staging target");
    const expected = EXPECTED_TARGETS[target.id];
    if (!expected || observed.has(target.id)) {
      throw invalidContract("The staging contract target set is invalid.");
    }
    observed.add(target.id);
    assertCanonicalRecord(target, expected, `staging target ${target.id}`);
  }
  if (observed.size !== Object.keys(EXPECTED_TARGETS).length) {
    throw invalidContract("The staging contract target set is incomplete.");
  }
  return deepFreeze(value);
}

export const OVERWRITE_STAGING_CONTRACT = loadOverwriteStagingContract();

export function getOverwriteStagingTarget(
  platform,
  arch,
  contract = OVERWRITE_STAGING_CONTRACT,
) {
  if (platform !== "darwin" && platform !== "win32") {
    throw stagingError(
      "unsupported_platform",
      "The overwrite addon staging target is unsupported.",
    );
  }
  const expectedArchitecture = platform === "darwin" ? "arm64" : "x64";
  if (arch !== expectedArchitecture) {
    throw stagingError(
      "unsupported_architecture",
      "The overwrite addon staging architecture is unsupported.",
    );
  }
  const target = contract.targets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) {
    throw invalidContract("The staging contract is missing a supported target.");
  }
  return target;
}

export function parseOverwriteBuildReceipt(value, target) {
  assertPlainObject(value, "build receipt");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "workPackage",
      "component",
      "target",
      "build",
      "artifact",
      "privacy",
    ],
    "build receipt",
  );
  assertEqual(value.schemaVersion, 1, "build receipt schemaVersion");
  if (
    typeof value.workPackage !== "string" ||
    !WORK_PACKAGE_PROVENANCE.test(value.workPackage)
  ) {
    throw invalidReceipt("The build receipt work-package provenance is invalid.");
  }
  assertEqual(value.component, OVERWRITE_STAGING_CONTRACT.component, "component");
  assertPlainObject(value.target, "build receipt target");
  assertExactKeys(value.target, ["platform", "arch"], "build receipt target");
  assertEqual(value.target.platform, target.platform, "build receipt platform");
  assertEqual(value.target.arch, target.arch, "build receipt architecture");

  assertPlainObject(value.build, "build receipt build");
  const buildKeys = target.platform === "darwin"
    ? [
        "recipe",
        "source",
        "nodeVersion",
        "napiVersion",
        "nativeProtocolVersion",
        "journalVersion",
        "cxxStandard",
        "deploymentTarget",
        "sdkVersion",
        "compiler",
        "shell",
      ]
    : [
        "recipe",
        "source",
        "delayLoadHook",
        "nodeImportMode",
        "delayedHostBinary",
        "nodeVersion",
        "napiVersion",
        "nativeProtocolVersion",
        "journalVersion",
        "cxxStandard",
        "minimumWindowsVersion",
        "compiler",
        "shell",
        "nodeImportLibrarySha256",
        "delayLoadHookSha256",
      ];
  assertExactKeys(value.build, buildKeys, "build receipt build");
  for (const key of ["recipe", "source", "cxxStandard"]) {
    assertEqual(value.build[key], target.build[key], `build receipt ${key}`);
  }
  for (const key of COMPATIBILITY_KEYS) {
    assertEqual(
      value.build[key],
      target.compatibility[key],
      `build receipt ${key}`,
    );
  }
  if (!NODE_VERSION.test(value.build.nodeVersion)) {
    throw invalidReceipt("The build receipt Node version is invalid.");
  }
  assertEqual(value.build.shell, false, "build receipt shell policy");
  if (target.platform === "darwin") {
    assertEqual(
      value.build.deploymentTarget,
      target.build.deploymentTarget,
      "build receipt deployment target",
    );
    assertEqual(value.build.compiler, "xcrun clang++", "build receipt compiler");
    if (!SDK_VERSION.test(value.build.sdkVersion)) {
      throw invalidReceipt("The build receipt SDK version is invalid.");
    }
  } else {
    for (const key of [
      "delayLoadHook",
      "nodeImportMode",
      "delayedHostBinary",
    ]) {
      assertEqual(value.build[key], target.build[key], `build receipt ${key}`);
    }
    assertEqual(
      value.build.minimumWindowsVersion,
      target.build.minimumWindowsVersion,
      "build receipt Windows version",
    );
    assertEqual(
      value.build.compiler,
      "portable llvm-mingw clang++",
      "build receipt compiler",
    );
    assertSha256(
      value.build.nodeImportLibrarySha256,
      "build receipt Node import library hash",
    );
    assertSha256(
      value.build.delayLoadHookSha256,
      "build receipt delay-load hook hash",
    );
  }

  assertPlainObject(value.artifact, "build receipt artifact");
  const artifactKeys = [
    "logicalFileName",
    "byteSize",
    "sha256",
    "format",
    "architecture",
    ...(target.platform === "darwin" ? ["minimumMacosVersion"] : []),
  ];
  assertExactKeys(value.artifact, artifactKeys, "build receipt artifact");
  assertEqual(
    value.artifact.logicalFileName,
    "local-subtitle-overwrite.node",
    "build receipt artifact name",
  );
  assertPositiveSafeInteger(value.artifact.byteSize, "build receipt byteSize");
  assertSha256(value.artifact.sha256, "build receipt artifact hash");
  assertEqual(value.artifact.format, target.artifact.format, "artifact format");
  assertEqual(
    value.artifact.architecture,
    target.artifact.architecture,
    "artifact architecture",
  );
  if (target.platform === "darwin") {
    assertEqual(
      value.artifact.minimumMacosVersion,
      target.artifact.minimumOsVersion,
      "artifact minimum macOS version",
    );
  }

  assertPlainObject(value.privacy, "build receipt privacy");
  assertExactKeys(
    value.privacy,
    ["absolutePathsRecorded", "usernameRecorded", "sourceContentRecorded"],
    "build receipt privacy",
  );
  for (const key of Reflect.ownKeys(value.privacy)) {
    assertEqual(value.privacy[key], false, `build receipt privacy.${String(key)}`);
  }
  return deepFreeze(value);
}

export function parseOverwriteAddonManifest(value, options) {
  const target = getOverwriteStagingTarget(options.platform, options.arch);
  assertPlainObject(value, "overwrite manifest");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "component",
      "target",
      "compatibility",
      "integrity",
      "artifact",
      "buildReceipt",
    ],
    "overwrite manifest",
  );
  assertEqual(value.schemaVersion, 1, "overwrite manifest schemaVersion");
  assertEqual(value.component, OVERWRITE_STAGING_CONTRACT.component, "component");
  assertCanonicalRecord(value.target, {
    platform: target.platform,
    arch: target.arch,
  }, "overwrite manifest target");
  assertCanonicalRecord(
    value.compatibility,
    target.compatibility,
    "overwrite manifest compatibility",
  );

  assertPlainObject(value.integrity, "overwrite manifest integrity");
  assertExactKeys(
    value.integrity,
    ["algorithm", "binaryHashPhase", "signatureKind"],
    "overwrite manifest integrity",
  );
  assertEqual(value.integrity.algorithm, "sha256", "integrity algorithm");
  assertEqual(
    value.integrity.binaryHashPhase,
    target.integrity.binaryHashPhase,
    "binary hash phase",
  );
  if (!target.integrity.allowedSignatureKinds.includes(value.integrity.signatureKind)) {
    throw invalidManifest("The overwrite addon signature kind is not allowed.");
  }

  assertPlainObject(value.artifact, "overwrite manifest artifact");
  assertExactKeys(
    value.artifact,
    [
      "relativePath",
      "byteSize",
      "sha256",
      "format",
      "architecture",
      "minimumOsVersion",
      "hasLoadCommandUuid",
    ],
    "overwrite manifest artifact",
  );
  assertPositiveSafeInteger(value.artifact.byteSize, "artifact byteSize");
  assertSha256(value.artifact.sha256, "artifact hash");
  const expectedLeaf = OVERWRITE_STAGING_CONTRACT.artifactLeafPattern.replace(
    "<sha256>",
    value.artifact.sha256,
  );
  assertEqual(
    value.artifact.relativePath,
    `${target.artifact.relativeDirectory}/${expectedLeaf}`,
    "content-addressed artifact path",
  );
  assertSafeRelativePath(value.artifact.relativePath, "artifact path");
  for (const key of [
    "format",
    "architecture",
    "minimumOsVersion",
  ]) {
    assertEqual(
      value.artifact[key],
      target.artifact[key],
      `artifact ${key}`,
    );
  }
  assertEqual(
    value.artifact.hasLoadCommandUuid,
    target.artifact.requiresLoadCommandUuid,
    "artifact LC_UUID policy",
  );

  assertPlainObject(value.buildReceipt, "overwrite manifest build receipt");
  assertExactKeys(
    value.buildReceipt,
    ["relativePath", "byteSize", "sha256", "artifactHashPhase"],
    "overwrite manifest build receipt",
  );
  assertEqual(
    value.buildReceipt.relativePath,
    OVERWRITE_STAGING_CONTRACT.buildReceiptRelativePath,
    "build receipt path",
  );
  assertPositiveSafeInteger(value.buildReceipt.byteSize, "build receipt byteSize");
  assertSha256(value.buildReceipt.sha256, "build receipt hash");
  assertEqual(
    value.buildReceipt.artifactHashPhase,
    "unsigned_link_output",
    "build receipt artifact hash phase",
  );
  return deepFreeze(value);
}

export function canonicalOverwriteJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function overwriteStagingError(code, message, cause) {
  return stagingError(code, message, cause);
}

function assertCanonicalRecord(actual, expected, label) {
  assertPlainObject(actual, label);
  assertExactKeys(actual, Reflect.ownKeys(expected), label);
  for (const key of Reflect.ownKeys(expected)) {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (Array.isArray(expectedValue)) {
      if (
        !Array.isArray(actualValue) ||
        actualValue.length !== expectedValue.length ||
        actualValue.some((entry, index) => entry !== expectedValue[index])
      ) {
        throw invalidContract(`${label}.${String(key)} does not match.`);
      }
    } else if (isPlainObject(expectedValue)) {
      assertCanonicalRecord(actualValue, expectedValue, `${label}.${String(key)}`);
    } else if (actualValue !== expectedValue) {
      throw invalidContract(`${label}.${String(key)} does not match.`);
    }
  }
}

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidContract(`The ${label} must be a plain object.`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw invalidContract(`The ${label} fields do not match the contract.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw invalidContract(`The ${label} does not match the contract.`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidContract(`The ${label} must be a positive safe integer.`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) {
    throw invalidContract(`The ${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertSafeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw invalidManifest(`The ${label} is not a safe relative path.`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalidContract(message) {
  return stagingError("overwrite_staging_invalid", message);
}

function invalidReceipt(message) {
  return stagingError("overwrite_build_receipt_invalid", message);
}

function invalidManifest(message) {
  return stagingError("overwrite_manifest_invalid", message);
}

function stagingError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}
