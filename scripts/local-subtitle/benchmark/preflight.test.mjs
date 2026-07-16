import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_PROFILES,
  buildToolchainReport,
  inferTargetId,
  minimalProbeEnvironment,
} from "./preflight.mjs";

const REPOSITORY = {
  packageManager: null,
  lockfileVersion: "6.0",
};

function fakeRunner(results, onCall = () => {}) {
  return (command, args, options) => {
    onCall(command, args, options);
    const key = `${command} ${args.join(" ")}`;
    return (
      results[key] ?? {
        exitCode: null,
        errorCode: "ENOENT",
        stdout: "",
        stderr: "",
      }
    );
  };
}

const MAC_TOOLS = {
  "pnpm --version": success("8.7.0"),
  "cmake --version": success("cmake version 4.1.0"),
  "c++ --version": success("Apple clang version 17.0.0"),
  "xcodebuild -version": success("Xcode 26.0\nBuild version 17A1"),
  "xcrun --find metal": success("/Applications/Xcode.app/usr/bin/metal"),
  "ffmpeg -hide_banner -version": success("ffmpeg version 8.1.2"),
  "ffprobe -hide_banner -version": success("ffprobe version 8.1.2"),
};

function success(stdout) {
  return { exitCode: 0, stdout, stderr: "" };
}

test("accepts a complete macOS arm64 Metal toolchain without recording command paths", () => {
  const probeOptions = new Map();
  const report = buildToolchainReport({
    targetId: "mac-arm64-metal",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v20.19.5",
    repositoryMetadata: REPOSITORY,
    availableDiskBytes: 100_000_000_000,
    runner: fakeRunner(MAC_TOOLS, (command, _args, options) => {
      probeOptions.set(command, options);
    }),
    now: new Date("2026-07-16T00:00:00.000Z"),
  });

  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.readinessScope, "source_build_poc");
  assert.equal(report.sourceBuild.requiredForPoc, true);
  assert.equal(report.sourceBuild.ready, true);
  assert.equal(report.tools.metalCompiler.status, "available");
  assert.equal(probeOptions.get("ffmpeg").timeoutMs, 15_000);
  assert.equal(probeOptions.get("ffprobe").timeoutMs, 15_000);
  assert.equal(JSON.stringify(report).includes("/Applications"), false);
  assert.ok(report.warnings.some((warning) => warning.code === "package_manager_field_missing"));
});

test("reports every missing required tool as an explicit blocker", () => {
  const report = buildToolchainReport({
    targetId: "mac-arm64-metal",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v20.19.5",
    repositoryMetadata: REPOSITORY,
    availableDiskBytes: 100_000_000_000,
    runner: fakeRunner({ "pnpm --version": success("8.7.0") }),
  });

  assert.equal(report.ready, false);
  const blockerCodes = new Set(report.blockers.map((blocker) => blocker.code));
  for (const toolId of [
    "cmake",
    "cxx",
    "xcodebuild",
    "metalCompiler",
    "ffmpeg",
    "ffprobe",
  ]) {
    assert.ok(blockerCodes.has(`tool_${toolId}`));
  }
});

test("pins the official Windows CUDA asset separately from the macOS profile", () => {
  const windowsTools = {
    "cmd.exe /d /s /c pnpm.cmd --version": success("8.7.0"),
    "cmake --version": success("cmake version 4.1.0"),
    "cl ": {
      exitCode: 2,
      stdout: "",
      stderr: "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35219 for x64",
    },
    "ffmpeg -hide_banner -version": success("ffmpeg version 8.1.2"),
    "ffprobe -hide_banner -version": success("ffprobe version 8.1.2"),
    "nvcc --version": success("Cuda compilation tools, release 13.0, V13.0.10"),
    "nvidia-smi --query-gpu=driver_version --format=csv,noheader": success("590.10"),
  };
  const report = buildToolchainReport({
    targetId: "windows-x64-cuda",
    platform: "win32",
    arch: "x64",
    nodeVersion: "v20.19.5",
    repositoryMetadata: REPOSITORY,
    availableDiskBytes: 100_000_000_000,
    runner: fakeRunner(windowsTools),
  });

  assert.equal(report.ready, true);
  assert.equal(report.readinessScope, "official_prebuilt_release_asset");
  assert.equal(report.sourceBuild.requiredForPoc, false);
  assert.equal(report.sourceBuild.ready, true);
  assert.equal("xcodebuild" in report.tools, false);
  assert.equal(report.tools.nvcc.version, "13.0");
  assert.equal(report.tools.pnpm.version, "8.7.0");
  assert.equal(report.pocArtifact.fileName, "whisper-cublas-12.4.0-bin-x64.zip");
  assert.equal(
    report.pocArtifact.sha256,
    "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
  );
});

test("does not block a Windows prebuilt PoC on missing source-build tools", () => {
  const report = buildToolchainReport({
    targetId: "windows-x64-cuda",
    platform: "win32",
    arch: "x64",
    nodeVersion: "v20.19.5",
    repositoryMetadata: REPOSITORY,
    availableDiskBytes: 100_000_000_000,
    runner: fakeRunner({
      "cmd.exe /d /s /c pnpm.cmd --version": success("8.7.0"),
      "ffmpeg -hide_banner -version": success("ffmpeg version 8.1.2"),
      "ffprobe -hide_banner -version": success("ffprobe version 8.1.2"),
      "nvidia-smi --query-gpu=driver_version --format=csv,noheader":
        success("610.62"),
    }),
  });

  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.sourceBuild.ready, false);
  assert.deepEqual(
    report.sourceBuild.blockers.map((blocker) => blocker.code),
    ["tool_cmake", "tool_msvc", "tool_nvcc"],
  );
  assert.equal(report.checks.some((check) => check.id === "tool_cmake"), false);
  assert.ok(
    report.warnings.some(
      (warning) => warning.code === "source_build_toolchain_incomplete",
    ),
  );
});

test("keeps only the Windows system locations required by native probes", () => {
  const environment = minimalProbeEnvironment({
    PATH: "safe-path",
    PATHEXT: ".EXE;.CMD",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    USERPROFILE: "C:\\Users\\private",
    OPENAI_API_KEY: "must-not-leak",
  });

  assert.equal(environment.ProgramFiles, "C:\\Program Files");
  assert.equal(environment.ProgramW6432, "C:\\Program Files");
  assert.equal("USERPROFILE" in environment, false);
  assert.equal("OPENAI_API_KEY" in environment, false);
});

test("rejects a pnpm version that could rewrite the v6 lockfile", () => {
  const tools = { ...MAC_TOOLS, "pnpm --version": success("11.7.0") };
  const report = buildToolchainReport({
    targetId: "mac-arm64-metal",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v20.19.5",
    repositoryMetadata: REPOSITORY,
    availableDiskBytes: 100_000_000_000,
    runner: fakeRunner(tools),
  });

  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((blocker) => blocker.code === "pnpm_version"));
});

test("rejects macOS x64 with a stable unsupported architecture error", () => {
  assert.equal("mac-x64-cpu" in TARGET_PROFILES, false);
  assert.throws(
    () => inferTargetId("darwin", "x64"),
    (error) =>
      error?.code === "unsupported_architecture" &&
      error.message.includes("macOS requires arm64"),
  );
  assert.throws(
    () =>
      buildToolchainReport({
        targetId: "mac-arm64-metal",
        platform: "darwin",
        arch: "x64",
      }),
    (error) =>
      error?.code === "unsupported_architecture" &&
      error.message.includes("only macOS arm64"),
  );
});
