import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const PCM_FORMAT = 1;
const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const TARGET_BITS_PER_SAMPLE = 16;
const MAX_FFMPEG_DIAGNOSTIC_CHARS = 8_000;

export async function normalizeMediaToPcm16Wav(options) {
  for (const [label, filePath] of [
    ["FFmpeg", options.ffmpegPath],
    ["input media", options.inputPath],
  ]) {
    if (!path.isAbsolute(filePath ?? "")) {
      throw new Error(`${label} path must be absolute.`);
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${label} must be a regular file.`);
  }
  if (!path.isAbsolute(options.outputPath ?? "")) {
    throw new Error("Normalized WAV output path must be absolute.");
  }

  const started = performance.now();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    options.inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    String(TARGET_CHANNELS),
    "-ar",
    String(TARGET_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    options.outputPath,
  ];
  const child = (options.spawnImpl ?? spawn)(options.ffmpegPath, args, {
    cwd: path.dirname(options.outputPath),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(
      -MAX_FFMPEG_DIAGNOSTIC_CHARS,
    );
  });
  const detachAbort = forwardAbort(options.signal, child);

  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (options.signal?.aborted) {
      throw new Error("Media normalization was cancelled.");
    }
    if (exit.code !== 0) {
      throw new Error(
        `FFmpeg media normalization failed (${exit.code ?? exit.signal ?? "unknown"}): ` +
        redactFfmpegDiagnostic(stderr, options.inputPath, options.outputPath),
      );
    }
    const metadata = await inspectPcm16Wav(options.outputPath);
    return {
      ...metadata,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    await rm(options.outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    detachAbort();
  }
}

export async function inspectPcm16Wav(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size < 44) {
    throw new Error("Normalized WAV is missing or too small.");
  }
  const handle = await open(filePath, "r");
  try {
    const riff = await readExactly(handle, 12, 0);
    if (
      riff.toString("ascii", 0, 4) !== "RIFF" ||
      riff.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("Normalized media is not a RIFF/WAVE file.");
    }

    let offset = 12;
    let format;
    let data;
    while (offset + 8 <= fileStat.size) {
      const header = await readExactly(handle, 8, offset);
      const chunkId = header.toString("ascii", 0, 4);
      const chunkSize = header.readUInt32LE(4);
      const dataOffset = offset + 8;
      if (dataOffset + chunkSize > fileStat.size) {
        throw new Error(`WAV chunk ${chunkId} exceeds the file boundary.`);
      }
      if (chunkId === "fmt ") {
        if (chunkSize < 16) throw new Error("WAV fmt chunk is incomplete.");
        const value = await readExactly(handle, 16, dataOffset);
        format = {
          audioFormat: value.readUInt16LE(0),
          channels: value.readUInt16LE(2),
          sampleRate: value.readUInt32LE(4),
          byteRate: value.readUInt32LE(8),
          blockAlign: value.readUInt16LE(12),
          bitsPerSample: value.readUInt16LE(14),
        };
      } else if (chunkId === "data") {
        data = { dataOffset, dataSize: chunkSize };
      }
      if (format && data) break;
      offset = dataOffset + chunkSize + (chunkSize % 2);
    }

    if (!format || !data) {
      throw new Error("Normalized WAV is missing fmt or data chunks.");
    }
    const expectedBlockAlign = TARGET_CHANNELS * (TARGET_BITS_PER_SAMPLE / 8);
    if (
      format.audioFormat !== PCM_FORMAT ||
      format.channels !== TARGET_CHANNELS ||
      format.sampleRate !== TARGET_SAMPLE_RATE ||
      format.bitsPerSample !== TARGET_BITS_PER_SAMPLE ||
      format.blockAlign !== expectedBlockAlign ||
      format.byteRate !== TARGET_SAMPLE_RATE * expectedBlockAlign
    ) {
      throw new Error("Normalized WAV must be 16 kHz mono PCM16.");
    }
    if (data.dataSize <= 0 || data.dataSize % format.blockAlign !== 0) {
      throw new Error("Normalized WAV data is empty or not frame-aligned.");
    }
    const totalFrames = data.dataSize / format.blockAlign;
    return {
      fileSizeBytes: fileStat.size,
      dataOffset: data.dataOffset,
      dataSizeBytes: data.dataSize,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bitsPerSample,
      blockAlign: format.blockAlign,
      byteRate: format.byteRate,
      totalFrames,
      durationMs: framesToMilliseconds(totalFrames, format.sampleRate),
    };
  } finally {
    await handle.close();
  }
}

export function planPcmWindows(metadata, options = {}) {
  const sampleRate = requirePositiveInteger(metadata.sampleRate, "sampleRate");
  const totalFrames = requirePositiveInteger(metadata.totalFrames, "totalFrames");
  const rangeStartFrame = options.rangeStartFrame ?? 0;
  const rangeEndFrame = options.rangeEndFrame ?? totalFrames;
  const ownedStartFrame = options.ownedStartFrame ?? rangeStartFrame;
  const ownedEndFrame = options.ownedEndFrame ?? rangeEndFrame;
  for (const [label, value] of [
    ["rangeStartFrame", rangeStartFrame],
    ["rangeEndFrame", rangeEndFrame],
    ["ownedStartFrame", ownedStartFrame],
    ["ownedEndFrame", ownedEndFrame],
  ]) {
    if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  }
  if (
    rangeStartFrame < 0 ||
    rangeEndFrame > totalFrames ||
    rangeEndFrame <= rangeStartFrame ||
    ownedStartFrame < rangeStartFrame ||
    ownedEndFrame > rangeEndFrame ||
    ownedEndFrame <= ownedStartFrame
  ) {
    throw new Error("PCM window range or owned range is invalid.");
  }

  const windowMs = options.windowMs ?? 30_000;
  const overlapMs = options.overlapMs ?? 5_000;
  const windowFrames = millisecondsToFrames(windowMs, sampleRate);
  const overlapFrames = millisecondsToFrames(overlapMs, sampleRate);
  if (overlapFrames < 0 || overlapFrames >= windowFrames) {
    throw new Error("PCM window overlap must be non-negative and smaller than the window.");
  }
  const stepFrames = windowFrames - overlapFrames;
  const ranges = [];
  for (let startFrame = rangeStartFrame; startFrame < rangeEndFrame;) {
    const endFrame = Math.min(rangeEndFrame, startFrame + windowFrames);
    ranges.push({ startFrame, endFrame });
    if (endFrame === rangeEndFrame) break;
    startFrame += stepFrames;
  }

  return ranges.map((range, index) => {
    const previous = ranges[index - 1];
    const next = ranges[index + 1];
    const naturalCoreStart = previous
      ? Math.floor((previous.endFrame + range.startFrame) / 2)
      : rangeStartFrame;
    const naturalCoreEnd = next
      ? Math.floor((range.endFrame + next.startFrame) / 2)
      : rangeEndFrame;
    const coreStartFrame = Math.max(ownedStartFrame, naturalCoreStart);
    const coreEndFrame = Math.min(ownedEndFrame, naturalCoreEnd);
    if (coreEndFrame <= coreStartFrame) {
      throw new Error("PCM window plan produced an empty owned core.");
    }
    const startMs = framesToMilliseconds(range.startFrame, sampleRate);
    const endMs = framesToMilliseconds(range.endFrame, sampleRate);
    return {
      index,
      depth: options.depth ?? 0,
      key: `${options.keyPrefix ?? "w"}${String(index).padStart(3, "0")}`,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      coreStartFrame,
      coreEndFrame,
      startMs,
      endMs,
      coreStartMs: framesToMilliseconds(coreStartFrame, sampleRate),
      coreEndMs: framesToMilliseconds(coreEndFrame, sampleRate),
      durationMs: endMs - startMs,
    };
  });
}

export async function writePcmWindow(options) {
  const { metadata, window } = options;
  if (!path.isAbsolute(options.sourcePath) || !path.isAbsolute(options.outputPath)) {
    throw new Error("PCM source and window paths must be absolute.");
  }
  const frameCount = window.endFrame - window.startFrame;
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error("PCM window frame range is invalid.");
  }
  const dataBytes = frameCount * metadata.blockAlign;
  const header = createPcm16WavHeader({
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    bitsPerSample: metadata.bitsPerSample,
    dataBytes,
  });
  const sourceStart = metadata.dataOffset + window.startFrame * metadata.blockAlign;
  const sourceEnd = sourceStart + dataBytes - 1;
  const output = createWriteStream(options.outputPath, { flags: "wx" });
  output.write(header);
  try {
    await pipeline(
      createReadStream(options.sourcePath, { start: sourceStart, end: sourceEnd }),
      output,
    );
    return inspectPcm16Wav(options.outputPath);
  } catch (error) {
    output.destroy();
    await rm(options.outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

function createPcm16WavHeader(options) {
  if (options.dataBytes > 0xffff_ffff - 36) {
    throw new Error("PCM window exceeds the RIFF/WAVE size limit.");
  }
  const blockAlign = options.channels * (options.bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + options.dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(options.channels, 22);
  header.writeUInt32LE(options.sampleRate, 24);
  header.writeUInt32LE(options.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(options.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(options.dataBytes, 40);
  return header;
}

function millisecondsToFrames(milliseconds, sampleRate) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("Window milliseconds must be a non-negative number.");
  }
  return Math.round(milliseconds * sampleRate / 1_000);
}

function framesToMilliseconds(frames, sampleRate) {
  return Math.round(frames * 1_000 / sampleRate);
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Unexpected end of WAV file.");
  return buffer;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function forwardAbort(signal, child) {
  if (!signal) return () => {};
  const abort = () => child.kill();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function redactFfmpegDiagnostic(value, ...paths) {
  return paths.reduce(
    (result, filePath) => result.split(filePath).join("[local-file]"),
    String(value).trim(),
  ).slice(-2_000);
}
