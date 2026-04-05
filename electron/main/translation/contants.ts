import { SubtitleSliceType } from "./typing";

export const DEFAULT_SLICE_LENGTH_MAP = {
  [SubtitleSliceType.NORMAL]: 3000,
  [SubtitleSliceType.SENSITIVE]: 100,
  [SubtitleSliceType.CUSTOM]: 1000,
};

export const LANGUAGE_NAMES: Record<string, string> = {
  JA: "Japanese",
  ZH: "Chinese",
  EN: "English",
  KO: "Korean",
  FR: "French",
  DE: "German",
  ES: "Spanish",
  RU: "Russian",
  PT: "Portuguese",
};

export function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}
