import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import * as yauzl from "yauzl";
import {
  parseLocalSubtitleAcceleratorArchiveContract,
  type LocalSubtitleAcceleratorArchiveContract,
} from "./accelerator-manifest";

const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_EXCLUSIVE_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const UNIX_HOST_SYSTEM = 3;
const UNIX_OS_X_HOST_SYSTEM = 19;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const ARCHIVE_HASH_CHUNK_BYTES = 1024 * 1024;

export const LOCAL_SUBTITLE_ACCELERATOR_ARCHIVE_POLICY = Object.freeze({
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
  supportedCompressionMethods: [0, 8] as const,
});

export type LocalSubtitleAcceleratorArchiveErrorCode =
  | "accelerator_archive_invalid"
  | "accelerator_archive_cancelled"
  | "accelerator_archive_cleanup_failed";

export class LocalSubtitleAcceleratorArchiveError extends Error {
  readonly name = "LocalSubtitleAcceleratorArchiveError";
  cleanupFailure?: string;

  constructor(
    readonly code: LocalSubtitleAcceleratorArchiveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtractLocalSubtitleAcceleratorArchiveOptions {
  readonly archivePath: string;
  readonly destinationDirectory: string;
  readonly contract: LocalSubtitleAcceleratorArchiveContract;
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    completedBytes: number,
    totalBytes: number,
  ) => void;
  readonly removeDirectory?: (absolutePath: string) => Promise<void>;
}

export interface LocalSubtitleAcceleratorArchiveExtraction {
  readonly archiveSha256: string;
  readonly archiveByteSize: number;
  readonly extractedFileCount: number;
  readonly extractedByteSize: number;
}

interface ValidatedArchiveEntry {
  readonly entry: yauzl.Entry;
  readonly selected?: LocalSubtitleAcceleratorArchiveContract["selectedEntries"][number];
}

export async function extractLocalSubtitleAcceleratorArchive(
  options: ExtractLocalSubtitleAcceleratorArchiveOptions,
): Promise<LocalSubtitleAcceleratorArchiveExtraction> {
  validateOptions(options);
  const contract = parseLocalSubtitleAcceleratorArchiveContract(options.contract);
  const archivePath = path.resolve(options.archivePath);
  const destinationDirectory = path.resolve(options.destinationDirectory);
  if (
    !path.isAbsolute(options.archivePath) ||
    !path.isAbsolute(options.destinationDirectory) ||
    archivePath === destinationDirectory ||
    isContainedPath(archivePath, destinationDirectory)
  ) {
    throw archiveInvalid();
  }

  const removeDirectory = options.removeDirectory ?? ((absolutePath) =>
    rm(absolutePath, {
      recursive: true,
      force: true,
      maxRetries: LOCAL_SUBTITLE_ACCELERATOR_ARCHIVE_POLICY.cleanupMaxRetries,
      retryDelay: LOCAL_SUBTITLE_ACCELERATOR_ARCHIVE_POLICY.cleanupRetryDelayMs,
    }));
  let archiveHandle: FileHandle | undefined;
  let zipFile: yauzl.ZipFile | undefined;
  let destinationCreated = false;
  let result: LocalSubtitleAcceleratorArchiveExtraction | undefined;
  let operationError: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    throwIfCancelled(options.signal);
    const archiveStat = await lstat(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size !== contract.archive.byteSize
    ) {
      throw archiveInvalid();
    }
    archiveHandle = await open(archivePath, READ_ONLY_NOFOLLOW_FLAGS);
    const openedStat = await archiveHandle.stat();
    assertSameFile(archiveStat, openedStat);

    const totalProgressBytes = contract.archive.byteSize +
      contract.selectedEntries.reduce((total, entry) => total + entry.byteSize, 0);
    const archiveObservation = await hashArchive(
      archiveHandle,
      contract.archive.byteSize,
      options.signal,
      (completedBytes) => options.onProgress?.(
        completedBytes,
        totalProgressBytes,
      ),
    );
    if (archiveObservation.sha256 !== contract.archive.sha256) {
      throw archiveInvalid();
    }
    assertSameFile(openedStat, await archiveHandle.stat());

    zipFile = await openZipFile(archiveHandle, contract.archive.byteSize);
    const entries = await collectAndValidateEntries(
      zipFile,
      contract,
      options.signal,
    );
    zipFile.close();
    zipFile = await openZipFile(archiveHandle, contract.archive.byteSize);

    await mkdir(destinationDirectory, { recursive: false, mode: 0o700 });
    destinationCreated = true;
    const extraction = await extractValidatedEntries(
      zipFile,
      entries,
      destinationDirectory,
      options.signal,
      (completedBytes) => options.onProgress?.(
        contract.archive.byteSize + completedBytes,
        totalProgressBytes,
      ),
    );
    result = Object.freeze({
      archiveSha256: archiveObservation.sha256,
      archiveByteSize: archiveObservation.byteSize,
      extractedFileCount: extraction.extractedFileCount,
      extractedByteSize: extraction.extractedByteSize,
    });
  } catch (error) {
    operationError = normalizeArchiveError(error, options.signal);
  }

  if (zipFile) {
    try {
      zipFile.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (archiveHandle) {
    try {
      await archiveHandle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (operationError || cleanupFailures.length > 0 || !result) {
    if (destinationCreated) {
      try {
        await removeDirectory(destinationDirectory);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const normalized = operationError
      ? normalizeArchiveError(operationError, options.signal)
      : archiveInvalid();
    if (cleanupFailures.length > 0) {
      if (normalized.code === "accelerator_archive_cancelled") {
        throw new LocalSubtitleAcceleratorArchiveError(
          "accelerator_archive_cleanup_failed",
          "The cancelled accelerator archive staging could not be cleaned up.",
        );
      }
      normalized.cleanupFailure = "Accelerator archive cleanup was incomplete.";
    }
    throw normalized;
  }
  return result;
}

async function hashArchive(
  handle: FileHandle,
  expectedBytes: number,
  signal: AbortSignal | undefined,
  onProgress: ((completedBytes: number) => void) | undefined,
): Promise<Readonly<{ byteSize: number; sha256: string }>> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
  let byteSize = 0;
  while (byteSize < expectedBytes) {
    throwIfCancelled(signal);
    const length = Math.min(buffer.length, expectedBytes - byteSize);
    const read = await handle.read(buffer, 0, length, byteSize);
    if (read.bytesRead <= 0) throw archiveInvalid();
    hash.update(buffer.subarray(0, read.bytesRead));
    byteSize += read.bytesRead;
    onProgress?.(byteSize);
  }
  if (byteSize !== expectedBytes) throw archiveInvalid();
  return Object.freeze({ byteSize, sha256: hash.digest("hex") });
}

class FileHandleRandomAccessReader extends yauzl.RandomAccessReader {
  constructor(readonly handle: FileHandle) {
    super();
  }

  _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle;
    return Readable.from((async function* readRange() {
      let position = start;
      const buffer = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
      while (position < end) {
        const length = Math.min(buffer.length, end - position);
        const read = await handle.read(buffer, 0, length, position);
        if (read.bytesRead <= 0) throw archiveInvalid();
        position += read.bytesRead;
        yield Buffer.from(buffer.subarray(0, read.bytesRead));
      }
    })());
  }

  close(callback: (error: Error | null) => void): void {
    setImmediate(callback, null);
  }
}

function openZipFile(
  archiveHandle: FileHandle,
  archiveByteSize: number,
): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new FileHandleRandomAccessReader(archiveHandle),
      archiveByteSize,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error) reject(archiveInvalid());
        else resolve(zipFile);
      },
    );
  });
}

function extractValidatedEntries(
  zipFile: yauzl.ZipFile,
  expectedEntries: readonly ValidatedArchiveEntry[],
  destinationDirectory: string,
  signal: AbortSignal | undefined,
  onProgress: ((completedBytes: number) => void) | undefined,
): Promise<Readonly<{
  extractedFileCount: number;
  extractedByteSize: number;
}>> {
  return new Promise((resolve, reject) => {
    let index = 0;
    let extractedFileCount = 0;
    let extractedByteSize = 0;
    let settled = false;
    const cleanup = () => {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(normalizeArchiveError(error, signal));
    };
    const onAbort = () => fail(cancelled());
    const onError = () => fail(archiveInvalid());
    const onEnd = () => {
      if (settled) return;
      if (index !== expectedEntries.length) {
        fail(archiveInvalid());
        return;
      }
      settled = true;
      cleanup();
      resolve(Object.freeze({ extractedFileCount, extractedByteSize }));
    };
    const onEntry = (entry: yauzl.Entry) => {
      const expected = expectedEntries[index];
      index += 1;
      if (!expected || !sameArchiveEntry(entry, expected.entry)) {
        fail(archiveInvalid());
        return;
      }
      void (async () => {
        throwIfCancelled(signal);
        if (expected.selected) {
          const destinationPath = resolveOutputPath(
            destinationDirectory,
            expected.selected.outputRelativePath,
          );
          await mkdir(path.dirname(destinationPath), {
            recursive: true,
            mode: 0o700,
          });
          await extractEntry(
            zipFile,
            entry,
            expected.selected,
            destinationPath,
            signal,
            (entryBytes) => onProgress?.(extractedByteSize + entryBytes),
          );
          extractedFileCount += 1;
          extractedByteSize += expected.selected.byteSize;
        }
        if (!settled) zipFile.readEntry();
      })().catch(fail);
    };

    zipFile.on("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfCancelled(signal);
      zipFile.readEntry();
    } catch (error) {
      fail(error);
    }
  });
}

function sameArchiveEntry(left: yauzl.Entry, right: yauzl.Entry): boolean {
  return left.fileName === right.fileName &&
    left.compressedSize === right.compressedSize &&
    left.uncompressedSize === right.uncompressedSize &&
    left.crc32 === right.crc32 &&
    left.compressionMethod === right.compressionMethod &&
    left.externalFileAttributes === right.externalFileAttributes &&
    left.relativeOffsetOfLocalHeader === right.relativeOffsetOfLocalHeader;
}

function collectAndValidateEntries(
  zipFile: yauzl.ZipFile,
  contract: LocalSubtitleAcceleratorArchiveContract,
  signal: AbortSignal | undefined,
): Promise<readonly ValidatedArchiveEntry[]> {
  return new Promise((resolve, reject) => {
    const expected = new Map<string, {
      readonly exactName: string;
      readonly selected?: LocalSubtitleAcceleratorArchiveContract["selectedEntries"][number];
    }>();
    for (const selected of contract.selectedEntries) {
      expected.set(selected.archiveName.toLowerCase(), {
        exactName: selected.archiveName,
        selected,
      });
    }
    for (const excluded of contract.excludedEntries) {
      expected.set(excluded.toLowerCase(), { exactName: excluded });
    }
    if (zipFile.entryCount !== contract.archive.expandedFileCount) {
      reject(archiveInvalid());
      return;
    }

    const entries: ValidatedArchiveEntry[] = [];
    const observed = new Set<string>();
    let expandedBytes = 0;
    let settled = false;
    const cleanup = () => {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(cancelled());
    const onError = () => fail(archiveInvalid());
    const onEnd = () => {
      if (settled) return;
      if (
        entries.length !== contract.archive.expandedFileCount ||
        observed.size !== expected.size ||
        expandedBytes !== contract.archive.expandedByteSize
      ) {
        fail(archiveInvalid());
        return;
      }
      settled = true;
      cleanup();
      resolve(entries);
    };
    const onEntry = (entry: yauzl.Entry) => {
      try {
        throwIfCancelled(signal);
        const normalizedName = validateArchiveEntry(entry, contract);
        const expectedEntry = expected.get(normalizedName.toLowerCase());
        if (
          !expectedEntry ||
          expectedEntry.exactName !== normalizedName ||
          observed.has(normalizedName.toLowerCase())
        ) {
          throw archiveInvalid();
        }
        if (
          expectedEntry.selected &&
          entry.uncompressedSize !== expectedEntry.selected.byteSize
        ) {
          throw archiveInvalid();
        }
        observed.add(normalizedName.toLowerCase());
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > contract.archive.expandedByteSize) {
          throw archiveInvalid();
        }
        entries.push(Object.freeze({
          entry,
          ...(expectedEntry.selected === undefined
            ? {}
            : { selected: expectedEntry.selected }),
        }));
        zipFile.readEntry();
      } catch (error) {
        fail(normalizeArchiveError(error, signal));
      }
    };

    zipFile.on("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfCancelled(signal);
      zipFile.readEntry();
    } catch (error) {
      fail(normalizeArchiveError(error, signal));
    }
  });
}

function validateArchiveEntry(
  entry: yauzl.Entry,
  contract: LocalSubtitleAcceleratorArchiveContract,
): string {
  const fileName = entry.fileName;
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    !isSafeArchivePath(fileName) ||
    entry.isEncrypted() ||
    !LOCAL_SUBTITLE_ACCELERATOR_ARCHIVE_POLICY.supportedCompressionMethods
      .includes(entry.compressionMethod as 0 | 8) ||
    !Number.isSafeInteger(entry.compressedSize) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > contract.maxEntryBytes ||
    entry.compressedSize > contract.archive.byteSize
  ) {
    throw archiveInvalid();
  }
  if (
    entry.uncompressedSize > 0 &&
    (entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize > contract.maxCompressionRatio)
  ) {
    throw archiveInvalid();
  }
  const hostSystem = entry.versionMadeBy >>> 8;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  const dosAttributes = entry.externalFileAttributes & 0xffff;
  if (
    ((hostSystem === UNIX_HOST_SYSTEM || hostSystem === UNIX_OS_X_HOST_SYSTEM) &&
      unixType !== 0 &&
      unixType !== UNIX_REGULAR_FILE) ||
    (dosAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0 ||
    (dosAttributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0
  ) {
    throw archiveInvalid();
  }
  return fileName;
}

function isSafeArchivePath(value: string): boolean {
  if (
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
    const base = segment.split(".", 1)[0]!.toUpperCase();
    return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
  });
}

async function extractEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  selected: LocalSubtitleAcceleratorArchiveContract["selectedEntries"][number],
  destinationPath: string,
  signal: AbortSignal | undefined,
  onProgress: ((completedBytes: number) => void) | undefined,
): Promise<void> {
  const outputHandle = await open(
    destinationPath,
    WRITE_EXCLUSIVE_NOFOLLOW_FLAGS,
    0o600,
  );
  let operationError: unknown;
  try {
    const input = await openEntryReadStream(zipFile, entry);
    const hash = createHash("sha256");
    let byteSize = 0;
    const cancel = () => input.destroy(cancelled());
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      for await (const chunk of input) {
        throwIfCancelled(signal);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (byteSize + buffer.length > selected.byteSize) {
          throw archiveInvalid();
        }
        let written = 0;
        while (written < buffer.length) {
          throwIfCancelled(signal);
          const result = await outputHandle.write(
            buffer,
            written,
            buffer.length - written,
            byteSize + written,
          );
          if (result.bytesWritten <= 0) throw archiveInvalid();
          written += result.bytesWritten;
        }
        hash.update(buffer);
        byteSize += buffer.length;
        onProgress?.(byteSize);
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      input.destroy();
    }
    if (byteSize !== selected.byteSize || hash.digest("hex") !== selected.sha256) {
      throw archiveInvalid();
    }
    await outputHandle.sync();
    const completedStat = await outputHandle.stat();
    if (!completedStat.isFile() || completedStat.size !== selected.byteSize) {
      throw archiveInvalid();
    }
  } catch (error) {
    operationError = normalizeArchiveError(error, signal);
  }
  try {
    await outputHandle.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError) throw normalizeArchiveError(operationError, signal);
}

function openEntryReadStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(archiveInvalid());
      else resolve(stream);
    });
  });
}

function resolveOutputPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isContainedPath(resolved, root)) throw archiveInvalid();
  return resolved;
}

function validateOptions(
  options: ExtractLocalSubtitleAcceleratorArchiveOptions,
): void {
  if (
    !options ||
    typeof options.archivePath !== "string" ||
    typeof options.destinationDirectory !== "string" ||
    options.archivePath.trim() !== options.archivePath ||
    options.destinationDirectory.trim() !== options.destinationDirectory ||
    options.archivePath.length === 0 ||
    options.destinationDirectory.length === 0 ||
    (options.onProgress !== undefined && typeof options.onProgress !== "function") ||
    (options.removeDirectory !== undefined && typeof options.removeDirectory !== "function")
  ) {
    throw archiveInvalid();
  }
}

function assertSameFile(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): void {
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeMs !== after.birthtimeMs ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw archiveInvalid();
  }
}

function isContainedPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function normalizeArchiveError(
  error: unknown,
  signal?: AbortSignal,
): LocalSubtitleAcceleratorArchiveError {
  if (error instanceof LocalSubtitleAcceleratorArchiveError) return error;
  if (signal?.aborted || isAbortError(error)) return cancelled();
  return archiveInvalid();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function archiveInvalid(): LocalSubtitleAcceleratorArchiveError {
  return new LocalSubtitleAcceleratorArchiveError(
    "accelerator_archive_invalid",
    "The local subtitle accelerator archive is invalid.",
  );
}

function cancelled(): LocalSubtitleAcceleratorArchiveError {
  return new LocalSubtitleAcceleratorArchiveError(
    "accelerator_archive_cancelled",
    "The local subtitle accelerator archive extraction was cancelled.",
  );
}
