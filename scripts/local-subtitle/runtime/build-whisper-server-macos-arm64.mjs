#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { cpus } from "node:os";
import {
  chmod,
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  buildSanitizedRuntimeEnvironment,
  inspectNativeBinaryFile,
  sha256File,
} from "./runtime-manifest.mjs";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const COMMAND_TERMINATION_GRACE_MS = 5_000;
const COMMAND_CLOSE_CONFIRMATION_MS = 5_000;

export const WHISPER_SERVER_BUILD_CONTRACT = Object.freeze({
  component: "whisper.cpp",
  version: "v1.9.1",
  commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
  deploymentTarget: "11.0",
  cmakeVersion: "4.4.0",
  sdkVersion: "26.5",
  compilerVersion: "Apple clang version 21.0.0 (clang-2100.1.1.101)",
  cmakeExecutableSha256:
    "8f136fce6bb8e9dbea38320f8a615b1f4896fe80cc7da5c1ff3da69e834f5d4c",
  recipe:
    "scripts/local-subtitle/runtime/build-whisper-server-macos-arm64.mjs",
  target: Object.freeze({ platform: "darwin", arch: "arm64" }),
});

export const WHISPER_SERVER_CMAKE_DEFINITIONS = Object.freeze([
  "CMAKE_BUILD_TYPE=Release",
  "CMAKE_OSX_ARCHITECTURES=arm64",
  "CMAKE_OSX_DEPLOYMENT_TARGET=11.0",
  "BUILD_SHARED_LIBS=OFF",
  "GGML_NATIVE=OFF",
  "GGML_METAL=ON",
  "GGML_METAL_EMBED_LIBRARY=ON",
  "WHISPER_BUILD_SERVER=ON",
]);

export const WHISPER_SERVER_PATH_MAP_DEFINITIONS = Object.freeze([
  "CMAKE_C_FLAGS=-ffile-prefix-map=<SOURCE>=. -fdebug-prefix-map=<SOURCE>=. " +
    "-ffile-prefix-map=<WORK>=. -fdebug-prefix-map=<WORK>=.",
  "CMAKE_CXX_FLAGS=-ffile-prefix-map=<SOURCE>=. -fdebug-prefix-map=<SOURCE>=. " +
    "-ffile-prefix-map=<WORK>=. -fdebug-prefix-map=<WORK>=.",
]);

export async function buildWhisperServerMacosArm64(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The whisper-server build requires a native darwin/arm64 host.");
  }
  const sourceRoot = path.resolve(requirePath(options.sourceRoot, "sourceRoot"));
  const outputRoot = path.resolve(requirePath(options.outputRoot, "outputRoot"));
  const cmakePath = options.cmakePath ?? "cmake";
  await assertMissing(outputRoot, "The whisper-server output already exists.");
  await verifyPinnedSourceCheckout(sourceRoot);

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-whisper-server-"));
  const buildRoot = path.join(workRoot, "build");
  const partialRoot = `${outputRoot}.partial-${path.basename(workRoot)}`;
  try {
    await mkdir(buildRoot, { recursive: true });
    const sourceMapFlags = [
      `-ffile-prefix-map=${sourceRoot}=.`,
      `-fdebug-prefix-map=${sourceRoot}=.`,
      `-ffile-prefix-map=${workRoot}=.`,
      `-fdebug-prefix-map=${workRoot}=.`,
    ].join(" ");
    const definitions = [
      ...WHISPER_SERVER_CMAKE_DEFINITIONS,
      `CMAKE_C_FLAGS=${sourceMapFlags}`,
      `CMAKE_CXX_FLAGS=${sourceMapFlags}`,
    ];
    const environment = buildToolEnvironment(workRoot);
    const cmakeExecutable = await resolvePinnedExecutable(cmakePath, environment);
    const compilerProbe = await runCommand(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--find", "clang"],
      { cwd: workRoot, env: environment, timeoutMs: 15_000 },
    );
    const compilerPath = compilerProbe.stdout.trim();
    if (!path.isAbsolute(compilerPath) || path.basename(compilerPath) !== "clang") {
      throw new Error("The macOS compiler path is not pinned.");
    }
    const sdkProbe = await runCommand(
      "/usr/bin/xcrun",
      ["--sdk", "macosx", "--show-sdk-version"],
      { cwd: workRoot, env: environment, timeoutMs: 15_000 },
    );
    const sdkVersion = sdkProbe.stdout.trim();
    if (!/^\d+\.\d+$/u.test(sdkVersion)) {
      throw new Error("The macOS SDK version is invalid.");
    }
    const cmakeVersion = await runCommand(cmakeExecutable, ["--version"], {
      cwd: workRoot,
      env: environment,
      timeoutMs: 15_000,
    });
    const cmakeVersionLabel = parseCmakeVersion(cmakeVersion.stdout);
    if (cmakeVersionLabel !== WHISPER_SERVER_BUILD_CONTRACT.cmakeVersion) {
      throw new Error("The CMake toolchain version is not pinned.");
    }
    const compilerVersionProbe = await runCommand(compilerPath, ["--version"], {
      cwd: workRoot,
      env: environment,
      timeoutMs: 15_000,
    });
    const compilerVersion = compilerVersionProbe.stdout.split(/\r?\n/u)[0];
    if (compilerVersion !== WHISPER_SERVER_BUILD_CONTRACT.compilerVersion) {
      throw new Error("The Apple clang toolchain version is not pinned.");
    }
    if (sdkVersion !== WHISPER_SERVER_BUILD_CONTRACT.sdkVersion) {
      throw new Error("The macOS SDK version is not pinned.");
    }
    await runCommand(
      cmakeExecutable,
      [
        "-S",
        sourceRoot,
        "-B",
        buildRoot,
        "-G",
        "Unix Makefiles",
        ...definitions.map((value) => `-D${value}`),
      ],
      { cwd: workRoot, env: environment, timeoutMs: 2 * 60_000 },
    );
    await runCommand(
      cmakeExecutable,
      [
        "--build",
        buildRoot,
        "--target",
        "whisper-server",
        "--parallel",
        String(normalizeJobs(options.jobs)),
      ],
      {
        cwd: workRoot,
        env: environment,
        timeoutMs: 20 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    const builtPath = path.join(buildRoot, "bin", "whisper-server");
    const outputPath = path.join(partialRoot, "bin", "whisper-server");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(builtPath, outputPath);
    await chmod(outputPath, 0o755);
    const artifact = await inspectWhisperServerArtifact(outputPath, {
      privatePaths: [sourceRoot, workRoot, buildRoot, partialRoot],
    });
    const versionProbe = await runCommand(outputPath, ["--help"], {
      cwd: partialRoot,
      env: buildSanitizedRuntimeEnvironment("darwin", { TMPDIR: workRoot }),
      timeoutMs: 15_000,
    });
    if (!/(?:whisper-server|whisper server|usage:)/iu.test(
      `${versionProbe.stdout}${versionProbe.stderr}`,
    )) {
      throw new Error("The built whisper-server failed its identity probe.");
    }

    const receipt = {
      schemaVersion: 1,
      component: WHISPER_SERVER_BUILD_CONTRACT.component,
      version: WHISPER_SERVER_BUILD_CONTRACT.version,
      target: WHISPER_SERVER_BUILD_CONTRACT.target,
      source: {
        kind: "exact_clean_upstream_git_checkout",
        tag: WHISPER_SERVER_BUILD_CONTRACT.version,
        commit: WHISPER_SERVER_BUILD_CONTRACT.commit,
        isolatedRepositoryRoot: true,
        cleanTrackedFiles: true,
      },
      build: {
        recipe: WHISPER_SERVER_BUILD_CONTRACT.recipe,
        cmakeVersion: cmakeVersionLabel,
        cmakeExecutableSha256:
          WHISPER_SERVER_BUILD_CONTRACT.cmakeExecutableSha256,
        generator: "Unix Makefiles",
        compiler: "xcrun --sdk macosx clang/clang++",
        compilerVersion,
        sdkVersion,
        cmakeDefinitions: [
          ...WHISPER_SERVER_CMAKE_DEFINITIONS,
          ...WHISPER_SERVER_PATH_MAP_DEFINITIONS,
        ],
        deploymentTarget: WHISPER_SERVER_BUILD_CONTRACT.deploymentTarget,
        shell: false,
        reproduciblePathMapping: true,
        sharedLibraries: false,
        nativeHostTuning: false,
        metalEnabled: true,
        metalLibraryEmbedded: true,
        cpuFallbackEnabled: true,
      },
      artifact,
      privacy: {
        absolutePathsRecorded: false,
        usernameRecorded: false,
        sourcePathsEmbedded: false,
      },
    };
    await writeFile(
      path.join(partialRoot, "build-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(partialRoot, outputRoot);
    return receipt;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    await rm(partialRoot, { recursive: true, force: true });
  }
}

export async function validateWhisperServerBuildReceipt(receipt, options) {
  assertExactKeys(receipt, [
    "schemaVersion", "component", "version", "target", "source", "build",
    "artifact", "privacy",
  ], "receipt");
  assertExactKeys(receipt.target, ["platform", "arch"], "target");
  assertExactKeys(receipt.source, [
    "kind", "tag", "commit", "isolatedRepositoryRoot", "cleanTrackedFiles",
  ], "source");
  assertExactKeys(receipt.build, [
    "recipe", "cmakeVersion", "cmakeExecutableSha256", "generator",
    "compiler", "compilerVersion", "sdkVersion",
    "cmakeDefinitions", "deploymentTarget", "shell",
    "reproduciblePathMapping", "sharedLibraries", "nativeHostTuning",
    "metalEnabled", "metalLibraryEmbedded", "cpuFallbackEnabled",
  ], "build");
  assertExactKeys(receipt.artifact, [
    "kind", "logicalFileName", "byteSize", "sha256", "architecture",
    "minimumMacosVersion", "metalLibraryEmbedded", "cpuFallbackEnabled",
    "dependencySummary", "signatureKind",
  ], "artifact");
  assertExactKeys(receipt.artifact?.dependencySummary, [
    "dependencyCount", "systemDependencyCount", "nonSystemDependencyLabels",
    "systemOnly",
  ], "artifact.dependencySummary");
  assertExactKeys(receipt.privacy, [
    "absolutePathsRecorded", "usernameRecorded", "sourcePathsEmbedded",
  ], "privacy");
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.component !== WHISPER_SERVER_BUILD_CONTRACT.component ||
    receipt.version !== WHISPER_SERVER_BUILD_CONTRACT.version ||
    receipt.target?.platform !== "darwin" ||
    receipt.target?.arch !== "arm64" ||
    receipt.source?.kind !== "exact_clean_upstream_git_checkout" ||
    receipt.source?.tag !== WHISPER_SERVER_BUILD_CONTRACT.version ||
    receipt.source?.commit !== WHISPER_SERVER_BUILD_CONTRACT.commit ||
    receipt.source?.isolatedRepositoryRoot !== true ||
    receipt.source?.cleanTrackedFiles !== true ||
    receipt.build?.recipe !== WHISPER_SERVER_BUILD_CONTRACT.recipe ||
    receipt.build?.cmakeVersion !== WHISPER_SERVER_BUILD_CONTRACT.cmakeVersion ||
    receipt.build?.cmakeExecutableSha256 !==
      WHISPER_SERVER_BUILD_CONTRACT.cmakeExecutableSha256 ||
    receipt.build?.generator !== "Unix Makefiles" ||
    receipt.build?.compiler !== "xcrun --sdk macosx clang/clang++" ||
    receipt.build?.compilerVersion !== WHISPER_SERVER_BUILD_CONTRACT.compilerVersion ||
    receipt.build?.sdkVersion !== WHISPER_SERVER_BUILD_CONTRACT.sdkVersion ||
    receipt.build?.deploymentTarget !== WHISPER_SERVER_BUILD_CONTRACT.deploymentTarget ||
    receipt.build?.shell !== false ||
    receipt.build?.reproduciblePathMapping !== true ||
    receipt.build?.sharedLibraries !== false ||
    receipt.build?.nativeHostTuning !== false ||
    receipt.build?.metalEnabled !== true ||
    receipt.build?.metalLibraryEmbedded !== true ||
    receipt.build?.cpuFallbackEnabled !== true ||
    receipt.privacy?.absolutePathsRecorded !== false ||
    receipt.privacy?.usernameRecorded !== false ||
    receipt.privacy?.sourcePathsEmbedded !== false ||
    !sameStringArray(
      receipt.build?.cmakeDefinitions,
      [
        ...WHISPER_SERVER_CMAKE_DEFINITIONS,
        ...WHISPER_SERVER_PATH_MAP_DEFINITIONS,
      ],
    )
  ) {
    throw new Error("The whisper-server build receipt does not match NATIVE-002A.");
  }
  assertReceiptPrivacy(receipt);
  const serverPath = path.resolve(requirePath(options.serverPath, "serverPath"));
  const artifact = await inspectWhisperServerArtifact(serverPath);
  if (
    receipt.artifact?.kind !== artifact.kind ||
    receipt.artifact?.logicalFileName !== artifact.logicalFileName ||
    receipt.artifact?.byteSize !== artifact.byteSize ||
    receipt.artifact?.sha256 !== artifact.sha256 ||
    receipt.artifact?.architecture !== artifact.architecture ||
    receipt.artifact?.minimumMacosVersion !== artifact.minimumMacosVersion ||
    receipt.artifact?.metalLibraryEmbedded !== true ||
    receipt.artifact?.cpuFallbackEnabled !== true ||
    receipt.artifact?.signatureKind !== artifact.signatureKind ||
    receipt.artifact?.dependencySummary?.dependencyCount !==
      artifact.dependencySummary.dependencyCount ||
    receipt.artifact?.dependencySummary?.systemDependencyCount !==
      artifact.dependencySummary.systemDependencyCount ||
    !sameStringArray(
      receipt.artifact?.dependencySummary?.nonSystemDependencyLabels,
      artifact.dependencySummary.nonSystemDependencyLabels,
    ) ||
    receipt.artifact?.dependencySummary?.systemOnly !== true
  ) {
    throw new Error("The whisper-server input does not match its build receipt.");
  }
  return true;
}

export async function verifyPinnedSourceCheckout(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const environment = buildToolEnvironment(os.tmpdir());
  const topLevel = await runCommand(
    "/usr/bin/git",
    ["-C", root, "rev-parse", "--show-toplevel"],
    { cwd: root, env: environment, timeoutMs: 15_000 },
  );
  if (path.resolve(topLevel.stdout.trim()) !== root) {
    throw new Error("The whisper.cpp source is not an isolated Git checkout.");
  }
  const commit = await runCommand(
    "/usr/bin/git",
    ["-C", root, "rev-parse", "HEAD"],
    { cwd: root, env: environment, timeoutMs: 15_000 },
  );
  if (commit.stdout.trim() !== WHISPER_SERVER_BUILD_CONTRACT.commit) {
    throw new Error("The whisper.cpp source commit is not pinned.");
  }
  const tag = await runCommand(
    "/usr/bin/git",
    ["-C", root, "describe", "--exact-match", "--tags", "HEAD"],
    { cwd: root, env: environment, timeoutMs: 15_000 },
  );
  if (tag.stdout.trim() !== WHISPER_SERVER_BUILD_CONTRACT.version) {
    throw new Error("The whisper.cpp source tag is not pinned.");
  }
  const status = await runCommand(
    "/usr/bin/git",
    [
      "-C",
      root,
      "status",
      "--porcelain=v1",
      "--ignored=matching",
      "--untracked-files=all",
    ],
    { cwd: root, env: environment, timeoutMs: 15_000 },
  );
  assertCleanSourceStatus(status.stdout);
  const submodules = await runCommand(
    "/usr/bin/git",
    ["-C", root, "submodule", "status", "--recursive"],
    { cwd: root, env: environment, timeoutMs: 15_000 },
  );
  if (submodules.stdout.split(/\r?\n/u).some((line) => /^[-+U]/u.test(line))) {
    throw new Error("The whisper.cpp source has an uninitialized or modified submodule.");
  }
  return true;
}

export function assertCleanSourceStatus(output) {
  if (typeof output !== "string" || output.trim() !== "") {
    throw new Error("The whisper.cpp source checkout is not completely clean.");
  }
  return true;
}

export async function inspectWhisperServerArtifact(filePath, options = {}) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_ARTIFACT_BYTES) {
    throw new Error("The whisper-server artifact size is invalid.");
  }
  const inspection = await inspectNativeBinaryFile(filePath);
  if (
    inspection.format !== "mach-o" ||
    inspection.architectures.length !== 1 ||
    inspection.architectures[0] !== "arm64" ||
    inspection.minimumOsVersion !== "11.0.0"
  ) {
    throw new Error("The whisper-server artifact is not thin arm64/macOS 11.");
  }
  const bytes = await readFile(filePath);
  assertNoPrivateBuildPath(bytes, options.privatePaths);
  const text = bytes.toString("latin1");
  if (
    !text.includes(WHISPER_SERVER_BUILD_CONTRACT.commit.slice(0, 7)) ||
    !text.includes("GGML_METAL_EMBED_LIBRARY") ||
    !text.includes("using embedded metal library") ||
    !text.includes("ggml_backend_metal_init")
  ) {
    throw new Error("The whisper-server artifact does not embed the Metal backend.");
  }
  const dependencySummary = await inspectMacosDependencies(filePath);
  if (!dependencySummary.systemOnly) {
    throw new Error("The whisper-server artifact has a non-system dependency.");
  }
  return {
    kind: "server",
    logicalFileName: "whisper-server",
    byteSize: fileStat.size,
    sha256: await sha256File(filePath),
    architecture: "arm64",
    minimumMacosVersion: inspection.minimumOsVersion,
    metalLibraryEmbedded: true,
    cpuFallbackEnabled: true,
    dependencySummary,
    signatureKind: "unsigned_before_runtime_staging",
  };
}

export function assertNoPrivateBuildPath(bytes, exactPaths = []) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes);
  const markers = [
    "/Users/",
    "/Volumes/",
    "/home/",
    "/workspace/",
    "/workspaces/",
    "/private/tmp/",
    "/private/var/folders/",
    ...exactPaths.map((entry) => path.resolve(entry)),
  ];
  for (const marker of markers) {
    if (text.includes(marker)) {
      throw new Error("The whisper-server artifact embeds a private build path.");
    }
  }
  return true;
}

async function inspectMacosDependencies(filePath) {
  const result = await runCommand("/usr/bin/otool", ["-L", filePath], {
    cwd: path.dirname(filePath),
    env: buildSanitizedRuntimeEnvironment("darwin"),
    timeoutMs: 30_000,
  });
  const dependencies = result.stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(" (", 1)[0])
    .filter(Boolean);
  const nonSystem = dependencies.filter(
    (dependency) =>
      !dependency.startsWith("/System/Library/") &&
      !dependency.startsWith("/usr/lib/"),
  );
  return {
    dependencyCount: dependencies.length,
    systemDependencyCount: dependencies.length - nonSystem.length,
    nonSystemDependencyLabels: nonSystem.map((entry) => path.basename(entry)),
    systemOnly: nonSystem.length === 0,
  };
}

function buildToolEnvironment(tempRoot) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: tempRoot,
    MACOSX_DEPLOYMENT_TARGET: WHISPER_SERVER_BUILD_CONTRACT.deploymentTarget,
  };
}

async function resolvePinnedExecutable(command, environment) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : environment.PATH.split(path.delimiter).map((directory) =>
        path.join(directory, command)
      );
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const candidateStat = await stat(canonical);
      if (!candidateStat.isFile()) continue;
      if (
        await sha256File(canonical) !==
          WHISPER_SERVER_BUILD_CONTRACT.cmakeExecutableSha256
      ) {
        throw new Error("The CMake executable hash is not pinned.");
      }
      return canonical;
    } catch (error) {
      if (error?.message === "The CMake executable hash is not pinned.") throw error;
    }
  }
  throw new Error("The pinned CMake executable is unavailable.");
}

async function runCommand(command, args, options) {
  return runBoundedBuildCommand(command, args, options);
}

export async function runBoundedBuildCommand(command, args, options) {
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  const terminationGraceMs =
    options.terminationGraceMs ?? COMMAND_TERMINATION_GRACE_MS;
  const closeConfirmationMs =
    options.closeConfirmationMs ?? COMMAND_CLOSE_CONFIRMATION_MS;
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let capturedBytes = 0;
  let failureMessage;
  let spawnError;
  let terminationPromise;
  let notifyFailure;
  const failureStarted = new Promise((resolve) => {
    notifyFailure = resolve;
  });
  const requestStop = (message) => {
    if (failureMessage !== undefined) return;
    failureMessage = message;
    terminationPromise = terminateBuildProcessTree(child, {
      detached,
      terminationGraceMs,
      closeConfirmationMs,
    });
    terminationPromise.catch(() => {});
    notifyFailure();
  };
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
    stream.on("data", (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxBuffer) {
        requestStop("exceeded its output limit");
      } else {
        chunks.push(chunk);
      }
    });
  }
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.once("error", (error) => {
    spawnError = error;
    requestStop("could not be spawned");
  });
  const timeout = setTimeout(
    () => requestStop("timed out"),
    options.timeoutMs,
  );
  const first = await Promise.race([
    closed.then((result) => ({ kind: "closed", result })),
    failureStarted.then(() => ({ kind: "failure" })),
  ]);
  clearTimeout(timeout);

  if (first.kind === "closed" && failureMessage === undefined) {
    if (first.result.code === 0) {
      if (isBuildProcessTreeAlive(child, detached)) {
        requestStop("left descendant processes running");
      } else {
        return {
          exitCode: 0,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
      }
    } else {
      requestStop(`exited with code ${String(first.result.code)}`);
    }
  }

  await terminationPromise;
  const closeResult = first.kind === "closed"
    ? first.result
    : await waitForCommandClose(closed, closeConfirmationMs);
  if (closeResult === null) {
    throw new Error(
      `whisper-server build command could not confirm close: ${path.basename(command)}.`,
    );
  }
  throw new Error(
    `whisper-server build command ${failureMessage}: ${path.basename(command)}.`,
    spawnError === undefined ? undefined : { cause: spawnError },
  );
}

async function terminateBuildProcessTree(child, options) {
  signalBuildProcessTree(child, options.detached, "SIGTERM");
  if (
    await waitForBuildProcessTreeExit(
      child,
      options.detached,
      options.terminationGraceMs,
    )
  ) {
    return;
  }
  signalBuildProcessTree(child, options.detached, "SIGKILL");
  if (
    !await waitForBuildProcessTreeExit(
      child,
      options.detached,
      options.closeConfirmationMs,
    )
  ) {
    throw new Error("The whisper-server build process group did not exit.");
  }
}

function signalBuildProcessTree(child, detached, signal) {
  if (child.pid === undefined) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function isBuildProcessTreeAlive(child, detached) {
  if (child.pid === undefined) return false;
  if (!detached) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForBuildProcessTreeExit(child, detached, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isBuildProcessTreeAlive(child, detached)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function waitForCommandClose(closed, timeoutMs) {
  let timer;
  const result = await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

function parseCmakeVersion(output) {
  const match = /^cmake version (\d+\.\d+\.\d+)$/mu.exec(output);
  if (!match) throw new Error("The CMake version output is invalid.");
  return match[1];
}

function normalizeJobs(value) {
  if (value === undefined) return Math.max(1, Math.min(cpus().length, 8));
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error("jobs must be an integer between 1 and 64.");
  }
  return value;
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The whisper-server ${label} is invalid.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameStringArray(actual, expected)) {
    throw new Error(`The whisper-server ${label} has missing or unknown fields.`);
  }
}

function assertReceiptPrivacy(receipt) {
  const serialized = JSON.stringify(receipt);
  for (const marker of [
    "/Users/",
    "/Volumes/",
    "/private/tmp/",
    "/private/var/folders/",
    "\\Users\\",
  ]) {
    if (serialized.includes(marker)) {
      throw new Error("The whisper-server build receipt contains a private path.");
    }
  }
}

async function assertMissing(filePath, message) {
  try {
    await stat(filePath);
    throw new Error(message);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
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
      source: { type: "string" },
      output: { type: "string" },
      cmake: { type: "string", default: "cmake" },
      jobs: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    sourceRoot: values.source,
    outputRoot: values.output,
    cmakePath: values.cmake,
    ...(values.jobs === undefined ? {} : { jobs: Number(values.jobs) }),
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node build-whisper-server-macos-arm64.mjs --source <clean-v1.9.1-checkout> " +
        "--output <ignored-output> [--cmake <path>] [--jobs <count>]\n",
    );
    return;
  }
  const receipt = await buildWhisperServerMacosArm64(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`whisper_server_build_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
