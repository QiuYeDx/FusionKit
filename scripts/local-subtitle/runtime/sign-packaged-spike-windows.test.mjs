import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePackagedRuntimeRoot } from "./sign-packaged-spike-windows.mjs";

test("derives the packaged Windows runtime only from the app executable", () => {
  const root = path.parse(process.cwd()).root;
  const app = path.join(root, "pre005", "win-unpacked", "FusionKit.exe");
  assert.equal(
    resolvePackagedRuntimeRoot(app),
    path.join(root, "pre005", "win-unpacked", "resources", "local-subtitle"),
  );
});
