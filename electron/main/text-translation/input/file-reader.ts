import { promises as fs } from "fs";
import type { Stats } from "fs";
import path from "path";
import { createHash } from "crypto";
import {
  TEXT_TRANSLATION_RESOURCE_LIMITS,
  type SourceFingerprint,
  type TextFileFormat,
  type TextTranslationErrorCode,
  type TextTranslationFileRef,
  type TextTranslationPhase,
  type TextTranslationValidationIssue,
} from "@/type/textTranslation";
import {
  calculateTextQuality,
  decodeTextBuffer,
  detectTextEncoding,
  SUPPORTED_TEXT_ENCODINGS,
  TEXT_ENCODING_THRESHOLDS,
  type EncodingCandidateScore,
  type EncodingDecisionSource,
  type SupportedTextEncoding,
} from "./encoding-detector";

export interface ReadTextTranslationInputFileRequest {
  sourcePath: string;
  relativePath?: string;
  order: number;
  fileId?: string;
  manualEncoding?: SupportedTextEncoding;
}

export interface TextTranslationEncodingSummary {
  encoding: SupportedTextEncoding;
  hasBom: boolean;
  confidence: number;
  source: EncodingDecisionSource;
  candidates: EncodingCandidateScore[];
  manualOverride: boolean;
}

export interface TextTranslationDecodedInputFile {
  file: TextTranslationFileRef;
  fingerprint: SourceFingerprint;
  encoding: TextTranslationEncodingSummary;
  text: string;
  textLength: number;
  newlineNormalized: boolean;
  warnings: TextTranslationValidationIssue[];
}

export interface TextTranslationInputFileInspection {
  file: TextTranslationFileRef;
  fingerprint: SourceFingerprint;
  warnings: TextTranslationValidationIssue[];
}

export class TextTranslationInputFileError extends Error {
  readonly code: TextTranslationErrorCode;
  readonly phase: TextTranslationPhase;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: TextTranslationErrorCode;
    message: string;
    phase: TextTranslationPhase;
    field?: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "TextTranslationInputFileError";
    this.code = params.code;
    this.phase = params.phase;
    this.field = params.field;
    this.details = params.details;
  }

  toValidationIssue(): TextTranslationValidationIssue {
    return {
      code: this.code,
      severity: "error",
      message: this.message,
      field: this.field,
      phase: this.phase,
      details: this.details,
    };
  }
}

export async function inspectTextTranslationInputFile(
  request: ReadTextTranslationInputFileRequest,
): Promise<TextTranslationInputFileInspection> {
  const sourcePath = path.resolve(request.sourcePath);
  const format = detectTextTranslationFileFormat(sourcePath);
  const stat = await statInputFile(sourcePath);
  if (!stat.isFile()) {
    throw new TextTranslationInputFileError({
      code: "path_is_not_file",
      message: "Text translation source path must point to a file.",
      phase: "inspecting_files",
      field: "sourcePath",
      details: { sourcePath },
    });
  }

  const file: TextTranslationFileRef = {
    fileId: request.fileId ?? createTextTranslationFileId(sourcePath, request.order),
    sourcePath,
    relativePath: request.relativePath,
    fileName: path.basename(sourcePath),
    format,
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs,
    order: request.order,
  };

  const warnings = collectResourceWarnings(file);
  assertNotOverHardLimit(file);

  return {
    file,
    fingerprint: {
      fileId: file.fileId,
      sourcePath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
    },
    warnings,
  };
}

export async function readAndDecodeTextTranslationInputFile(
  request: ReadTextTranslationInputFileRequest,
): Promise<TextTranslationDecodedInputFile> {
  const inspection = await inspectTextTranslationInputFile(request);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(inspection.file.sourcePath);
  } catch (error) {
    throw new TextTranslationInputFileError({
      code: "file_read_failed",
      message:
        error instanceof Error
          ? error.message
          : "Failed to read text translation source file.",
      phase: "inspecting_files",
      field: "sourcePath",
      details: { sourcePath: inspection.file.sourcePath },
    });
  }

  const rawHash = createHash("sha256").update(buffer).digest("hex");
  const fingerprint: SourceFingerprint = {
    ...inspection.fingerprint,
    contentHash: rawHash,
  };

  const encoding = request.manualEncoding
    ? decodeWithManualOverride(buffer, request.manualEncoding)
    : decodeWithAutoDetection(buffer);

  const normalizedText = normalizeDecodedText(encoding.text);

  return {
    file: inspection.file,
    fingerprint,
    encoding: {
      encoding: encoding.encoding,
      hasBom: encoding.hasBom,
      confidence: encoding.confidence,
      source: encoding.source,
      candidates: encoding.candidates,
      manualOverride: encoding.source === "manual_override",
    },
    text: normalizedText.text,
    textLength: normalizedText.text.length,
    newlineNormalized: normalizedText.newlineNormalized,
    warnings: inspection.warnings,
  };
}

export function detectTextTranslationFileFormat(
  sourcePath: string,
): TextFileFormat {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".txt") return "txt";
  if (extension === ".md" || extension === ".markdown") return "markdown";

  throw new TextTranslationInputFileError({
    code: "unsupported_file_format",
    message: "Only .txt, .md, and .markdown files are supported.",
    phase: "inspecting_files",
    field: "sourcePath",
    details: { sourcePath },
  });
}

export function createTextTranslationFileId(
  sourcePath: string,
  order: number,
): string {
  const hash = createHash("sha256")
    .update(`${path.resolve(sourcePath)}\0${order}`)
    .digest("hex")
    .slice(0, 12);
  return `file_${String(order).padStart(4, "0")}_${hash}`;
}

function decodeWithAutoDetection(buffer: Buffer): {
  encoding: SupportedTextEncoding;
  text: string;
  hasBom: boolean;
  source: EncodingDecisionSource;
  confidence: number;
  candidates: EncodingCandidateScore[];
} {
  const detection = detectTextEncoding(buffer);

  if (detection.status === "accepted") {
    return detection;
  }

  throw new TextTranslationInputFileError({
    code:
      detection.reason === "empty_input"
        ? "empty_file"
        : "encoding_detection_failed",
    message:
      detection.reason === "empty_input"
        ? "Text translation source file is empty."
        : "Unable to determine a reliable text encoding for this file.",
    phase: "detecting_encoding",
    field: "sourcePath",
    details: {
      reason: detection.reason,
      candidates: detection.candidates,
      manualOverrideOptions: detection.manualOverrideOptions,
    },
  });
}

function decodeWithManualOverride(
  buffer: Buffer,
  encoding: SupportedTextEncoding,
): {
  encoding: SupportedTextEncoding;
  text: string;
  hasBom: boolean;
  source: "manual_override";
  confidence: number;
  candidates: EncodingCandidateScore[];
} {
  if (!SUPPORTED_TEXT_ENCODINGS.includes(encoding)) {
    throw new TextTranslationInputFileError({
      code: "encoding_detection_failed",
      message: "Manual encoding override is not supported.",
      phase: "detecting_encoding",
      field: "manualEncoding",
      details: { encoding },
    });
  }

  const text = decodeTextBuffer(buffer, encoding);
  const qualityScore = calculateTextQuality(text);
  if (qualityScore < TEXT_ENCODING_THRESHOLDS.minQualityScore) {
    throw new TextTranslationInputFileError({
      code: "manual_encoding_quality_failed",
      message: "Manual encoding override produced low-quality decoded text.",
      phase: "detecting_encoding",
      field: "manualEncoding",
      details: { encoding, qualityScore },
    });
  }

  return {
    encoding,
    text,
    hasBom: hasKnownBom(buffer),
    source: "manual_override",
    confidence: qualityScore,
    candidates: [],
  };
}

async function statInputFile(sourcePath: string): Promise<Stats> {
  try {
    return await fs.stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TextTranslationInputFileError({
        code: "file_not_found",
        message: "Text translation source file does not exist.",
        phase: "inspecting_files",
        field: "sourcePath",
        details: { sourcePath },
      });
    }
    throw new TextTranslationInputFileError({
      code: "file_read_failed",
      message:
        error instanceof Error
          ? error.message
          : "Failed to inspect text translation source file.",
      phase: "inspecting_files",
      field: "sourcePath",
      details: { sourcePath },
    });
  }
}

function collectResourceWarnings(
  file: TextTranslationFileRef,
): TextTranslationValidationIssue[] {
  const softLimit =
    file.format === "markdown"
      ? TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileSoftWarningBytes
      : TEXT_TRANSLATION_RESOURCE_LIMITS.txtSingleFileSoftWarningBytes;

  if (file.sizeBytes <= softLimit) return [];

  return [
    {
      code: "file_size_soft_warning",
      severity: "warning",
      field: "files",
      fileId: file.fileId,
      message: "File size exceeds the first-version soft warning.",
      details: {
        sizeBytes: file.sizeBytes,
        softLimitBytes: softLimit,
      },
    },
  ];
}

function assertNotOverHardLimit(file: TextTranslationFileRef): void {
  const hardLimit =
    file.format === "markdown"
      ? TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileHardLimitBytes
      : TEXT_TRANSLATION_RESOURCE_LIMITS.txtSingleFileHardLimitBytes;

  if (file.sizeBytes <= hardLimit) return;

  throw new TextTranslationInputFileError({
    code: "file_size_hard_limit",
    message: "File size exceeds the first-version hard limit.",
    phase: "inspecting_files",
    field: "files",
    details: {
      fileId: file.fileId,
      sizeBytes: file.sizeBytes,
      hardLimitBytes: hardLimit,
    },
  });
}

function normalizeDecodedText(text: string): {
  text: string;
  newlineNormalized: boolean;
} {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    text: normalized,
    newlineNormalized: normalized !== text,
  };
}

function hasKnownBom(buffer: Uint8Array): boolean {
  return (
    startsWithBytes(buffer, [0xef, 0xbb, 0xbf]) ||
    startsWithBytes(buffer, [0xff, 0xfe]) ||
    startsWithBytes(buffer, [0xfe, 0xff])
  );
}

function startsWithBytes(buffer: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}
