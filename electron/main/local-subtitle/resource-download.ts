import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  type Stats,
} from "node:fs";
import {
  link,
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";

const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
const WRITE_EXCLUSIVE_NOFOLLOW_FLAGS =
  WRITE_ONLY_NOFOLLOW_FLAGS | fsConstants.O_CREAT | fsConstants.O_EXCL;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY = Object.freeze({
  metadataSchemaVersion: 1,
  maxRedirects: 5,
  maxUrlChars: 4_096,
  maxMetadataBytes: 8 * 1_024,
  metadataSyncBytes: 8 * 1_024 * 1_024,
  responseHeaderTimeoutMs: 30_000,
} as const);

export type LocalSubtitleResourceDownloadErrorCode =
  | "model_download_failed"
  | "model_disk_full"
  | "resource_not_allowed";

export class LocalSubtitleResourceDownloadError extends Error {
  readonly name = "LocalSubtitleResourceDownloadError";

  constructor(
    readonly code: LocalSubtitleResourceDownloadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LocalSubtitleDownloadResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  discard(): void;
}

export interface OpenLocalSubtitleDownloadResponseOptions {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type OpenLocalSubtitleDownloadResponse = (
  options: OpenLocalSubtitleDownloadResponseOptions,
) => Promise<LocalSubtitleDownloadResponse>;

export interface DownloadLocalSubtitleResourceOptions {
  readonly sourceUrl: string;
  readonly allowedHosts: readonly string[];
  readonly expectedBytes: number;
  readonly downloadDirectory: string;
  readonly partFileName: string;
  readonly metadataFileName: string;
  readonly destinationPath: string;
  readonly signal: AbortSignal;
  readonly ensureCapacity: (remainingBytes: number) => Promise<void>;
  readonly onProgress?: (completedBytes: number, totalBytes: number) => void;
  readonly openResponse?: OpenLocalSubtitleDownloadResponse;
  readonly metadataSyncBytes?: number;
}

export interface LocalSubtitleResourceDownloadResult {
  readonly absolutePath: string;
  readonly byteSize: number;
  readonly resumedBytes: number;
  readonly effectiveUrl: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

interface DownloadMetadata {
  readonly schemaVersion: 1;
  readonly sourceUrl: string;
  readonly effectiveUrl: string;
  readonly expectedBytes: number;
  readonly bytesCompleted: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

interface ResumeState {
  readonly bytesCompleted: number;
  readonly metadata?: DownloadMetadata;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly size: number;
  readonly nlink: number;
}

export async function downloadLocalSubtitleResource(
  options: DownloadLocalSubtitleResourceOptions,
): Promise<LocalSubtitleResourceDownloadResult> {
  const validated = validateOptions(options);
  const partPath = resolveDownloadLeaf(
    validated.downloadDirectory,
    validated.partFileName,
  );
  const metadataPath = resolveDownloadLeaf(
    validated.downloadDirectory,
    validated.metadataFileName,
  );
  let resume = await readResumeState(validated, partPath, metadataPath);
  const initiallyResumedBytes = resume.bytesCompleted;

  await validated.ensureCapacity(validated.expectedBytes - resume.bytesCompleted);
  if (resume.bytesCompleted === validated.expectedBytes) {
    const adopted = await adoptCompletedPart(
      partPath,
      metadataPath,
      validated.destinationPath,
    );
    return Object.freeze({
      absolutePath: validated.destinationPath,
      byteSize: validated.expectedBytes,
      resumedBytes: initiallyResumedBytes,
      effectiveUrl: resume.metadata?.effectiveUrl ?? validated.sourceUrl,
      ...(resume.metadata?.etag === undefined
        ? {}
        : { etag: resume.metadata.etag }),
      ...(resume.metadata?.lastModified === undefined
        ? {}
        : { lastModified: resume.metadata.lastModified }),
    });
  }

  let restartUsed = false;
  while (true) {
    throwIfAborted(validated.signal);
    let opened:
      | {
          readonly response: LocalSubtitleDownloadResponse;
          readonly effectiveUrl: URL;
        }
      | undefined;
    let responseDisposition: "continue" | "restart";
    try {
      opened = await openFollowingRedirects(validated, resume);
      responseDisposition = validateResponse(
        opened.response,
        resume,
        validated.expectedBytes,
      );
    } catch (error) {
      opened?.response.discard();
      if (validated.signal.aborted) {
        await removeDownloadState(partPath, metadataPath).catch(() => undefined);
        throwIfAborted(validated.signal);
      }
      if (error instanceof LocalSubtitleResourceDownloadError) throw error;
      throw downloadFailure(
        "The local subtitle resource response could not be opened safely.",
      );
    }
    if (responseDisposition === "restart") {
      opened.response.discard();
      if (restartUsed) {
        throw downloadFailure(
          "The local subtitle resource server did not honor a safe resume request.",
        );
      }
      restartUsed = true;
      await removeDownloadState(partPath, metadataPath);
      resume = { bytesCompleted: 0 };
      await validated.ensureCapacity(validated.expectedBytes);
      continue;
    }

    let handle: FileHandle | undefined;
    let completedBytes = resume.bytesCompleted;
    const metadata = createResponseMetadata(
      validated.sourceUrl,
      opened.effectiveUrl.href,
      validated.expectedBytes,
      completedBytes,
      opened.response.headers,
    );
    let nextMetadataSyncAt = completedBytes + validated.metadataSyncBytes;
    let responseFinished = false;
    try {
      handle = await openPartFile(partPath, resume.bytesCompleted);
      validated.onProgress?.(completedBytes, validated.expectedBytes);
      for await (const value of opened.response.body) {
        throwIfAborted(validated.signal);
        const chunk = Buffer.from(value);
        if (chunk.byteLength === 0) continue;
        if (completedBytes + chunk.byteLength > validated.expectedBytes) {
          throw downloadFailure(
            "The local subtitle resource exceeded its expected byte size.",
          );
        }
        await writeAll(handle, chunk, completedBytes);
        completedBytes += chunk.byteLength;
        validated.onProgress?.(completedBytes, validated.expectedBytes);
        if (completedBytes >= nextMetadataSyncAt) {
          await persistProgress(
            handle,
            metadataPath,
            withCompletedBytes(metadata, completedBytes),
          );
          nextMetadataSyncAt = completedBytes + validated.metadataSyncBytes;
        }
      }
      responseFinished = true;
      if (completedBytes !== validated.expectedBytes) {
        throw downloadFailure(
          "The local subtitle resource ended before its expected byte size.",
        );
      }
      await persistProgress(
        handle,
        metadataPath,
        withCompletedBytes(metadata, completedBytes),
      );
      await handle.close();
      handle = undefined;
      await adoptCompletedPart(
        partPath,
        metadataPath,
        validated.destinationPath,
      );
      return Object.freeze({
        absolutePath: validated.destinationPath,
        byteSize: completedBytes,
        resumedBytes: initiallyResumedBytes,
        effectiveUrl: opened.effectiveUrl.href,
        ...(metadata.etag === undefined ? {} : { etag: metadata.etag }),
        ...(metadata.lastModified === undefined
          ? {}
          : { lastModified: metadata.lastModified }),
      });
    } catch (error) {
      if (!responseFinished) opened.response.discard();
      if (handle) {
        if (!validated.signal.aborted && hasResumeValidator(metadata)) {
          await persistProgress(
            handle,
            metadataPath,
            withCompletedBytes(metadata, completedBytes),
          ).catch(() => undefined);
        }
        await handle.close().catch(() => undefined);
      }
      if (validated.signal.aborted) {
        await removeDownloadState(partPath, metadataPath).catch(() => undefined);
        throwIfAborted(validated.signal);
      }
      if (!hasResumeValidator(metadata)) {
        await removeDownloadState(partPath, metadataPath).catch(() => undefined);
      }
      if (isNodeError(error, "ENOSPC")) {
        throw new LocalSubtitleResourceDownloadError(
          "model_disk_full",
          "The local subtitle resource download ran out of disk space.",
        );
      }
      if (error instanceof LocalSubtitleResourceDownloadError) throw error;
      throw downloadFailure(
        "The local subtitle resource download could not be completed.",
      );
    }
  }
}

function validateOptions(
  options: DownloadLocalSubtitleResourceOptions,
): DownloadLocalSubtitleResourceOptions & { readonly metadataSyncBytes: number } {
  if (!options || !(options.signal instanceof AbortSignal)) {
    throw new TypeError("The local subtitle resource download options are invalid.");
  }
  if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0) {
    throw new TypeError("The local subtitle resource byte size is invalid.");
  }
  if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0) {
    throw new TypeError("The local subtitle resource host allowlist is invalid.");
  }
  const source = parseAllowedUrl(options.sourceUrl, options.allowedHosts);
  const metadataSyncBytes = options.metadataSyncBytes ??
    LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.metadataSyncBytes;
  if (!Number.isSafeInteger(metadataSyncBytes) || metadataSyncBytes <= 0) {
    throw new TypeError("The local subtitle resource metadata interval is invalid.");
  }
  if (typeof options.ensureCapacity !== "function") {
    throw new TypeError("The local subtitle resource capacity probe is invalid.");
  }
  validateAbsoluteDirectory(options.downloadDirectory);
  validateAbsolutePath(options.destinationPath);
  validateLeaf(options.partFileName);
  validateLeaf(options.metadataFileName);
  if (options.partFileName === options.metadataFileName) {
    throw new TypeError("The local subtitle resource state leaves must be distinct.");
  }
  return Object.freeze({
    ...options,
    sourceUrl: source.href,
    allowedHosts: Object.freeze([...options.allowedHosts]),
    metadataSyncBytes,
    openResponse: options.openResponse ?? openHttpsResponse,
  });
}

async function readResumeState(
  options: DownloadLocalSubtitleResourceOptions,
  partPath: string,
  metadataPath: string,
): Promise<ResumeState> {
  const [partStats, metadataStats] = await Promise.all([
    lstatOptional(partPath),
    lstatOptional(metadataPath),
  ]);
  if (!partStats && !metadataStats) return { bytesCompleted: 0 };
  if (
    !partStats?.isFile() ||
    partStats.isSymbolicLink() ||
    !metadataStats?.isFile() ||
    metadataStats.isSymbolicLink() ||
    partStats.size > options.expectedBytes ||
    metadataStats.size > LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.maxMetadataBytes
  ) {
    await removeDownloadState(partPath, metadataPath);
    return { bytesCompleted: 0 };
  }
  if (partStats.size === 0) {
    await removeDownloadState(partPath, metadataPath);
    return { bytesCompleted: 0 };
  }
  let metadata: DownloadMetadata;
  try {
    metadata = parseMetadata(await readNoFollowText(metadataPath));
  } catch {
    await removeDownloadState(partPath, metadataPath);
    return { bytesCompleted: 0 };
  }
  if (
    metadata.sourceUrl !== options.sourceUrl ||
    metadata.expectedBytes !== options.expectedBytes ||
    metadata.bytesCompleted !== partStats.size ||
    !hasResumeValidator(metadata) ||
    !isAllowedUrl(metadata.effectiveUrl, options.allowedHosts)
  ) {
    await removeDownloadState(partPath, metadataPath);
    return { bytesCompleted: 0 };
  }
  return Object.freeze({ bytesCompleted: partStats.size, metadata });
}

async function openFollowingRedirects(
  options: DownloadLocalSubtitleResourceOptions & {
    readonly openResponse?: OpenLocalSubtitleDownloadResponse;
  },
  resume: ResumeState,
): Promise<{
  readonly response: LocalSubtitleDownloadResponse;
  readonly effectiveUrl: URL;
}> {
  const openResponse = options.openResponse ?? openHttpsResponse;
  let current = parseAllowedUrl(options.sourceUrl, options.allowedHosts);
  const visited = new Set<string>();
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (redirectCount > LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.maxRedirects) {
      throw downloadFailure(
        "The local subtitle resource exceeded its redirect limit.",
      );
    }
    if (visited.has(current.href)) {
      throw downloadFailure("The local subtitle resource redirect looped.");
    }
    visited.add(current.href);
    const response = await openResponse({
      url: current,
      headers: buildRequestHeaders(resume),
      signal: options.signal,
    });
    if (!REDIRECT_STATUSES.has(response.statusCode)) {
      return { response, effectiveUrl: current };
    }
    const location = response.headers.location;
    response.discard();
    if (!location || location.length > LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.maxUrlChars) {
      throw downloadFailure(
        "The local subtitle resource redirect target is invalid.",
      );
    }
    let redirected: URL;
    try {
      redirected = new URL(location, current);
    } catch {
      throw downloadFailure(
        "The local subtitle resource redirect target is invalid.",
      );
    }
    current = parseAllowedUrl(redirected.href, options.allowedHosts);
  }
}

function buildRequestHeaders(
  resume: ResumeState,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/octet-stream",
    "accept-encoding": "identity",
    "user-agent": "FusionKit-local-subtitle/1",
  };
  if (resume.bytesCompleted > 0) {
    headers.range = `bytes=${resume.bytesCompleted}-`;
    const validator = resume.metadata?.etag ?? resume.metadata?.lastModified;
    if (validator) headers["if-range"] = validator;
  }
  return Object.freeze(headers);
}

function validateResponse(
  response: LocalSubtitleDownloadResponse,
  resume: ResumeState,
  expectedBytes: number,
): "continue" | "restart" {
  if (resume.bytesCompleted > 0 && response.statusCode === 200) return "restart";
  if (resume.bytesCompleted > 0 && response.statusCode === 416) return "restart";
  if (resume.bytesCompleted === 0) {
    if (response.statusCode !== 200) {
      throw downloadFailure(
        `The local subtitle resource server returned HTTP ${response.statusCode}.`,
      );
    }
    const contentLength = parseOptionalIntegerHeader(
      response.headers["content-length"],
    );
    if (contentLength !== undefined && contentLength !== expectedBytes) {
      throw downloadFailure(
        "The local subtitle resource response size did not match its manifest.",
      );
    }
    return "continue";
  }
  if (response.statusCode !== 206) {
    throw downloadFailure(
      `The local subtitle resource server returned HTTP ${response.statusCode}.`,
    );
  }
  const range = parseContentRange(response.headers["content-range"]);
  if (
    !range ||
    range.start !== resume.bytesCompleted ||
    range.end !== expectedBytes - 1 ||
    range.total !== expectedBytes
  ) {
    return "restart";
  }
  const contentLength = parseOptionalIntegerHeader(
    response.headers["content-length"],
  );
  if (
    contentLength !== undefined &&
    contentLength !== expectedBytes - resume.bytesCompleted
  ) {
    return "restart";
  }
  if (!sameResumeValidator(resume.metadata, response.headers)) return "restart";
  return "continue";
}

function createResponseMetadata(
  sourceUrl: string,
  effectiveUrl: string,
  expectedBytes: number,
  bytesCompleted: number,
  headers: Readonly<Record<string, string | undefined>>,
): DownloadMetadata {
  const etag = normalizeValidator(headers.etag);
  const lastModified = normalizeValidator(headers["last-modified"]);
  return Object.freeze({
    schemaVersion: 1,
    sourceUrl,
    effectiveUrl,
    expectedBytes,
    bytesCompleted,
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  });
}

function withCompletedBytes(
  metadata: DownloadMetadata,
  bytesCompleted: number,
): DownloadMetadata {
  return Object.freeze({ ...metadata, bytesCompleted });
}

async function openPartFile(
  partPath: string,
  resumeBytes: number,
): Promise<FileHandle> {
  if (resumeBytes === 0) {
    return open(partPath, WRITE_EXCLUSIVE_NOFOLLOW_FLAGS, 0o600);
  }
  const before = await lstat(partPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== resumeBytes) {
    throw downloadFailure(
      "The local subtitle resource partial file changed before resume.",
    );
  }
  const handle = await open(partPath, WRITE_ONLY_NOFOLLOW_FLAGS);
  try {
    assertSameFileIdentity(fileIdentity(before), fileIdentity(await handle.stat()));
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function persistProgress(
  partHandle: FileHandle,
  metadataPath: string,
  metadata: DownloadMetadata,
): Promise<void> {
  await partHandle.sync();
  const temporaryPath = `${metadataPath}.tmp-${randomUUID()}`;
  let temporary: FileHandle | undefined;
  try {
    temporary = await open(
      temporaryPath,
      WRITE_EXCLUSIVE_NOFOLLOW_FLAGS,
      0o600,
    );
    const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
    if (bytes.byteLength > LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.maxMetadataBytes) {
      throw downloadFailure(
        "The local subtitle resource resume metadata exceeded its limit.",
      );
    }
    await writeAll(temporary, bytes, 0);
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, metadataPath);
  } finally {
    await temporary?.close().catch(() => undefined);
    await unlinkOptional(temporaryPath);
  }
}

async function adoptCompletedPart(
  partPath: string,
  metadataPath: string,
  destinationPath: string,
): Promise<FileIdentity> {
  const partStats = await lstat(partPath);
  if (
    !partStats.isFile() ||
    partStats.isSymbolicLink() ||
    partStats.nlink !== 1
  ) {
    throw downloadFailure(
      "The completed local subtitle resource partial file is invalid.",
    );
  }
  const partIdentity = fileIdentity(partStats);
  await link(partPath, destinationPath);
  try {
    const destinationIdentity = fileIdentity(await lstat(destinationPath));
    assertSameFileObject(partIdentity, destinationIdentity);
    await unlink(partPath);
    if (await lstatOptional(partPath)) {
      throw downloadFailure(
        "The completed local subtitle resource partial file could not be retired.",
      );
    }
    const settledIdentity = fileIdentity(await lstat(destinationPath));
    assertSameFileObject(partIdentity, settledIdentity);
    if (settledIdentity.nlink !== 1) {
      throw downloadFailure(
        "The completed local subtitle resource retained an unexpected hard link.",
      );
    }
    await unlinkOptional(metadataPath);
    return settledIdentity;
  } catch (error) {
    await unlinkOptional(destinationPath);
    throw error;
  }
}

async function removeDownloadState(
  partPath: string,
  metadataPath: string,
): Promise<void> {
  const results = await Promise.allSettled([
    unlinkOptional(partPath),
    unlinkOptional(metadataPath),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

async function unlinkOptional(absolutePath: string): Promise<void> {
  try {
    await unlink(absolutePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function readNoFollowText(absolutePath: string): Promise<string> {
  const handle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.maxMetadataBytes
    ) {
      throw new Error("invalid resume metadata file");
    }
    return await readFile(handle, "utf8");
  } finally {
    await handle.close();
  }
}

function parseMetadata(value: string): DownloadMetadata {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("invalid resume metadata");
  const keys = Object.keys(parsed);
  const allowedKeys = new Set([
    "schemaVersion",
    "sourceUrl",
    "effectiveUrl",
    "expectedBytes",
    "bytesCompleted",
    "etag",
    "lastModified",
  ]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new Error("invalid resume metadata");
  }
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.sourceUrl !== "string" ||
    typeof parsed.effectiveUrl !== "string" ||
    !Number.isSafeInteger(parsed.expectedBytes) ||
    !Number.isSafeInteger(parsed.bytesCompleted) ||
    (parsed.etag !== undefined && typeof parsed.etag !== "string") ||
    (parsed.lastModified !== undefined && typeof parsed.lastModified !== "string")
  ) {
    throw new Error("invalid resume metadata");
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceUrl: parsed.sourceUrl,
    effectiveUrl: parsed.effectiveUrl,
    expectedBytes: parsed.expectedBytes as number,
    bytesCompleted: parsed.bytesCompleted as number,
    ...(parsed.etag === undefined ? {} : { etag: parsed.etag }),
    ...(parsed.lastModified === undefined
      ? {}
      : { lastModified: parsed.lastModified }),
  });
}

function sameResumeValidator(
  metadata: DownloadMetadata | undefined,
  headers: Readonly<Record<string, string | undefined>>,
): boolean {
  if (!metadata) return false;
  if (metadata.etag !== undefined) {
    return normalizeValidator(headers.etag) === metadata.etag;
  }
  if (metadata.lastModified !== undefined) {
    return normalizeValidator(headers["last-modified"]) === metadata.lastModified;
  }
  return false;
}

function hasResumeValidator(metadata: DownloadMetadata): boolean {
  return metadata.etag !== undefined || metadata.lastModified !== undefined;
}

function normalizeValidator(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function parseContentRange(
  value: string | undefined,
): { readonly start: number; readonly end: number; readonly total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return undefined;
  }
  return { start, end, total };
}

function parseOptionalIntegerHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function parseAllowedUrl(value: string, allowedHosts: readonly string[]): URL {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.maxUrlChars
  ) {
    throw new LocalSubtitleResourceDownloadError(
      "resource_not_allowed",
      "The local subtitle resource URL is invalid.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalSubtitleResourceDownloadError(
      "resource_not_allowed",
      "The local subtitle resource URL is invalid.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    !hostAllowed(parsed.hostname, allowedHosts)
  ) {
    throw new LocalSubtitleResourceDownloadError(
      "resource_not_allowed",
      "The local subtitle resource URL is not allowlisted.",
    );
  }
  return parsed;
}

function isAllowedUrl(value: string, allowedHosts: readonly string[]): boolean {
  try {
    parseAllowedUrl(value, allowedHosts);
    return true;
  } catch {
    return false;
  }
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const candidate = entry.toLowerCase();
    if (candidate.startsWith("*.")) {
      const suffix = candidate.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return normalized === candidate;
  });
}

function resolveDownloadLeaf(root: string, leaf: string): string {
  const candidate = path.resolve(root, leaf);
  if (path.dirname(candidate) !== path.resolve(root)) {
    throw new TypeError("The local subtitle resource state path escaped its root.");
  }
  return candidate;
}

function validateLeaf(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new TypeError("The local subtitle resource state leaf is invalid.");
  }
}

function validateAbsoluteDirectory(value: string): void {
  validateAbsolutePath(value);
  if (path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new TypeError("The local subtitle resource root is invalid.");
  }
}

function validateAbsolutePath(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("The local subtitle resource path is invalid.");
  }
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    );
    if (result.bytesWritten <= 0) throw new Error("resource write made no progress");
    written += result.bytesWritten;
  }
}

async function openHttpsResponse(
  options: OpenLocalSubtitleDownloadResponseOptions,
): Promise<LocalSubtitleDownloadResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpsRequest(
      options.url,
      {
        method: "GET",
        headers: options.headers,
        signal: options.signal,
        maxHeaderSize: 16 * 1_024,
      },
      (response) => {
        settled = true;
        request.setTimeout(0);
        resolve(Object.freeze({
          statusCode: response.statusCode ?? 0,
          headers: Object.freeze({
            location: firstHeader(response.headers.location),
            etag: firstHeader(response.headers.etag),
            "last-modified": firstHeader(response.headers["last-modified"]),
            "content-length": firstHeader(response.headers["content-length"]),
            "content-range": firstHeader(response.headers["content-range"]),
          }),
          body: response,
          discard: () => response.destroy(),
        }));
      },
    );
    request.setTimeout(
      LOCAL_SUBTITLE_RESOURCE_DOWNLOAD_POLICY.responseHeaderTimeoutMs,
      () => request.destroy(new Error("resource response header timeout")),
    );
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value[0] : undefined;
}

function fileIdentity(stats: Stats): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    size: stats.size,
    nlink: stats.nlink,
  });
}

function assertSameFileIdentity(expected: FileIdentity, actual: FileIdentity): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.birthtimeMs !== actual.birthtimeMs ||
    expected.size !== actual.size ||
    expected.nlink !== actual.nlink
  ) {
    throw downloadFailure("The local subtitle resource partial file changed.");
  }
}

function assertSameFileObject(expected: FileIdentity, actual: FileIdentity): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.birthtimeMs !== actual.birthtimeMs ||
    expected.size !== actual.size
  ) {
    throw downloadFailure("The local subtitle resource file identity changed.");
  }
}

async function lstatOptional(absolutePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The local subtitle resource download was aborted.", "AbortError");
}

function downloadFailure(message: string): LocalSubtitleResourceDownloadError {
  return new LocalSubtitleResourceDownloadError(
    "model_download_failed",
    message,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
