import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPcm16WavFixture,
  parseExactHealthResponse,
  verifyPinnedLaunchModel,
} from "./run-native002-macos-smoke.mjs";

test("creates a deterministic mono 16 kHz PCM16 WAV", () => {
  const wav = createPcm16WavFixture(160);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320);
});

test("accepts only the exact private health response", () => {
  assert.equal(parseExactHealthResponse(Buffer.from('{"status":"ok"}')), true);
  for (const invalid of [
    "{}",
    '{"status":"ready"}',
    '{"status":"ok","extra":true}',
    "not-json",
  ]) {
    assert.throws(() => parseExactHealthResponse(Buffer.from(invalid)));
  }
});

test("binds the smoke model bytes to the pinned model manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-native002-model-"));
  try {
    const modelPath = path.join(root, "model.bin");
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(modelPath, "model-bytes");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update("model-bytes").digest("hex");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      engine: {
        version: "v1.9.1",
        commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
      },
      models: [{
        id: "large-v3-q5_0",
        byteSize: 11,
        sha256,
        defaultRecommended: true,
        bundledInInstaller: false,
      }],
    }));
    const verified = await verifyPinnedLaunchModel(modelPath, manifestPath);
    assert.equal(verified.model.sha256, sha256);
    await writeFile(modelPath, "changed");
    await assert.rejects(
      verifyPinnedLaunchModel(modelPath, manifestPath),
      /does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
