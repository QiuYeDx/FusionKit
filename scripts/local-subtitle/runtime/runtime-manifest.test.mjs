import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RUNTIME_HASH_PHASE,
  RUNTIME_MANIFEST_RELATIVE_PATH,
  assertSupportedRuntimeTarget,
  buildSanitizedRuntimeEnvironment,
  inspectNativeBinary,
  loadRuntimeManifest,
  validateRuntimeManifest,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";

const acceptSignature = async () => true;

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
  assert.equal("OPENAI_API_KEY" in windows, false);
  assert.equal("HTTPS_PROXY" in windows, false);
  assert.equal("AUTHORIZATION" in windows, false);
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

async function withRuntimeFixture(target, callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusionkit-runtime-manifest-"));
  const runtimeRoot = path.join(tempRoot, "local-subtitle");
  const manifest = createManifest(target);
  const binary = target.platform === "darwin"
    ? createMachO("arm64", "11.0.0")
    : createPe("x64");
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
      writeEvidence(runtimeRoot, record, `license:${license.id}:${record.relativePath}`);
    }
  }
  for (const source of manifest.sources) {
    writeEvidence(runtimeRoot, source.evidenceFile, `source:${source.id}`);
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
  const darwin = target.platform === "darwin";
  const root = darwin ? "mac-arm64" : "win-x64";
  const extension = darwin ? "" : ".exe";
  const signatureKind = darwin ? "adhoc" : "authenticode";
  return {
    schemaVersion: 1,
    runtimeContractVersion: 1,
    manifestId: `local-subtitle-${target.platform}-${target.arch}-fixture`,
    target: { platform: target.platform, arch: target.arch },
    integrity: {
      algorithm: "sha256",
      binaryHashPhase: RUNTIME_HASH_PHASE,
      outerSignatureCoverage: "required",
    },
    artifacts: [
      {
        id: `whisper-server-${root}`,
        kind: "server",
        platform: target.platform,
        arch: target.arch,
        backend: darwin ? "metal_cpu" : "cpu",
        relativePath: darwin
          ? `${root}/metal/whisper-server`
          : `${root}/cpu/whisper-server.exe`,
        byteSize: 1,
        sha256: "a".repeat(64),
        version: "v1.9.1",
        licenseRef: "whisper-cpp-mit",
        sourceRef: "whisper-cpp-v1.9.1",
        executable: true,
        signatureKind,
      },
      {
        id: `ffmpeg-${root}`,
        kind: "ffmpeg",
        platform: target.platform,
        arch: target.arch,
        backend: "media",
        relativePath: `${root}/media/ffmpeg${extension}`,
        byteSize: 1,
        sha256: "b".repeat(64),
        version: "8.1.2",
        licenseRef: "ffmpeg-lgpl-2.1-or-later",
        sourceRef: "ffmpeg-8.1.2",
        executable: true,
        signatureKind,
      },
      {
        id: `ffprobe-${root}`,
        kind: "ffprobe",
        platform: target.platform,
        arch: target.arch,
        backend: "media",
        relativePath: `${root}/media/ffprobe${extension}`,
        byteSize: 1,
        sha256: "c".repeat(64),
        version: "8.1.2",
        licenseRef: "ffmpeg-lgpl-2.1-or-later",
        sourceRef: "ffmpeg-8.1.2",
        executable: true,
        signatureKind,
      },
    ],
    licenses: [
      {
        id: "whisper-cpp-mit",
        component: "whisper.cpp",
        spdxExpression: "MIT",
        licenseFiles: [evidenceRecord("licenses/whisper.cpp-MIT.txt")],
        noticeFiles: [],
      },
      {
        id: "ffmpeg-lgpl-2.1-or-later",
        component: "FFmpeg",
        spdxExpression: "LGPL-2.1-or-later",
        licenseFiles: [evidenceRecord("licenses/FFmpeg-COPYING.LGPLv2.1.txt")],
        noticeFiles: [evidenceRecord("licenses/FFmpeg-LICENSE.md")],
      },
    ],
    sources: [
      {
        id: "whisper-cpp-v1.9.1",
        component: "whisper.cpp",
        version: "v1.9.1",
        evidenceFile: evidenceRecord("licenses/whisper.cpp-v1.9.1-source.json"),
      },
      {
        id: "ffmpeg-8.1.2",
        component: "FFmpeg",
        version: "8.1.2",
        evidenceFile: evidenceRecord("licenses/FFmpeg-8.1.2-source-offer.json"),
      },
    ],
  };
}

function evidenceRecord(relativePath) {
  return { relativePath, byteSize: 1, sha256: "d".repeat(64) };
}

function writeEvidence(runtimeRoot, record, value) {
  const bytes = Buffer.from(value);
  const filePath = path.join(runtimeRoot, ...record.relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  record.byteSize = bytes.length;
  record.sha256 = sha256(bytes);
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
