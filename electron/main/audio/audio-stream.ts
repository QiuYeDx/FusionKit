import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Pcm16WavOptions {
  sampleRate?: number;
  channels?: number;
}

export interface AudioStreamStatsInput {
  startedAtMs: number;
  firstChunkAtMs?: number;
  chunkCount: number;
  totalBytes: number;
  sampleRate?: number;
  channels?: number;
  streamMode?: "incremental" | "final_only";
}

export interface AudioStreamStats {
  firstChunkLatencyMs?: number;
  chunkCount: number;
  totalBytes: number;
  sampleRate: number;
  channels: number;
  streamMode?: "incremental" | "final_only";
}

const DEFAULT_PCM16_SAMPLE_RATE = 24_000;
const DEFAULT_PCM16_CHANNELS = 1;
const PCM16_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

export function createPcm16WavBuffer(
  chunks: readonly Uint8Array[],
  options: Pcm16WavOptions = {},
): Buffer {
  const sampleRate = options.sampleRate ?? DEFAULT_PCM16_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_PCM16_CHANNELS;
  validatePcm16WavOptions(sampleRate, channels);

  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = Buffer.alloc(WAV_HEADER_BYTES + dataSize);

  writeAscii(output, 0, "RIFF");
  output.writeUInt32LE(36 + dataSize, 4);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(
    sampleRate * channels * (PCM16_BITS_PER_SAMPLE / 8),
    28,
  );
  output.writeUInt16LE(channels * (PCM16_BITS_PER_SAMPLE / 8), 32);
  output.writeUInt16LE(PCM16_BITS_PER_SAMPLE, 34);
  writeAscii(output, 36, "data");
  output.writeUInt32LE(dataSize, 40);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    Buffer.from(chunk).copy(output, offset);
    offset += chunk.byteLength;
  }

  return output;
}

export async function writePcm16WavFile(
  outputPath: string,
  chunks: readonly Uint8Array[],
  options: Pcm16WavOptions = {},
): Promise<{ outputPath: string; sizeBytes: number }> {
  const wav = createPcm16WavBuffer(chunks, options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, wav);
  return {
    outputPath,
    sizeBytes: wav.byteLength,
  };
}

export function createAudioStreamStats(
  input: AudioStreamStatsInput,
): AudioStreamStats {
  return {
    ...(input.firstChunkAtMs !== undefined
      ? { firstChunkLatencyMs: input.firstChunkAtMs - input.startedAtMs }
      : {}),
    chunkCount: input.chunkCount,
    totalBytes: input.totalBytes,
    sampleRate: input.sampleRate ?? DEFAULT_PCM16_SAMPLE_RATE,
    channels: input.channels ?? DEFAULT_PCM16_CHANNELS,
    ...(input.streamMode ? { streamMode: input.streamMode } : {}),
  };
}

function validatePcm16WavOptions(sampleRate: number, channels: number): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("PCM16 WAV sampleRate must be a positive integer.");
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error("PCM16 WAV channels must be a positive integer.");
  }
}

function writeAscii(buffer: Buffer, offset: number, value: string): void {
  buffer.write(value, offset, value.length, "ascii");
}
