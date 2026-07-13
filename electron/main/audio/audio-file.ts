import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AudioApiDialect, AudioOutputPathMode } from "@/type/audio";
import { createAudioRuntimeError } from "./audio-errors";

export const AUDIO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MIMO_MAX_BASE64_AUDIO_BYTES = 10 * 1024 * 1024;
export const AUDIO_FILE_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;

export interface AudioFileInfo {
  filePath: string;
  fileName: string;
  extension: string;
  mimeType: AudioMimeType;
  sizeBytes: number;
  base64EncodedBytes: number;
}

export interface ResolveAudioInputFileOptions {
  filePath: string;
  mimeType?: string;
  dialect: AudioApiDialect;
}

export interface ResolveAudioOutputPathOptions {
  outputPathMode?: AudioOutputPathMode;
  sourcePath?: string;
  outputDir?: string;
  fileNameHint: string;
  extension: string;
  now?: Date;
  tempRoot?: string;
}

export interface AuthorizedAudioFileInfo {
  fileToken: string;
  fileName: string;
  mimeType: AudioMimeType;
  sizeBytes: number;
  expiresAt: number;
}

interface AudioFileAuthorizationEntry extends AuthorizedAudioFileInfo {
  ownerId: number;
  filePath: string;
}

export type AudioMimeType =
  | "audio/wav"
  | "audio/mpeg"
  | "audio/mp3"
  | "audio/mp4"
  | "audio/flac"
  | "audio/ogg"
  | "audio/webm";

const AUDIO_MIME_BY_EXTENSION: Record<string, AudioMimeType> = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  webm: "audio/webm",
};

const OPENAI_AUDIO_MIME_TYPES = new Set<AudioMimeType>([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/flac",
  "audio/ogg",
  "audio/webm",
]);

const MIMO_AUDIO_MIME_TYPES = new Set<AudioMimeType>([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
]);

export function inferAudioMimeType(
  filePathOrName: string,
  explicitMimeType?: string,
): AudioMimeType | undefined {
  const normalizedExplicit = normalizeAudioMimeType(explicitMimeType);
  if (normalizedExplicit) return normalizedExplicit;

  const extension = path
    .extname(filePathOrName)
    .replace(/^\./, "")
    .toLowerCase();
  return AUDIO_MIME_BY_EXTENSION[extension];
}

export function isAudioMimeTypeAllowedForDialect(
  mimeType: AudioMimeType,
  dialect: AudioApiDialect,
): boolean {
  if (dialect === "mimo_chat_audio") {
    return MIMO_AUDIO_MIME_TYPES.has(mimeType);
  }
  return OPENAI_AUDIO_MIME_TYPES.has(mimeType);
}

export function getBase64EncodedByteLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export async function resolveAudioInputFile(
  options: ResolveAudioInputFileOptions,
): Promise<AudioFileInfo> {
  let fileStat;
  try {
    fileStat = await stat(options.filePath);
  } catch (error) {
    throw createAudioRuntimeError({
      code: "file_read_failed",
      message: "Audio file could not be read.",
      field: "filePath",
      details: { filePath: options.filePath },
      cause: error,
    });
  }

  if (!fileStat.isFile()) {
    throw createAudioRuntimeError({
      code: "file_read_failed",
      message: "Audio input path must point to a file.",
      field: "filePath",
      details: { filePath: options.filePath },
    });
  }

  const base64EncodedBytes = getBase64EncodedByteLength(fileStat.size);
  if (options.dialect === "mimo_chat_audio") {
    if (base64EncodedBytes > MIMO_MAX_BASE64_AUDIO_BYTES) {
      throw createAudioRuntimeError({
        code: "file_too_large",
        message: "MiMo audio input exceeds the 10MB Base64 payload limit.",
        field: "filePath",
        details: {
          sizeBytes: fileStat.size,
          base64EncodedBytes,
          maxBase64EncodedBytes: MIMO_MAX_BASE64_AUDIO_BYTES,
        },
      });
    }
  } else if (fileStat.size > AUDIO_MAX_UPLOAD_BYTES) {
    throw createAudioRuntimeError({
      code: "file_too_large",
      message: "Audio input exceeds the upload size limit.",
      field: "filePath",
      details: {
        sizeBytes: fileStat.size,
        maxBytes: AUDIO_MAX_UPLOAD_BYTES,
      },
    });
  }

  const extensionMimeType = inferAudioMimeType(options.filePath);
  const explicitMimeType = normalizeAudioMimeType(options.mimeType);
  const detectedMimeType = await detectAudioMimeTypeFromFile(options.filePath);
  if (
    !detectedMimeType ||
    (extensionMimeType &&
      !areEquivalentAudioMimeTypes(extensionMimeType, detectedMimeType)) ||
    (explicitMimeType &&
      !areEquivalentAudioMimeTypes(explicitMimeType, detectedMimeType)) ||
    !isAudioMimeTypeAllowedForDialect(detectedMimeType, options.dialect)
  ) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message:
        "Audio file signature does not match a supported format for the selected audio profile.",
      field: "mimeType",
      details: {
        filePath: options.filePath,
        mimeType: options.mimeType ?? extensionMimeType ?? "",
        detectedMimeType: detectedMimeType ?? "",
        dialect: options.dialect,
      },
    });
  }

  return {
    filePath: options.filePath,
    fileName: path.basename(options.filePath),
    extension: path.extname(options.filePath).replace(/^\./, "").toLowerCase(),
    mimeType: detectedMimeType,
    sizeBytes: fileStat.size,
    base64EncodedBytes,
  };
}

export async function detectAudioMimeTypeFromFile(
  filePath: string,
): Promise<AudioMimeType | undefined> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return detectAudioMimeTypeFromHeader(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function detectAudioMimeTypeFromHeader(
  header: Uint8Array,
): AudioMimeType | undefined {
  const bytes = Buffer.from(header);
  if (
    bytes.length >= 12 &&
    (bytes.subarray(0, 4).toString("ascii") === "RIFF" ||
      bytes.subarray(0, 4).toString("ascii") === "RF64") &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }
  if (
    bytes.length >= 3 &&
    bytes.subarray(0, 3).toString("ascii") === "ID3"
  ) {
    return "audio/mpeg";
  }
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0
  ) {
    return "audio/mpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).toString("ascii") === "fLaC"
  ) {
    return "audio/flac";
  }
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).toString("ascii") === "OggS"
  ) {
    return "audio/ogg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "audio/mp4";
  }
  return undefined;
}

export class AudioFileAuthorizationStore {
  private readonly entries = new Map<string, AudioFileAuthorizationEntry>();

  constructor(
    private readonly ttlMs = AUDIO_FILE_AUTHORIZATION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(
    ownerId: number,
    filePath: string,
    explicitMimeType?: string,
  ): Promise<AuthorizedAudioFileInfo> {
    this.removeExpired();
    const fileInfo = await resolveAudioInputFile({
      filePath,
      mimeType: explicitMimeType,
      dialect: "openai_audio",
    });
    const fileToken = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const entry: AudioFileAuthorizationEntry = {
      ownerId,
      fileToken,
      filePath: fileInfo.filePath,
      fileName: fileInfo.fileName,
      mimeType: fileInfo.mimeType,
      sizeBytes: fileInfo.sizeBytes,
      expiresAt,
    };
    this.entries.set(fileToken, entry);
    return toPublicAuthorization(entry);
  }

  async resolve(
    ownerId: number,
    fileToken: string,
    dialect: AudioApiDialect,
  ): Promise<AudioFileInfo> {
    const entry = this.requireEntry(ownerId, fileToken);
    return this.resolveEntry(entry, dialect, fileToken);
  }

  async consume(
    ownerId: number,
    fileToken: string,
    dialect: AudioApiDialect,
  ): Promise<AudioFileInfo> {
    const entry = this.requireEntry(ownerId, fileToken);
    this.entries.delete(fileToken);
    return this.resolveEntry(entry, dialect, fileToken);
  }

  revoke(ownerId: number, fileToken: string): void {
    const entry = this.entries.get(fileToken);
    if (entry?.ownerId === ownerId) this.entries.delete(fileToken);
  }

  private requireEntry(
    ownerId: number,
    fileToken: string,
  ): AudioFileAuthorizationEntry {
    this.removeExpired();
    const entry = this.entries.get(fileToken);
    if (entry && entry.ownerId === ownerId) return entry;
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "Audio file authorization is invalid or expired.",
      field: "fileToken",
    });
  }

  private async resolveEntry(
    entry: AudioFileAuthorizationEntry,
    dialect: AudioApiDialect,
    fileToken: string,
  ): Promise<AudioFileInfo> {
    const resolved = await resolveAudioInputFile({
      filePath: entry.filePath,
      mimeType: entry.mimeType,
      dialect,
    });
    if (resolved.sizeBytes !== entry.sizeBytes) {
      this.entries.delete(fileToken);
      throw createAudioRuntimeError({
        code: "file_read_failed",
        message: "Authorized audio file changed after it was selected.",
        field: "fileToken",
      });
    }
    return resolved;
  }

  releaseOwner(ownerId: number): void {
    for (const [token, entry] of this.entries) {
      if (entry.ownerId === ownerId) this.entries.delete(token);
    }
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}

export async function readAudioFileAsDataUri(
  fileInfo: Pick<AudioFileInfo, "filePath" | "mimeType">,
): Promise<string> {
  const bytes = await readFile(fileInfo.filePath);
  return `data:${fileInfo.mimeType};base64,${bytes.toString("base64")}`;
}

export async function resolveAudioOutputPath(
  options: ResolveAudioOutputPathOptions,
): Promise<string> {
  const directory = resolveOutputDirectory(options);
  const extension = normalizeExtension(options.extension);
  const fileName = `${sanitizeFileNameStem(
    options.fileNameHint,
    options.now,
  )}.${extension}`;

  await mkdir(directory, { recursive: true });
  return ensureUniqueOutputPath(path.join(directory, fileName));
}

export async function writeAudioOutputFile(
  outputPath: string,
  data: Uint8Array | Buffer | string,
): Promise<{ outputPath: string; sizeBytes: number }> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const parsed = path.parse(outputPath);
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0
      ? outputPath
      : path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    let handle;
    try {
      handle = await open(candidate, "wx");
      await handle.writeFile(data);
      await handle.close();
      handle = undefined;
      const written = await stat(candidate);
      return { outputPath: candidate, sizeBytes: written.size };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isNodeErrorCode(error, "EEXIST")) continue;
      await unlink(candidate).catch(() => undefined);
      throw createAudioRuntimeError({
        code: "output_write_failed",
        message: "Audio output could not be written.",
        field: "outputPath",
        details: { outputPath: candidate },
        cause: error,
      });
    }
  }
  throw createAudioRuntimeError({
    code: "output_write_failed",
    message: "Audio output path could not be reserved.",
    field: "outputPath",
  });
}

export async function discardAudioOutputIfAborted(
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal?.aborted) return;
  await unlink(outputPath).catch(() => undefined);
  throw createAudioRuntimeError({
    code: "aborted",
    message: "Audio request was cancelled before the output was committed.",
  });
}

export async function ensureUniqueOutputPath(targetPath: string): Promise<string> {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let index = 1;

  while (await pathExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }

  return candidate;
}

export function createSpeechOutputFileNameHint(now = new Date()): string {
  return `speech_${formatTimestamp(now)}`;
}

export function createTranscriptOutputFileNameHint(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return `${parsed.name}.transcript`;
}

export function createRealtimeCaptionsFileNameHint(now = new Date()): string {
  return `realtime_captions_${formatTimestamp(now)}`;
}

function resolveOutputDirectory(options: ResolveAudioOutputPathOptions): string {
  const mode = options.outputPathMode ?? "temp";
  if (mode === "custom_dir") {
    if (!options.outputDir?.trim()) {
      throw createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "Custom output directory is required.",
        field: "outputDir",
      });
    }
    return options.outputDir;
  }

  if (mode === "source_dir") {
    if (!options.sourcePath?.trim()) {
      throw createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "Source path is required for source directory output.",
        field: "sourcePath",
      });
    }
    return path.dirname(options.sourcePath);
  }

  return path.join(options.tempRoot ?? os.tmpdir(), "fusionkit-audio");
}

function normalizeAudioMimeType(
  mimeType: string | undefined,
): AudioMimeType | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  if (normalized === "audio/x-wav" || normalized === "audio/wave") {
    return "audio/wav";
  }
  if (normalized === "audio/x-mpeg") {
    return "audio/mpeg";
  }
  if (isKnownAudioMimeType(normalized)) {
    return normalized;
  }
  return undefined;
}

function isKnownAudioMimeType(value: string): value is AudioMimeType {
  return OPENAI_AUDIO_MIME_TYPES.has(value as AudioMimeType);
}

export async function cleanupStaleAudioOutputs(options: {
  maxAgeMs?: number;
  maxTotalBytes?: number;
  now?: number;
} = {}): Promise<void> {
  const directory = path.join(os.tmpdir(), "fusionkit-audio");
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
  const now = options.now ?? Date.now();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs >= maxAgeMs) {
        await unlink(filePath).catch(() => undefined);
      } else {
        files.push({ path: filePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    } catch {
      // A concurrent cleanup may already own this path.
    }
  }
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= maxTotalBytes) break;
    await unlink(file.path).catch(() => undefined);
    totalBytes -= file.size;
  }
}

function areEquivalentAudioMimeTypes(
  left: AudioMimeType,
  right: AudioMimeType,
): boolean {
  const canonical = (value: AudioMimeType) =>
    value === "audio/mp3" ? "audio/mpeg" : value;
  return canonical(left) === canonical(right);
}

function toPublicAuthorization(
  entry: AudioFileAuthorizationEntry,
): AuthorizedAudioFileInfo {
  return {
    fileToken: entry.fileToken,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
    expiresAt: entry.expiresAt,
  };
}

function normalizeExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").trim().toLowerCase();
  if (!normalized) {
    throw createAudioRuntimeError({
      code: "invalid_ipc_request",
      message: "Output extension is required.",
      field: "extension",
    });
  }
  return normalized;
}

function sanitizeFileNameStem(stem: string, fallbackDate = new Date()): string {
  const cleaned = stem
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .slice(0, 160);

  return cleaned || createSpeechOutputFileNameHint(fallbackDate);
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
