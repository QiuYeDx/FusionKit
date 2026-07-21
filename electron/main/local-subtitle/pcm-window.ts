import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
} from "@/type/localSubtitle";

const PCM_AUDIO_FORMAT = 1;
const PCM_SAMPLE_RATE_HZ = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BLOCK_ALIGN = 2;
const PCM_BYTE_RATE = 32_000 as const;
const CANONICAL_RIFF_HEADER_BYTES = 44;
const UINT32_MAX = 0xffff_ffff;
const MAX_DS64_TABLE_ENTRIES = 1_024;
const MAX_FORMAT_CHUNK_BYTES = 4_096;
const IO_CHUNK_BYTES = 1024 * 1024;
const NOFOLLOW_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const EXCLUSIVE_WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const MAX_WINDOW_FRAMES =
  (LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.pcmWindowMs *
    PCM_SAMPLE_RATE_HZ) /
  1_000;
const MAX_WINDOW_DATA_BYTES = MAX_WINDOW_FRAMES * PCM_BLOCK_ALIGN;

export const LOCAL_SUBTITLE_PCM_WINDOW_ERROR_REASONS = [
  "invalid_configuration",
  "source_unavailable",
  "source_identity_mismatch",
  "invalid_wav",
  "unsupported_wav",
  "limit_exceeded",
  "aborted",
  "output_exists",
  "output_write_failed",
  "output_verification_failed",
  "window_frame_mismatch",
] as const;

export type LocalSubtitlePcmWindowErrorReason =
  (typeof LOCAL_SUBTITLE_PCM_WINDOW_ERROR_REASONS)[number];

export class LocalSubtitlePcmWindowError extends Error {
  readonly name = "LocalSubtitlePcmWindowError";

  constructor(
    readonly reason: LocalSubtitlePcmWindowErrorReason,
    message: string,
  ) {
    super(message);
  }
}

export interface LocalSubtitlePcmFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface LocalSubtitlePcm16WavMetadata {
  readonly container: "RIFF" | "RF64";
  readonly fileSize: number;
  readonly fileIdentity: LocalSubtitlePcmFileIdentity;
  readonly audioFormat: 1;
  readonly channels: 1;
  readonly sampleRateHz: 16_000;
  readonly byteRate: 32_000;
  readonly blockAlign: 2;
  readonly bitsPerSample: 16;
  readonly dataOffset: number;
  readonly dataSize: number;
  readonly totalFrames: number;
  readonly durationMs: number;
}

export interface WriteLocalSubtitlePcmWindowOptions {
  readonly sourcePath: string;
  readonly sourceIdentity: LocalSubtitlePcmFileIdentity;
  readonly metadata: LocalSubtitlePcm16WavMetadata;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly outputPath: string;
  readonly signal?: AbortSignal;
}

export interface LocalSubtitleWrittenPcmWindow {
  readonly sha256: string;
  readonly metadata: LocalSubtitlePcm16WavMetadata;
}

interface OpenedStableFile {
  readonly handle: FileHandle;
  readonly identity: LocalSubtitlePcmFileIdentity;
}

interface ParsedFormatChunk {
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
}

interface ParsedDs64Chunk {
  readonly riffSize: number;
  readonly dataSize: number;
  readonly sampleCount: number;
  readonly tableSizes: ReadonlyMap<string, number>;
  readonly nextOffset: number;
}

export async function inspectLocalSubtitlePcm16Wav(
  filePath: string,
): Promise<LocalSubtitlePcm16WavMetadata> {
  assertAbsolutePath(filePath, "The PCM input path is invalid.");
  const opened = await openStableFile(
    filePath,
    "source_unavailable",
    "source_identity_mismatch",
  );
  let handle: FileHandle | undefined = opened.handle;
  try {
    const metadata = await parsePcm16Wav(
      handle,
      opened.identity,
    );
    await assertOpenAndPathIdentity(
      filePath,
      handle,
      opened.identity,
      "source_identity_mismatch",
    );
    await closeRequired(
      handle,
      "source_unavailable",
      "The PCM input could not be released.",
    );
    handle = undefined;
    return Object.freeze({
      ...metadata,
      fileIdentity: Object.freeze({ ...metadata.fileIdentity }),
    });
  } catch (error) {
    throw asPcmWindowError(
      error,
      "source_unavailable",
      "The PCM input could not be inspected.",
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export function createLocalSubtitlePcm16WavHeader(dataBytes: number): Buffer {
  if (
    !Number.isSafeInteger(dataBytes) ||
    dataBytes <= 0 ||
    dataBytes % PCM_BLOCK_ALIGN !== 0
  ) {
    throw failure(
      "invalid_configuration",
      "The PCM window byte count is invalid.",
    );
  }
  if (dataBytes > MAX_WINDOW_DATA_BYTES || dataBytes + 36 > UINT32_MAX) {
    throw failure(
      "limit_exceeded",
      "The PCM window exceeds the bounded RIFF size.",
    );
  }

  const header = Buffer.alloc(CANONICAL_RIFF_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_AUDIO_FORMAT, 20);
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(PCM_BYTE_RATE, 28);
  header.writeUInt16LE(PCM_BLOCK_ALIGN, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export async function writeLocalSubtitlePcmWindow(
  options: WriteLocalSubtitlePcmWindowOptions,
): Promise<LocalSubtitleWrittenPcmWindow> {
  validateWriteOptions(options);
  throwIfAborted(options.signal);

  let sourceHandle: FileHandle | undefined;
  let outputHandle: FileHandle | undefined;
  let outputIdentity: LocalSubtitlePcmFileIdentity | undefined;
  let createdOutput = false;
  try {
    const source = await openStableFile(
      options.sourcePath,
      "source_unavailable",
      "source_identity_mismatch",
    );
    sourceHandle = source.handle;
    if (
      !sameIdentity(source.identity, options.sourceIdentity) ||
      !sameIdentity(source.identity, options.metadata.fileIdentity)
    ) {
      throw failure(
        "source_identity_mismatch",
        "The normalized PCM source identity changed.",
      );
    }
    const observedMetadata = await parsePcm16Wav(sourceHandle, source.identity);
    if (!sameMetadata(observedMetadata, options.metadata)) {
      throw failure(
        "source_identity_mismatch",
        "The normalized PCM source metadata changed.",
      );
    }

    throwIfAborted(options.signal);
    try {
      outputHandle = await open(
        options.outputPath,
        EXCLUSIVE_WRITE_FLAGS,
        0o600,
      );
      createdOutput = true;
      const createdStat = await outputHandle.stat();
      if (
        !createdStat.isFile() ||
        (process.platform !== "win32" && (createdStat.mode & 0o777) !== 0o600)
      ) {
        throw failure(
          "output_write_failed",
          "The PCM window output identity is invalid.",
        );
      }
      outputIdentity = Object.freeze(toIdentity(createdStat));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw failure(
          "output_exists",
          "The PCM window output already exists.",
        );
      }
      throw failure(
        "output_write_failed",
        "The PCM window output could not be created.",
      );
    }

    const frameCount = options.endFrame - options.startFrame;
    const dataBytes = frameCount * PCM_BLOCK_ALIGN;
    const header = createLocalSubtitlePcm16WavHeader(dataBytes);
    const expectedHash = createHash("sha256");
    expectedHash.update(header);
    await writeExactly(outputHandle, header, 0);

    const buffer = Buffer.alloc(Math.min(IO_CHUNK_BYTES, dataBytes));
    let copiedBytes = 0;
    const sourceDataStart =
      options.metadata.dataOffset + options.startFrame * PCM_BLOCK_ALIGN;
    while (copiedBytes < dataBytes) {
      throwIfAborted(options.signal);
      const requested = Math.min(buffer.length, dataBytes - copiedBytes);
      const bytes = buffer.subarray(0, requested);
      await readIntoExactly(
        sourceHandle,
        bytes,
        sourceDataStart + copiedBytes,
        "source_identity_mismatch",
        "The normalized PCM source ended unexpectedly.",
      );
      expectedHash.update(bytes);
      await writeExactly(
        outputHandle,
        bytes,
        CANONICAL_RIFF_HEADER_BYTES + copiedBytes,
      );
      copiedBytes += requested;
    }
    throwIfAborted(options.signal);

    await assertOpenAndPathIdentity(
      options.sourcePath,
      sourceHandle,
      source.identity,
      "source_identity_mismatch",
    );
    const outputStat = await outputHandle.stat();
    if (
      !outputStat.isFile() ||
      !sameFileObject(toIdentity(outputStat), outputIdentity) ||
      outputStat.size !== CANONICAL_RIFF_HEADER_BYTES + dataBytes ||
      (process.platform !== "win32" && (outputStat.mode & 0o777) !== 0o600)
    ) {
      throw failure(
        "output_write_failed",
        "The PCM window output identity is invalid.",
      );
    }
    await assertOpenAndPathIdentity(
      options.outputPath,
      outputHandle,
      toIdentity(outputStat),
      "output_verification_failed",
    );
    await outputHandle.sync();
    await closeRequired(
      outputHandle,
      "output_write_failed",
      "The PCM window output could not be finalized.",
    );
    outputHandle = undefined;
    await closeRequired(
      sourceHandle,
      "source_unavailable",
      "The normalized PCM source could not be released.",
    );
    sourceHandle = undefined;

    let parsed: LocalSubtitlePcm16WavMetadata;
    try {
      parsed = await inspectLocalSubtitlePcm16Wav(options.outputPath);
    } catch {
      throw failure(
        "output_verification_failed",
        "The PCM window output failed parse-back validation.",
      );
    }
    if (
      parsed.container !== "RIFF" ||
      parsed.fileSize !== CANONICAL_RIFF_HEADER_BYTES + dataBytes ||
      parsed.dataOffset !== CANONICAL_RIFF_HEADER_BYTES ||
      parsed.dataSize !== dataBytes ||
      parsed.totalFrames !== frameCount ||
      parsed.durationMs !== framesToMilliseconds(frameCount)
    ) {
      throw failure(
        "output_verification_failed",
        "The PCM window output does not match its frame range.",
      );
    }

    const actualHash = await hashStableFile(
      options.outputPath,
      parsed.fileIdentity,
      options.signal,
    );
    const expectedSha256 = expectedHash.digest("hex");
    if (actualHash !== expectedSha256) {
      throw failure(
        "output_verification_failed",
        "The PCM window output hash is inconsistent.",
      );
    }
    throwIfAborted(options.signal);
    return Object.freeze({ sha256: actualHash, metadata: parsed });
  } catch (error) {
    if (outputHandle) await outputHandle.close().catch(() => undefined);
    if (sourceHandle) await sourceHandle.close().catch(() => undefined);
    outputHandle = undefined;
    sourceHandle = undefined;
    if (createdOutput) {
      try {
        await removeOwnedOutput(options.outputPath, outputIdentity);
      } catch {
        throw failure(
          "output_write_failed",
          "The partial PCM window output could not be removed.",
        );
      }
    }
    throw asPcmWindowError(
      error,
      "output_write_failed",
      "The PCM window could not be written.",
    );
  }
}

async function parsePcm16Wav(
  handle: FileHandle,
  identity: LocalSubtitlePcmFileIdentity,
): Promise<Omit<LocalSubtitlePcm16WavMetadata, "fileIdentity"> & {
  readonly fileIdentity: LocalSubtitlePcmFileIdentity;
}> {
  const fileSize = identity.size;
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize < CANONICAL_RIFF_HEADER_BYTES
  ) {
    throw failure("invalid_wav", "The PCM WAV file is truncated.");
  }
  if (fileSize > LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes) {
    throw failure(
      "limit_exceeded",
      "The normalized PCM file exceeds the byte limit.",
    );
  }

  const header = await readExactly(
    handle,
    12,
    0,
    "invalid_wav",
    "The PCM WAV header is truncated.",
  );
  const container = header.toString("ascii", 0, 4);
  if (
    (container !== "RIFF" && container !== "RF64") ||
    header.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw failure("invalid_wav", "The PCM input is not a RIFF/RF64 WAVE file.");
  }

  const declaredRiffSize = header.readUInt32LE(4);
  let ds64: ParsedDs64Chunk | undefined;
  let offset = 12;
  if (container === "RIFF") {
    if (
      declaredRiffSize === UINT32_MAX ||
      declaredRiffSize + 8 !== fileSize
    ) {
      throw failure("invalid_wav", "The RIFF size does not match the PCM file.");
    }
  } else {
    if (declaredRiffSize !== UINT32_MAX) {
      throw failure("invalid_wav", "The RF64 size marker is invalid.");
    }
    ds64 = await parseDs64Chunk(handle, fileSize);
    offset = ds64.nextOffset;
  }

  let format: ParsedFormatChunk | undefined;
  let dataOffset: number | undefined;
  let dataSize: number | undefined;
  const consumedTableEntries = new Set<string>();
  while (offset < fileSize) {
    if (fileSize - offset < 8) {
      throw failure("invalid_wav", "A PCM WAV chunk header is truncated.");
    }
    const chunkHeader = await readExactly(
      handle,
      8,
      offset,
      "invalid_wav",
      "A PCM WAV chunk header is truncated.",
    );
    const chunkId = chunkHeader.toString("ascii", 0, 4);
    const rawChunkSize = chunkHeader.readUInt32LE(4);
    if (chunkId === "ds64") {
      throw failure("invalid_wav", "The PCM WAV file contains duplicate ds64 chunks.");
    }

    let chunkSize = rawChunkSize;
    if (rawChunkSize === UINT32_MAX) {
      if (!ds64) {
        throw failure("invalid_wav", "A RIFF chunk uses an RF64 size marker.");
      }
      if (chunkId === "data") {
        chunkSize = ds64.dataSize;
      } else {
        const tableSize = ds64.tableSizes.get(chunkId);
        if (tableSize === undefined || consumedTableEntries.has(chunkId)) {
          throw failure("invalid_wav", "An RF64 chunk size is not defined by ds64.");
        }
        chunkSize = tableSize;
        consumedTableEntries.add(chunkId);
      }
    } else if (ds64 && chunkId === "data") {
      throw failure("invalid_wav", "The RF64 data chunk is missing its size marker.");
    }

    const payloadOffset = checkedAdd(offset, 8);
    const payloadEnd = checkedAdd(payloadOffset, chunkSize);
    const paddedEnd = checkedAdd(payloadEnd, chunkSize % 2);
    if (payloadEnd > fileSize || paddedEnd > fileSize) {
      throw failure("invalid_wav", "A PCM WAV chunk exceeds the file boundary.");
    }
    if (chunkSize % 2 === 1) {
      const padding = await readExactly(
        handle,
        1,
        payloadEnd,
        "invalid_wav",
        "A PCM WAV chunk padding byte is missing.",
      );
      if (padding[0] !== 0) {
        throw failure("invalid_wav", "A PCM WAV chunk padding byte is invalid.");
      }
    }

    if (chunkId === "fmt ") {
      if (format) {
        throw failure("invalid_wav", "The PCM WAV file contains duplicate fmt chunks.");
      }
      if (chunkSize < 16 || chunkSize > MAX_FORMAT_CHUNK_BYTES) {
        throw failure("invalid_wav", "The PCM WAV fmt chunk size is invalid.");
      }
      const value = await readExactly(
        handle,
        16,
        payloadOffset,
        "invalid_wav",
        "The PCM WAV fmt chunk is truncated.",
      );
      format = {
        audioFormat: value.readUInt16LE(0),
        channels: value.readUInt16LE(2),
        sampleRateHz: value.readUInt32LE(4),
        byteRate: value.readUInt32LE(8),
        blockAlign: value.readUInt16LE(12),
        bitsPerSample: value.readUInt16LE(14),
      };
    } else if (chunkId === "data") {
      if (dataOffset !== undefined) {
        throw failure("invalid_wav", "The PCM WAV file contains duplicate data chunks.");
      }
      dataOffset = payloadOffset;
      dataSize = chunkSize;
    }
    offset = paddedEnd;
  }

  if (offset !== fileSize || !format || dataOffset === undefined || dataSize === undefined) {
    throw failure("invalid_wav", "The PCM WAV structure is incomplete.");
  }
  if (ds64 && consumedTableEntries.size !== ds64.tableSizes.size) {
    throw failure("invalid_wav", "The RF64 ds64 table contains unused entries.");
  }
  if (
    format.audioFormat !== PCM_AUDIO_FORMAT ||
    format.channels !== PCM_CHANNELS ||
    format.sampleRateHz !== PCM_SAMPLE_RATE_HZ ||
    format.byteRate !== PCM_BYTE_RATE ||
    format.blockAlign !== PCM_BLOCK_ALIGN ||
    format.bitsPerSample !== PCM_BITS_PER_SAMPLE
  ) {
    throw failure("unsupported_wav", "The WAV input is not 16 kHz mono PCM16.");
  }
  if (
    dataSize <= 0 ||
    dataSize > LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes ||
    dataSize % PCM_BLOCK_ALIGN !== 0
  ) {
    throw failure("invalid_wav", "The PCM WAV data chunk is empty or unaligned.");
  }

  const totalFrames = dataSize / PCM_BLOCK_ALIGN;
  const durationMs = framesToMilliseconds(totalFrames);
  if (
    !Number.isSafeInteger(totalFrames) ||
    totalFrames <= 0 ||
    !Number.isSafeInteger(durationMs)
  ) {
    throw failure("invalid_wav", "The PCM WAV frame count is invalid.");
  }
  if (durationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs) {
    throw failure(
      "limit_exceeded",
      "The PCM WAV duration exceeds the shared media limit.",
    );
  }
  if (
    ds64 &&
    (ds64.dataSize !== dataSize || ds64.sampleCount !== totalFrames)
  ) {
    throw failure("invalid_wav", "The RF64 ds64 sample count is inconsistent.");
  }

  return {
    container,
    fileSize,
    fileIdentity: identity,
    audioFormat: PCM_AUDIO_FORMAT,
    channels: PCM_CHANNELS,
    sampleRateHz: PCM_SAMPLE_RATE_HZ,
    byteRate: PCM_BYTE_RATE,
    blockAlign: PCM_BLOCK_ALIGN,
    bitsPerSample: PCM_BITS_PER_SAMPLE,
    dataOffset,
    dataSize,
    totalFrames,
    durationMs,
  };
}

async function parseDs64Chunk(
  handle: FileHandle,
  fileSize: number,
): Promise<ParsedDs64Chunk> {
  const header = await readExactly(
    handle,
    8,
    12,
    "invalid_wav",
    "The RF64 ds64 chunk is missing.",
  );
  if (header.toString("ascii", 0, 4) !== "ds64") {
    throw failure("invalid_wav", "The RF64 ds64 chunk must be first.");
  }
  const chunkSize = header.readUInt32LE(4);
  if (chunkSize === UINT32_MAX || chunkSize < 28) {
    throw failure("invalid_wav", "The RF64 ds64 chunk size is invalid.");
  }
  const base = await readExactly(
    handle,
    28,
    20,
    "invalid_wav",
    "The RF64 ds64 chunk is truncated.",
  );
  const tableLength = base.readUInt32LE(24);
  if (tableLength > MAX_DS64_TABLE_ENTRIES || chunkSize !== 28 + tableLength * 12) {
    throw failure("invalid_wav", "The RF64 ds64 table size is invalid.");
  }
  const riffSize = safeBigIntToNumber(base.readBigUInt64LE(0));
  const dataSize = safeBigIntToNumber(base.readBigUInt64LE(8));
  const sampleCount = safeBigIntToNumber(base.readBigUInt64LE(16));
  if (riffSize !== fileSize - 8 || dataSize <= 0 || sampleCount <= 0) {
    throw failure("invalid_wav", "The RF64 ds64 sizes are inconsistent.");
  }

  const tableSizes = new Map<string, number>();
  for (let index = 0; index < tableLength; index += 1) {
    const entry = await readExactly(
      handle,
      12,
      48 + index * 12,
      "invalid_wav",
      "The RF64 ds64 table is truncated.",
    );
    const chunkId = entry.toString("ascii", 0, 4);
    if (
      chunkId === "data" ||
      chunkId === "ds64" ||
      tableSizes.has(chunkId)
    ) {
      throw failure("invalid_wav", "The RF64 ds64 table is ambiguous.");
    }
    tableSizes.set(chunkId, safeBigIntToNumber(entry.readBigUInt64LE(4)));
  }

  const payloadEnd = checkedAdd(20, chunkSize);
  const nextOffset = checkedAdd(payloadEnd, chunkSize % 2);
  if (nextOffset > fileSize) {
    throw failure("invalid_wav", "The RF64 ds64 chunk exceeds the file boundary.");
  }
  if (chunkSize % 2 === 1) {
    const padding = await readExactly(
      handle,
      1,
      payloadEnd,
      "invalid_wav",
      "The RF64 ds64 padding byte is missing.",
    );
    if (padding[0] !== 0) {
      throw failure("invalid_wav", "The RF64 ds64 padding byte is invalid.");
    }
  }
  return {
    riffSize,
    dataSize,
    sampleCount,
    tableSizes,
    nextOffset,
  };
}

function validateWriteOptions(options: WriteLocalSubtitlePcmWindowOptions): void {
  if (!options || typeof options !== "object") {
    throw failure("invalid_configuration", "The PCM window request is invalid.");
  }
  assertAbsolutePath(options.sourcePath, "The PCM source path is invalid.");
  assertAbsolutePath(options.outputPath, "The PCM output path is invalid.");
  if (options.sourcePath === options.outputPath) {
    throw failure(
      "invalid_configuration",
      "The PCM source and output must be different files.",
    );
  }
  assertIdentity(options.sourceIdentity);
  validateMetadata(options.metadata);
  if (!sameIdentity(options.sourceIdentity, options.metadata.fileIdentity)) {
    throw failure(
      "source_identity_mismatch",
      "The PCM metadata does not belong to the authorized source.",
    );
  }
  if (
    !Number.isSafeInteger(options.startFrame) ||
    !Number.isSafeInteger(options.endFrame) ||
    options.startFrame < 0 ||
    options.endFrame <= options.startFrame ||
    options.endFrame > options.metadata.totalFrames ||
    options.endFrame - options.startFrame > MAX_WINDOW_FRAMES
  ) {
    throw failure(
      "invalid_configuration",
      "The PCM window frame range is invalid.",
    );
  }
}

function validateMetadata(metadata: LocalSubtitlePcm16WavMetadata): void {
  if (
    !metadata ||
    (metadata.container !== "RIFF" && metadata.container !== "RF64") ||
    !Number.isSafeInteger(metadata.fileSize) ||
    metadata.fileSize < CANONICAL_RIFF_HEADER_BYTES ||
    metadata.fileSize > LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes ||
    metadata.audioFormat !== PCM_AUDIO_FORMAT ||
    metadata.channels !== PCM_CHANNELS ||
    metadata.sampleRateHz !== PCM_SAMPLE_RATE_HZ ||
    metadata.byteRate !== PCM_BYTE_RATE ||
    metadata.blockAlign !== PCM_BLOCK_ALIGN ||
    metadata.bitsPerSample !== PCM_BITS_PER_SAMPLE ||
    !Number.isSafeInteger(metadata.dataOffset) ||
    metadata.dataOffset < 12 ||
    !Number.isSafeInteger(metadata.dataSize) ||
    metadata.dataSize <= 0 ||
    metadata.dataSize % PCM_BLOCK_ALIGN !== 0 ||
    checkedAdd(metadata.dataOffset, metadata.dataSize) > metadata.fileSize ||
    !Number.isSafeInteger(metadata.totalFrames) ||
    metadata.totalFrames !== metadata.dataSize / PCM_BLOCK_ALIGN ||
    metadata.durationMs !== framesToMilliseconds(metadata.totalFrames)
  ) {
    throw failure("invalid_configuration", "The PCM source metadata is invalid.");
  }
  assertIdentity(metadata.fileIdentity);
  if (
    metadata.fileIdentity.size !== metadata.fileSize ||
    metadata.durationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs
  ) {
    throw failure("invalid_configuration", "The PCM source metadata is inconsistent.");
  }
}

async function removeOwnedOutput(
  outputPath: string,
  expected: LocalSubtitlePcmFileIdentity | undefined,
): Promise<void> {
  if (!expected) {
    throw failure(
      "output_write_failed",
      "The partial PCM window output identity is unavailable.",
    );
  }
  let current: Stats;
  try {
    current = await lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw failure(
      "output_write_failed",
      "The partial PCM window output identity cannot be read.",
    );
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameFileObject(toIdentity(current), expected)
  ) {
    throw failure(
      "output_write_failed",
      "The partial PCM window output identity changed before cleanup.",
    );
  }
  try {
    await rm(outputPath, { force: false });
  } catch {
    throw failure(
      "output_write_failed",
      "The partial PCM window output could not be removed.",
    );
  }
}

async function openStableFile(
  filePath: string,
  unavailableReason: LocalSubtitlePcmWindowErrorReason,
  mismatchReason: LocalSubtitlePcmWindowErrorReason,
): Promise<OpenedStableFile> {
  let before: Stats;
  try {
    before = await lstat(filePath);
  } catch {
    throw failure(unavailableReason, "The PCM file is unavailable.");
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw failure(mismatchReason, "The PCM file identity is unsafe.");
  }

  let handle: FileHandle;
  try {
    handle = await open(filePath, NOFOLLOW_READ_FLAGS);
  } catch {
    throw failure(unavailableReason, "The PCM file cannot be opened safely.");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStats(before, opened)) {
      throw failure(mismatchReason, "The PCM file identity changed while opening.");
    }
    return { handle, identity: Object.freeze(toIdentity(opened)) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw asPcmWindowError(
      error,
      mismatchReason,
      "The PCM file identity cannot be verified.",
    );
  }
}

async function assertOpenAndPathIdentity(
  filePath: string,
  handle: FileHandle,
  expected: LocalSubtitlePcmFileIdentity,
  reason: LocalSubtitlePcmWindowErrorReason,
): Promise<void> {
  let opened: Stats;
  let lexical: Stats;
  try {
    [opened, lexical] = await Promise.all([handle.stat(), lstat(filePath)]);
  } catch {
    throw failure(reason, "The PCM file identity is unavailable.");
  }
  if (
    !opened.isFile() ||
    !lexical.isFile() ||
    lexical.isSymbolicLink() ||
    !sameIdentity(toIdentity(opened), expected) ||
    !sameIdentity(toIdentity(lexical), expected)
  ) {
    throw failure(reason, "The PCM file identity changed.");
  }
}

async function hashStableFile(
  filePath: string,
  expected: LocalSubtitlePcmFileIdentity,
  signal?: AbortSignal,
): Promise<string> {
  const opened = await openStableFile(
    filePath,
    "output_verification_failed",
    "output_verification_failed",
  );
  let handle: FileHandle | undefined = opened.handle;
  try {
    if (!sameIdentity(opened.identity, expected)) {
      throw failure(
        "output_verification_failed",
        "The PCM window output identity changed before hashing.",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(IO_CHUNK_BYTES, expected.size));
    let position = 0;
    while (position < expected.size) {
      throwIfAborted(signal);
      const requested = Math.min(buffer.length, expected.size - position);
      const bytes = buffer.subarray(0, requested);
      await readIntoExactly(
        handle,
        bytes,
        position,
        "output_verification_failed",
        "The PCM window output ended while hashing.",
      );
      hash.update(bytes);
      position += requested;
    }
    await assertOpenAndPathIdentity(
      filePath,
      handle,
      expected,
      "output_verification_failed",
    );
    await closeRequired(
      handle,
      "output_verification_failed",
      "The PCM window output could not be released after hashing.",
    );
    handle = undefined;
    return hash.digest("hex");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
  reason: LocalSubtitlePcmWindowErrorReason,
  message: string,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  await readIntoExactly(handle, buffer, position, reason, message);
  return buffer;
}

async function readIntoExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  reason: LocalSubtitlePcmWindowErrorReason,
  message: string,
): Promise<void> {
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        position + offset,
      );
      if (bytesRead === 0) throw new Error("unexpected end");
      offset += bytesRead;
    }
  } catch {
    throw failure(reason, message);
  }
}

async function writeExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
        position + offset,
      );
      if (bytesWritten === 0) throw new Error("short write");
      offset += bytesWritten;
    }
  } catch {
    throw failure(
      "output_write_failed",
      "The PCM window output could not be written completely.",
    );
  }
}

async function closeRequired(
  handle: FileHandle,
  reason: LocalSubtitlePcmWindowErrorReason,
  message: string,
): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw failure(reason, message);
  }
}

function assertAbsolutePath(value: string, message: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    path.parse(value).root === value
  ) {
    throw failure("invalid_configuration", message);
  }
}

function assertIdentity(value: LocalSubtitlePcmFileIdentity): void {
  if (
    !value ||
    !Number.isSafeInteger(value.dev) ||
    !Number.isSafeInteger(value.ino) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    !Number.isFinite(value.mtimeMs) ||
    !Number.isFinite(value.ctimeMs)
  ) {
    throw failure("invalid_configuration", "The PCM file identity is invalid.");
  }
}

function toIdentity(stat: Stats): LocalSubtitlePcmFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameStats(left: Stats, right: Stats): boolean {
  return sameIdentity(toIdentity(left), toIdentity(right));
}

function sameIdentity(
  left: LocalSubtitlePcmFileIdentity,
  right: LocalSubtitlePcmFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameFileObject(
  left: LocalSubtitlePcmFileIdentity,
  right: LocalSubtitlePcmFileIdentity | undefined,
): boolean {
  return Boolean(right && left.dev === right.dev && left.ino === right.ino);
}

function sameMetadata(
  left: LocalSubtitlePcm16WavMetadata,
  right: LocalSubtitlePcm16WavMetadata,
): boolean {
  return (
    left.container === right.container &&
    left.fileSize === right.fileSize &&
    sameIdentity(left.fileIdentity, right.fileIdentity) &&
    left.audioFormat === right.audioFormat &&
    left.channels === right.channels &&
    left.sampleRateHz === right.sampleRateHz &&
    left.byteRate === right.byteRate &&
    left.blockAlign === right.blockAlign &&
    left.bitsPerSample === right.bitsPerSample &&
    left.dataOffset === right.dataOffset &&
    left.dataSize === right.dataSize &&
    left.totalFrames === right.totalFrames &&
    left.durationMs === right.durationMs
  );
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure("invalid_wav", "A PCM WAV chunk offset is invalid.");
  }
  return value;
}

function safeBigIntToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw failure("limit_exceeded", "An RF64 size exceeds the safe integer limit.");
  }
  return Number(value);
}

function framesToMilliseconds(frames: number): number {
  return Math.round((frames * 1_000) / PCM_SAMPLE_RATE_HZ);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw failure("aborted", "The PCM window operation was cancelled.");
  }
}

function failure(
  reason: LocalSubtitlePcmWindowErrorReason,
  message: string,
): LocalSubtitlePcmWindowError {
  return new LocalSubtitlePcmWindowError(reason, message);
}

function asPcmWindowError(
  error: unknown,
  fallbackReason: LocalSubtitlePcmWindowErrorReason,
  fallbackMessage: string,
): LocalSubtitlePcmWindowError {
  return error instanceof LocalSubtitlePcmWindowError
    ? error
    : failure(fallbackReason, fallbackMessage);
}
