import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { isPathInside } from "./sign-packaged-spike.mjs";

test("signing ignore containment covers only the staged local runtime", () => {
  const root = path.join(path.parse(process.cwd()).root, "app", "Resources", "local-subtitle");
  assert.equal(isPathInside(root, path.join(root, "mac-arm64", "media", "ffmpeg")), true);
  assert.equal(isPathInside(root, root), true);
  assert.equal(
    isPathInside(root, path.join(path.dirname(root), "local-subtitle-escape", "ffmpeg")),
    false,
  );
  assert.equal(isPathInside(root, path.join(root, "..", "app.asar")), false);
});
