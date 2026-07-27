import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMacosArm64OverwriteAddon } from "./build-addon-macos-arm64.mjs";
import {
  stageOverwriteNativeAddon,
  verifyStagedOverwriteNativeAddon,
} from "./overwrite-native-staging.mjs";

const MACOS_ARM64 = process.platform === "darwin" && process.arch === "arm64";

test(
  "stages and verifies a real production macOS addon with default dependencies",
  { skip: !MACOS_ARM64, timeout: 120_000 },
  async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-overwrite-real-staging-"),
    );
    const runtimeRoot = path.join(tempRoot, "local-subtitle");
    const addonPath = path.join(tempRoot, "local-subtitle-overwrite.node");
    const receiptPath = path.join(tempRoot, "build-receipt.json");
    try {
      await mkdir(runtimeRoot, { recursive: true });
      await buildMacosArm64OverwriteAddon({
        outputPath: addonPath,
        receiptPath,
      });
      const staged = await stageOverwriteNativeAddon({
        root: runtimeRoot,
        addonPath,
        buildReceiptPath: receiptPath,
        platform: "darwin",
        arch: "arm64",
        signingIdentity: "-",
      });
      assert.equal(staged.ready, true);
      const verified = await verifyStagedOverwriteNativeAddon({
        root: runtimeRoot,
        platform: "darwin",
        arch: "arm64",
      });
      assert.equal(verified.ready, true);
      assert.equal(verified.moduleExportsVerified, true);
      assert.equal(verified.artifact.sha256.length, 64);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test("stages signed macOS final bytes under a content-addressed atomic subtree", async () => {
  const fixture = await createFixture("darwin", "arm64");
  let signerCalls = 0;
  try {
    const report = await stageOverwriteNativeAddon(
      fixture.stageOptions,
      dependencies(fixture, {
        signer: async (filePath) => {
          signerCalls += 1;
          await appendFile(filePath, "-nested-signature");
          return "adhoc";
        },
      }),
    );
    assert.equal(report.ready, true);
    assert.equal(report.staged, true);
    assert.equal(report.contentAddressed, true);
    assert.equal(report.atomicNoClobberPublication, true);
    assert.equal(report.privacy.absolutePathsRecorded, false);
    assert.equal(JSON.stringify(report).includes(fixture.root), false);
    assert.equal(signerCalls, 1);

    const manifest = await readManifest(fixture.root);
    const unsignedHash = sha256(fixture.addonBytes);
    assert.notEqual(manifest.artifact.sha256, unsignedHash);
    assert.equal(
      path.posix.basename(manifest.artifact.relativePath),
      `local-subtitle-overwrite.${manifest.artifact.sha256}.node`,
    );
    assert.equal(
      manifest.integrity.binaryHashPhase,
      "after_nested_code_signing_before_outer_bundle_signing",
    );
    assert.equal(manifest.buildReceipt.artifactHashPhase, "unsigned_link_output");
    const stagedReceipt = JSON.parse(
      await readFile(
        path.join(fixture.root, "overwrite/v1/build-receipt.v1.json"),
        "utf8",
      ),
    );
    assert.equal(stagedReceipt.artifact.sha256, unsignedHash);

    const verified = await verifyStagedOverwriteNativeAddon(
      {
        root: fixture.root,
        platform: "darwin",
        arch: "arm64",
        signatureVerifier: async () => true,
      },
      dependencies(fixture),
    );
    assert.equal(verified.ready, true);
    assert.equal(verified.generation.length, 64);
    assert.equal(verified.moduleExportsVerified, true);
    assert.equal(verified.noPathFallback, true);
    assert.deepEqual(await residualPartialNames(fixture.root), []);
  } finally {
    await fixture.cleanup();
  }
});

test("stages Windows unsigned final bytes without invoking a signer", async () => {
  const fixture = await createFixture("win32", "x64");
  let signerCalls = 0;
  try {
    const report = await stageOverwriteNativeAddon(
      fixture.stageOptions,
      dependencies(fixture, {
        signer: async () => {
          signerCalls += 1;
          return "unsigned";
        },
      }),
    );
    const manifest = await readManifest(fixture.root);
    assert.equal(report.ready, true);
    assert.equal(signerCalls, 0);
    assert.equal(manifest.integrity.signatureKind, "unsigned");
    assert.equal(manifest.artifact.sha256, sha256(fixture.addonBytes));
    assert.equal(
      manifest.integrity.binaryHashPhase,
      "unsigned_final_bytes_before_outer_packaging",
    );
    const verified = await verifyStagedOverwriteNativeAddon(
      { root: fixture.root, platform: "win32", arch: "x64" },
      dependencies(fixture),
    );
    assert.equal(verified.ready, true);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects test-only receipts and test-only module exports before publication", async () => {
  const receiptFixture = await createFixture("darwin", "arm64", {
    receiptMutation(receipt) {
      receipt.testOnly = true;
      receipt.testFaultInjection = true;
    },
  });
  try {
    await assert.rejects(
      stageOverwriteNativeAddon(
        receiptFixture.stageOptions,
        dependencies(receiptFixture),
      ),
      (error) => error?.code === "overwrite_staging_invalid",
    );
    assert.equal(await exists(path.join(receiptFixture.root, "overwrite/v1")), false);
  } finally {
    await receiptFixture.cleanup();
  }

  const exportFixture = await createFixture("darwin", "arm64");
  try {
    await assert.rejects(
      stageOverwriteNativeAddon(
        exportFixture.stageOptions,
        dependencies(exportFixture, {
          moduleProbe: async () => ({
            ...validModuleIdentity(exportFixture),
            keys: [
              ...validModuleIdentity(exportFixture).keys,
              "testFaultInjection",
            ],
          }),
        }),
      ),
      (error) => error?.code === "overwrite_module_invalid",
    );
    assert.equal(await exists(path.join(exportFixture.root, "overwrite/v1")), false);
    assert.deepEqual(await residualPartialNames(exportFixture.root), []);
  } finally {
    await exportFixture.cleanup();
  }
});

test("rejects stale receipt bytes and preserves a prior no-clobber generation", async () => {
  const stale = await createFixture("win32", "x64");
  try {
    await appendFile(stale.addonPath, "-changed-after-receipt");
    await assert.rejects(
      stageOverwriteNativeAddon(stale.stageOptions, dependencies(stale)),
      (error) => error?.code === "overwrite_build_receipt_invalid",
    );
    assert.equal(await exists(path.join(stale.root, "overwrite/v1")), false);
  } finally {
    await stale.cleanup();
  }

  const existing = await createFixture("win32", "x64");
  try {
    const deps = dependencies(existing);
    const first = await stageOverwriteNativeAddon(existing.stageOptions, deps);
    const manifestBefore = await readFile(
      path.join(existing.root, "overwrite/v1/local-subtitle-overwrite.v1.json"),
    );
    await assert.rejects(
      stageOverwriteNativeAddon(existing.stageOptions, deps),
      (error) => error?.code === "overwrite_staging_exists",
    );
    const manifestAfter = await readFile(
      path.join(existing.root, "overwrite/v1/local-subtitle-overwrite.v1.json"),
    );
    assert.equal(first.ready, true);
    assert.deepEqual(manifestAfter, manifestBefore);
  } finally {
    await existing.cleanup();
  }
});

test("fails verification for tampering, symbolic leaves, and signature-time mutation", async () => {
  const tampered = await createFixture("win32", "x64");
  try {
    const deps = dependencies(tampered);
    await stageOverwriteNativeAddon(tampered.stageOptions, deps);
    const manifest = await readManifest(tampered.root);
    const artifactPath = path.join(
      tampered.root,
      "overwrite/v1",
      ...manifest.artifact.relativePath.split("/"),
    );
    await appendFile(artifactPath, "tampered");
    await assert.rejects(
      verifyStagedOverwriteNativeAddon(
        { root: tampered.root, platform: "win32", arch: "x64" },
        deps,
      ),
      (error) => error?.code === "overwrite_addon_invalid",
    );
  } finally {
    await tampered.cleanup();
  }

  const symbolic = await createFixture("win32", "x64");
  try {
    const deps = dependencies(symbolic);
    await stageOverwriteNativeAddon(symbolic.stageOptions, deps);
    const manifest = await readManifest(symbolic.root);
    const artifactPath = path.join(
      symbolic.root,
      "overwrite/v1",
      ...manifest.artifact.relativePath.split("/"),
    );
    const outside = path.join(symbolic.tempRoot, "outside.node");
    await writeFile(outside, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(outside, artifactPath, "file");
    await assert.rejects(
      verifyStagedOverwriteNativeAddon(
        { root: symbolic.root, platform: "win32", arch: "x64" },
        deps,
      ),
      (error) => error?.code === "overwrite_staging_invalid",
    );
  } finally {
    await symbolic.cleanup();
  }

  const signatureRace = await createFixture("darwin", "arm64");
  try {
    const deps = dependencies(signatureRace);
    await stageOverwriteNativeAddon(signatureRace.stageOptions, deps);
    await assert.rejects(
      verifyStagedOverwriteNativeAddon(
        {
          root: signatureRace.root,
          platform: "darwin",
          arch: "arm64",
          signatureVerifier: async (filePath) => {
            await appendFile(filePath, "signature-race");
            return true;
          },
        },
        deps,
      ),
      (error) => error?.code === "overwrite_addon_invalid",
    );
  } finally {
    await signatureRace.cleanup();
  }
});

test("shares the runtime 256 KiB overwrite manifest limit", async () => {
  const fixture = await createFixture("win32", "x64");
  try {
    const deps = dependencies(fixture);
    await stageOverwriteNativeAddon(fixture.stageOptions, deps);
    const manifestPath = path.join(
      fixture.root,
      "overwrite/v1/local-subtitle-overwrite.v1.json",
    );
    const currentSize = (await lstat(manifestPath)).size;
    await appendFile(manifestPath, " ".repeat(256 * 1024 - currentSize + 1));

    await assert.rejects(
      verifyStagedOverwriteNativeAddon(
        { root: fixture.root, platform: "win32", arch: "x64" },
        deps,
      ),
      (error) => error?.code === "overwrite_manifest_invalid",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("keeps the builder-facing verifier options exact and target-first", async () => {
  await assert.rejects(
    verifyStagedOverwriteNativeAddon({
      root: "/definitely/missing",
      platform: "darwin",
      arch: "x64",
    }),
    (error) => error?.code === "unsupported_architecture",
  );
  await assert.rejects(
    verifyStagedOverwriteNativeAddon({
      root: "/definitely/missing",
      platform: "linux",
      arch: "x64",
    }),
    (error) => error?.code === "unsupported_platform",
  );
  await assert.rejects(
    verifyStagedOverwriteNativeAddon({
      root: "/definitely/missing",
      platform: "darwin",
      arch: "arm64",
      signatureVerifier: async () => true,
      fallbackPath: process.cwd(),
    }),
    (error) => error?.code === "overwrite_staging_invalid",
  );
});

async function createFixture(platform, arch, options = {}) {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-overwrite-staging-test-"),
  );
  const root = path.join(tempRoot, "local-subtitle");
  await mkdir(root, { recursive: true });
  const addonBytes = Buffer.from(`production-${platform}-${arch}-addon`);
  const addonPath = path.join(tempRoot, "production.node");
  const receiptPath = path.join(tempRoot, "production-receipt.json");
  await writeFile(addonPath, addonBytes, { mode: 0o755 });
  const receipt = platform === "darwin"
    ? macReceipt(addonBytes)
    : windowsReceipt(addonBytes);
  options.receiptMutation?.(receipt);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    tempRoot,
    root,
    platform,
    arch,
    addonBytes,
    addonPath,
    receiptPath,
    stageOptions: {
      root,
      addonPath,
      buildReceiptPath: receiptPath,
      platform,
      arch,
      ...(platform === "darwin" ? { signingIdentity: "-" } : {}),
    },
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

function dependencies(fixture, overrides = {}) {
  return {
    signer: async (filePath) => {
      await appendFile(filePath, "-nested-signature");
      return "adhoc";
    },
    signatureVerifier: async () => true,
    nativeInspector: async () => ({
      format: fixture.platform === "darwin" ? "mach-o" : "pe",
      architectures: [fixture.arch],
      minimumOsVersion: fixture.platform === "darwin" ? "11.0.0" : null,
      hasLoadCommandUuid: fixture.platform === "darwin",
    }),
    moduleProbe: async () => validModuleIdentity(fixture),
    ...overrides,
  };
}

function validModuleIdentity(fixture) {
  return {
    keys: [
      "protocolVersion",
      "platform",
      "architecture",
      "begin",
      "recover",
      "acknowledge",
    ],
    protocolVersion: 4,
    platform: fixture.platform,
    architecture: fixture.arch,
    types: {
      begin: "function",
      recover: "function",
      acknowledge: "function",
    },
  };
}

function macReceipt(bytes) {
  return {
    schemaVersion: 1,
    workPackage: "FS-TXN-001F",
    component: "local-subtitle-overwrite",
    target: { platform: "darwin", arch: "arm64" },
    build: {
      recipe:
        "scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs",
      source: "native/local-subtitle-overwrite/src/addon.cc",
      nodeVersion: "20.19.5",
      napiVersion: 8,
      nativeProtocolVersion: 4,
      journalVersion: 3,
      cxxStandard: "c++17",
      deploymentTarget: "11.0",
      sdkVersion: "15.5",
      compiler: "xcrun clang++",
      shell: false,
    },
    artifact: {
      logicalFileName: "local-subtitle-overwrite.node",
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      format: "mach-o",
      architecture: "arm64",
      minimumMacosVersion: "11.0.0",
    },
    privacy: privacyRecord(),
  };
}

function windowsReceipt(bytes) {
  return {
    schemaVersion: 1,
    workPackage: "FS-TXN-001F",
    component: "local-subtitle-overwrite",
    target: { platform: "win32", arch: "x64" },
    build: {
      recipe:
        "scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs",
      source: "native/local-subtitle-overwrite/src/addon-win32.cc",
      nodeVersion: "20.19.5",
      napiVersion: 8,
      nativeProtocolVersion: 4,
      journalVersion: 3,
      cxxStandard: "c++17",
      minimumWindowsVersion: "10.0",
      compiler: "portable llvm-mingw clang++",
      shell: false,
      nodeImportLibrarySha256: "c".repeat(64),
    },
    artifact: {
      logicalFileName: "local-subtitle-overwrite.node",
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      format: "pe",
      architecture: "x64",
    },
    privacy: privacyRecord(),
  };
}

function privacyRecord() {
  return {
    absolutePathsRecorded: false,
    usernameRecorded: false,
    sourceContentRecorded: false,
  };
}

async function readManifest(root) {
  return JSON.parse(
    await readFile(
      path.join(root, "overwrite/v1/local-subtitle-overwrite.v1.json"),
      "utf8",
    ),
  );
}

async function residualPartialNames(root) {
  const overwriteRoot = path.join(root, "overwrite");
  if (!(await exists(overwriteRoot))) return [];
  return (await readdir(overwriteRoot)).filter((name) => name.includes("partial"));
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
