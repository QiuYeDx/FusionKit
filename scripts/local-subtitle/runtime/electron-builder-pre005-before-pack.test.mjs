import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { findRuntimeRoot } = require("./electron-builder-pre005-before-pack.cjs");

test("beforePack resolves only the explicit local-subtitle extraResources entry", () => {
  const expected = path.resolve("ignored/runtime/local-subtitle");
  assert.equal(
    findRuntimeRoot([
      { from: "other", to: "other" },
      { from: "ignored/runtime/local-subtitle", to: "local-subtitle" },
    ]),
    expected,
  );
  assert.equal(findRuntimeRoot({ from: "other", to: "other" }), null);
  assert.equal(findRuntimeRoot("unstructured-path"), null);
});
