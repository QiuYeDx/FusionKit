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
  assertBuilderArtifactNamePattern(
    builderConfig,
    LOCAL_SUBTITLE_STAGING_CONTRACT.artifactNamePattern,
  );

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = getLocalSubtitleStagingTarget(platform, arch);
  const runtimeRoot = resolveDevelopmentRuntimeRoot(projectRoot);
  await assertCanonicalDevelopmentRuntimePath(projectRoot, runtimeRoot);
  const verify = options.verifyRuntimeBundleImpl ?? verifyRuntimeBundle;
  const verification = await verify({
    runtimeRoot,
    platform,
    arch,
    scope: "all",
    launch: false,
  });
  if (verification?.ready !== true) {
    throw invalidStaging("The canonical runtime staging root is not ready.");
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
    verificationScope: "point_in_time_static",
    launchPerformed: false,
    runtimeVerified: true,
    verification,
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
