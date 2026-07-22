import {
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleFormat,
  type LocalSubtitleTranscript,
} from "@/type/localSubtitle";
import { validateLocalSubtitleTranscript } from "@/type/localSubtitleIpc";

const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const UTF8_ENCODER = new TextEncoder();
const SRT_TIMESTAMP =
  /^(\d{2}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/u;
const LRC_TIMESTAMP = /^(\[(\d{2,}):([0-5]\d)\.(\d{2})\])(.*)$/u;
const UNSAFE_SUBTITLE_TEXT =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_PROJECTED_LRC_TEXT_CHARS =
  LOCAL_SUBTITLE_LIMITS.maxCueTextChars +
  LOCAL_SUBTITLE_LIMITS.maxCueLines -
  1;

export type LocalSubtitleFormatErrorCode =
  | "invalid_content"
  | "limit_exceeded";

export class LocalSubtitleFormatError extends Error {
  readonly name = "LocalSubtitleFormatError";

  constructor(
    readonly code: LocalSubtitleFormatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedLocalSubtitleCue {
  readonly startMs: number;
  readonly endMs?: number;
  readonly text: string;
}

export interface ParsedLocalSubtitleArtifact {
  readonly format: LocalSubtitleFormat;
  readonly rawText: string;
  readonly cues: readonly ParsedLocalSubtitleCue[];
}

export function formatLocalSubtitleSrt(
  transcript: LocalSubtitleTranscript,
): string {
  const validated = requireTranscript(transcript);
  const chunks: string[] = [];
  let byteLength = 0;
  validated.segments.forEach((segment, index) => {
    assertSrtCueText(segment.text);
    const block = [
      String(index + 1),
      `${formatSrtTimestamp(segment.startMs)} --> ${formatSrtTimestamp(segment.endMs)}`,
      segment.text,
    ].join("\n");
    byteLength = appendBoundedArtifactChunk(
      chunks,
      `${index === 0 ? "" : "\n\n"}${block}`,
      byteLength,
    );
  });
  appendBoundedArtifactChunk(chunks, "\n", byteLength);
  return chunks.join("");
}

export function formatLocalSubtitleLrc(
  transcript: LocalSubtitleTranscript,
): string {
  const validated = requireTranscript(transcript);
  const chunks: string[] = [];
  let byteLength = 0;
  validated.segments.forEach((segment) => {
    const text = projectLocalSubtitleLrcText(segment.text);
    byteLength = appendBoundedArtifactChunk(
      chunks,
      `${formatLrcTimestamp(segment.startMs)}${text}\n`,
      byteLength,
    );
  });
  return chunks.join("");
}

export function formatLocalSubtitleArtifact(
  format: LocalSubtitleFormat,
  transcript: LocalSubtitleTranscript,
): string {
  switch (format) {
    case "SRT":
      return formatLocalSubtitleSrt(transcript);
    case "LRC":
      return formatLocalSubtitleLrc(transcript);
  }
}

export function encodeLocalSubtitleArtifact(
  format: LocalSubtitleFormat,
  transcript: LocalSubtitleTranscript,
): Uint8Array {
  return UTF8_ENCODER.encode(
    formatLocalSubtitleArtifact(format, transcript),
  );
}

export function parseLocalSubtitleSrtUtf8(
  bytes: Uint8Array,
): ParsedLocalSubtitleArtifact {
  const rawText = decodeArtifactUtf8(bytes);
  const body = removeRequiredTrailingLf(rawText);
  const blocks = body.split("\n\n");
  if (
    blocks.length === 0 ||
    blocks.length > LOCAL_SUBTITLE_LIMITS.maxArtifactCues
  ) {
    throw limit("SRT cue count is outside the supported range.");
  }

  let previousEndMs = 0;
  const cues = blocks.map<ParsedLocalSubtitleCue>((block, index) => {
    const lines = block.split("\n");
    if (lines.length < 3 || lines.some((line) => line.length === 0)) {
      throw invalid("SRT blocks must contain an index, timestamp, and text.");
    }
    if (lines[0] !== String(index + 1)) {
      throw invalid("SRT cue indices must be consecutive and one-based.");
    }
    const timestamp = SRT_TIMESTAMP.exec(lines[1]!);
    if (!timestamp) throw invalid("SRT timestamp syntax is invalid.");
    const startMs = parseSrtTimestamp(timestamp, 1);
    const endMs = parseSrtTimestamp(timestamp, 5);
    if (endMs <= startMs || startMs < previousEndMs) {
      throw invalid("SRT cue timestamps must be ordered and non-overlapping.");
    }
    const text = lines.slice(2).join("\n");
    assertSrtCueText(text);
    previousEndMs = endMs;
    return Object.freeze({ startMs, endMs, text });
  });

  return Object.freeze({
    format: "SRT" as const,
    rawText,
    cues: Object.freeze(cues),
  });
}

export function parseLocalSubtitleLrcUtf8(
  bytes: Uint8Array,
): ParsedLocalSubtitleArtifact {
  const rawText = decodeArtifactUtf8(bytes);
  const body = removeRequiredTrailingLf(rawText);
  const lines = body.split("\n");
  if (
    lines.length === 0 ||
    lines.length > LOCAL_SUBTITLE_LIMITS.maxArtifactCues
  ) {
    throw limit("LRC cue count is outside the supported range.");
  }

  let previousStartMs = 0;
  const cues = lines.map<ParsedLocalSubtitleCue>((line) => {
    const timestamp = LRC_TIMESTAMP.exec(line);
    if (!timestamp) throw invalid("LRC line syntax is invalid.");
    const minutes = parseBoundedInteger(timestamp[2]!, "LRC minutes");
    const seconds = parseBoundedInteger(timestamp[3]!, "LRC seconds");
    const centiseconds = parseBoundedInteger(
      timestamp[4]!,
      "LRC centiseconds",
    );
    const startMs = minutes * 60_000 + seconds * 1_000 + centiseconds * 10;
    if (!Number.isSafeInteger(startMs)) {
      throw invalid("LRC timestamp is invalid.");
    }
    if (startMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs) {
      throw limit("LRC timestamp exceeds the supported range.");
    }
    if (timestamp[1] !== formatLrcTimestamp(startMs)) {
      throw invalid("LRC timestamp is not in canonical form.");
    }
    if (startMs < previousStartMs) {
      throw invalid("LRC timestamps must be ordered.");
    }
    const text = timestamp[5]!;
    assertLrcCueText(text);
    previousStartMs = startMs;
    return Object.freeze({ startMs, text });
  });

  return Object.freeze({
    format: "LRC" as const,
    rawText,
    cues: Object.freeze(cues),
  });
}

export function parseLocalSubtitleArtifactUtf8(
  format: LocalSubtitleFormat,
  bytes: Uint8Array,
): ParsedLocalSubtitleArtifact {
  switch (format) {
    case "SRT":
      return parseLocalSubtitleSrtUtf8(bytes);
    case "LRC":
      return parseLocalSubtitleLrcUtf8(bytes);
  }
}

export function verifyLocalSubtitleArtifactRoundTrip(
  format: LocalSubtitleFormat,
  transcript: LocalSubtitleTranscript,
  parsed: ParsedLocalSubtitleArtifact,
): void {
  const validated = requireTranscript(transcript);
  if (
    parsed.format !== format ||
    parsed.cues.length !== validated.segments.length
  ) {
    throw invalid("Subtitle parse-back cue identity does not match the transcript.");
  }

  parsed.cues.forEach((cue, index) => {
    const segment = validated.segments[index]!;
    if (format === "SRT") {
      if (
        cue.startMs !== segment.startMs ||
        cue.endMs !== segment.endMs ||
        cue.text !== segment.text
      ) {
        throw invalid("SRT parse-back does not match the canonical transcript.");
      }
      return;
    }
    if (
      cue.startMs !== Math.floor(segment.startMs / 10) * 10 ||
      cue.endMs !== undefined ||
      cue.text !== projectLocalSubtitleLrcText(segment.text)
    ) {
      throw invalid("LRC parse-back does not match its canonical projection.");
    }
  });
}

export function toPlainLocalSubtitleText(
  parsed: ParsedLocalSubtitleArtifact,
): string {
  const value = parsed.cues.map((cue) => cue.text).join("\n");
  if (!value) throw invalid("Subtitle artifact has no readable text.");
  return value;
}

export function projectLocalSubtitleLrcText(text: string): string {
  assertCanonicalCueText(text);
  const projected = text.replaceAll("\n", " ");
  assertLrcCueText(projected);
  return projected;
}

function requireTranscript(
  transcript: LocalSubtitleTranscript,
): LocalSubtitleTranscript {
  const validation = validateLocalSubtitleTranscript(transcript);
  if (!validation.ok) {
    throw invalid("Canonical subtitle transcript is invalid.");
  }
  if (validation.data.segments.length > LOCAL_SUBTITLE_LIMITS.maxArtifactCues) {
    throw limit("Subtitle cue count exceeds the artifact limit.");
  }
  return validation.data;
}

function formatSrtTimestamp(milliseconds: number): string {
  assertTimestamp(milliseconds);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)},${threeDigits(millis)}`;
}

function formatLrcTimestamp(milliseconds: number): string {
  assertTimestamp(milliseconds);
  const totalCentiseconds = Math.floor(milliseconds / 10);
  const minutes = Math.floor(totalCentiseconds / 6_000);
  const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `[${String(minutes).padStart(2, "0")}:${twoDigits(seconds)}.${twoDigits(centiseconds)}]`;
}

function parseSrtTimestamp(match: RegExpExecArray, offset: number): number {
  const hours = parseBoundedInteger(match[offset]!, "SRT hours");
  const minutes = parseBoundedInteger(match[offset + 1]!, "SRT minutes");
  const seconds = parseBoundedInteger(match[offset + 2]!, "SRT seconds");
  const millis = parseBoundedInteger(match[offset + 3]!, "SRT milliseconds");
  const result =
    hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;
  assertTimestamp(result);
  return result;
}

function decodeArtifactUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    throw invalid("Subtitle artifact must not be empty.");
  }
  if (bytes.byteLength > LOCAL_SUBTITLE_LIMITS.maxArtifactBytes) {
    throw limit("Subtitle artifact exceeds the byte limit.");
  }
  let value: string;
  try {
    value = UTF8_DECODER.decode(bytes);
  } catch {
    throw invalid("Subtitle artifact is not valid UTF-8.");
  }
  if (value.startsWith("\ufeff")) {
    throw invalid("Subtitle artifact must not contain a UTF-8 BOM.");
  }
  if (UNSAFE_SUBTITLE_TEXT.test(value)) {
    throw invalid("Subtitle artifact contains unsafe control characters.");
  }
  return value;
}

function removeRequiredTrailingLf(value: string): string {
  if (!value.endsWith("\n") || value.endsWith("\n\n")) {
    throw invalid("Subtitle artifact must end with exactly one LF.");
  }
  const body = value.slice(0, -1);
  if (!body) throw invalid("Subtitle artifact must contain at least one cue.");
  return body;
}

function assertSrtCueText(value: string): void {
  assertCanonicalCueText(value);
  if (value.split("\n").some((line) => line.length === 0)) {
    throw invalid("SRT cue text cannot contain an empty internal line.");
  }
}

function assertCanonicalCueText(value: string): void {
  assertSafeNonBlankText(value);
  const lines = value.split("\n");
  if (
    lines.length > LOCAL_SUBTITLE_LIMITS.maxCueLines ||
    lines.some((line) => line.length > LOCAL_SUBTITLE_LIMITS.maxLineChars) ||
    lines.reduce((sum, line) => sum + line.length, 0) >
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars
  ) {
    throw invalid("Subtitle cue text is invalid.");
  }
}

function assertLrcCueText(value: string): void {
  assertSafeNonBlankText(value);
  if (value.includes("\n")) {
    throw invalid("Standard LRC cues must be one line.");
  }
  if (value.length > MAX_PROJECTED_LRC_TEXT_CHARS) {
    throw invalid("LRC cue text exceeds the projected text limit.");
  }
}

function assertSafeNonBlankText(value: string): void {
  if (
    !value ||
    !value.trim() ||
    UNSAFE_SUBTITLE_TEXT.test(value) ||
    hasUnpairedSurrogate(value)
  ) {
    throw invalid("Subtitle cue text is invalid.");
  }
}

function appendBoundedArtifactChunk(
  chunks: string[],
  value: string,
  currentByteLength: number,
): number {
  const nextByteLength = currentByteLength + UTF8_ENCODER.encode(value).byteLength;
  if (nextByteLength > LOCAL_SUBTITLE_LIMITS.maxArtifactBytes) {
    throw limit("Subtitle artifact exceeds the byte limit.");
  }
  chunks.push(value);
  return nextByteLength;
}

function assertTimestamp(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > LOCAL_SUBTITLE_LIMITS.maxDurationMs
  ) {
    throw limit("Subtitle timestamp exceeds the supported range.");
  }
}

function parseBoundedInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalid(`${label} is invalid.`);
  }
  return parsed;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function threeDigits(value: number): string {
  return String(value).padStart(3, "0");
}

function invalid(message: string): LocalSubtitleFormatError {
  return new LocalSubtitleFormatError("invalid_content", message);
}

function limit(message: string): LocalSubtitleFormatError {
  return new LocalSubtitleFormatError("limit_exceeded", message);
}
