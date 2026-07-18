import assert from "node:assert/strict";
import test from "node:test";
import { WINDOWS_FFMPEG_CANDIDATE } from "./audit-ffmpeg-windows-x64.mjs";
import { FFMPEG_SOURCE_RELEASE } from "./ffmpeg-source-release.mjs";
import {
  WHISPER_WINDOWS_CPU_CONTRACT,
  resolveWindowsSigningProfile,
  validateWindowsFfmpegAuditReceipt,
} from "./stage-runtime-windows-x64.mjs";

test("pins only the required Windows CPU server and dependency artifacts", () => {
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
