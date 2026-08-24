#!/usr/bin/env node

import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyStagedOverwriteNativeAddon } from "../overwrite-native/overwrite-native-staging.mjs";
import { runFaultMatrix } from "./run-pre005-smoke.mjs";
import {
  inspectNativeBinaryFile,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";

const COMMON_FAULT_EXPECTATIONS = Object.freeze({
  manifest_missing: "media_runtime_missing",
  ffmpeg_missing: "media_runtime_missing",
  license_missing: "media_runtime_missing",
  source_offer_missing: "media_runtime_missing",
  ffmpeg_hash_changed: "media_runtime_invalid",
  ffmpeg_wrong_architecture: "media_runtime_invalid",
  ffmpeg_launch_identity_failed: "media_runtime_launch_failed",
  server_missing: "runtime_missing",
});

export function resolvePackagedRuntimeRoot(appPath, platform, arch) {
  const target = normalizeTarget(platform, arch);
  const resolvedAppPath = path.resolve(requirePath(appPath, "appPath"));
  if (target.platform === "darwin") {
    if (!resolvedAppPath.endsWith(".app")) {
      throw packagedError("The macOS packaged application must be an .app directory.");
    }
    return path.join(
      resolvedAppPath,
      "Contents",
      "Resources",
      "local-subtitle",
    );
  }
  return path.join(resolvedAppPath, "resources", "local-subtitle");
}

export function resolvePackagedAppAsarPath(appPath, platform, arch) {
  const target = normalizeTarget(platform, arch);
  const resolvedAppPath = path.resolve(requirePath(appPath, "appPath"));
  return target.platform === "darwin"
    ? path.join(resolvedAppPath, "Contents", "Resources", "app.asar")
    : path.join(resolvedAppPath, "resources", "app.asar");
}

export function resolvePackagedExecutablePath(appPath, platform, arch) {
  const target = normalizeTarget(platform, arch);
  const resolvedAppPath = path.resolve(requirePath(appPath, "appPath"));
  return target.platform === "darwin"
    ? path.join(resolvedAppPath, "Contents", "MacOS", "FusionKit")
    : path.join(resolvedAppPath, "FusionKit.exe");
}

export async function verifyPackagedLocalSubtitle(options, dependencies = {}) {
  const target = normalizeTarget(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const appPath = path.resolve(requirePath(options.appPath, "appPath"));
  const runtimeRoot = resolvePackagedRuntimeRoot(
    appPath,
    target.platform,
    target.arch,
  );
  await assertCanonicalDirectory(appPath, "packaged application");
  await assertCanonicalDirectory(runtimeRoot, "packaged local-subtitle runtime");
  await assertCanonicalRegularFile(
    resolvePackagedAppAsarPath(appPath, target.platform, target.arch),
    "packaged app.asar",
  );
  const executablePath = resolvePackagedExecutablePath(
    appPath,
    target.platform,
    target.arch,
  );
  await assertCanonicalRegularFile(
    executablePath,
    "packaged application executable",
    { executable: target.platform === "darwin" },
  );
  const inspectExecutable = dependencies.inspectNativeBinaryFile ??
    inspectNativeBinaryFile;
  const executableIdentity = await inspectExecutable(executablePath);
  assertExecutableIdentity(executableIdentity, target);

  const verifyRuntime = dependencies.verifyRuntimeBundle ?? verifyRuntimeBundle;
  const runtimeVerification = await verifyRuntime({
    runtimeRoot,
    platform: target.platform,
    arch: target.arch,
    scope: "all",
    launch: true,
  });
  if (
    runtimeVerification?.ready !== true ||
    runtimeVerification.noPathFallback !== true
  ) {
    throw packagedError("The packaged official runtime is not ready.");
  }

  const verifyOverwrite = dependencies.verifyStagedOverwriteNativeAddon ??
    verifyStagedOverwriteNativeAddon;
  const overwriteVerification = await verifyOverwrite({
    root: runtimeRoot,
    platform: target.platform,
    arch: target.arch,
  });
  if (
    overwriteVerification?.ready !== true ||
    overwriteVerification.moduleExportsVerified !== true ||
    overwriteVerification.contentAddressed !== true ||
    overwriteVerification.noPathFallback !== true
  ) {
    throw packagedError("The packaged overwrite native addon is not ready.");
  }

  const runFaults = dependencies.runFaultMatrix ?? runFaultMatrix;
  const faultMatrix = await runFaults(runtimeRoot, target, {
    tempParent: path.resolve(options.faultsTempParent ?? os.tmpdir()),
  });
  assertFaultMatrix(faultMatrix, target);

  return {
    schemaVersion: 1,
    workPackage: target.platform === "darwin" ? "NATIVE-002C" : "NATIVE-002D",
    target,
    status: "packaged_component_passed",
    packagedLayout: target.platform === "darwin"
      ? "Contents/Resources/local-subtitle"
      : "resources/local-subtitle",
    packagedExecutable: {
      format: executableIdentity.format,
      architectures: executableIdentity.architectures,
      executable: true,
    },
    officialRuntime: {
      manifestSha256: runtimeVerification.manifestSha256,
      artifactCount: runtimeVerification.artifactCount,
      launchResults: runtimeVerification.launchResults,
      noPathFallback: runtimeVerification.noPathFallback === true,
    },
    overwriteNative: {
      generation: overwriteVerification.generation,
      artifact: overwriteVerification.artifact,
      moduleExportsVerified:
        overwriteVerification.moduleExportsVerified === true,
      contentAddressed: overwriteVerification.contentAddressed === true,
      noPathFallback: overwriteVerification.noPathFallback === true,
    },
    faultMatrix,
    blocksBeforeEnqueue: true,
    productionGateChanged: false,
    packagedProductE2EClaimed: false,
    releaseReady: false,
    remainingTargetEvidence: target.platform === "darwin"
      ? ["windows_x64_packaged_application_and_installer_closure"]
      : [],
    deferredReleaseEvidence: target.platform === "darwin"
      ? ["developer_id_notarization_and_gatekeeper_acceptance_QA_004"]
      : ["windows_distribution_license_closure_QA_005"],
    privacy: {
      absolutePathsRecorded: false,
      signingIdentityRecorded: false,
    },
  };
}

async function assertCanonicalDirectory(directoryPath, label) {
  let proof;
  let canonical;
  try {
    [proof, canonical] = await Promise.all([
      lstat(directoryPath),
      realpath(directoryPath),
    ]);
  } catch (cause) {
    throw packagedError(`The ${label} is missing.`, cause);
  }
  if (
    !proof.isDirectory() ||
    proof.isSymbolicLink() ||
    !isSameCanonicalPath(canonical, directoryPath)
  ) {
    throw packagedError(`The ${label} must be a canonical directory.`);
  }
}

async function assertCanonicalRegularFile(filePath, label, options = {}) {
  let proof;
  let canonical;
  try {
    [proof, canonical] = await Promise.all([lstat(filePath), realpath(filePath)]);
  } catch (cause) {
    throw packagedError(`The ${label} is missing.`, cause);
  }
  if (
    !proof.isFile() ||
    proof.isSymbolicLink() ||
    !isSameCanonicalPath(canonical, filePath) ||
    (options.executable === true && (proof.mode & 0o111) === 0)
  ) {
    throw packagedError(`The ${label} must be a canonical regular file.`);
  }
}

function isSameCanonicalPath(canonicalPath, requestedPath) {
  const resolved = path.resolve(requestedPath);
  return (
    path.relative(canonicalPath, resolved) === "" &&
    path.relative(resolved, canonicalPath) === ""
  );
}

function assertExecutableIdentity(identity, target) {
  const expectedFormat = target.platform === "darwin" ? "mach-o" : "pe";
  if (
    identity?.format !== expectedFormat ||
    !Array.isArray(identity.architectures) ||
    identity.architectures.length !== 1 ||
    identity.architectures[0] !== target.arch
  ) {
    throw packagedError("The packaged application executable target is invalid.");
  }
}

function assertFaultMatrix(faultMatrix, target) {
  const expectations = {
    ...COMMON_FAULT_EXPECTATIONS,
    ...(target.platform === "darwin"
      ? { ffmpeg_not_executable: "media_runtime_invalid" }
      : { ffmpeg_signature_policy_invalid: "media_runtime_invalid" }),
  };
  if (!Array.isArray(faultMatrix) || faultMatrix.length !== 9) {
    throw packagedError("The packaged runtime fail-closed matrix is incomplete.");
  }
  const observed = new Set();
  for (const entry of faultMatrix) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.fault !== "string" ||
      observed.has(entry.fault) ||
      expectations[entry.fault] !== entry.errorCode ||
      entry.blockedBeforeEnqueue !== true
    ) {
      throw packagedError("The packaged runtime fail-closed matrix did not pass.");
    }
    observed.add(entry.fault);
  }
  if (Object.keys(expectations).some((fault) => !observed.has(fault))) {
    throw packagedError("The packaged runtime fail-closed matrix is incomplete.");
  }
}

function normalizeTarget(platform, arch) {
  const supported =
    (platform === "darwin" && arch === "arm64") ||
    (platform === "win32" && arch === "x64");
  if (!supported) {
    throw packagedError("The packaged local-subtitle target is unsupported.");
  }
  return Object.freeze({ platform, arch });
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw packagedError(`${label} is required.`);
  }
  return value;
}

function packagedError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = "packaged_runtime_invalid";
  return error;
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: "string" },
      platform: { type: "string", default: process.platform },
      arch: { type: "string", default: process.arch },
      "faults-temp-parent": { type: "string", default: os.tmpdir() },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    appPath: values.app,
    platform: values.platform,
    arch: values.arch,
    faultsTempParent: values["faults-temp-parent"],
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node verify-packaged-local-subtitle.mjs --app <application-directory> " +
        "[--platform darwin|win32] [--arch arm64|x64] " +
        "[--faults-temp-parent <directory>]\n",
    );
    return;
  }
  const report = await verifyPackagedLocalSubtitle(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`packaged_runtime_validation_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
