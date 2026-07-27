import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { createElectronBuilderSpikeConfig } from "./generate-electron-builder-spike.mjs";

const require = createRequire(import.meta.url);
const { findRuntimeRoot } = require("./electron-builder-pre005-before-pack.cjs");

test("keeps the historical PRE-005 spike on its path-based preflight", () => {
  const runtimeRoot = path.resolve("ignored/runtime/local-subtitle");
  const config = createElectronBuilderSpikeConfig(
    { mac: {}, win: {} },
    {
      runtimeRoot,
      releaseOutput: path.resolve("ignored/release"),
      platform: "darwin",
      arch: "arm64",
    },
  );

  assert.equal(config.beforePack.endsWith("electron-builder-pre005-before-pack.cjs"), true);
  assert.equal(findRuntimeRoot(config.extraResources), runtimeRoot);
  assert.equal(findRuntimeRoot({ from: "other", to: "other" }), null);
});
