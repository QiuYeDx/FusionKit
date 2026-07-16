import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SYNTHETIC_SILENCE,
  createPcm16SilenceWav,
  generateSyntheticFixtures,
} from "./generate-synthetic-fixtures.mjs";

test("creates a deterministic 16 kHz mono PCM16 silence WAV", () => {
  const wav = createPcm16SilenceWav();
  assert.equal(wav.length, SYNTHETIC_SILENCE.byteSize);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320_000);
  assert.equal(wav.subarray(44).every((value) => value === 0), true);
});

test("writes only the non-ASCII fixture leaf and returns no absolute path", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusionkit-synthetic-audio-"));
  try {
    const result = generateSyntheticFixtures(tmpRoot);
    const fixture = result.fixtures[0];
    assert.match(fixture.relativeFileName, /[^\x00-\x7f]/);
    assert.equal(JSON.stringify(result).includes(tmpRoot), false);
    assert.equal(
      fs.statSync(path.join(tmpRoot, fixture.relativeFileName)).size,
      SYNTHETIC_SILENCE.byteSize,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
