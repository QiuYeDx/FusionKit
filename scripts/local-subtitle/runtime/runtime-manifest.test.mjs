import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_MANIFEST_RELATIVE_PATH,
  assertSupportedRuntimeTarget,
  buildSanitizedRuntimeEnvironment,
  getWindowsPowerShellPath,
  inspectNativeBinary,
  loadRuntimeManifest,
  validateRuntimeManifest,
  verifyArtifactSignature,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";
import {
  STAGING_LIMITS,
  getLocalSubtitleStagingTarget,
} from "./staging-contract.mjs";

const acceptSignature = async () => true;
const EVIDENCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../resources/local-subtitle/licenses",
);

test("parses thin arm64 Mach-O, fat Mach-O, and x64 PE identities", () => {
  const arm64 = createMachO("arm64", "11.0.0");
  assert.deepEqual(inspectNativeBinary(arm64), {
    format: "mach-o",
    architectures: ["arm64"],
    minimumOsVersion: "11.0.0",
  });

  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x0100000c, 8);
  fat.writeUInt32BE(0x01000007, 28);
  assert.deepEqual(inspectNativeBinary(fat).architectures, ["arm64", "x64"]);

  const pe = createPe("x64");
  assert.deepEqual(inspectNativeBinary(pe), {
    format: "pe",
    architectures: ["x64"],
    minimumOsVersion: null,
  });
});

test("rejects unsupported macOS architecture before reading a manifest", async () => {
  assert.throws(
    () => assertSupportedRuntimeTarget("darwin", "x64"),
    (error) => error.code === "unsupported_architecture",
  );
  await assert.rejects(
    loadRuntimeManifest("/path/that/does/not/exist", {
      platform: "darwin",
      arch: "x64",
    }),
    (error) => error.code === "unsupported_architecture",
  );
});

test("rejects an oversized runtime manifest before JSON parsing", async () => {
  await withRuntimeFixture(
    { platform: "darwin", arch: "arm64" },
    async (fixture) => {
      fs.writeFileSync(
        fixture.manifestPath,
        Buffer.alloc(STAGING_LIMITS.maxManifestBytes + 1),
      );
      await assert.rejects(
        loadRuntimeManifest(fixture.runtimeRoot, {
          platform: "darwin",
          arch: "arm64",
        }),
        (error) => error.code === "media_runtime_invalid",
      );
    },
  );
});

test("requires exact manifest fields, contained paths, and known references", () => {
  const manifest = createManifest({ platform: "darwin", arch: "arm64" });
  assert.equal(
    validateRuntimeManifest(manifest, {
      platform: "darwin",
      arch: "arm64",
    }),
    manifest,
  );

  const unknownField = structuredClone(manifest);
  unknownField.artifacts[0].executablePath = "/tmp/injected";
  assert.throws(
    () => validateRuntimeManifest(unknownField, {
      platform: "darwin",
      arch: "arm64",
    }),
    (error) => error.code === "media_runtime_invalid",
  );

  const pathEscape = structuredClone(manifest);
  pathEscape.artifacts[1].relativePath = "../ffmpeg";
  assert.throws(
    () => validateRuntimeManifest(pathEscape, {
      platform: "darwin",
      arch: "arm64",
    }),
    (error) => error.code === "media_runtime_invalid",
  );

  const unknownLicense = structuredClone(manifest);
  unknownLicense.artifacts[1].licenseRef = "missing-license";
  assert.throws(
    () => validateRuntimeManifest(unknownLicense, {
      platform: "darwin",
      arch: "arm64",
    }),
    (error) => error.code === "media_runtime_invalid",
  );

  for (const manifestId of ["Invalid ID", "a".repeat(129), "-leading"]) {
    const invalidId = structuredClone(manifest);
    invalidId.manifestId = manifestId;
    assert.throws(
      () => validateRuntimeManifest(invalidId, {
        platform: "darwin",
        arch: "arm64",
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  }
});

test("binds integrity, artifacts, licenses, and sources to the selected target", () => {
  const manifest = createManifest({ platform: "darwin", arch: "arm64" });

  const profileDrift = structuredClone(manifest);
  profileDrift.integrityProfile =
    "windows_unsigned_personal_final_bytes_sha256";
  assert.throws(
    () => validateRuntimeManifest(profileDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /integrity profile/u,
  );

  const integrityDrift = structuredClone(manifest);
  integrityDrift.integrity.binaryHashPhase =
    "unsigned_final_bytes_before_outer_packaging";
  assert.throws(
    () => validateRuntimeManifest(integrityDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /integrity policy/u,
  );

  const artifactDrift = structuredClone(manifest);
  artifactDrift.artifacts[0].backend = "cpu";
  assert.throws(
    () => validateRuntimeManifest(artifactDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /artifact metadata/u,
  );

  const incompleteWindows = createManifest({ platform: "win32", arch: "x64" });
  incompleteWindows.artifacts.splice(1, 1);
  assert.throws(
    () => validateRuntimeManifest(incompleteWindows, {
      platform: "win32",
      arch: "x64",
    }),
    /artifacts do not match/u,
  );

  const licenseDrift = structuredClone(manifest);
  licenseDrift.licenses[1].spdxExpression = "MIT";
  assert.throws(
    () => validateRuntimeManifest(licenseDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /license metadata/u,
  );

  const sourceDrift = structuredClone(manifest);
  sourceDrift.sources[1].version = "latest";
  assert.throws(
    () => validateRuntimeManifest(sourceDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /source metadata/u,
  );

  const missingNotice = structuredClone(manifest);
  missingNotice.licenses[1].noticeFiles.pop();
  assert.throws(
    () => validateRuntimeManifest(missingNotice, {
      platform: "darwin",
      arch: "arm64",
    }),
    /notice files/u,
  );

  const evidenceHashDrift = structuredClone(manifest);
  evidenceHashDrift.sources[0].evidenceFile.sha256 = "f".repeat(64);
  assert.throws(
    () => validateRuntimeManifest(evidenceHashDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /source evidence/u,
  );

  const versionDrift = structuredClone(manifest);
  versionDrift.artifacts[0].version = "latest";
  assert.throws(
    () => validateRuntimeManifest(versionDrift, {
      platform: "darwin",
      arch: "arm64",
    }),
    /artifact metadata/u,
  );
});

test("rejects production-incompatible relative path syntax and limits", () => {
  for (const relativePath of [
    "win-x64/media/ffmpeg.exe:stream",
    "win-x64/CON/file.exe",
    "win-x64/media/trailing. ",
    `licenses/${"x".repeat(512)}`,
  ]) {
    const manifest = createManifest({ platform: "win32", arch: "x64" });
    manifest.artifacts[0].relativePath = relativePath;
    assert.throws(
      () => validateRuntimeManifest(manifest, {
        platform: "win32",
        arch: "x64",
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  }
});

test("rejects resource paths duplicated across sections ignoring case", () => {
  const manifest = createManifest({ platform: "darwin", arch: "arm64" });
  manifest.sources[0].evidenceFile.relativePath =
    manifest.licenses[0].licenseFiles[0].relativePath.toUpperCase();
  assert.throws(
    () => validateRuntimeManifest(manifest, {
      platform: "darwin",
      arch: "arm64",
    }),
    (error) => error.code === "media_runtime_invalid",
  );
});

test("sanitized child environments exclude API keys and proxy credentials", () => {
  const source = {
    OPENAI_API_KEY: "secret",
    HTTPS_PROXY: "https://secret.invalid",
    AUTHORIZATION: "Bearer secret",
    TMPDIR: "/safe-temp",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
  };
  const mac = buildSanitizedRuntimeEnvironment("darwin", source);
  assert.deepEqual(mac, {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: "/safe-temp",
  });
  const windows = buildSanitizedRuntimeEnvironment("win32", source);
  assert.equal(windows.SystemRoot, "C:\\Windows");
  assert.equal(windows.ProgramFiles, "C:\\Program Files");
  assert.equal(
    windows.PSModulePath,
    path.join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
  );
  assert.equal("OPENAI_API_KEY" in windows, false);
  assert.equal("HTTPS_PROXY" in windows, false);
  assert.equal("AUTHORIZATION" in windows, false);
  assert.equal(
    getWindowsPowerShellPath(source),
    path.join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
});

test("accepts an explicit unsigned Windows personal-distribution integrity profile", () => {
  const manifest = createManifest({ platform: "win32", arch: "x64" });
  assert.equal(
    validateRuntimeManifest(manifest, { platform: "win32", arch: "x64" }),
    manifest,
  );

  const falseClaim = structuredClone(manifest);
  falseClaim.artifacts[1].signatureKind = "authenticode";
  assert.throws(
    () => validateRuntimeManifest(falseClaim, { platform: "win32", arch: "x64" }),
    /does not match the integrity profile/u,
  );
});

test("verifies a complete macOS media bundle and launches only manifest paths", async () => {
  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    const launched = [];
    const report = await verifyRuntimeBundle({
      runtimeRoot: fixture.runtimeRoot,
      platform: "darwin",
      arch: "arm64",
      scope: "media",
      launch: true,
      commandRunner: async (command) => {
        launched.push(command);
        const name = path.basename(command);
        return {
          exitCode: 0,
          stdout: `${name} version 8.1.2 fixture\n`,
          stderr: "",
        };
      },
      signatureVerifier: acceptSignature,
    });
    assert.equal(report.ready, true);
    assert.equal(report.noPathFallback, true);
    assert.equal(report.artifactCount, 2);
    assert.equal(report.launchResults.length, 2);
    assert.equal(launched.every((value) => value.startsWith(fixture.runtimeRoot)), true);
    assert.equal(JSON.stringify(report).includes(fixture.tempRoot), false);
  });
});

test("classifies missing, changed, wrong-arch, and non-executable media tools", async () => {
  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    fs.rmSync(fixture.ffmpegPath);
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        signatureVerifier: acceptSignature,
      }),
      (error) => error.code === "media_runtime_missing",
    );
  });

  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    fs.appendFileSync(fixture.ffmpegPath, "changed");
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        signatureVerifier: acceptSignature,
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  });

  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    const x64 = createMachO("x64", "11.0.0");
    fs.writeFileSync(fixture.ffmpegPath, x64, { mode: 0o755 });
    updateArtifactEvidence(fixture, "ffmpeg", x64);
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        signatureVerifier: acceptSignature,
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  });

  if (process.platform !== "win32") {
    await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
      fs.chmodSync(fixture.ffmpegPath, 0o644);
      await assert.rejects(
        verifyRuntimeBundle({
          runtimeRoot: fixture.runtimeRoot,
          platform: "darwin",
          arch: "arm64",
          scope: "media",
          signatureVerifier: acceptSignature,
        }),
        (error) => error.code === "media_runtime_invalid",
      );
    });
  }
});

test("classifies a static-pass identity failure as media_runtime_launch_failed", async () => {
  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        launch: true,
        commandRunner: async () => ({
          exitCode: 0,
          stdout: "unexpected executable identity\n",
          stderr: "",
        }),
        signatureVerifier: acceptSignature,
      }),
      (error) => error.code === "media_runtime_launch_failed",
    );
  });
});

test("rejects runtime-root and intermediate-directory links", async () => {
  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    const realRoot = path.join(fixture.tempRoot, "real-local-subtitle");
    fs.renameSync(fixture.runtimeRoot, realRoot);
    fs.symlinkSync(realRoot, fixture.runtimeRoot, directoryLinkType());
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        signatureVerifier: acceptSignature,
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  });

  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    const licenses = path.join(fixture.runtimeRoot, "licenses");
    const realLicenses = path.join(fixture.runtimeRoot, "real-licenses");
    fs.renameSync(licenses, realLicenses);
    fs.symlinkSync(realLicenses, licenses, directoryLinkType());
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        signatureVerifier: acceptSignature,
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  });

});

test("rechecks static bytes after signature verification and launch probes", async () => {
  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    let mutated = false;
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        signatureVerifier: async (filePath) => {
          if (!mutated) {
            const bytes = fs.readFileSync(filePath);
            bytes[bytes.length - 1] ^= 0xff;
            fs.writeFileSync(filePath, bytes);
            mutated = true;
          }
          return true;
        },
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  });

  await withRuntimeFixture({ platform: "darwin", arch: "arm64" }, async (fixture) => {
    let mutated = false;
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "media",
        launch: true,
        signatureVerifier: acceptSignature,
        commandRunner: async (filePath) => {
          if (!mutated) {
            const bytes = fs.readFileSync(filePath);
            bytes[bytes.length - 1] ^= 0xff;
            fs.writeFileSync(filePath, bytes);
            mutated = true;
          }
          return {
            exitCode: 0,
            stdout: `${path.basename(filePath)} version 8.1.2 fixture\n`,
            stderr: "",
          };
        },
      }),
      (error) => error.code === "media_runtime_invalid",
    );
  });

  await withRuntimeFixture({ platform: "win32", arch: "x64" }, async (fixture) => {
    const dependency = fixture.manifest.artifacts.find(
      (artifact) => artifact.kind === "dynamic_library",
    );
    const dependencyPath = path.join(
      fixture.runtimeRoot,
      ...dependency.relativePath.split("/"),
    );
    let mutated = false;
    await assert.rejects(
      verifyRuntimeBundle({
        runtimeRoot: fixture.runtimeRoot,
        platform: "win32",
        arch: "x64",
        scope: "server",
        launch: true,
        commandRunner: async (filePath) => {
          if (!mutated) {
            const bytes = fs.readFileSync(dependencyPath);
            bytes[bytes.length - 1] ^= 0xff;
            fs.writeFileSync(dependencyPath, bytes);
            mutated = true;
          }
          return {
            exitCode: 0,
            stdout: `${path.basename(filePath)} usage fixture\n`,
            stderr: "",
          };
        },
      }),
      (error) => error.code === "runtime_protocol_mismatch",
    );
  });
});

test("validates Windows PE resources on a non-Windows host without POSIX mode rules", async () => {
  await withRuntimeFixture({ platform: "win32", arch: "x64" }, async (fixture) => {
    fs.chmodSync(fixture.ffmpegPath, 0o644);
    const report = await verifyRuntimeBundle({
      runtimeRoot: fixture.runtimeRoot,
      platform: "win32",
      arch: "x64",
      scope: "media",
      signatureVerifier: acceptSignature,
    });
    assert.equal(report.ready, true);
    assert.equal(report.artifactSummary.every(
      (artifact) => artifact.architectures[0] === "x64",
    ), true);
  });
});

test("rejects a target-architecture binary in the wrong native format", async () => {
  await withRuntimeFixture(
    { platform: "win32", arch: "x64" },
    async (fixture) => {
      await assert.rejects(
        verifyRuntimeBundle({
          runtimeRoot: fixture.runtimeRoot,
          platform: "win32",
          arch: "x64",
          scope: "media",
        }),
        (error) => error.code === "media_runtime_invalid",
      );
    },
    { binary: createMachO("x64", "11.0.0") },
  );
});

test("reports that unsigned Windows personal distribution does not require signing", async () => {
  await withRuntimeFixture({ platform: "win32", arch: "x64" }, async (fixture) => {
    const report = await verifyRuntimeBundle({
      runtimeRoot: fixture.runtimeRoot,
      platform: "win32",
      arch: "x64",
      scope: "media",
    });
    assert.equal(
      report.signatureVerification,
      "not_required_unsigned_personal_distribution",
    );
  });
});

test(
  "uses the absolute Windows PowerShell verifier for a trusted Authenticode PE",
  { skip: process.platform !== "win32" },
  async () => {
    const trustedPePath = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "where.exe",
    );
    assert.equal(
      await verifyArtifactSignature(trustedPePath, {
        platform: "win32",
        expectedKind: "authenticode",
      }),
      true,
    );
  },
);

async function withRuntimeFixture(target, callback, options = {}) {
  const tempBase = options.tempBase ?? os.tmpdir();
  fs.mkdirSync(tempBase, { recursive: true });
  const tempRoot = fs.mkdtempSync(
    path.join(tempBase, "fusionkit-runtime-manifest-"),
  );
  const runtimeRoot = path.join(tempRoot, "local-subtitle");
  const manifest = createManifest(target);
  const binary = options.binary ?? (target.platform === "darwin"
    ? createMachO("arm64", "11.0.0")
    : createPe("x64"));
  const artifactPaths = manifest.artifacts.map((artifact) => {
    const filePath = path.join(runtimeRoot, ...artifact.relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, binary, { mode: 0o755 });
    artifact.byteSize = binary.length;
    artifact.sha256 = sha256(binary);
    return [artifact.kind, filePath];
  });
  for (const license of manifest.licenses) {
    for (const record of [...license.licenseFiles, ...license.noticeFiles]) {
      copyEvidence(runtimeRoot, record.relativePath);
    }
  }
  for (const source of manifest.sources) {
    copyEvidence(runtimeRoot, source.evidenceFile.relativePath);
  }
  const manifestPath = path.join(
    runtimeRoot,
    ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/"),
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const fixture = {
    tempRoot,
    runtimeRoot,
    manifest,
    manifestPath,
    ffmpegPath: new Map(artifactPaths).get("ffmpeg"),
  };
  try {
    await callback(fixture);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function createManifest(target) {
  const targetContract = getLocalSubtitleStagingTarget(
    target.platform,
    target.arch,
  );
  const signatureKind = targetContract.allowedSignatureKinds[0];
  return {
    schemaVersion: 1,
    runtimeContractVersion: 1,
    manifestId: `local-subtitle-${target.platform}-${target.arch}-fixture`,
    target: { platform: target.platform, arch: target.arch },
    integrityProfile: targetContract.integrityProfile,
    integrity: structuredClone(targetContract.integrity),
    artifacts: targetContract.requiredArtifacts.map((required) => ({
      ...structuredClone(required),
      platform: target.platform,
      arch: target.arch,
      byteSize: 1,
      sha256: "a".repeat(64),
      version: required.kind === "ffmpeg" || required.kind === "ffprobe"
        ? targetContract.artifactVersions.media
        : targetContract.artifactVersions.runner,
      signatureKind,
    })),
    licenses: structuredClone(targetContract.requiredLicenses),
    sources: structuredClone(targetContract.requiredSources),
  };
}

function copyEvidence(runtimeRoot, relativePath) {
  const filePath = path.join(runtimeRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(
    path.join(EVIDENCE_ROOT, path.basename(relativePath)),
    filePath,
  );
}

function updateArtifactEvidence(fixture, kind, bytes) {
  const artifact = fixture.manifest.artifacts.find((entry) => entry.kind === kind);
  artifact.byteSize = bytes.length;
  artifact.sha256 = sha256(bytes);
  fs.writeFileSync(
    fixture.manifestPath,
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
  );
}

function createMachO(arch, minimumVersion) {
  const buffer = Buffer.alloc(56);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  buffer.writeUInt32LE(3, 8);
  buffer.writeUInt32LE(2, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(24, 20);
  buffer.writeUInt32LE(0, 24);
  buffer.writeUInt32LE(0, 28);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(24, 36);
  buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE(packVersion(minimumVersion), 44);
  buffer.writeUInt32LE(packVersion("26.2.0"), 48);
  buffer.writeUInt32LE(0, 52);
  return buffer;
}

function createPe(arch) {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "binary");
  buffer.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 68);
  return buffer;
}

function packVersion(value) {
  const [major, minor, patch] = value.split(".").map(Number);
  return (major << 16) | (minor << 8) | patch;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function directoryLinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}
