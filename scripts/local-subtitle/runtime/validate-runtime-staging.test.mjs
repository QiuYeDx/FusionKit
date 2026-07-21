import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STAGING_ARTIFACT_NAME_PATTERN } from "./staging-contract.mjs";
import {
  assertBuilderArtifactNamePattern,
  validateRuntimeStaging,
} from "./validate-runtime-staging.mjs";

test("validates both builder artifact names before the canonical runtime root", async () => {
  await withProjectFixture(async (projectRoot) => {
    const calls = [];
    const report = await validateRuntimeStaging({
      projectRoot,
      platform: "darwin",
      arch: "arm64",
      verifyRuntimeBundleImpl: async (options) => {
        calls.push(options);
        return { ready: true, artifactCount: 3 };
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      runtimeRoot: path.join(
        projectRoot,
        "build",
        "local-subtitle-resources",
        "local-subtitle",
      ),
      platform: "darwin",
      arch: "arm64",
      scope: "all",
      launch: false,
    });
    assert.equal(report.target.id, "darwin-arm64");
    assert.equal(report.verificationScope, "point_in_time_static");
    assert.equal(report.launchPerformed, false);
    assert.equal(report.runtimeVerified, true);
    assert.equal(report.artifactNamePattern, STAGING_ARTIFACT_NAME_PATTERN);
  });
});

test("rejects either builder artifact-name drift before bundle verification", async () => {
  for (const platformKey of ["mac", "win"]) {
    await withProjectFixture(async (projectRoot, config) => {
      config[platformKey].artifactName = "${productName}_${version}.${ext}";
      fs.writeFileSync(
        path.join(projectRoot, "electron-builder.json"),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      let verified = false;
      await assert.rejects(
        validateRuntimeStaging({
          projectRoot,
          platform: "win32",
          arch: "x64",
          verifyRuntimeBundleImpl: async () => {
            verified = true;
            return { ready: true };
          },
        }),
        (error) => error.code === "runtime_staging_invalid",
      );
      assert.equal(verified, false);
    });
  }
});

test("rejects a symbolic ancestor in the canonical development runtime path", async () => {
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
      }),
      (error) => error.code === "runtime_staging_invalid",
    );
    assert.equal(verified, false);
  });
});

test("requires exact mac and Windows artifact-name patterns", () => {
  assert.equal(
    assertBuilderArtifactNamePattern(createBuilderConfig(), STAGING_ARTIFACT_NAME_PATTERN),
    true,
  );
  assert.throws(
    () => assertBuilderArtifactNamePattern(
      { mac: {}, win: { artifactName: STAGING_ARTIFACT_NAME_PATTERN } },
      STAGING_ARTIFACT_NAME_PATTERN,
    ),
    (error) => error.code === "runtime_staging_invalid",
  );
});

test("rejects a verifier result that is not explicitly ready", async () => {
  await withProjectFixture(async (projectRoot) => {
    await assert.rejects(
      validateRuntimeStaging({
        projectRoot,
        platform: "darwin",
        arch: "arm64",
        verifyRuntimeBundleImpl: async () => ({ ready: false }),
      }),
      (error) => error.code === "runtime_staging_invalid",
    );
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
    mac: { artifactName: STAGING_ARTIFACT_NAME_PATTERN },
    win: { artifactName: STAGING_ARTIFACT_NAME_PATTERN },
  };
}
