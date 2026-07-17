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
  config.mac = {
    ...(config.mac ?? {}),
    artifactName: "${productName}_${version}_${arch}.${ext}",
    target: [{ target: "dir", arch: ["arm64"] }],
    identity: "-",
    signIgnore: [
      ...normalizeStrings(config.mac?.signIgnore),
      PRE005_SIGN_IGNORE,
    ],
  };
  config.win = {
    ...(config.win ?? {}),
    artifactName: "${productName}_${version}_${arch}.${ext}",
  };
  return config;
}

export async function generateElectronBuilderSpike(options) {
  const baseConfigPath = path.resolve(
    requirePath(options.baseConfigPath, "baseConfigPath"),
  );
  const outputPath = path.resolve(requirePath(options.outputPath, "outputPath"));
  const runtimeRoot = path.resolve(requirePath(options.runtimeRoot, "runtimeRoot"));
  await verifyRuntimeBundle({
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
    scope: "all",
    launch: true,
  });
  const baseConfig = JSON.parse(await readFile(baseConfigPath, "utf8"));
  const config = createElectronBuilderSpikeConfig(baseConfig, {
    runtimeRoot,
    releaseOutput: options.releaseOutput,
  });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    schemaVersion: 1,
    target: { platform: "darwin", arch: "arm64" },
    runtimeVerifiedBeforeBuilder: true,
    extraResourcesDestination: "local-subtitle",
    artifactNameIncludesArch: true,
    nestedRuntimeSignIgnoreConfigured: true,
    beforePackRuntimeGateConfigured: true,
    outerAppSignatureRequired: true,
    outputContainsMachinePath: true,
    outputMustRemainGitIgnored: true,
  };
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
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node generate-electron-builder-spike.mjs --runtime <local-subtitle> " +
        "--output <ignored-config.json> --release <ignored-output-directory> " +
        "[--base electron-builder.json]\n",
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
