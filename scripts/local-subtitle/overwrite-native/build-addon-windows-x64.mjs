#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectNativeBinaryFile } from "../runtime/runtime-manifest.mjs";
import {
  parseNodeHeaderVersion,
  publishNoClobber,
} from "./build-addon-macos-arm64.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");
const SOURCE_RELATIVE_PATH =
  "native/local-subtitle-overwrite/src/addon-win32.cc";
const DELAY_LOAD_HOOK_RELATIVE_PATH =
  "native/local-subtitle-overwrite/src/win-delay-load-hook.cc";
const LOGICAL_ARTIFACT_NAME = "local-subtitle-overwrite.node";
const DEFAULT_OUTPUT_PATH = path.join(
  os.tmpdir(),
  "fusionkit-local-subtitle-overwrite-napi-v8-win32-x64.node",
);
const COMPILER_LEAF = "x86_64-w64-mingw32-clang++.exe";
const INSPECTOR_LEAF = "llvm-readobj.exe";
const DELAYED_HOST_BINARY = "node.exe";

export const OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT = deepFreeze({
  schemaVersion: 1,
  workPackage: "FS-TXN-001F",
  component: "local-subtitle-overwrite",
  target: { platform: "win32", arch: "x64" },
  napiVersion: 8,
  nativeProtocolVersion: 4,
  journalVersion: 3,
  cxxStandard: "c++17",
  minimumWindowsVersion: "10.0",
  sourceRelativePath: SOURCE_RELATIVE_PATH,
  delayLoadHookRelativePath: DELAY_LOAD_HOOK_RELATIVE_PATH,
  hostBinding: {
    delayedBinary: DELAYED_HOST_BINARY,
    resolution: "current-process-image",
  },
  defaultOutputPath: DEFAULT_OUTPUT_PATH,
});

const FIXED_COMPILE_FLAGS = Object.freeze([
  "-std=c++17",
  "-O2",
  "-DNDEBUG",
  `-DNAPI_VERSION=${OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.napiVersion}`,
  "-DNODE_GYP_MODULE_NAME=local_subtitle_overwrite",
  "-DUNICODE",
  "-D_UNICODE",
  "-D_WIN32_WINNT=0x0A00",
  "-DWIN32_LEAN_AND_MEAN",
  "-DNOMINMAX",
  `-DHOST_BINARY=\"${DELAYED_HOST_BINARY}\"`,
  "-fvisibility=hidden",
  "-Wall",
  "-Wextra",
  "-Wpedantic",
  "-Werror",
  "-shared",
  "-static",
  "-static-libgcc",
  "-static-libstdc++",
]);

export function createWindowsDryRunCommandDescriptor(options = {}) {
  assertSupportedHost(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  return deepFreeze({
    contract: OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT,
    commands: [
      commandDescriptor(
        `<toolchain-root>/bin/${COMPILER_LEAF}`,
        createCompileArguments({
          headersPath: "<current-node-headers>",
          nodeLibPath: "<current-node-win-x64-node.lib>",
          outputPath: `<temporary-output>/${LOGICAL_ARTIFACT_NAME}`,
        }),
      ),
      commandDescriptor(
        `<toolchain-root>/bin/${INSPECTOR_LEAF}`,
        [
          "--coff-imports",
          `<temporary-output>/${LOGICAL_ARTIFACT_NAME}`,
        ],
      ),
    ],
    paths: {
      source: SOURCE_RELATIVE_PATH,
      toolchainRoot: "<explicit-portable-llvm-mingw-root>",
      nodeHeaders: "<explicit-current-node-headers>",
      nodeImportLibrary: "<explicit-current-node-win-x64-node.lib>",
      delayLoadHook: DELAY_LOAD_HOOK_RELATIVE_PATH,
      output: `<explicit-output-directory>/${path.basename(
        options.outputPath ?? DEFAULT_OUTPUT_PATH,
      )}`,
    },
  });
}

export function parseWindowsBuildArguments(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string" },
      receipt: { type: "string" },
      "toolchain-root": { type: "string" },
      "node-headers": { type: "string" },
      "node-lib": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length > 0) {
    throw buildError(
      "invalid_arguments",
      "Positional arguments are not supported.",
    );
  }
  if (values.help) return { help: true };
  return {
    outputPath: normalizeAbsoluteFile(
      values.output ?? DEFAULT_OUTPUT_PATH,
      "output",
      ".node",
    ),
    receiptPath: values.receipt === undefined
      ? undefined
      : normalizeAbsoluteFile(values.receipt, "receipt", ".json"),
    toolchainRoot: normalizeAbsoluteDirectory(
      values["toolchain-root"] ??
        process.env.FUSIONKIT_LLVM_MINGW_ROOT,
      "toolchain-root",
    ),
    nodeHeadersPath: normalizeAbsoluteDirectory(
      values["node-headers"] ?? process.env.FUSIONKIT_NODE_HEADERS_DIR,
      "node-headers",
    ),
    nodeLibPath: normalizeAbsoluteFile(
      values["node-lib"] ?? process.env.FUSIONKIT_NODE_LIB_PATH,
      "node-lib",
      ".lib",
    ),
    dryRun: values["dry-run"],
  };
}

export async function buildWindowsX64OverwriteAddon(options = {}) {
  assertSupportedHost(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const outputPath = normalizeAbsoluteFile(
    options.outputPath ?? DEFAULT_OUTPUT_PATH,
    "outputPath",
    ".node",
  );
  const receiptPath = options.receiptPath === undefined
    ? undefined
    : normalizeAbsoluteFile(options.receiptPath, "receiptPath", ".json");
  if (receiptPath === outputPath) {
    throw buildError(
      "invalid_arguments",
      "The receipt and addon paths must differ.",
    );
  }
  const toolchainRoot = await realDirectory(
    normalizeAbsoluteDirectory(
      options.toolchainRoot ?? process.env.FUSIONKIT_LLVM_MINGW_ROOT,
      "toolchainRoot",
    ),
    "toolchain_unavailable",
  );
  const compilerPath = path.join(toolchainRoot, "bin", COMPILER_LEAF);
  const inspectorPath = path.join(toolchainRoot, "bin", INSPECTOR_LEAF);
  const headersPath = await realDirectory(
    normalizeAbsoluteDirectory(
      options.nodeHeadersPath ?? process.env.FUSIONKIT_NODE_HEADERS_DIR,
      "nodeHeadersPath",
    ),
    "node_headers_unavailable",
  );
  const nodeLibPath = await realFile(
    normalizeAbsoluteFile(
      options.nodeLibPath ?? process.env.FUSIONKIT_NODE_LIB_PATH,
      "nodeLibPath",
      ".lib",
    ),
    "node_import_library_unavailable",
  );
  await Promise.all([
    access(compilerPath, fsConstants.X_OK),
    access(inspectorPath, fsConstants.X_OK),
    assertRegularSource(path.join(PROJECT_ROOT, SOURCE_RELATIVE_PATH)),
    assertRegularSource(
      path.join(PROJECT_ROOT, DELAY_LOAD_HOOK_RELATIVE_PATH),
    ),
    access(path.join(headersPath, "node_api.h"), fsConstants.R_OK),
    access(path.join(headersPath, "node_version.h"), fsConstants.R_OK),
  ]);
  const nodeVersion = parseNodeHeaderVersion(
    await readFile(path.join(headersPath, "node_version.h"), "utf8"),
  );
  if (nodeVersion !== process.versions.node) {
    throw buildError(
      "node_headers_mismatch",
      "The Node headers do not match the running Node version.",
    );
  }
  const outputDirectory = await prepareOutputDirectory(path.dirname(outputPath));
  await assertMissing(outputPath, "output_exists");
  if (receiptPath) {
    await prepareOutputDirectory(path.dirname(receiptPath));
    await assertMissing(receiptPath, "receipt_exists");
  }

  const workRoot = await mkdtemp(
    path.join(outputDirectory, ".fusionkit-overwrite-win-build-"),
  );
  let receiptWorkRoot;
  try {
    const temporaryOutput = path.join(workRoot, LOGICAL_ARTIFACT_NAME);
    const commandRunner = options.commandRunner ?? runCommand;
    const compile = commandRunner(
      compilerPath,
      createCompileArguments({
        headersPath,
        nodeLibPath,
        outputPath: temporaryOutput,
      }),
      {
        cwd: PROJECT_ROOT,
        env: buildEnvironment(toolchainRoot),
        timeoutMs: 120_000,
      },
    );
    assertCommandSuccess(compile);
    const imports = commandRunner(
      inspectorPath,
      ["--coff-imports", temporaryOutput],
      {
        cwd: PROJECT_ROOT,
        env: buildEnvironment(toolchainRoot),
        timeoutMs: 30_000,
      },
    );
    assertCommandSuccess(imports);
    assertDelayLoadedHostImport(imports.stdout);
    const inspection = await inspectNativeBinaryFile(temporaryOutput);
    if (
      inspection.format !== "pe" ||
      inspection.architectures.length !== 1 ||
      inspection.architectures[0] !== "x64"
    ) {
      throw buildError(
        "artifact_contract_mismatch",
        "The addon is not a Windows x64 PE artifact.",
      );
    }
    const bytes = await readFile(temporaryOutput);
    assertNoPrivateBuildPath(bytes);
    const nodeLibBytes = await readFile(nodeLibPath);
    const delayLoadHookBytes = await readFile(
      path.join(PROJECT_ROOT, DELAY_LOAD_HOOK_RELATIVE_PATH),
    );
    const receipt = deepFreeze({
      schemaVersion: 1,
      workPackage: OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.workPackage,
      component: OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.component,
      target: OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.target,
      build: {
        recipe:
          "scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs",
        source: SOURCE_RELATIVE_PATH,
        delayLoadHook: DELAY_LOAD_HOOK_RELATIVE_PATH,
        nodeVersion,
        napiVersion: OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.napiVersion,
        nativeProtocolVersion:
          OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.nativeProtocolVersion,
        journalVersion:
          OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.journalVersion,
        cxxStandard: OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.cxxStandard,
        minimumWindowsVersion:
          OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.minimumWindowsVersion,
        compiler: "portable llvm-mingw clang++",
        shell: false,
        nodeImportMode: "delay-load-current-host",
        delayedHostBinary: DELAYED_HOST_BINARY,
        nodeImportLibrarySha256: createHash("sha256")
          .update(nodeLibBytes)
          .digest("hex"),
        delayLoadHookSha256: createHash("sha256")
          .update(delayLoadHookBytes)
          .digest("hex"),
      },
      artifact: {
        logicalFileName: LOGICAL_ARTIFACT_NAME,
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        format: inspection.format,
        architecture: inspection.architectures[0],
      },
      privacy: {
        absolutePathsRecorded: false,
        usernameRecorded: false,
        sourceContentRecorded: false,
      },
    });

    let temporaryReceipt;
    if (receiptPath) {
      receiptWorkRoot = await mkdtemp(
        path.join(path.dirname(receiptPath), ".fusionkit-overwrite-win-receipt-"),
      );
      temporaryReceipt = path.join(receiptWorkRoot, "build-receipt.json");
      await writeFile(
        temporaryReceipt,
        `${JSON.stringify(receipt, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    const published = await publishNoClobber(temporaryOutput, outputPath);
    if (receiptPath && temporaryReceipt) {
      try {
        await publishNoClobber(temporaryReceipt, receiptPath);
      } catch (error) {
        await rollbackPublishedFile(outputPath, published);
        throw buildError(
          "receipt_write_failed",
          "The build receipt could not be published.",
          error,
        );
      }
    }
    return receipt;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    if (receiptWorkRoot) {
      await rm(receiptWorkRoot, { recursive: true, force: true });
    }
  }
}

function createCompileArguments({ headersPath, nodeLibPath, outputPath }) {
  return [
    ...FIXED_COMPILE_FLAGS,
    "-I",
    headersPath,
    SOURCE_RELATIVE_PATH,
    DELAY_LOAD_HOOK_RELATIVE_PATH,
    nodeLibPath,
    `-Wl,--delayload,${DELAYED_HOST_BINARY}`,
    "-ldelayimp",
    "-o",
    outputPath,
  ];
}

function assertDelayLoadedHostImport(output) {
  if (
    typeof output !== "string" ||
    !/DelayImport\s*\{\s*Name:\s*node\.exe\b/iu.test(output) ||
    /(?:^|\n)Import\s*\{\s*Name:\s*node\.exe\b/iu.test(output)
  ) {
    throw buildError(
      "artifact_contract_mismatch",
      "The addon must delay-load Node APIs from the current host executable.",
    );
  }
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

function assertCommandSuccess(result) {
  if (
    !result ||
    result.exitCode !== 0 ||
    result.errorCode !== undefined ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw buildError(
      "compile_failed",
      "The shell-free Windows native build command failed.",
      result,
    );
  }
}

function buildEnvironment(toolchainRoot) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: [
      path.join(toolchainRoot, "bin"),
      path.join(systemRoot, "System32"),
      systemRoot,
    ].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    SOURCE_DATE_EPOCH: "0",
  };
}

function commandDescriptor(command, args) {
  return {
    command,
    args,
    options: {
      cwd: "<project-root>",
      environment: "minimal-native-build",
      shell: false,
    },
  };
}

function assertSupportedHost(platform, arch) {
  if (platform !== "win32") {
    throw buildError(
      "unsupported_platform",
      "The Windows overwrite addon build requires Windows.",
    );
  }
  if (arch !== "x64") {
    throw buildError(
      "unsupported_architecture",
      "The Windows overwrite addon build requires x64.",
    );
  }
}

function normalizeAbsoluteFile(value, label, extension) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    !path.basename(value).toLowerCase().endsWith(extension)
  ) {
    throw buildError(
      "invalid_arguments",
      `${label} must be an absolute ${extension} path.`,
    );
  }
  return path.normalize(value);
}

function normalizeAbsoluteDirectory(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw buildError(
      "invalid_arguments",
      `${label} must be an absolute directory path.`,
    );
  }
  return path.normalize(value);
}

async function realDirectory(value, code) {
  try {
    const canonical = await realpath(value);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch (error) {
    throw buildError(code, "A required native build directory is unavailable.", error);
  }
}

async function realFile(value, code) {
  try {
    const canonical = await realpath(value);
    const proof = await lstat(canonical);
    if (!proof.isFile() || proof.isSymbolicLink()) throw new Error();
    return canonical;
  } catch (error) {
    throw buildError(code, "A required native build file is unavailable.", error);
  }
}

async function assertRegularSource(filePath) {
  const proof = await lstat(filePath);
  if (!proof.isFile() || proof.isSymbolicLink()) {
    throw buildError(
      "source_unavailable",
      "The pinned Windows addon source is unavailable.",
    );
  }
}

async function prepareOutputDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  return realDirectory(directoryPath, "invalid_arguments");
}

async function assertMissing(filePath, code) {
  try {
    await lstat(filePath);
    throw buildError(code, "The requested build output already exists.");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function assertNoPrivateBuildPath(bytes) {
  for (const marker of [
    Buffer.from("C:\\Users\\", "utf8"),
    Buffer.from("C:/Users/", "utf8"),
    Buffer.from("\\\\Users\\\\", "utf16le"),
  ]) {
    if (bytes.includes(marker)) {
      throw buildError(
        "private_path_embedded",
        "The addon contains a private build-host path.",
      );
    }
  }
}

async function rollbackPublishedFile(filePath, expected) {
  try {
    const proof = await lstat(filePath);
    if (
      !proof.isFile() ||
      proof.dev !== expected.dev ||
      proof.ino !== expected.ino ||
      proof.birthtimeMs !== expected.birthtimeMs
    ) {
      throw buildError(
        "receipt_publish_cleanup_failed",
        "The published addon identity changed before cleanup.",
      );
    }
    await unlink(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
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
  const options = parseWindowsBuildArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node build-addon-windows-x64.mjs " +
        "--toolchain-root <absolute-path> --node-headers <absolute-path> " +
        "--node-lib <absolute-path> [--output <absolute.node>] " +
        "[--receipt <absolute.json>] [--dry-run]\n",
    );
    return;
  }
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(createWindowsDryRunCommandDescriptor(options), null, 2)}\n`,
    );
    return;
  }
  const receipt = await buildWindowsX64OverwriteAddon(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `overwrite_native_windows_build_failed:${error?.code ?? "unknown"}\n`,
    );
    process.exitCode = 1;
  });
}
