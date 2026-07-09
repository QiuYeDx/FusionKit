import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioApiDialect, AudioOutputPathMode } from "@/type/audio";
import { createAudioRuntimeError } from "./audio-errors";

export const AUDIO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MIMO_MAX_BASE64_AUDIO_BYTES = 10 * 1024 * 1024;

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

  const mimeType = inferAudioMimeType(options.filePath, options.mimeType);
  if (!mimeType || !isAudioMimeTypeAllowedForDialect(mimeType, options.dialect)) {
    throw createAudioRuntimeError({
      code: "unsupported_audio_format",
      message: "Audio format is not supported by the selected audio profile.",
      field: "mimeType",
      details: {
        filePath: options.filePath,
        mimeType: options.mimeType ?? mimeType ?? "",
        dialect: options.dialect,
      },
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

  return {
    filePath: options.filePath,
    fileName: path.basename(options.filePath),
    extension: path.extname(options.filePath).replace(/^\./, "").toLowerCase(),
    mimeType,
    sizeBytes: fileStat.size,
    base64EncodedBytes,
  };
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
  await writeFile(outputPath, data);
  const written = await stat(outputPath);
  return {
    outputPath,
    sizeBytes: written.size,
  };
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
