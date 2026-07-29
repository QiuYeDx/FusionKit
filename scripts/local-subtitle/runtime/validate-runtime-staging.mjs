#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRuntimeBundle } from "./runtime-manifest.mjs";
import {
  LOCAL_SUBTITLE_STAGING_CONTRACT,
  getLocalSubtitleStagingTarget,
  resolveDevelopmentRuntimeRoot,
} from "./staging-contract.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "../../..");
export const LOCAL_SUBTITLE_BUILDER_EXTRA_RESOURCE = Object.freeze({
  from: "build/local-subtitle-resources/local-subtitle",
  to: "local-subtitle",
  filter: Object.freeze(["**/*"]),
});
export const LOCAL_SUBTITLE_BUILDER_BEFORE_PACK =
  "scripts/local-subtitle/runtime/electron-builder-local-subtitle-before-pack.cjs";
export const LOCAL_SUBTITLE_BUILDER_MAC_SIGN_IGNORE =
  "Contents/Resources/local-subtitle/";

export async function validateRuntimeStaging(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const electronBuilderConfigPath = path.resolve(
    options.electronBuilderConfigPath ??
      path.join(projectRoot, "electron-builder.json"),
  );
  const builderConfig = await readJsonFile(
    electronBuilderConfigPath,
    "electron-builder config",
  );
  assertBuilderConsumptionContract(
    builderConfig,
    LOCAL_SUBTITLE_STAGING_CONTRACT.artifactNamePattern,
  );

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = getLocalSubtitleStagingTarget(platform, arch);
  const runtimeRoot = resolveDevelopmentRuntimeRoot(projectRoot);
  await assertCanonicalDevelopmentRuntimePath(projectRoot, runtimeRoot);
  const verify = options.verifyRuntimeBundleImpl ?? verifyRuntimeBundle;
  const runtimeVerification = await verify({
    runtimeRoot,
    platform,
    arch,
    scope: "all",
    launch: false,
  });
  if (runtimeVerification?.ready !== true) {
    throw invalidStaging("The canonical runtime staging root is not ready.");
  }
  const verifyOverwrite = options.verifyOverwriteNativeAddonImpl ??
    await loadOverwriteNativeVerifier();
  const overwriteVerification = await verifyOverwrite({
    root: runtimeRoot,
    platform,
    arch,
    ...(options.overwriteSignatureVerifier === undefined
      ? {}
      : { signatureVerifier: options.overwriteSignatureVerifier }),
  });
  if (overwriteVerification?.ready !== true) {
    throw invalidStaging("The staged overwrite native addon is not ready.");
  }

  return {
    schemaVersion: 1,
    target: { id: target.id, platform, arch },
    developmentRuntimeRoot:
      LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot,
    runtimeManifestRelativePath:
      LOCAL_SUBTITLE_STAGING_CONTRACT.runtimeManifestRelativePath,
    artifactNamePattern:
      LOCAL_SUBTITLE_STAGING_CONTRACT.artifactNamePattern,
    verificationScope: "point_in_time_static_plus_addon_module_probe",
    officialRuntimeLaunchPerformed: false,
    overwriteAddonModuleProbePerformed: true,
    runtimeVerified: true,
    overwriteNativeVerified: true,
    verification: runtimeVerification,
    overwriteVerification,
  };
}

export async function assertCanonicalDevelopmentRuntimePath(
  projectRoot,
  runtimeRoot = resolveDevelopmentRuntimeRoot(projectRoot),
) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const relative = path.relative(resolvedProjectRoot, resolvedRuntimeRoot);
  const relativePosix = relative.split(path.sep).join("/");
  if (
    relativePosix !== LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot ||
    path.isAbsolute(relative)
  ) {
    throw invalidStaging("The canonical runtime staging path does not match its contract.");
  }

  let current = resolvedProjectRoot;
  for (const segment of [
    "",
    ...LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot.split("/"),
  ]) {
    if (segment !== "") current = path.join(current, segment);
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch {
      throw invalidStaging("The canonical runtime staging path is missing.");
    }
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw invalidStaging(
        "The canonical runtime staging path contains a symbolic directory.",
      );
    }
  }
  return resolvedRuntimeRoot;
}

export function assertBuilderArtifactNamePattern(config, expectedPattern) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw invalidStaging("The electron-builder config must be an object.");
  }
  for (const platformKey of ["mac", "win"]) {
    const platformConfig = config[platformKey];
    if (
      platformConfig === null ||
      typeof platformConfig !== "object" ||
      Array.isArray(platformConfig) ||
      platformConfig.artifactName !== expectedPattern
    ) {
      throw invalidStaging(
        `electron-builder ${platformKey}.artifactName does not match the staging contract.`,
      );
    }
  }
  return true;
}

export function assertBuilderConsumptionContract(config, expectedPattern) {
  assertBuilderArtifactNamePattern(config, expectedPattern);
  if (
    config.beforePack !== LOCAL_SUBTITLE_BUILDER_BEFORE_PACK ||
    !Array.isArray(config.extraResources) ||
    config.extraResources.length !== 1 ||
    !isExactExtraResource(config.extraResources[0])
  ) {
    throw invalidStaging(
      "The electron-builder local-subtitle resource mapping is invalid.",
    );
  }
  if (
    !isExactTargetMatrix(config.mac?.target, ["dmg", "zip"], "arm64") ||
    !isExactTargetMatrix(config.win?.target, ["nsis"], "x64") ||
    !Array.isArray(config.mac?.signIgnore) ||
    config.mac.signIgnore.length !== 1 ||
    config.mac.signIgnore[0] !== LOCAL_SUBTITLE_BUILDER_MAC_SIGN_IGNORE
  ) {
    throw invalidStaging("The electron-builder target contract is invalid.");
  }
  return true;
}

function isExactExtraResource(input) {
  return isExactObject(input, ["from", "to", "filter"]) &&
    input.from === LOCAL_SUBTITLE_BUILDER_EXTRA_RESOURCE.from &&
    input.to === LOCAL_SUBTITLE_BUILDER_EXTRA_RESOURCE.to &&
    Array.isArray(input.filter) &&
    input.filter.length === 1 &&
    input.filter[0] === LOCAL_SUBTITLE_BUILDER_EXTRA_RESOURCE.filter[0];
}

function isExactTargetMatrix(input, expectedTargets, expectedArch) {
  if (!Array.isArray(input) || input.length !== expectedTargets.length) return false;
  return input.every((entry, index) =>
    isExactObject(entry, ["target", "arch"]) &&
    entry.target === expectedTargets[index] &&
    Array.isArray(entry.arch) &&
    entry.arch.length === 1 &&
    entry.arch[0] === expectedArch
  );
}

function isExactObject(input, expectedKeys) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const keys = Object.keys(input);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key));
}

async function loadOverwriteNativeVerifier() {
  const module = await import(
    "../overwrite-native/overwrite-native-staging.mjs"
  );
  if (typeof module.verifyStagedOverwriteNativeAddon !== "function") {
    throw invalidStaging("The overwrite native staging verifier is unavailable.");
  }
  return module.verifyStagedOverwriteNativeAddon;
}

async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw invalidStaging(`The ${label} is missing or invalid JSON.`);
  }
}

function invalidStaging(message) {
  const error = new Error(message);
  error.code = "runtime_staging_invalid";
  return error;
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "project-root": { type: "string", default: PROJECT_ROOT },
      platform: { type: "string", default: process.platform },
      arch: { type: "string", default: process.arch },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    projectRoot: values["project-root"],
    platform: values.platform,
    arch: values.arch,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node validate-runtime-staging.mjs " +
        "[--project-root <FusionKit>] [--platform darwin|win32] " +
        "[--arch arm64|x64]\n",
    );
    return;
  }
  const report = await validateRuntimeStaging(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `runtime_staging_validation_failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
