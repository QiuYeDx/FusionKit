import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  DEVELOPMENT_RUNTIME_ROOT,
  LOCAL_SUBTITLE_STAGING_CONTRACT,
  PACKAGED_RUNTIME_ROOT,
  STAGING_ARTIFACT_NAME_PATTERN,
  STAGING_LIMITS,
  STAGING_RUNTIME_MANIFEST_RELATIVE_PATH,
  getLocalSubtitleStagingTarget,
  resolveDevelopmentRuntimeRoot,
  resolveRuntimeStagingOutputParent,
  validateLocalSubtitleStagingContract,
} from "./staging-contract.mjs";

test("loads the immutable canonical staging roots and artifact naming contract", () => {
  assert.equal(
    LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot,
    DEVELOPMENT_RUNTIME_ROOT,
  );
  assert.equal(DEVELOPMENT_RUNTIME_ROOT, "build/local-subtitle-resources/local-subtitle");
  assert.equal(PACKAGED_RUNTIME_ROOT, "local-subtitle");
  assert.equal(
    STAGING_RUNTIME_MANIFEST_RELATIVE_PATH,
    "manifests/local-subtitle-runtime.v1.json",
  );
  assert.equal(
    STAGING_ARTIFACT_NAME_PATTERN,
    "${productName}_${version}_${arch}.${ext}",
  );
  assert.deepEqual(LOCAL_SUBTITLE_STAGING_CONTRACT.limits, STAGING_LIMITS);
  assert.equal(Object.isFrozen(LOCAL_SUBTITLE_STAGING_CONTRACT), true);
  assert.equal(Object.isFrozen(LOCAL_SUBTITLE_STAGING_CONTRACT.targets[0]), true);
});

test("freezes exact macOS and Windows staging target profiles", () => {
  const mac = getLocalSubtitleStagingTarget("darwin", "arm64");
  assert.equal(mac.id, "darwin-arm64");
  assert.equal(
    mac.integrityProfile,
    "macos_nested_signed_final_bytes_sha256",
  );
  assert.deepEqual(mac.allowedSignatureKinds, ["adhoc", "developer_id"]);
  assert.deepEqual(mac.artifactVersions, {
    runner: "v1.9.1+f049fff",
    media: "8.1.2",
  });
  assert.deepEqual(
    mac.requiredArtifacts.map((artifact) => artifact.id),
    [
      "whisper-server-mac-arm64-metal-cpu",
      "ffmpeg-mac-arm64",
      "ffprobe-mac-arm64",
    ],
  );

  const windows = getLocalSubtitleStagingTarget("win32", "x64");
  assert.equal(windows.id, "win32-x64");
  assert.equal(
    windows.integrityProfile,
    "windows_unsigned_personal_final_bytes_sha256",
  );
  assert.deepEqual(windows.allowedSignatureKinds, ["unsigned"]);
  assert.equal(
    windows.requiredArtifacts.find((artifact) => artifact.kind === "server").id,
    "whisper-server-win-x64-cpu",
  );
  assert.equal(windows.requiredArtifacts.length, 15);
  assert.equal(
    windows.requiredArtifacts.filter((artifact) => artifact.kind === "server")
      .length,
    1,
  );
  assert.equal(
    windows.requiredArtifacts.filter(
      (artifact) => artifact.kind === "dynamic_library",
    ).length,
    12,
  );
  assert.equal(
    windows.requiredArtifacts.filter(
      (artifact) => artifact.kind === "ffmpeg" || artifact.kind === "ffprobe",
    ).length,
    2,
  );
  assert.deepEqual(
    windows.requiredLicenses.find(
      (license) => license.id === "ffmpeg-windows-lgpl-3.0-or-later",
    ).noticeFiles.map((file) => file.relativePath),
    [
      "licenses/FFmpeg-LICENSE.md",
      "licenses/THIRD_PARTY_NOTICES.local-subtitle.md",
    ],
  );
});

test("rejects unknown fields and drift in artifact, license, or source pins", () => {
  const unknown = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
  unknown.targets[0].downloadUrl = "https://example.invalid/runtime";
  assert.throws(
    () => validateLocalSubtitleStagingContract(unknown),
    (error) => error.code === "invalid_staging_contract",
  );

  const artifactDrift = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
  artifactDrift.targets[1].requiredArtifacts[1].backend = "cuda";
  assert.throws(
    () => validateLocalSubtitleStagingContract(artifactDrift),
    /canonical contract/u,
  );

  const licenseDrift = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
  licenseDrift.targets[1].requiredLicenses[1].spdxExpression = "MIT";
  assert.throws(
    () => validateLocalSubtitleStagingContract(licenseDrift),
    /canonical contract/u,
  );

  const sourceDrift = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
  sourceDrift.targets[0].requiredSources[1].version = "latest";
  assert.throws(
    () => validateLocalSubtitleStagingContract(sourceDrift),
    /canonical contract/u,
  );

  const noticeDrift = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
  noticeDrift.targets[0].requiredLicenses[1].noticeFiles.pop();
  assert.throws(
    () => validateLocalSubtitleStagingContract(noticeDrift),
    /canonical contract/u,
  );

  const hashDrift = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
  hashDrift.targets[1].requiredSources[1].evidenceFile.sha256 = "f".repeat(64);
  assert.throws(
    () => validateLocalSubtitleStagingContract(hashDrift),
    /canonical contract/u,
  );
});

test("rejects unsupported targets and resolves only the canonical development root", () => {
  assert.throws(
    () => getLocalSubtitleStagingTarget("darwin", "x64"),
    (error) => error.code === "unsupported_architecture",
  );
  assert.throws(
    () => getLocalSubtitleStagingTarget("linux", "x64"),
    (error) => error.code === "unsupported_platform",
  );

  const projectRoot = path.resolve("ignored-project-root");
  const runtimeRoot = resolveDevelopmentRuntimeRoot(projectRoot);
  assert.equal(
    runtimeRoot,
    path.join(projectRoot, "build", "local-subtitle-resources", "local-subtitle"),
  );
  assert.equal(
    resolveRuntimeStagingOutputParent(projectRoot),
    path.join(projectRoot, "build", "local-subtitle-resources"),
  );
});
