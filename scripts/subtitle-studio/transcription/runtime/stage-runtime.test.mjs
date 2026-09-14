import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { FFMPEG_BUILD_CONTRACT, FFMPEG_CONFIGURE_FLAGS } from './build-ffmpeg-macos-arm64.mjs';
import {
  RUNTIME_LAYOUTS,
  getRuntimeLayout,
  resolveRuntimeOutputParent,
  validateFfmpegBuildReceipt,
  verifyStagedCopyMatches,
} from "./stage-runtime.mjs";

test("freezes separate macOS arm64 and Windows x64 resource layouts", () => {
  assert.deepEqual(getRuntimeLayout("darwin", "arm64"), {
    targetId: "darwin-arm64",
    server: "mac-arm64/metal/whisper-server",
    ffmpeg: "mac-arm64/media/ffmpeg",
    ffprobe: "mac-arm64/media/ffprobe",
    serverBackend: "metal_cpu",
  });
  assert.deepEqual(getRuntimeLayout("win32", "x64"), {
    targetId: "win32-x64",
    server: "win-x64/cpu/whisper-server.exe",
    ffmpeg: "win-x64/media/ffmpeg.exe",
    ffprobe: "win-x64/media/ffprobe.exe",
    dependencyRoot: "win-x64/cpu",
    serverBackend: "cpu",
  });
  assert.equal(Object.keys(RUNTIME_LAYOUTS).some((key) => key.includes("darwin-x64")), false);
});

test("defaults staging output to the canonical ignored build parent", () => {
  assert.equal(
    resolveRuntimeOutputParent(undefined),
    path.resolve("build/subtitle-studio-resources"),
  );
  assert.equal(
    resolveRuntimeOutputParent("ignored/custom-parent"),
    path.resolve("ignored/custom-parent"),
  );
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

test('rejects unverified source signatures and drifted build flags before candidate access', async () => {
  const valid = { schemaVersion: 1, component: 'FFmpeg', version: '8.1.2', target: { platform: 'darwin', arch: 'arm64' },
    source: { archiveSha256: FFMPEG_BUILD_CONTRACT.sourceArchiveSha256, signatureSha256: FFMPEG_BUILD_CONTRACT.signatureSha256,
      signatureVerification: { status: 'verified', fingerprint: FFMPEG_BUILD_CONTRACT.signingKeyFingerprint }, isolatedFromAncestorGitMetadata: true },
    build: { recipe: 'scripts/subtitle-studio/transcription/runtime/build-ffmpeg-macos-arm64.mjs', logicalPrefix: FFMPEG_BUILD_CONTRACT.logicalPrefix,
      deploymentTarget: '11.0', configureFlags: [...FFMPEG_CONFIGURE_FLAGS], license: 'LGPL-2.1-or-later', gplEnabled: false,
      nonfreeEnabled: false, version3Enabled: false, networkEnabled: false, externalLibraries: [] }, artifacts: [{}, {}] };
  const mutations = [
    value => { value.source.signatureVerification.status = 'not_run_tool_unavailable'; },
    value => { value.source.signatureVerification.fingerprint = '0'.repeat(40); },
    value => { value.build.configureFlags.push('--enable-gpl'); },
    value => { value.build.externalLibraries.push('uncontrolled'); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid); mutate(value);
    await assert.rejects(validateFfmpegBuildReceipt(value, { ffmpegPath: '/not/read', ffprobePath: '/not/read' }), /does not match PRE-005/u);
  }
});

test("rejects staged bytes that drift from the verified input pin", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusionkit-staged-copy-"));
  const filePath = path.join(tempRoot, "artifact");
  const expected = Buffer.from("verified input bytes");
  try {
    fs.writeFileSync(filePath, expected);
    await assert.doesNotReject(
      verifyStagedCopyMatches(filePath, {
        byteSize: expected.length,
        sha256: createHash("sha256").update(expected).digest("hex"),
      }, "fixture"),
    );
    fs.writeFileSync(filePath, Buffer.from("substituted bytes"));
    await assert.rejects(
      verifyStagedCopyMatches(filePath, {
        byteSize: expected.length,
        sha256: createHash("sha256").update(expected).digest("hex"),
      }, "fixture"),
      /do not match the verified input/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
