import assert from "node:assert/strict";
import test from "node:test";
import {
  OVERWRITE_STAGING_CONTRACT,
  getOverwriteStagingTarget,
  parseOverwriteAddonManifest,
  parseOverwriteBuildReceipt,
  parseOverwriteStagingContract,
} from "./overwrite-staging-contract.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("freezes an exact two-target overwrite staging contract", () => {
  assert.equal(Object.isFrozen(OVERWRITE_STAGING_CONTRACT), true);
  assert.equal(Object.isFrozen(OVERWRITE_STAGING_CONTRACT.targets), true);
  assert.equal(
    OVERWRITE_STAGING_CONTRACT.manifestRelativePath,
    "overwrite/v1/local-subtitle-overwrite.v1.json",
  );
  assert.equal(
    OVERWRITE_STAGING_CONTRACT.artifactLeafPattern,
    "local-subtitle-overwrite.<sha256>.node",
  );
  assert.deepEqual(
    OVERWRITE_STAGING_CONTRACT.targets.map(({ id, compatibility }) => ({
      id,
      compatibility,
    })),
    [
      {
        id: "darwin-arm64",
        compatibility: {
          napiVersion: 8,
          nativeProtocolVersion: 4,
          journalVersion: 3,
        },
      },
      {
        id: "win32-x64",
        compatibility: {
          napiVersion: 8,
          nativeProtocolVersion: 4,
          journalVersion: 3,
        },
      },
    ],
  );
});

test("rejects unknown contract fields and target policy drift", () => {
  assert.throws(
    () =>
      parseOverwriteStagingContract({
        ...structuredClone(OVERWRITE_STAGING_CONTRACT),
        bypass: true,
      }),
    (error) => error?.code === "overwrite_staging_invalid",
  );
  const drifted = structuredClone(OVERWRITE_STAGING_CONTRACT);
  drifted.targets[0].compatibility.nativeProtocolVersion = 5;
  assert.throws(
    () => parseOverwriteStagingContract(drifted),
    (error) => error?.code === "overwrite_staging_invalid",
  );
  assert.throws(
    () => getOverwriteStagingTarget("darwin", "x64"),
    (error) => error?.code === "unsupported_architecture",
  );
  assert.throws(
    () => getOverwriteStagingTarget("linux", "x64"),
    (error) => error?.code === "unsupported_platform",
  );
});

test("accepts bounded work-package provenance but pins production compatibility", () => {
  const target = getOverwriteStagingTarget("darwin", "arm64");
  const receipt = macReceipt();
  assert.equal(parseOverwriteBuildReceipt(receipt, target), receipt);
  assert.equal(Object.isFrozen(receipt), true);

  for (const mutation of [
    (value) => { value.workPackage = "FS-TXN-001G"; },
    (value) => { value.build.nativeProtocolVersion = 5; },
    (value) => { value.build.napiVersion = 9; },
    (value) => { value.build.recipe = "arbitrary-builder.mjs"; },
    (value) => { value.testOnly = true; },
  ]) {
    const candidate = macReceipt();
    mutation(candidate);
    if (candidate.workPackage === "FS-TXN-001G" && !candidate.testOnly) {
      assert.doesNotThrow(() => parseOverwriteBuildReceipt(candidate, target));
    } else {
      assert.throws(() => parseOverwriteBuildReceipt(candidate, target));
    }
  }
  const unsafeProvenance = macReceipt();
  unsafeProvenance.workPackage = "../../test-only";
  assert.throws(() => parseOverwriteBuildReceipt(unsafeProvenance, target));
});

test("requires a content-addressed exact overwrite manifest", () => {
  const manifest = macManifest();
  const parsed = parseOverwriteAddonManifest(manifest, {
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(parsed, manifest);
  assert.equal(Object.isFrozen(parsed.artifact), true);

  const wrongLeaf = structuredClone(manifest);
  wrongLeaf.artifact.relativePath =
    "native/darwin-arm64/local-subtitle-overwrite." + HASH_B + ".node";
  assert.throws(() =>
    parseOverwriteAddonManifest(wrongLeaf, {
      platform: "darwin",
      arch: "arm64",
    }));

  const expanded = structuredClone(manifest);
  expanded.artifact.testFaultInjection = true;
  assert.throws(() =>
    parseOverwriteAddonManifest(expanded, {
      platform: "darwin",
      arch: "arm64",
    }));

  assert.throws(() =>
    parseOverwriteAddonManifest(manifest, {
      platform: "win32",
      arch: "x64",
    }));
});

function macReceipt() {
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
      byteSize: 128,
      sha256: HASH_A,
      format: "mach-o",
      architecture: "arm64",
      minimumMacosVersion: "11.0.0",
    },
    privacy: {
      absolutePathsRecorded: false,
      usernameRecorded: false,
      sourceContentRecorded: false,
    },
  };
}

function macManifest() {
  return {
    schemaVersion: 1,
    component: "local-subtitle-overwrite",
    target: { platform: "darwin", arch: "arm64" },
    compatibility: {
      napiVersion: 8,
      nativeProtocolVersion: 4,
      journalVersion: 3,
    },
    integrity: {
      algorithm: "sha256",
      binaryHashPhase:
        "after_nested_code_signing_before_outer_bundle_signing",
      signatureKind: "adhoc",
    },
    artifact: {
      relativePath:
        "native/darwin-arm64/local-subtitle-overwrite." + HASH_A + ".node",
      byteSize: 128,
      sha256: HASH_A,
      format: "mach-o",
      architecture: "arm64",
      minimumOsVersion: "11.0.0",
      hasLoadCommandUuid: true,
    },
    buildReceipt: {
      relativePath: "build-receipt.v1.json",
      byteSize: 512,
      sha256: HASH_B,
      artifactHashPhase: "unsigned_link_output",
    },
  };
}
