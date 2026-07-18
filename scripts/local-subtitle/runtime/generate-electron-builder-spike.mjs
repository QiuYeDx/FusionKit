#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRuntimeBundle } from "./runtime-manifest.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BEFORE_PACK_HOOK = path.join(
  SCRIPT_DIRECTORY,
  "electron-builder-pre005-before-pack.cjs",
);

export const PRE005_SIGN_IGNORE = "Contents/Resources/local-subtitle/";

export function createElectronBuilderSpikeConfig(baseConfig, options) {
  if (!baseConfig || typeof baseConfig !== "object" || Array.isArray(baseConfig)) {
    throw new TypeError("baseConfig must be an object.");
  }
  const runtimeRoot = path.resolve(requirePath(options.runtimeRoot, "runtimeRoot"));
  const releaseOutput = path.resolve(
    requirePath(options.releaseOutput, "releaseOutput"),
  );
  const target = normalizeTarget(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const config = structuredClone(baseConfig);
  config.directories = {
    ...(config.directories ?? {}),
    output: releaseOutput,
  };
  config.extraResources = [
    ...normalizeFileSets(config.extraResources),
    {
      from: runtimeRoot,
      to: "local-subtitle",
      filter: ["**/*"],
    },
  ];
  config.beforePack = BEFORE_PACK_HOOK;
  if (target.platform === "win32") config.forceCodeSigning = false;
  config.mac = target.platform === "darwin"
    ? {
        ...(config.mac ?? {}),
        artifactName: "${productName}_${version}_${arch}.${ext}",
        target: [{ target: "dir", arch: ["arm64"] }],
        identity: "-",
        signIgnore: [
          ...normalizeStrings(config.mac?.signIgnore),
          PRE005_SIGN_IGNORE,
        ],
      }
    : { ...(config.mac ?? {}) };
  config.win = {
    ...(config.win ?? {}),
    artifactName: "${productName}_${version}_${arch}.${ext}",
    ...(target.platform === "win32"
      ? { target: [{ target: "dir", arch: ["x64"] }] }
      : {}),
  };
  return config;
}

export async function generateElectronBuilderSpike(options) {
  const baseConfigPath = path.resolve(
    requirePath(options.baseConfigPath, "baseConfigPath"),
  );
  const outputPath = path.resolve(requirePath(options.outputPath, "outputPath"));
  const runtimeRoot = path.resolve(requirePath(options.runtimeRoot, "runtimeRoot"));
  const target = normalizeTarget(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  await verifyRuntimeBundle({
    runtimeRoot,
    platform: target.platform,
    arch: target.arch,
    scope: "all",
    launch: true,
  });
  const baseConfig = JSON.parse(await readFile(baseConfigPath, "utf8"));
  const config = createElectronBuilderSpikeConfig(baseConfig, {
    runtimeRoot,
    releaseOutput: options.releaseOutput,
    platform: target.platform,
    arch: target.arch,
  });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    schemaVersion: 1,
    target,
    runtimeVerifiedBeforeBuilder: true,
    extraResourcesDestination: "local-subtitle",
    artifactNameIncludesArch: true,
    nestedRuntimeSignIgnoreConfigured: target.platform === "darwin",
    nestedRuntimeIntegrityVerifiedBeforeBuilder: true,
    nestedRuntimeAuthenticodeVerifiedBeforeBuilder: false,
    beforePackRuntimeGateConfigured: true,
    outerAppSignatureRequired: target.platform === "darwin",
    distributionProfile: target.platform === "win32"
      ? "unsigned_personal_distribution"
      : "adhoc_packaged_validation",
    outputContainsMachinePath: true,
    outputMustRemainGitIgnored: true,
  };
}

function normalizeTarget(platform, arch) {
  const supported =
    (platform === "darwin" && arch === "arm64") ||
    (platform === "win32" && arch === "x64");
  if (!supported) {
    throw new Error("The PRE-005 builder spike target is unsupported.");
  }
  return { platform, arch };
}

function normalizeFileSets(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStrings(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "electron-builder.json" },
      runtime: { type: "string" },
      output: { type: "string" },
      release: { type: "string" },
      platform: { type: "string", default: process.platform },
      arch: { type: "string", default: process.arch },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    baseConfigPath: values.base,
    runtimeRoot: values.runtime,
    outputPath: values.output,
    releaseOutput: values.release,
    platform: values.platform,
    arch: values.arch,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node generate-electron-builder-spike.mjs --runtime <local-subtitle> " +
        "--output <ignored-config.json> --release <ignored-output-directory> " +
        "[--base electron-builder.json] [--platform darwin|win32] " +
        "[--arch arm64|x64]\n",
    );
    return;
  }
  const report = await generateElectronBuilderSpike(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`builder_spike_generation_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
