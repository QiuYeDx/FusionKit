import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  assertBuilderConsumptionContract,
} from "./validate-runtime-staging.mjs";

const require = createRequire(import.meta.url);
const {
  createBeforePackHook,
  findRuntimeRoot,
} = require("./electron-builder-local-subtitle-before-pack.cjs");

test("beforePack verifies the exact process target and both staged runtimes without launch", async () => {
  const projectRoot = path.resolve("ignored/project");
  const calls = [];
  const signatureVerifier = () => true;
  const hook = createBeforePackHook({
    processPlatform: "darwin",
    processArch: "arm64",
    assertBuilderConsumptionContract,
    overwriteSignatureVerifier: signatureVerifier,
    verifyRuntimeBundle: async (options) => {
      calls.push(["runtime", options]);
      return { ready: true };
    },
    verifyStagedOverwriteNativeAddon: async (options) => {
      calls.push(["overwrite", options]);
      return { ready: true };
    },
  });

  await hook(createContext(projectRoot));

  const root = path.join(
    projectRoot,
    "build",
    "local-subtitle-resources",
    "local-subtitle",
  );
  assert.deepEqual(calls, [
    ["runtime", {
      runtimeRoot: root,
      platform: "darwin",
      arch: "arm64",
      scope: "all",
      launch: false,
    }],
    ["overwrite", {
      root,
      platform: "darwin",
      arch: "arm64",
      signatureVerifier,
    }],
  ]);
});

test("beforePack rejects process, context, and packager target drift before verification", async () => {
  const cases = [
    ["process platform", { processPlatform: "win32" }, {}],
    ["process architecture", { processArch: "x64" }, {}],
    ["context architecture", {}, { arch: 1 }],
    ["packager platform", {}, { packagerPlatform: "win32" }],
  ];
  for (const [label, dependencyOverrides, contextOverrides] of cases) {
    let verified = false;
    const hook = createBeforePackHook({
      processPlatform: "darwin",
      processArch: "arm64",
      assertBuilderConsumptionContract,
      verifyRuntimeBundle: async () => {
        verified = true;
        return { ready: true };
      },
      verifyStagedOverwriteNativeAddon: async () => ({ ready: true }),
      ...dependencyOverrides,
    });
    await assert.rejects(
      hook(createContext(path.resolve("ignored/project"), contextOverrides)),
      (error) => error.code === "runtime_staging_invalid",
      label,
    );
    assert.equal(verified, false, label);
  }
});

test("beforePack fails closed when either verifier is not explicitly ready", async () => {
  for (const failedVerifier of ["runtime", "overwrite"]) {
    const hook = createBeforePackHook({
      processPlatform: "darwin",
      processArch: "arm64",
      assertBuilderConsumptionContract,
      verifyRuntimeBundle: async () => ({ ready: failedVerifier !== "runtime" }),
      verifyStagedOverwriteNativeAddon: async () => ({
        ready: failedVerifier !== "overwrite",
      }),
    });
    await assert.rejects(
      hook(createContext(path.resolve("ignored/project"))),
      (error) => error.code === "runtime_staging_invalid",
      failedVerifier,
    );
  }
});

test("beforePack resolves only one exact canonical extraResources mapping", () => {
  const projectRoot = path.resolve("ignored/project");
  const expected = path.join(
    projectRoot,
    "build",
    "local-subtitle-resources",
    "local-subtitle",
  );
  const mapping = createBuilderConfig().extraResources[0];
  assert.equal(findRuntimeRoot([mapping], projectRoot), expected);
  assert.equal(findRuntimeRoot([mapping, mapping], projectRoot), null);
  assert.equal(findRuntimeRoot([{ ...mapping, to: "other" }], projectRoot), null);
  assert.equal(findRuntimeRoot({ ...mapping }, projectRoot), null);
});

function createContext(projectRoot, overrides = {}) {
  return {
    electronPlatformName: overrides.platform ?? "darwin",
    arch: overrides.arch ?? 3,
    packager: {
      platform: { nodeName: overrides.packagerPlatform ?? "darwin" },
      info: { projectDir: projectRoot },
      config: overrides.config ?? createBuilderConfig(),
    },
  };
}

function createBuilderConfig() {
  return {
    extraResources: [{
      from: "build/local-subtitle-resources/local-subtitle",
      to: "local-subtitle",
      filter: ["**/*"],
    }],
    beforePack: "scripts/local-subtitle/runtime/electron-builder-local-subtitle-before-pack.cjs",
    mac: {
      artifactName: "${productName}_${version}_${arch}.${ext}",
      target: [
        { target: "dmg", arch: ["arm64"] },
        { target: "zip", arch: ["arm64"] },
      ],
      signIgnore: ["Contents/Resources/local-subtitle/"],
    },
    win: {
      artifactName: "${productName}_${version}_${arch}.${ext}",
      target: [{ target: "nsis", arch: ["x64"] }],
    },
  };
}
