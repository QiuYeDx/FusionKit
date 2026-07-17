import assert from "node:assert/strict";
import test from "node:test";
import {
  PRE005_SIGN_IGNORE,
  createElectronBuilderSpikeConfig,
} from "./generate-electron-builder-spike.mjs";

test("creates an isolated arm64 extraResources spike without mutating base config", () => {
  const base = {
    appId: "com.fusionkit.app",
    directories: { output: "release/${version}" },
    files: ["dist-electron", "dist"],
    mac: {
      target: ["dmg", "zip"],
      artifactName: "${productName}_${version}.${ext}",
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "${productName}_${version}.${ext}",
    },
  };
  const original = structuredClone(base);
  const config = createElectronBuilderSpikeConfig(base, {
    runtimeRoot: "/tmp/pre005/local-subtitle",
    releaseOutput: "/tmp/pre005/release",
  });

  assert.deepEqual(base, original);
  assert.equal(config.extraResources.length, 1);
  assert.equal(config.extraResources[0].to, "local-subtitle");
  assert.equal(config.beforePack.endsWith("electron-builder-pre005-before-pack.cjs"), true);
  assert.deepEqual(config.mac.target, [{ target: "dir", arch: ["arm64"] }]);
  assert.equal(config.mac.identity, "-");
  assert.equal(config.mac.signIgnore.includes(PRE005_SIGN_IGNORE), true);
  assert.equal(config.mac.artifactName.includes("${arch}"), true);
  assert.equal(config.win.artifactName.includes("${arch}"), true);
  assert.equal(JSON.stringify(config.mac).includes("x64"), false);
});

test("preserves existing extraResources and signIgnore rules", () => {
  const config = createElectronBuilderSpikeConfig(
    {
      extraResources: { from: "existing", to: "existing" },
      mac: { signIgnore: "existing-ignore" },
    },
    {
      runtimeRoot: "/tmp/pre005/local-subtitle",
      releaseOutput: "/tmp/pre005/release",
    },
  );
  assert.equal(config.extraResources.length, 2);
  assert.deepEqual(config.mac.signIgnore, ["existing-ignore", PRE005_SIGN_IGNORE]);
});
