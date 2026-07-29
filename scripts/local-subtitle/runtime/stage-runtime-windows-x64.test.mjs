import assert from "node:assert/strict";
import test from "node:test";
import { WINDOWS_FFMPEG_CANDIDATE } from "./audit-ffmpeg-windows-x64.mjs";
import { FFMPEG_SOURCE_RELEASE } from "./ffmpeg-source-release.mjs";
import {
  WHISPER_WINDOWS_CPU_CONTRACT,
  normalizeEvidenceBytesForStaging,
  resolveWindowsSigningProfile,
  validateWindowsFfmpegAuditReceipt,
} from "./stage-runtime-windows-x64.mjs";
import { getLocalSubtitleStagingTarget } from "./staging-contract.mjs";

test("pins only the required Windows CPU server and dependency artifacts", () => {
  assert.equal(
    WHISPER_WINDOWS_CPU_CONTRACT.downloadUrl,
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
  );
  assert.equal(
    WHISPER_WINDOWS_CPU_CONTRACT.acquisition,
    "official-prebuilt-release-asset",
  );
  assert.equal(WHISPER_WINDOWS_CPU_CONTRACT.releaseTag, "v1.9.1");
  assert.equal(WHISPER_WINDOWS_CPU_CONTRACT.sourceBuildRequired, false);
  assert.equal(WHISPER_WINDOWS_CPU_CONTRACT.artifacts.length, 13);
  assert.deepEqual(
    WHISPER_WINDOWS_CPU_CONTRACT.artifacts
      .filter((artifact) => artifact.kind === "server")
      .map((artifact) => artifact.fileName),
    ["whisper-server.exe"],
  );
  assert.equal(
    WHISPER_WINDOWS_CPU_CONTRACT.artifacts.some(
      (artifact) => artifact.fileName === "SDL2.dll",
    ),
    false,
  );
  const target = getLocalSubtitleStagingTarget("win32", "x64");
  assert.deepEqual(
    target.requiredArtifacts
      .filter(
        (artifact) =>
          artifact.sourceRef ===
          "whisper-cpp-v1.9.1-windows-x64-release",
      )
      .map((artifact) => artifact.relativePath.split("/").at(-1)),
    WHISPER_WINDOWS_CPU_CONTRACT.artifacts.map(
      (artifact) => artifact.fileName,
    ),
  );
});

test("defaults Windows personal distribution to an explicit unsigned profile", () => {
  assert.deepEqual(resolveWindowsSigningProfile("unsigned"), {
    mode: "unsigned",
    signatureKind: "unsigned",
    reportName: "unsigned_personal_distribution",
    certificateThumbprint: null,
  });
  assert.throws(
    () => resolveWindowsSigningProfile("unsigned", "a".repeat(40)),
    /not accepted/u,
  );
  assert.equal(
    resolveWindowsSigningProfile("authenticode", "a".repeat(40))
      .certificateThumbprint,
    "A".repeat(40),
  );
});

test("rejects a Windows FFmpeg receipt before reading binaries when PGP is missing", async () => {
  await assert.rejects(
    validateWindowsFfmpegAuditReceipt(
      {
        schemaVersion: 1,
        component: "FFmpeg",
        version: WINDOWS_FFMPEG_CANDIDATE.version,
        target: { platform: "win32", arch: "x64" },
        upstreamSource: {
          archiveSha256: FFMPEG_SOURCE_RELEASE.archiveSha256,
          signingKeyFingerprint: FFMPEG_SOURCE_RELEASE.signingKeyFingerprint,
          signatureVerification: { status: "not_run_tool_unavailable" },
        },
        binaryDistribution: {
          releaseTag: WINDOWS_FFMPEG_CANDIDATE.releaseTag,
          assetId: WINDOWS_FFMPEG_CANDIDATE.assetId,
          assetSha256: WINDOWS_FFMPEG_CANDIDATE.assetSha256,
        },
        buildAudit: {
          license: WINDOWS_FFMPEG_CANDIDATE.license,
          gplEnabled: false,
          nonfreeEnabled: false,
          version3Enabled: true,
        },
        artifacts: [],
      },
      "not-read",
    ),
    /does not match PRE-005/u,
  );
});

test("normalizes release evidence to contract LF bytes on Windows checkouts", () => {
  const normalized = normalizeEvidenceBytesForStaging(
    Buffer.from("first\r\nsecond\rthird\n", "utf8"),
  );
  assert.equal(normalized.toString("utf8"), "first\nsecond\nthird\n");
  assert.throws(
    () => normalizeEvidenceBytesForStaging("not-bytes"),
    /must be a Buffer/u,
  );
});
