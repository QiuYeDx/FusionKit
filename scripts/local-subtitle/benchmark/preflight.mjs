#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");

export const TARGET_PROFILES = Object.freeze({
  "mac-arm64-metal": {
    platform: "darwin",
    arch: "arm64",
    requiredTools: [
      "cmake",
      "cxx",
      "xcodebuild",
      "metalCompiler",
      "ffmpeg",
      "ffprobe",
    ],
  },
  "windows-x64-cpu": {
    platform: "win32",
    arch: "x64",
    requiredTools: ["cmake", "msvc", "ffmpeg", "ffprobe"],
  },
  "windows-x64-cuda": {
    platform: "win32",
    arch: "x64",
    requiredTools: [
      "cmake",
      "msvc",
      "ffmpeg",
      "ffprobe",
      "nvcc",
      "nvidiaSmi",
    ],
  },
});

const TOOL_SPECS = Object.freeze({
  cmake: { command: "cmake", args: ["--version"] },
  cxx: { command: "c++", args: ["--version"] },
  msvc: { command: "cl", args: [] },
  xcodebuild: { command: "xcodebuild", args: ["-version"] },
  metalCompiler: { command: "xcrun", args: ["--find", "metal"] },
  ffmpeg: {
    command: "ffmpeg",
    args: ["-hide_banner", "-version"],
    timeoutMs: 15_000,
  },
  ffprobe: {
    command: "ffprobe",
    args: ["-hide_banner", "-version"],
    timeoutMs: 15_000,
  },
  nvcc: { command: "nvcc", args: ["--version"] },
  nvidiaSmi: {
    command: "nvidia-smi",
    args: ["--query-gpu=driver_version", "--format=csv,noheader"],
  },
  pnpm: { command: "pnpm", args: ["--version"] },
});

function minimalProbeEnvironment(environment = process.env) {
  const allowedKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => typeof environment[key] === "string")
      .map((key) => [key, environment[key]]),
  );
}

export function createCommandRunner(environment = process.env) {
  const env = minimalProbeEnvironment(environment);
  return (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env,
      shell: false,
      timeout: options.timeoutMs ?? 5_000,
      windowsHide: true,
    });
    return {
      exitCode: result.status,
      errorCode: result.error?.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function extractVersion(toolId, stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim();
  const rules = {
    cmake: /cmake version\s+([^\s]+)/i,
    cxx: /((?:Apple\s+)?clang version\s+[^\s]+|g\+\+[^\n]*?\d+(?:\.\d+)+)/i,
    msvc: /Compiler Version\s+([^\s]+)/i,
    xcodebuild: /Xcode\s+([^\s]+)/i,
    ffmpeg: /ffmpeg version\s+([^\s]+)/i,
    ffprobe: /ffprobe version\s+([^\s]+)/i,
    nvcc: /release\s+([^,\s]+)/i,
    nvidiaSmi: /(\d+(?:\.\d+)+)/,
    pnpm: /(^|\s)(\d+\.\d+\.\d+)(?:\s|$)/,
  };
  if (toolId === "metalCompiler") return text ? "available" : undefined;
  const match = text.match(rules[toolId]);
  if (!match) return undefined;
  return toolId === "pnpm" ? match[2] : match[1];
}

function probeTool(toolId, runner) {
  const spec = TOOL_SPECS[toolId];
  const result = runner(spec.command, spec.args, {
    timeoutMs: spec.timeoutMs,
  });
  const version = extractVersion(toolId, result.stdout, result.stderr);

  if (result.errorCode === "ENOENT") {
    return { status: "missing" };
  }
  if (result.errorCode === "ETIMEDOUT") {
    return { status: "error", reason: `${toolId}_probe_timeout` };
  }
  if (result.exitCode === 0) {
    return version
      ? { status: "available", version }
      : { status: "available" };
  }
  if (version && toolId === "msvc") {
    return { status: "available", version };
  }
  return { status: "error", reason: `${toolId}_probe_failed` };
}

export function readRepositoryMetadata(projectRoot = PROJECT_ROOT) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const lockText = fs.readFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "utf8");
  const lockfileVersion = lockText.match(/^lockfileVersion:\s*['\"]?([^'\"\s]+)['\"]?/m)?.[1];
  return {
    packageManager: packageJson.packageManager ?? null,
    lockfileVersion: lockfileVersion ?? null,
  };
}

function readAvailableDiskBytes(projectRoot) {
  try {
    const stats = fs.statfsSync(projectRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function majorVersion(version) {
  const match = String(version ?? "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : null;
}

function check(id, passed, detail) {
  return { id, passed, detail };
}

export function buildToolchainReport(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertSupportedHost(platform, arch);
  const targetId = options.targetId ?? inferTargetId(platform, arch);
  const target = TARGET_PROFILES[targetId];
  if (!target) {
    throw new Error(`Unknown target profile: ${targetId}`);
  }

  const runner = options.runner ?? createCommandRunner();
  const repository =
    options.repositoryMetadata ?? readRepositoryMetadata(options.projectRoot);
  const nodeVersion = options.nodeVersion ?? process.version;
  const tools = {};
  for (const toolId of new Set([...target.requiredTools, "pnpm"])) {
    tools[toolId] = probeTool(toolId, runner);
  }

  const checks = [
    check(
      "target_platform",
      platform === target.platform,
      `${platform}/${arch} -> ${target.platform}/${target.arch}`,
    ),
    check("target_arch", arch === target.arch, `${arch} -> ${target.arch}`),
    check(
      "node_version",
      majorVersion(nodeVersion) !== null && majorVersion(nodeVersion) >= 18,
      nodeVersion,
    ),
    check(
      "pnpm_version",
      tools.pnpm.status === "available" && tools.pnpm.version === "8.7.0",
      tools.pnpm.version ?? tools.pnpm.status,
    ),
    check(
      "lockfile_version",
      repository.lockfileVersion === "6.0" || repository.lockfileVersion === "6",
      repository.lockfileVersion ?? "missing",
    ),
    ...target.requiredTools.map((toolId) =>
      check(
        `tool_${toolId}`,
        tools[toolId].status === "available",
        tools[toolId].version ?? tools[toolId].status,
      ),
    ),
  ];

  const warnings = [];
  if (!repository.packageManager) {
    warnings.push({
      code: "package_manager_field_missing",
      detail: "package.json does not declare packageManager; keep pnpm 8.7.0 explicit in commands.",
    });
  }

  const availableDiskBytes =
    options.availableDiskBytes ??
    readAvailableDiskBytes(options.projectRoot ?? PROJECT_ROOT);
  if (availableDiskBytes === null) {
    warnings.push({
      code: "disk_probe_unavailable",
      detail: "Available disk space could not be measured.",
    });
  }

  const blockers = checks
    .filter((item) => !item.passed)
    .map((item) => ({ code: item.id, detail: item.detail }));

  return {
    schemaVersion: 1,
    reportType: "local_subtitle_toolchain_preflight",
    generatedAt: (options.now ?? new Date()).toISOString(),
    target: {
      id: targetId,
      expectedPlatform: target.platform,
      expectedArch: target.arch,
    },
    host: {
      platform,
      arch,
      nodeVersion,
      availableDiskBytes,
    },
    repository,
    tools,
    checks,
    warnings,
    blockers,
    ready: blockers.length === 0,
    privacy: {
      hostnameRecorded: false,
      usernameRecorded: false,
      absolutePathsRecorded: false,
      environmentAllowlistOnly: true,
    },
  };
}

export function inferTargetId(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "mac-arm64-metal";
  if (platform === "win32" && arch === "x64") return "windows-x64-cpu";
  if (platform === "darwin" || platform === "win32") {
    throw preflightTargetError(
      "unsupported_architecture",
      `PRE-001 does not support ${platform}/${arch}; macOS requires arm64 and Windows requires x64.`,
    );
  }
  throw preflightTargetError(
    "unsupported_platform",
    `PRE-001 does not support ${platform}/${arch}.`,
  );
}

function assertSupportedHost(platform, arch) {
  if (platform === "darwin" && arch !== "arm64") {
    throw preflightTargetError(
      "unsupported_architecture",
      `PRE-001 does not support macOS ${arch}; only macOS arm64 is in the release matrix.`,
    );
  }
}

function preflightTargetError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const parsed = { targetId: undefined, outputPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      parsed.targetId = readArgumentValue(argv, ++index, value);
    } else if (value === "--output") {
      parsed.outputPath = readArgumentValue(argv, ++index, value);
    } else if (value === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function readArgumentValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log("Usage: node preflight.mjs [--target <profile>] [--output <report.json>]");
  console.log(`Profiles: ${Object.keys(TARGET_PROFILES).join(", ")}`);
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const report = buildToolchainReport({ targetId: args.targetId });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) {
    const outputPath = path.resolve(args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized, "utf8");
    console.log(`Toolchain report written (${report.ready ? "ready" : "not ready"}).`);
  } else {
    process.stdout.write(serialized);
  }

  if (!report.ready) {
    for (const blocker of report.blockers) {
      console.error(`[BLOCKED] ${blocker.code}: ${blocker.detail}`);
    }
  }
  return report.ready ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
