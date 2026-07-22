import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";
import {
  LocalSubtitleModelError,
  type LocalSubtitleGgmlManifestHeader,
} from "./model-manifest";

export const LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE = 48 as const;

const GGML_HEADER_INT_COUNT = 11;
const FILE_HASH_CHUNK_BYTES = 1024 * 1024;
const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export interface LocalSubtitleGgmlModelExpectation {
  readonly modelId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly ggml: LocalSubtitleGgmlManifestHeader;
}

export interface LocalSubtitleGgmlModelHeader {
  readonly magicHex: string;
  readonly nVocab: number;
  readonly nAudioContext: number;
  readonly nAudioState: number;
  readonly nAudioHeads: number;
  readonly nAudioLayers: number;
  readonly nTextContext: number;
  readonly nTextState: number;
  readonly nTextHeads: number;
  readonly nTextLayers: number;
  readonly nMels: number;
  readonly fileType: number;
  readonly headerInt32Le: readonly number[];
}

export interface LocalSubtitleGgmlModelVerification {
  readonly modelId: string;
  readonly absolutePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly header: LocalSubtitleGgmlModelHeader;
  readonly fileIdentity: LocalSubtitleGgmlModelFileIdentity;
}

export interface LocalSubtitleGgmlModelFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export function parseLocalSubtitleGgmlModelHeader(
  input: Uint8Array,
): LocalSubtitleGgmlModelHeader {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE
  ) {
    throw modelFailure(
      "model_corrupt",
      "header",
      "The local subtitle GGML model header is truncated.",
    );
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const magicHex = bytes.subarray(0, 4).toString("hex");
  if (magicHex !== "6c6d6767") {
    throw modelFailure(
      "model_incompatible",
      "header",
      "The selected file is not a supported whisper.cpp GGML model.",
    );
  }
  const headerInt32Le = Array.from(
    { length: GGML_HEADER_INT_COUNT },
    (_, index) => bytes.readInt32LE(4 + index * 4),
  );
  if (headerInt32Le.some((value) => value <= 0)) {
    throw modelFailure(
      "model_incompatible",
      "header",
      "The selected GGML model has an unsupported header.",
    );
  }
  return deepFreeze({
    magicHex,
    nVocab: headerInt32Le[0]!,
    nAudioContext: headerInt32Le[1]!,
    nAudioState: headerInt32Le[2]!,
    nAudioHeads: headerInt32Le[3]!,
    nAudioLayers: headerInt32Le[4]!,
    nTextContext: headerInt32Le[5]!,
    nTextState: headerInt32Le[6]!,
    nTextHeads: headerInt32Le[7]!,
    nTextLayers: headerInt32Le[8]!,
    nMels: headerInt32Le[9]!,
    fileType: headerInt32Le[10]!,
    headerInt32Le,
  });
}

export function verifyLocalSubtitleGgmlModelHeader(
  input: Uint8Array,
  expected: LocalSubtitleGgmlManifestHeader,
): LocalSubtitleGgmlModelHeader {
  assertValidHeaderExpectation(expected);
  const header = parseLocalSubtitleGgmlModelHeader(input);
  if (
    header.magicHex !== expected.magicHex ||
    header.headerInt32Le.length !== expected.headerInt32Le.length ||
    header.headerInt32Le.some(
      (value, index) => value !== expected.headerInt32Le[index],
    )
  ) {
    throw modelFailure(
      "model_incompatible",
      "header",
      "The selected GGML model architecture or quantization is not allowlisted.",
    );
  }
  return header;
}

export async function verifyLocalSubtitleGgmlModelFile(
  absolutePath: string,
  expected: LocalSubtitleGgmlModelExpectation,
  signal?: AbortSignal,
): Promise<LocalSubtitleGgmlModelVerification> {
  const verifiedPath = validateAbsolutePath(absolutePath);
  assertValidExpectation(expected);
  throwIfAborted(signal);

  const pathStat = await lstatModelPath(verifiedPath);
  throwIfAborted(signal);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw modelFailure(
      "model_incompatible",
      "path",
      "The selected model must be a regular file, not a directory or symbolic link.",
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(verifiedPath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch {
    throw modelFailure(
      "model_incompatible",
      "path",
      "The selected model cannot be opened without following symbolic links.",
    );
  }

  try {
    throwIfAborted(signal);
    const openedStat = await statOpenModel(handle);
    assertMatchingIdentity(pathStat, openedStat);
    if (!openedStat.isFile()) {
      throw modelFailure(
        "model_incompatible",
        "path",
        "The selected model is not a regular file.",
      );
    }
    if (openedStat.size !== expected.byteSize) {
      throw modelFailure(
        "model_corrupt",
        "integrity",
        "The selected model has an unexpected byte size.",
      );
    }
    const headerBytes = await readExactHeader(handle, openedStat.size, signal);
    const header = verifyLocalSubtitleGgmlModelHeader(
      headerBytes,
      expected.ggml,
    );
    const sha256 = await hashOpenModel(handle, openedStat.size, signal);
    if (sha256 !== expected.sha256) {
      throw modelFailure(
        "model_corrupt",
        "integrity",
        "The selected model failed its SHA-256 check.",
      );
    }
    throwIfAborted(signal);
    const completedStat = await statOpenModel(handle);
    assertMatchingIdentity(openedStat, completedStat);
    await assertPathStillNamesFile(verifiedPath, completedStat);
    return deepFreeze({
      modelId: expected.modelId,
      absolutePath: verifiedPath,
      byteSize: openedStat.size,
      sha256,
      header,
      fileIdentity: modelFileIdentity(completedStat),
    });
  } finally {
    await handle.close();
  }
}

function modelFileIdentity(stats: Stats): LocalSubtitleGgmlModelFileIdentity {
  return deepFreeze({
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

async function readExactHeader(
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (fileSize < LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE) {
    throw modelFailure(
      "model_corrupt",
      "header",
      "The local subtitle GGML model header is truncated.",
    );
  }
  const header = Buffer.alloc(LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE);
  let position = 0;
  try {
    while (position < header.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(
        header,
        position,
        header.length - position,
        position,
      );
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
  } catch (error) {
    throwIfAborted(signal);
    throw modelFailure(
      "model_corrupt",
      "header",
      "The local subtitle GGML model header cannot be read.",
    );
  }
  if (position !== header.length) {
    throw modelFailure(
      "model_corrupt",
      "header",
      "The local subtitle GGML model header is truncated.",
    );
  }
  return header;
}

async function hashOpenModel(
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
): Promise<string> {
  const chunk = Buffer.alloc(Math.min(FILE_HASH_CHUNK_BYTES, fileSize));
  const hash = createHash("sha256");
  let position = 0;
  try {
    while (position < fileSize) {
      throwIfAborted(signal);
      const requested = Math.min(chunk.length, fileSize - position);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        requested,
        position,
      );
      throwIfAborted(signal);
      if (bytesRead === 0) {
        throw new Error("unexpected end of file");
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    throw modelFailure(
      "model_corrupt",
      "integrity",
      "The selected model cannot be hashed completely.",
    );
  }
  return hash.digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The GGML model verification was aborted.", "AbortError");
}

async function lstatModelPath(absolutePath: string): Promise<Stats> {
  try {
    return await lstat(absolutePath);
  } catch {
    throw modelFailure(
      "model_incompatible",
      "path",
      "The selected model path is unavailable.",
    );
  }
}

async function statOpenModel(handle: FileHandle): Promise<Stats> {
  try {
    return await handle.stat();
  } catch {
    throw modelFailure(
      "model_corrupt",
      "integrity",
      "The selected model filesystem identity cannot be read.",
    );
  }
}

async function assertPathStillNamesFile(
  absolutePath: string,
  expected: Stats,
): Promise<void> {
  let observed: Stats;
  try {
    observed = await lstat(absolutePath);
  } catch {
    throw changedDuringVerification();
  }
  if (!observed.isFile() || observed.isSymbolicLink()) {
    throw changedDuringVerification();
  }
  assertMatchingIdentity(expected, observed);
}

function assertMatchingIdentity(before: Stats, after: Stats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.birthtimeMs !== after.birthtimeMs
  ) {
    throw changedDuringVerification();
  }
}

function validateAbsolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("A host-absolute local subtitle model path is required.");
  }
  return path.resolve(value);
}

function assertValidExpectation(
  expected: LocalSubtitleGgmlModelExpectation,
): void {
  if (
    !expected ||
    typeof expected !== "object" ||
    typeof expected.modelId !== "string" ||
    expected.modelId.length < 1 ||
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize < LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE ||
    expected.byteSize > LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  ) {
    throw new TypeError("The local subtitle GGML model expectation is invalid.");
  }
  assertValidHeaderExpectation(expected.ggml);
}

function assertValidHeaderExpectation(
  expected: LocalSubtitleGgmlManifestHeader,
): void {
  if (
    !expected ||
    typeof expected !== "object" ||
    !/^[a-f0-9]{8}$/u.test(expected.magicHex) ||
    !Array.isArray(expected.headerInt32Le) ||
    expected.headerInt32Le.length !== GGML_HEADER_INT_COUNT ||
    expected.headerInt32Le.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff,
    )
  ) {
    throw new TypeError("The local subtitle GGML header expectation is invalid.");
  }
}

function changedDuringVerification(): LocalSubtitleModelError {
  return modelFailure(
    "model_corrupt",
    "integrity",
    "The selected model changed during verification.",
  );
}

function modelFailure(
  code: "model_incompatible" | "model_corrupt",
  stage: "path" | "header" | "integrity",
  message: string,
): LocalSubtitleModelError {
  return new LocalSubtitleModelError(code, stage, message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
