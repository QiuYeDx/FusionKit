#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const SYNTHETIC_SILENCE = Object.freeze({
  sampleId: "synthetic-silence-short",
  fileName: "synthetic-\u9759\u97f3-10s.wav",
  durationMs: 10_000,
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  byteSize: 320_044,
  sha256: "ee7bea4232762775f8fce9b3e27e4d3948c8ac6a45a87ca769f703d6eed0b448",
});

export function createPcm16SilenceWav(spec = SYNTHETIC_SILENCE) {
  const frameCount = (spec.durationMs * spec.sampleRate) / 1_000;
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error("Synthetic fixture duration must resolve to a positive frame count.");
  }
  const blockAlign = spec.channels * (spec.bitsPerSample / 8);
  const dataBytes = frameCount * blockAlign;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(spec.channels, 22);
  buffer.writeUInt32LE(spec.sampleRate, 24);
  buffer.writeUInt32LE(spec.sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(spec.bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export function generateSyntheticFixtures(outputRoot) {
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    throw new Error("An output directory is required.");
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const wav = createPcm16SilenceWav();
  const sha256 = createHash("sha256").update(wav).digest("hex");
  if (wav.length !== SYNTHETIC_SILENCE.byteSize || sha256 !== SYNTHETIC_SILENCE.sha256) {
    throw new Error("Synthetic fixture bytes do not match the committed manifest evidence.");
  }
  fs.writeFileSync(path.join(outputRoot, SYNTHETIC_SILENCE.fileName), wav, {
    flag: "wx",
  });
  return {
    schemaVersion: 1,
    fixtures: [
      {
        sampleId: SYNTHETIC_SILENCE.sampleId,
        relativeFileName: SYNTHETIC_SILENCE.fileName,
        durationMs: SYNTHETIC_SILENCE.durationMs,
        byteSize: wav.length,
        sha256,
      },
    ],
  };
}

function parseArguments(argv) {
  let outputRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") {
      outputRoot = argv[++index];
      if (!outputRoot || outputRoot.startsWith("--")) {
        throw new Error("--output requires a directory.");
      }
    } else if (value === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!outputRoot) throw new Error("--output is required.");
  return { outputRoot };
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log("Usage: node generate-synthetic-fixtures.mjs --output <local-directory>");
    return 0;
  }
  const result = generateSyntheticFixtures(path.resolve(args.outputRoot));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
