import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STAGING_ARTIFACT_NAME_PATTERN } from "./staging-contract.mjs";
import {
  assertBuilderConsumptionContract,
  validateRuntimeStaging,
} from "./validate-runtime-staging.mjs";

test("validates the builder contract and both canonical staged runtimes", async () => {
  await withProjectFixture(async (projectRoot) => {
    const calls = [];
    const signatureVerifier = () => true;
    const report = await validateRuntimeStaging({
      projectRoot,
      platform: "darwin",
      arch: "arm64",
      overwriteSignatureVerifier: signatureVerifier,
      verifyRuntimeBundleImpl: async (options) => {
        calls.push(["runtime", options]);
        return { ready: true, artifactCount: 3 };
      },
      verifyOverwriteNativeAddonImpl: async (options) => {
        calls.push(["overwrite", options]);
        return { ready: true, artifactId: "local-subtitle-overwrite-darwin-arm64" };
      },
    });

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
    assert.equal(report.target.id, "darwin-arm64");
    assert.equal(
      report.verificationScope,
      "point_in_time_static_plus_addon_module_probe",
    );
    assert.equal(report.officialRuntimeLaunchPerformed, false);
    assert.equal(report.overwriteAddonModuleProbePerformed, true);
    assert.equal(report.runtimeVerified, true);
    assert.equal(report.overwriteNativeVerified, true);
    assert.equal(report.artifactNamePattern, STAGING_ARTIFACT_NAME_PATTERN);
  });
});

test("validates the canonical Windows x64 runtime and addon probe contract", async () => {
  await withProjectFixture(async (projectRoot) => {
    const calls = [];
    const report = await validateRuntimeStaging({
      projectRoot,
      platform: "win32",
      arch: "x64",
      verifyRuntimeBundleImpl: async (options) => {
        calls.push(["runtime", options]);
        return { ready: true, artifactCount: 15 };
      },
      verifyOverwriteNativeAddonImpl: async (options) => {
        calls.push(["overwrite", options]);
        return { ready: true };
      },
    });
    const root = path.join(
      projectRoot,
      "build",
      "local-subtitle-resources",
      "local-subtitle",
    );
    assert.deepEqual(calls, [
      ["runtime", {
        runtimeRoot: root,
        platform: "win32",
        arch: "x64",
        scope: "all",
        launch: false,
      }],
      ["overwrite", {
        root,
        platform: "win32",
        arch: "x64",
      }],
    ]);
    assert.equal(report.target.id, "win32-x64");
    assert.equal(report.officialRuntimeLaunchPerformed, false);
    assert.equal(report.overwriteAddonModuleProbePerformed, true);
  });
});

test("rejects builder contract drift before either staging verifier", async () => {
  const mutations = [
    ["mac artifact name", (config) => {
      config.mac.artifactName = "${productName}_${version}.${ext}";
    }],
    ["win artifact name", (config) => {
      config.win.artifactName = "${productName}_${version}.${ext}";
    }],
    ["beforePack", (config) => {
      config.beforePack = "other.cjs";
    }],
    ["mapping from", (config) => {
      config.extraResources[0].from = "other";
    }],
    ["mapping to", (config) => {
      config.extraResources[0].to = "other";
    }],
    ["mapping filter", (config) => {
      config.extraResources[0].filter = ["**/*.node"];
    }],
    ["duplicate mapping", (config) => {
      config.extraResources.push(structuredClone(config.extraResources[0]));
    }],
    ["mac sign ignore", (config) => {
      config.mac.signIgnore = [];
    }],
    ["mac target arch", (config) => {
      config.mac.target[0].arch = ["x64"];
    }],
    ["win target arch", (config) => {
      config.win.target[0].arch = ["arm64"];
    }],
  ];
  for (const [label, mutate] of mutations) {
    await withProjectFixture(async (projectRoot, config) => {
      mutate(config);
      fs.writeFileSync(
        path.join(projectRoot, "electron-builder.json"),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      let verified = false;
      await assert.rejects(
        validateRuntimeStaging({
          projectRoot,
          platform: "darwin",
          arch: "arm64",
          verifyRuntimeBundleImpl: async () => {
            verified = true;
            return { ready: true };
          },
          verifyOverwriteNativeAddonImpl: async () => ({ ready: true }),
        }),
        (error) => error.code === "runtime_staging_invalid",
        label,
      );
      assert.equal(verified, false, label);
    });
  }
});

test("rejects a symbolic ancestor before either staging verifier", async () => {
  await withProjectFixture(async (projectRoot) => {
    const buildRoot = path.join(projectRoot, "build");
    const realBuildRoot = path.join(projectRoot, "real-build");
    fs.renameSync(buildRoot, realBuildRoot);
    fs.symlinkSync(realBuildRoot, buildRoot, directoryLinkType());
    let verified = false;
    await assert.rejects(
      validateRuntimeStaging({
        projectRoot,
        platform: "darwin",
        arch: "arm64",
        verifyRuntimeBundleImpl: async () => {
          verified = true;
          return { ready: true };
        },
        verifyOverwriteNativeAddonImpl: async () => ({ ready: true }),
      }),
      (error) => error.code === "runtime_staging_invalid",
    );
    assert.equal(verified, false);
  });
});

test("requires the complete exact builder consumption contract", () => {
  assert.equal(
    assertBuilderConsumptionContract(
      createBuilderConfig(),
      STAGING_ARTIFACT_NAME_PATTERN,
    ),
    true,
  );
  const expanded = createBuilderConfig();
  expanded.extraResources[0].optional = true;
  assert.throws(
    () => assertBuilderConsumptionContract(expanded, STAGING_ARTIFACT_NAME_PATTERN),
    (error) => error.code === "runtime_staging_invalid",
  );
});

test("requires both verifier results to be explicitly ready", async () => {
  for (const failedVerifier of ["runtime", "overwrite"]) {
    await withProjectFixture(async (projectRoot) => {
      await assert.rejects(
        validateRuntimeStaging({
          projectRoot,
          platform: "darwin",
          arch: "arm64",
          verifyRuntimeBundleImpl: async () => ({
            ready: failedVerifier !== "runtime",
          }),
          verifyOverwriteNativeAddonImpl: async () => ({
            ready: failedVerifier !== "overwrite",
          }),
        }),
        (error) => error.code === "runtime_staging_invalid",
        failedVerifier,
      );
    });
  }
});

test("does not pass an absent optional signature verifier to the strict verifier", async () => {
  await withProjectFixture(async (projectRoot) => {
    let overwriteOptions;
    await validateRuntimeStaging({
      projectRoot,
      platform: "darwin",
      arch: "arm64",
      verifyRuntimeBundleImpl: async () => ({ ready: true }),
      verifyOverwriteNativeAddonImpl: async (options) => {
        overwriteOptions = options;
        return { ready: true };
      },
    });
    assert.deepEqual(Object.keys(overwriteOptions).sort(), ["arch", "platform", "root"]);
  });
});

async function withProjectFixture(callback) {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "fusionkit-runtime-staging-validator-"),
  );
  const config = createBuilderConfig();
  fs.writeFileSync(
    path.join(projectRoot, "electron-builder.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  fs.mkdirSync(
    path.join(
      projectRoot,
      "build",
      "local-subtitle-resources",
      "local-subtitle",
    ),
    { recursive: true },
  );
  try {
    await callback(projectRoot, config);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function directoryLinkType() {
  return process.platform === "win32" ? "junction" : "dir";
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
      artifactName: STAGING_ARTIFACT_NAME_PATTERN,
      target: [
        { target: "dmg", arch: ["arm64"] },
        { target: "zip", arch: ["arm64"] },
      ],
      signIgnore: ["Contents/Resources/local-subtitle/"],
    },
    win: {
      artifactName: STAGING_ARTIFACT_NAME_PATTERN,
      target: [{ target: "nsis", arch: ["x64"] }],
    },
  };
}
