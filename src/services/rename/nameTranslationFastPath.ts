import type {
  NameTranslationModelOutputItem,
  NameTranslationOptions,
  NameTranslationTarget,
} from "./nameTypes";

type FastPathReason =
  | "empty"
  | "numeric"
  | "date"
  | "episode_code"
  | "technical_only"
  | "no_natural_language";

const ASCII_SEASON_EPISODE_PATTERN =
  /^(?:s\d{1,3}e\d{1,4}|season[\s._-]?\d{1,3}|episode[\s._-]?\d{1,4}|ep[\s._-]?\d{1,4})$/i;
const DATE_PATTERN =
  /^(?:19|20)\d{2}(?:[-_.](?:0?[1-9]|1[0-2])(?:[-_.](?:0?[1-9]|[12]\d|3[01]))?)?$/;
const NUMERIC_PATTERN = /^\d+(?:[._-]\d+)*$/;
const TECHNICAL_TOKEN_PATTERN =
  /^(?:\d{3,4}p|\d+k|x26[45]|h\.?26[45]|av1|aac|flac|mp3|opus|hdr|sdr|dv|webrip|web[-_. ]?dl|bluray|bdrip|dvdrip|remux|proper|repack|v\d+|r\d+|cd\d+|disc\d+)$/i;

export function getNameTranslationFastPath(
  target: NameTranslationTarget,
  options: NameTranslationOptions
): NameTranslationModelOutputItem | null {
  const reason = getFastPathReason(target.stem, options);
  if (!reason) return null;

  return {
    id: target.id,
    translatedStem: target.stem,
    confidence: "high",
    note: `fast_path:${reason}`,
  };
}

function getFastPathReason(
  stem: string,
  options: NameTranslationOptions
): FastPathReason | null {
  const normalized = stem.normalize("NFC").trim();
  if (!normalized) return "empty";
  if (isSymbolOnly(normalized)) return "no_natural_language";
  if (NUMERIC_PATTERN.test(normalized)) return "numeric";
  if (DATE_PATTERN.test(normalized)) return "date";
  if (ASCII_SEASON_EPISODE_PATTERN.test(normalized)) return "episode_code";
  if (
    options.preserveTechnicalTokens &&
    isTechnicalOnly(normalized)
  ) {
    return "technical_only";
  }
  return null;
}

function isSymbolOnly(value: string): boolean {
  return !/[\p{L}\p{N}]/u.test(value);
}

function isTechnicalOnly(value: string): boolean {
  const tokens = value
    .split(/[\s._()[\]{}+-]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens.length > 0 && tokens.every((token) => TECHNICAL_TOKEN_PATTERN.test(token));
}
