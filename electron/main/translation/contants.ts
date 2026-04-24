/**
 * 字幕翻译模块 - 常量与辅助函数
 */

import { SubtitleSliceType } from "./typing";

/**
 * 各分片策略对应的 token 上限。
 * 翻译时会把字幕内容按此上限拆分成多个 fragment，每个 fragment 独立调用一次 LLM。
 */
export const DEFAULT_SLICE_LENGTH_MAP = {
  [SubtitleSliceType.NORMAL]: 3000,
  [SubtitleSliceType.SENSITIVE]: 100,
  [SubtitleSliceType.CUSTOM]: 1000,
};

/** 语言代码 → 英文全称，用于构建发给 LLM 的 prompt */
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

/** 将内部语言代码转为英文名称，未识别的代码原样返回 */
export function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}
