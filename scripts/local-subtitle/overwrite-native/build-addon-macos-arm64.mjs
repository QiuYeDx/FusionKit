#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  link,
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
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectNativeBinaryFile } from "../runtime/runtime-manifest.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");
const SOURCE_RELATIVE_PATH = "native/local-subtitle-overwrite/src/addon.cc";
const DEFAULT_OUTPUT_PATH =
  "/tmp/fusionkit-local-subtitle-overwrite-napi-v8-darwin-arm64.node";
const LOGICAL_ARTIFACT_NAME = "local-subtitle-overwrite.node";
const XCRUN_PATH = "/usr/bin/xcrun";

export const OVERWRITE_NATIVE_BUILD_CONTRACT = deepFreeze({
  schemaVersion: 1,
  workPackage: "FS-TXN-001F",
  component: "local-subtitle-overwrite",
  target: { platform: "darwin", arch: "arm64" },
  napiVersion: 8,
  nativeProtocolVersion: 4,
  journalVersion: 3,
  cxxStandard: "c++17",
  deploymentTarget: "11.0",
  sourceRelativePath: SOURCE_RELATIVE_PATH,
  defaultOutputPath: DEFAULT_OUTPUT_PATH,
});

const FIXED_COMPILE_FLAGS = Object.freeze([
  "-std=c++17",
  "-O2",
  "-DNDEBUG",
  `-DNAPI_VERSION=${OVERWRITE_NATIVE_BUILD_CONTRACT.napiVersion}`,
  "-arch",
  OVERWRITE_NATIVE_BUILD_CONTRACT.target.arch,
  `-mmacosx-version-min=${OVERWRITE_NATIVE_BUILD_CONTRACT.deploymentTarget}`,
  "-fvisibility=hidden",
  "-Wall",
  "-Wextra",
  "-Wpedantic",
  "-Werror",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-Wl,-dead_strip",
]);

export function createDryRunCommandDescriptor(options = {}) {
  assertSupportedHost(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const outputLeaf = normalizeArtifactLeaf(
    options.outputLeaf ?? path.basename(DEFAULT_OUTPUT_PATH),
    "outputLeaf",
    ".node",
  );
  const compileArgs = [
    "--sdk",
    "macosx",
    "clang++",
    ...FIXED_COMPILE_FLAGS,
    "-isysroot",
    "<xcrun:macosx-sdk>",
    "-I",
    "<current-node-headers>",
    SOURCE_RELATIVE_PATH,
    "-o",
    `<temporary-output>/${LOGICAL_ARTIFACT_NAME}`,
  ];
  return deepFreeze({
    contract: OVERWRITE_NATIVE_BUILD_CONTRACT,
    commands: [
      commandDescriptor(XCRUN_PATH, ["--sdk", "macosx", "--find", "clang++"]),
      commandDescriptor(XCRUN_PATH, ["--sdk", "macosx", "--show-sdk-path"]),
      commandDescriptor(XCRUN_PATH, ["--sdk", "macosx", "--show-sdk-version"]),
      commandDescriptor(XCRUN_PATH, compileArgs),
    ],
    paths: {
      source: SOURCE_RELATIVE_PATH,
      nodeHeaders: "<current-node-headers>",
      output: `<explicit-output-directory>/${outputLeaf}`,
    },
  });
}

export function currentNodeHeaderCandidates(execPath = process.execPath) {
  const candidates = [
    path.resolve(path.dirname(execPath), "../include/node"),
  ];
  const prefix = process.config?.variables?.node_prefix;
  if (typeof prefix === "string" && path.isAbsolute(prefix) && prefix !== "/") {
    candidates.push(path.join(prefix, "include/node"));
  }
  return [...new Set(candidates)];
}

export async function locateCurrentNodeHeaders(options = {}) {
  const execPath = await realpath(options.execPath ?? process.execPath);
  const expectedVersion = options.nodeVersion ?? process.versions.node;
  const candidates = options.candidates ?? currentNodeHeaderCandidates(execPath);
  for (const candidate of candidates) {
    try {
      const headersPath = await realpath(candidate);
      const nodeApiPath = path.join(headersPath, "node_api.h");
      const nodeVersionPath = path.join(headersPath, "node_version.h");
      await Promise.all([
        access(nodeApiPath, fsConstants.R_OK),
        access(nodeVersionPath, fsConstants.R_OK),
      ]);
      const headerVersion = parseNodeHeaderVersion(
        await readFile(nodeVersionPath, "utf8"),
      );
      if (headerVersion !== expectedVersion) continue;
      return Object.freeze({ headersPath, nodeVersion: headerVersion });
    } catch {
      // Try only paths derived from the running Node installation.
    }
  }
  throw buildError(
    "node_headers_unavailable",
    "The running Node installation does not expose matching development headers.",
  );
}

export function parseNodeHeaderVersion(headerText) {
  if (typeof headerText !== "string") {
    throw buildError("invalid_node_headers", "The Node version header is invalid.");
  }
  const readPart = (name) => {
    const match = headerText.match(
      new RegExp(`^#define\\s+NODE_${name}_VERSION\\s+(\\d+)\\s*$`, "mu"),
    );
    if (!match) {
      throw buildError("invalid_node_headers", "The Node version header is invalid.");
    }
    return Number(match[1]);
  };
  return `${readPart("MAJOR")}.${readPart("MINOR")}.${readPart("PATCH")}`;
}

export function parseBuildArguments(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string" },
      receipt: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length > 0) {
    throw buildError("invalid_arguments", "Positional arguments are not supported.");
  }
  if (values.help) return { help: true };
  const outputPath = normalizeAbsoluteArtifactPath(
    values.output ?? DEFAULT_OUTPUT_PATH,
    "output",
    ".node",
  );
  const receiptPath = values.receipt === undefined
    ? undefined
    : normalizeAbsoluteArtifactPath(values.receipt, "receipt", ".json");
  if (receiptPath === outputPath) {
    throw buildError("invalid_arguments", "The receipt and addon paths must differ.");
  }
  return {
    outputPath,
    receiptPath,
    dryRun: values["dry-run"],
  };
}

export async function buildMacosArm64OverwriteAddon(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertSupportedHost(platform, arch);

  const sourcePath = path.join(PROJECT_ROOT, SOURCE_RELATIVE_PATH);
  const outputPath = normalizeAbsoluteArtifactPath(
    options.outputPath ?? DEFAULT_OUTPUT_PATH,
    "outputPath",
    ".node",
  );
  const receiptPath = options.receiptPath === undefined
    ? undefined
    : normalizeAbsoluteArtifactPath(options.receiptPath, "receiptPath", ".json");
  if (receiptPath === outputPath) {
    throw buildError("invalid_arguments", "The receipt and addon paths must differ.");
  }

  await assertPinnedRegularFile(sourcePath, "native_source_unavailable");
  const nodeHeaders = await locateCurrentNodeHeaders();
  const toolchain = await discoverMacosToolchain(options.commandRunner);
  const outputDirectory = await prepareArtifactDirectory(path.dirname(outputPath));
  const canonicalOutputPath = path.join(outputDirectory, path.basename(outputPath));
  await assertPathMissing(canonicalOutputPath, "output_exists");
  let canonicalReceiptPath;
  if (receiptPath) {
    const receiptDirectory = await prepareArtifactDirectory(path.dirname(receiptPath));
    canonicalReceiptPath = path.join(receiptDirectory, path.basename(receiptPath));
    await assertPathMissing(canonicalReceiptPath, "receipt_exists");
  }

  const workRoot = await mkdtemp(
    path.join(outputDirectory, ".fusionkit-overwrite-native-build-"),
  );
  const temporaryOutputPath = path.join(workRoot, LOGICAL_ARTIFACT_NAME);
  let receiptWorkRoot;
  try {
    const compileArgs = createCompileArguments({
      sdkPath: toolchain.sdkPath,
      headersPath: nodeHeaders.headersPath,
      outputPath: temporaryOutputPath,
    });
    const compile = (options.commandRunner ?? runCommand)(
      XCRUN_PATH,
      ["--sdk", "macosx", "clang++", ...compileArgs],
      {
        cwd: PROJECT_ROOT,
        env: buildEnvironment(),
        timeoutMs: 120_000,
      },
    );
    assertCommandSuccess(compile, "compile_failed");

    const inspection = await inspectNativeBinaryFile(temporaryOutputPath);
    if (
      inspection.format !== "mach-o" ||
      inspection.architectures.length !== 1 ||
      inspection.architectures[0] !== "arm64" ||
      inspection.minimumOsVersion !== "11.0.0"
    ) {
      throw buildError(
        "artifact_contract_mismatch",
        "The addon is not a thin arm64 Mach-O with a macOS 11.0 minimum.",
      );
    }
    await assertNoPrivateBuildPath(temporaryOutputPath);
    const artifactBytes = await readFile(temporaryOutputPath);
    const receipt = deepFreeze({
      schemaVersion: 1,
      workPackage: OVERWRITE_NATIVE_BUILD_CONTRACT.workPackage,
      component: OVERWRITE_NATIVE_BUILD_CONTRACT.component,
      target: OVERWRITE_NATIVE_BUILD_CONTRACT.target,
      build: {
        recipe:
          "scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs",
        source: SOURCE_RELATIVE_PATH,
        nodeVersion: nodeHeaders.nodeVersion,
        napiVersion: OVERWRITE_NATIVE_BUILD_CONTRACT.napiVersion,
        nativeProtocolVersion:
          OVERWRITE_NATIVE_BUILD_CONTRACT.nativeProtocolVersion,
        journalVersion: OVERWRITE_NATIVE_BUILD_CONTRACT.journalVersion,
        cxxStandard: OVERWRITE_NATIVE_BUILD_CONTRACT.cxxStandard,
        deploymentTarget: OVERWRITE_NATIVE_BUILD_CONTRACT.deploymentTarget,
        sdkVersion: toolchain.sdkVersion,
        compiler: "xcrun clang++",
        shell: false,
      },
      artifact: {
        logicalFileName: LOGICAL_ARTIFACT_NAME,
        byteSize: artifactBytes.byteLength,
        sha256: createHash("sha256").update(artifactBytes).digest("hex"),
        format: inspection.format,
        architecture: inspection.architectures[0],
        minimumMacosVersion: inspection.minimumOsVersion,
      },
      privacy: {
        absolutePathsRecorded: false,
        usernameRecorded: false,
        sourceContentRecorded: false,
      },
    });

    let temporaryReceiptPath;
    if (canonicalReceiptPath) {
      receiptWorkRoot = await mkdtemp(
        path.join(path.dirname(canonicalReceiptPath), ".fusionkit-overwrite-native-receipt-"),
      );
      temporaryReceiptPath = path.join(receiptWorkRoot, "build-receipt.json");
      await writeFile(
        temporaryReceiptPath,
        `${JSON.stringify(receipt, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }

    const publishedAddon = await publishNoClobber(
      temporaryOutputPath,
      canonicalOutputPath,
    );
    if (canonicalReceiptPath && temporaryReceiptPath) {
      try {
        await publishNoClobber(temporaryReceiptPath, canonicalReceiptPath);
      } catch (receiptError) {
        try {
          await rollbackPublishedFile(canonicalOutputPath, publishedAddon);
        } catch (cleanupError) {
          throw buildError(
            "receipt_publish_cleanup_failed",
            "The optional build receipt failed and the published addon could not be rolled back.",
            { receiptError, cleanupError },
          );
        }
        throw buildError(
          "receipt_write_failed",
          "The optional build receipt could not be published.",
          receiptError,
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

export async function discoverMacosToolchain(commandRunner = runCommand) {
  const options = {
    cwd: PROJECT_ROOT,
    env: buildEnvironment(),
    timeoutMs: 15_000,
  };
  const compilerProbe = commandRunner(
    XCRUN_PATH,
    ["--sdk", "macosx", "--find", "clang++"],
    options,
  );
  assertCommandSuccess(compilerProbe, "compiler_unavailable");
  const compilerPath = requireAbsoluteProbePath(
    compilerProbe.stdout,
    "compiler_unavailable",
  );
  const sdkProbe = commandRunner(
    XCRUN_PATH,
    ["--sdk", "macosx", "--show-sdk-path"],
    options,
  );
  assertCommandSuccess(sdkProbe, "sdk_unavailable");
  const sdkPath = requireAbsoluteProbePath(sdkProbe.stdout, "sdk_unavailable");
  const sdkVersionProbe = commandRunner(
    XCRUN_PATH,
    ["--sdk", "macosx", "--show-sdk-version"],
    options,
  );
  assertCommandSuccess(sdkVersionProbe, "sdk_unavailable");
  const sdkVersion = sdkVersionProbe.stdout.trim();
  if (!/^\d+(?:\.\d+){1,2}$/u.test(sdkVersion)) {
    throw buildError("sdk_unavailable", "xcrun returned an invalid macOS SDK version.");
  }
  await Promise.all([
    access(compilerPath, fsConstants.X_OK),
    access(sdkPath, fsConstants.R_OK),
  ]);
  return Object.freeze({ compilerPath, sdkPath, sdkVersion });
}

function createCompileArguments({ sdkPath, headersPath, outputPath }) {
  return [
    ...FIXED_COMPILE_FLAGS,
    "-isysroot",
    sdkPath,
    "-I",
    headersPath,
    SOURCE_RELATIVE_PATH,
    "-o",
    outputPath,
  ];
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

function assertCommandSuccess(result, code) {
  if (
    !result ||
    result.exitCode !== 0 ||
    result.errorCode !== undefined ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw buildError(code, "A required shell-free native build command failed.");
  }
}

function buildEnvironment() {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    MACOSX_DEPLOYMENT_TARGET:
      OVERWRITE_NATIVE_BUILD_CONTRACT.deploymentTarget,
    SOURCE_DATE_EPOCH: "0",
    ZERO_AR_DATE: "1",
  };
}

function assertSupportedHost(platform, arch) {
  if (platform !== "darwin") {
    throw buildError(
      "unsupported_platform",
      "The overwrite addon developer build currently supports only macOS.",
    );
  }
  if (arch !== "arm64") {
    throw buildError(
      "unsupported_architecture",
      "The overwrite addon developer build currently supports only macOS arm64.",
    );
  }
}

function normalizeAbsoluteArtifactPath(value, label, extension) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw buildError(
      "invalid_arguments",
      `${label} must be an absolute path without NUL bytes.`,
    );
  }
  const normalized = path.normalize(value);
  normalizeArtifactLeaf(path.basename(normalized), label, extension);
  return normalized;
}

function normalizeArtifactLeaf(value, label, extension) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value !== path.basename(value) ||
    /[\\/\u0000-\u001f\u007f]/u.test(value) ||
    !value.endsWith(extension)
  ) {
    throw buildError(
      "invalid_arguments",
      `${label} must be a safe ${extension} file name.`,
    );
  }
  return value;
}

function requireAbsoluteProbePath(value, code) {
  const probePath = String(value ?? "").trim();
  if (
    !path.isAbsolute(probePath) ||
    probePath.includes("\0") ||
    probePath.includes("\n") ||
    probePath.includes("\r")
  ) {
    throw buildError(code, "xcrun returned an invalid toolchain path.");
  }
  return path.normalize(probePath);
}

async function assertPinnedRegularFile(filePath, code) {
  try {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error();
  } catch (error) {
    throw buildError(code, "The pinned overwrite addon source is unavailable.", error);
  }
}

async function prepareArtifactDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directoryPath);
  const directoryStat = await stat(canonical);
  if (!directoryStat.isDirectory()) {
    throw buildError("invalid_arguments", "An artifact parent is not a directory.");
  }
  return canonical;
}

async function assertPathMissing(filePath, code) {
  try {
    await lstat(filePath);
    throw buildError(code, "The requested build artifact already exists.");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

export async function publishNoClobber(
  sourcePath,
  outputPath,
  operations = { link, lstat, unlink },
) {
  const sourceStat = await operations.lstat(sourcePath);
  const expected = requireRegularFileProof(sourceStat, "output_publish_failed");
  try {
    await operations.link(sourcePath, outputPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw buildError("output_exists", "The requested build artifact already exists.");
    }
    throw buildError("output_publish_failed", "The addon could not be published.", error);
  }
  try {
    const linked = await operations.lstat(outputPath);
    requireMatchingRegularFile(linked, expected, "output_publish_failed");
    await operations.unlink(sourcePath);
    const published = await operations.lstat(outputPath);
    requireMatchingRegularFile(published, expected, "output_publish_failed");
    return expected;
  } catch (error) {
    try {
      await rollbackPublishedFile(outputPath, expected, operations);
    } catch (cleanupError) {
      throw buildError(
        "output_publish_cleanup_failed",
        "The addon publish failed and its final link could not be rolled back.",
        { error, cleanupError },
      );
    }
    throw buildError(
      "output_publish_failed",
      "The addon publish did not converge.",
      error,
    );
  }
}

async function rollbackPublishedFile(
  outputPath,
  expected,
  operations = { lstat, unlink },
) {
  let current;
  try {
    current = await operations.lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  requireMatchingRegularFile(current, expected, "output_publish_cleanup_failed");
  try {
    await operations.unlink(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function requireRegularFileProof(fileStat, code) {
  if (!fileStat?.isFile?.() || fileStat.isSymbolicLink?.()) {
    throw buildError(code, "The staged build artifact is not a regular file.");
  }
  return Object.freeze({
    dev: fileStat.dev,
    ino: fileStat.ino,
    birthtimeMs: fileStat.birthtimeMs,
    byteSize: fileStat.size,
  });
}

function requireMatchingRegularFile(fileStat, expected, code) {
  const actual = requireRegularFileProof(fileStat, code);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.birthtimeMs !== expected.birthtimeMs ||
    actual.byteSize !== expected.byteSize
  ) {
    throw buildError(code, "The published build artifact identity changed.");
  }
}

async function assertNoPrivateBuildPath(filePath) {
  const bytes = await readFile(filePath);
  for (const marker of ["/Users/", "/private/tmp/", "/private/var/"]) {
    if (bytes.includes(Buffer.from(marker))) {
      throw buildError(
        "private_path_embedded",
        "The addon contains a private build-host path.",
      );
    }
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
  const options = parseBuildArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node build-addon-macos-arm64.mjs " +
        "[--output </absolute/path/addon.node>] " +
        "[--receipt </absolute/path/build-receipt.json>] [--dry-run]\n",
    );
    return;
  }
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        createDryRunCommandDescriptor({
          outputLeaf: path.basename(options.outputPath),
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  const receipt = await buildMacosArm64OverwriteAddon(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `overwrite_native_build_failed:${error?.code ?? "unknown"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
