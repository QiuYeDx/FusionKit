import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createPackagedIntegritySnapshot,
  isPathInside,
} from "./sign-packaged-spike.mjs";

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

test("freezes official runtime and overwrite addon integrity together", () => {
  const snapshot = createPackagedIntegritySnapshot(
    {
      ready: true,
      artifactSummary: [
        { id: "server", sha256: "server-hash" },
        { id: "ffmpeg", sha256: "ffmpeg-hash" },
      ],
    },
    {
      ready: true,
      generation: "addon-generation",
      artifact: { sha256: "addon-hash" },
      buildReceiptSha256: "receipt-hash",
      moduleExportsVerified: true,
    },
    "manifest-hash",
  );
  assert.deepEqual(snapshot, {
    manifestSha256: "manifest-hash",
    artifactHashes: [
      { id: "server", sha256: "server-hash" },
      { id: "ffmpeg", sha256: "ffmpeg-hash" },
    ],
    overwriteNative: {
      generation: "addon-generation",
      artifactSha256: "addon-hash",
      buildReceiptSha256: "receipt-hash",
      moduleExportsVerified: true,
    },
  });
  assert.throws(
    () => createPackagedIntegritySnapshot(
      { ready: true, artifactSummary: [] },
      { ready: true, moduleExportsVerified: false },
      "manifest-hash",
    ),
    /snapshot is incomplete/u,
  );
});
