#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  OVERWRITE_NATIVE_BUILD_CONTRACT,
  buildMacosArm64OverwriteAddon,
  createDryRunCommandDescriptor,
} from "./build-addon-macos-arm64.mjs";

const SOURCE_RELATIVE_PATH = OVERWRITE_NATIVE_BUILD_CONTRACT.sourceRelativePath;
const DEFAULT_OUTPUT_PATH =
  "/tmp/fusionkit-local-subtitle-overwrite-test-napi-v8-darwin-arm64.node";
const TEST_FAULT_DEFINITION = "-DFUSIONKIT_OVERWRITE_TEST_FAULTS=1";

export const OVERWRITE_NATIVE_TEST_BUILD_CONTRACT = deepFreeze({
  ...OVERWRITE_NATIVE_BUILD_CONTRACT,
  workPackage: "FS-TXN-001F",
  defaultOutputPath: DEFAULT_OUTPUT_PATH,
  testOnly: true,
  faultInjection: {
    compileDefinition: "FUSIONKIT_OVERWRITE_TEST_FAULTS=1",
    crashExitCode: 86,
  },
});

export function createTestDryRunCommandDescriptor(options = {}) {
  const production = createDryRunCommandDescriptor(options);
  const commands = production.commands.map((entry, index) => {
    if (index !== production.commands.length - 1) return entry;
    return { ...entry, args: injectTestFaultDefinition(entry.args) };
  });
  return deepFreeze({
    contract: OVERWRITE_NATIVE_TEST_BUILD_CONTRACT,
    commands,
    paths: production.paths,
  });
}

export function parseTestBuildArguments(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length > 0) {
    throw testBuildError(
      "invalid_arguments",
      "Positional arguments are not supported.",
    );
  }
  if (values.help) return { help: true };
  return {
    outputPath: normalizeAbsoluteAddonPath(values.output ?? DEFAULT_OUTPUT_PATH),
    dryRun: values["dry-run"],
  };
}

export async function buildTestMacosArm64OverwriteAddon(options = {}) {
  const productionReceipt = await buildMacosArm64OverwriteAddon({
    outputPath: normalizeAbsoluteAddonPath(
      options.outputPath ?? DEFAULT_OUTPUT_PATH,
    ),
    platform: options.platform,
    arch: options.arch,
    commandRunner: createTestCommandRunner(
      options.commandRunner ?? runShellFreeCommand,
    ),
  });
  return deepFreeze({
    ...productionReceipt,
    workPackage: OVERWRITE_NATIVE_TEST_BUILD_CONTRACT.workPackage,
    testOnly: true,
    testFaultInjection: true,
    build: {
      ...productionReceipt.build,
      recipe:
        "scripts/local-subtitle/overwrite-native/build-test-addon-macos-arm64.mjs",
      compileDefinitions: [
        OVERWRITE_NATIVE_TEST_BUILD_CONTRACT.faultInjection.compileDefinition,
      ],
    },
    artifact: {
      ...productionReceipt.artifact,
      logicalFileName: "local-subtitle-overwrite-test.node",
    },
    productionGateChanged: false,
  });
}

function createTestCommandRunner(commandRunner) {
  return (command, args, options) => {
    const compileArgs = args.includes(SOURCE_RELATIVE_PATH)
      ? injectTestFaultDefinition(args)
      : args;
    return commandRunner(command, compileArgs, options);
  };
}

function injectTestFaultDefinition(args) {
  const sourceIndex = args.indexOf(SOURCE_RELATIVE_PATH);
  if (sourceIndex < 0) {
    throw testBuildError(
      "production_contract_mismatch",
      "The production compile command does not contain the pinned source.",
    );
  }
  if (args.includes(TEST_FAULT_DEFINITION)) {
    throw testBuildError(
      "production_contract_mismatch",
      "The production compile command already enables test fault injection.",
    );
  }
  const result = [...args];
  result.splice(sourceIndex, 0, TEST_FAULT_DEFINITION);
  return result;
}

function runShellFreeCommand(command, args, options) {
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
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    !path.basename(value).endsWith(".node")
  ) {
    throw testBuildError(
      "invalid_arguments",
      "output must be an absolute .node path without NUL bytes.",
    );
  }
  return path.normalize(value);
}

function testBuildError(code, message, cause) {
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
  const options = parseTestBuildArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node build-test-addon-macos-arm64.mjs " +
        "[--output </absolute/path/test-addon.node>] [--dry-run]\n",
    );
    return;
  }
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        createTestDryRunCommandDescriptor({
          outputLeaf: path.basename(options.outputPath),
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  const receipt = await buildTestMacosArm64OverwriteAddon(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `overwrite_native_test_build_failed:${error?.code ?? "unknown"}\n`,
    );
    process.exitCode = 1;
  });
}
