import chardet from "chardet";
import iconv from "iconv-lite";

export type SupportedTextEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "gb18030"
  | "big5"
  | "shift_jis"
  | "euc-jp"
  | "euc-kr"
  | "windows-1252";

export type EncodingDecisionSource =
  | "bom"
  | "strict_utf8"
  | "utf16_heuristic"
  | "statistical_detector"
  | "manual_override";

export interface EncodingCandidateScore {
  encoding: SupportedTextEncoding;
  detectorConfidence: number;
  qualityScore: number;
  combinedScore: number;
}

export type EncodingDetectionResult =
  | {
      status: "accepted";
      encoding: SupportedTextEncoding;
      text: string;
      hasBom: boolean;
      source: EncodingDecisionSource;
      confidence: number;
      candidates: EncodingCandidateScore[];
    }
  | {
      status: "rejected";
      hasBom: false;
      reason:
        | "empty_input"
        | "unsupported_or_low_confidence"
        | "decoded_text_failed_quality_check";
      candidates: EncodingCandidateScore[];
      manualOverrideOptions: SupportedTextEncoding[];
    };

export const SUPPORTED_TEXT_ENCODINGS: SupportedTextEncoding[] = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "gb18030",
  "big5",
  "shift_jis",
  "euc-jp",
  "euc-kr",
  "windows-1252",
];

export const TEXT_ENCODING_THRESHOLDS = {
  minDetectorConfidence: 0.55,
  minDetectorGap: 0.15,
  minQualityScore: 0.82,
  highDetectorConfidence: 0.9,
} as const;

const BOM_SIGNATURES: Array<{
  encoding: SupportedTextEncoding;
  bytes: number[];
}> = [
  { encoding: "utf-8", bytes: [0xef, 0xbb, 0xbf] },
  { encoding: "utf-16le", bytes: [0xff, 0xfe] },
  { encoding: "utf-16be", bytes: [0xfe, 0xff] },
];

const ENCODING_ALIASES: Record<string, SupportedTextEncoding | undefined> = {
  utf8: "utf-8",
  utf16le: "utf-16le",
  utf16be: "utf-16be",
  gb18030: "gb18030",
  gbk: "gb18030",
  gb2312: "gb18030",
  big5: "big5",
  big5hkscs: "big5",
  shiftjis: "shift_jis",
  sjis: "shift_jis",
  cp932: "shift_jis",
  eucjp: "euc-jp",
  euckr: "euc-kr",
  cp949: "euc-kr",
  windows1252: "windows-1252",
  iso88591: "windows-1252",
};

export function detectTextEncoding(
  buffer: Uint8Array,
): EncodingDetectionResult {
  if (buffer.length === 0) {
    return {
      status: "rejected",
      hasBom: false,
      reason: "empty_input",
      candidates: [],
      manualOverrideOptions: [...SUPPORTED_TEXT_ENCODINGS],
    };
  }

  for (const signature of BOM_SIGNATURES) {
    if (!startsWithBytes(buffer, signature.bytes)) continue;

    const text = decodeTextBuffer(
      buffer,
      signature.encoding,
      signature.bytes.length,
    );
    const qualityScore = calculateTextQuality(text);

    if (qualityScore < TEXT_ENCODING_THRESHOLDS.minQualityScore) {
      return {
        status: "rejected",
        hasBom: false,
        reason: "decoded_text_failed_quality_check",
        candidates: [
          {
            encoding: signature.encoding,
            detectorConfidence: 1,
            qualityScore,
            combinedScore: qualityScore,
          },
        ],
        manualOverrideOptions: [...SUPPORTED_TEXT_ENCODINGS],
      };
    }

    return {
      status: "accepted",
      encoding: signature.encoding,
      text,
      hasBom: true,
      source: "bom",
      confidence: 1,
      candidates: [],
    };
  }

  const utf16Heuristic = detectBomlessUtf16(buffer);
  if (utf16Heuristic) {
    const text = decodeTextBuffer(buffer, utf16Heuristic.encoding);
    const qualityScore = calculateTextQuality(text);
    if (qualityScore >= TEXT_ENCODING_THRESHOLDS.minQualityScore) {
      return {
        status: "accepted",
        encoding: utf16Heuristic.encoding,
        text,
        hasBom: false,
        source: "utf16_heuristic",
        confidence: utf16Heuristic.confidence * qualityScore,
        candidates: [],
      };
    }
  }

  const utf8Text = tryDecodeStrictUtf8(buffer);
  if (utf8Text !== undefined) {
    return {
      status: "accepted",
      encoding: "utf-8",
      text: utf8Text,
      hasBom: false,
      source: "strict_utf8",
      confidence: 1,
      candidates: [],
    };
  }

  const candidates = buildDetectorCandidates(buffer);
  const best = candidates[0];
  const runnerUp = candidates[1];
  const detectorGap = best
    ? best.detectorConfidence - (runnerUp?.detectorConfidence ?? 0)
    : 0;

  if (
    best &&
    best.detectorConfidence >=
      TEXT_ENCODING_THRESHOLDS.minDetectorConfidence &&
    best.qualityScore >= TEXT_ENCODING_THRESHOLDS.minQualityScore &&
    (best.detectorConfidence >=
      TEXT_ENCODING_THRESHOLDS.highDetectorConfidence ||
      detectorGap >= TEXT_ENCODING_THRESHOLDS.minDetectorGap)
  ) {
    return {
      status: "accepted",
      encoding: best.encoding,
      text: decodeTextBuffer(buffer, best.encoding),
      hasBom: false,
      source: "statistical_detector",
      confidence: best.combinedScore,
      candidates,
    };
  }

  return {
    status: "rejected",
    hasBom: false,
    reason: "unsupported_or_low_confidence",
    candidates,
    manualOverrideOptions: [...SUPPORTED_TEXT_ENCODINGS],
  };
}

export function decodeTextBuffer(
  buffer: Uint8Array,
  encoding: SupportedTextEncoding,
  bomLength = 0,
): string {
  return iconv.decode(buffer.subarray(bomLength), encoding, {
    stripBOM: true,
  });
}

export function normalizeTextEncodingName(
  name: string,
): SupportedTextEncoding | undefined {
  return ENCODING_ALIASES[name.toLowerCase().replace(/[^a-z0-9]/g, "")];
}

export function calculateTextQuality(text: string): number {
  const characters = Array.from(text);
  if (characters.length === 0) return 0;

  let replacementCount = 0;
  let nullCount = 0;
  let disallowedControlCount = 0;
  let readableCount = 0;

  for (const character of characters) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\uFFFD") replacementCount += 1;
    if (codePoint === 0) nullCount += 1;

    const isAllowedWhitespace =
      character === "\n" || character === "\r" || character === "\t";
    const isDisallowedControl =
      (!isAllowedWhitespace && codePoint < 0x20) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
    if (isDisallowedControl) disallowedControlCount += 1;

    if (
      isAllowedWhitespace ||
      /[\p{L}\p{N}\p{P}\p{S}\p{Z}]/u.test(character)
    ) {
      readableCount += 1;
    }
  }

  const length = characters.length;
  const replacementRatio = replacementCount / length;
  const nullRatio = nullCount / length;
  const controlRatio = disallowedControlCount / length;
  const readableRatio = readableCount / length;

  const score =
    readableRatio -
    replacementRatio * 8 -
    nullRatio * 8 -
    controlRatio * 6;

  return Math.max(0, Math.min(1, score));
}

function normalizeDetectorEncodingName(
  name: string,
): SupportedTextEncoding | undefined {
  return normalizeTextEncodingName(name);
}

function startsWithBytes(buffer: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function tryDecodeStrictUtf8(buffer: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(buffer);
    return calculateTextQuality(text) >=
      TEXT_ENCODING_THRESHOLDS.minQualityScore
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

function detectBomlessUtf16(
  buffer: Uint8Array,
):
  | { encoding: "utf-16le" | "utf-16be"; confidence: number }
  | undefined {
  if (buffer.length < 8 || buffer.length % 2 !== 0) return undefined;

  let evenNulls = 0;
  let oddNulls = 0;
  const pairs = buffer.length / 2;

  for (let index = 0; index < buffer.length; index += 2) {
    if (buffer[index] === 0) evenNulls += 1;
    if (buffer[index + 1] === 0) oddNulls += 1;
  }

  const evenNullRatio = evenNulls / pairs;
  const oddNullRatio = oddNulls / pairs;

  if (oddNullRatio >= 0.3 && evenNullRatio <= 0.05) {
    return {
      encoding: "utf-16le",
      confidence: Math.min(0.95, 0.65 + oddNullRatio * 0.3),
    };
  }

  if (evenNullRatio >= 0.3 && oddNullRatio <= 0.05) {
    return {
      encoding: "utf-16be",
      confidence: Math.min(0.95, 0.65 + evenNullRatio * 0.3),
    };
  }

  return undefined;
}

function buildDetectorCandidates(buffer: Uint8Array): EncodingCandidateScore[] {
  const scores = new Map<SupportedTextEncoding, EncodingCandidateScore>();

  for (const match of chardet.analyse(buffer)) {
    const encoding = normalizeDetectorEncodingName(match.name);
    if (!encoding || scores.has(encoding)) continue;

    const text = decodeTextBuffer(buffer, encoding);
    const detectorConfidence = match.confidence / 100;
    const qualityScore = calculateTextQuality(text);
    const combinedScore = detectorConfidence * 0.75 + qualityScore * 0.25;

    scores.set(encoding, {
      encoding,
      detectorConfidence,
      qualityScore,
      combinedScore,
    });
  }

  return [...scores.values()].sort(
    (left, right) => right.combinedScore - left.combinedScore,
  );
}
