import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_LAYOUTS,
  getRuntimeLayout,
  validateFfmpegBuildReceipt,
} from "./stage-runtime.mjs";

test("freezes separate macOS arm64 and Windows x64 resource layouts", () => {
  assert.deepEqual(getRuntimeLayout("darwin", "arm64"), {
    targetId: "mac-arm64",
    server: "mac-arm64/metal/whisper-server",
    ffmpeg: "mac-arm64/media/ffmpeg",
    ffprobe: "mac-arm64/media/ffprobe",
    serverBackend: "metal_cpu",
  });
  assert.deepEqual(getRuntimeLayout("win32", "x64"), {
    targetId: "win-x64",
    server: "win-x64/cpu/whisper-server.exe",
    ffmpeg: "win-x64/media/ffmpeg.exe",
    ffprobe: "win-x64/media/ffprobe.exe",
    dependencyRoot: "win-x64/cpu",
    serverBackend: "cpu",
  });
  assert.equal(Object.keys(RUNTIME_LAYOUTS).some((key) => key.includes("darwin-x64")), false);
});

test("rejects unsupported platforms and macOS x64 before staging", () => {
  assert.throws(
    () => getRuntimeLayout("darwin", "x64"),
    (error) => error.code === "unsupported_architecture",
  );
  assert.throws(
    () => getRuntimeLayout("linux", "x64"),
    (error) => error.code === "unsupported_platform",
  );
});

test("rejects a GPL build receipt before reading candidate binaries", async () => {
  await assert.rejects(
    validateFfmpegBuildReceipt(
      {
        schemaVersion: 1,
        component: "FFmpeg",
        version: "8.1.2",
        target: { platform: "darwin", arch: "arm64" },
        source: {
          archiveSha256:
            "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
        },
        build: {
          license: "GPL-2.0-or-later",
          gplEnabled: true,
          nonfreeEnabled: false,
          version3Enabled: false,
          networkEnabled: false,
        },
        artifacts: [],
      },
      { ffmpegPath: "/not/read", ffprobePath: "/not/read" },
    ),
    /does not match PRE-005/u,
  );
});
