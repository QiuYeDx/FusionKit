#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT,
  buildWindowsX64OverwriteAddon,
  createWindowsDryRunCommandDescriptor,
} from "./build-addon-windows-x64.mjs";

const SOURCE_RELATIVE_PATH =
  OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.sourceRelativePath;
const TEST_FAULT_DEFINITION = "-DFUSIONKIT_OVERWRITE_TEST_FAULTS=1";
const DEFAULT_OUTPUT_PATH = path.join(
  os.tmpdir(),
  "fusionkit-local-subtitle-overwrite-test-napi-v8-win32-x64.node",
);

export const OVERWRITE_NATIVE_WINDOWS_TEST_BUILD_CONTRACT = deepFreeze({
  ...OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT,
  defaultOutputPath: DEFAULT_OUTPUT_PATH,
  testOnly: true,
  faultInjection: {
    compileDefinition: "FUSIONKIT_OVERWRITE_TEST_FAULTS=1",
    crashExitCode: 86,
  },
});

export function createWindowsTestDryRunCommandDescriptor(options = {}) {
  const production = createWindowsDryRunCommandDescriptor(options);
  return deepFreeze({
    contract: OVERWRITE_NATIVE_WINDOWS_TEST_BUILD_CONTRACT,
    commands: production.commands.map((entry) => ({
      ...entry,
      args: injectFaultDefinition(entry.args),
    })),
    paths: production.paths,
  });
}

export function parseWindowsTestBuildArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      output: { type: "string" },
      "toolchain-root": { type: "string" },
      "node-headers": { type: "string" },
      "node-lib": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    outputPath: normalizeAbsoluteAddonPath(
      values.output ?? DEFAULT_OUTPUT_PATH,
    ),
    toolchainRoot: values["toolchain-root"],
    nodeHeadersPath: values["node-headers"],
    nodeLibPath: values["node-lib"],
    dryRun: values["dry-run"],
  };
}

export async function buildTestWindowsX64OverwriteAddon(options = {}) {
  const receipt = await buildWindowsX64OverwriteAddon({
    ...options,
    outputPath: normalizeAbsoluteAddonPath(
      options.outputPath ?? DEFAULT_OUTPUT_PATH,
    ),
    commandRunner: createTestCommandRunner(
      options.commandRunner ?? runCommand,
    ),
  });
  return deepFreeze({
    ...receipt,
    testOnly: true,
    testFaultInjection: true,
    build: {
      ...receipt.build,
      recipe:
        "scripts/local-subtitle/overwrite-native/build-test-addon-windows-x64.mjs",
      compileDefinitions: [
        OVERWRITE_NATIVE_WINDOWS_TEST_BUILD_CONTRACT.faultInjection
          .compileDefinition,
      ],
    },
    artifact: {
      ...receipt.artifact,
      logicalFileName: "local-subtitle-overwrite-test.node",
    },
    productionGateChanged: false,
  });
}

function createTestCommandRunner(commandRunner) {
  return (command, args, options) =>
    commandRunner(command, injectFaultDefinition(args), options);
}

function injectFaultDefinition(args) {
  const sourceIndex = args.indexOf(SOURCE_RELATIVE_PATH);
  if (sourceIndex < 0 || args.includes(TEST_FAULT_DEFINITION)) {
    throw buildError(
      "production_contract_mismatch",
      "The production compile command cannot be converted to a test build.",
    );
  }
  const result = [...args];
  result.splice(sourceIndex, 0, TEST_FAULT_DEFINITION);
  return result;
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    errorCode: result.error?.code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function normalizeAbsoluteAddonPath(value) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.extname(value).toLowerCase() !== ".node"
  ) {
    throw buildError(
      "invalid_arguments",
      "output must be an absolute .node path.",
    );
  }
  return path.normalize(value);
}

function buildError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseWindowsTestBuildArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node build-test-addon-windows-x64.mjs " +
        "--toolchain-root <absolute-path> --node-headers <absolute-path> " +
        "--node-lib <absolute-path> [--output <absolute.node>] [--dry-run]\n",
    );
    return;
  }
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        createWindowsTestDryRunCommandDescriptor(options),
        null,
        2,
      )}\n`,
    );
    return;
  }
  const receipt = await buildTestWindowsX64OverwriteAddon(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `overwrite_native_windows_test_build_failed:${error?.code ?? "unknown"}\n`,
    );
    process.exitCode = 1;
  });
}
