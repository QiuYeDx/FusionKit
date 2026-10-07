import type { AgentMessage } from "./types";

// ---------------------------------------------------------------------------
// User-intent authority — model arguments that widen filesystem effects must be
// backed by what the user actually wrote, never by tool results or file contents.
// ---------------------------------------------------------------------------

const OVERWRITE_RE = /覆盖|覆蓋|替换|替換|上書き|置き換え|\boverwrit(?:e|ing)\b|\breplac(?:e|ing)\b/i;
const NEGATED_OVERWRITE_RE = /(?:不要|不用|无需|無需|别|別|不|勿|禁止|避免|しない|しないで|don['’]?t|do not|never|no|without|avoid)\s*(?:直接|同名)?\s*(?:覆盖|覆蓋|替换|替換|上書き|置き換え|overwrit|replac)/i;

/** True only when the latest user message explicitly asks to overwrite existing files. */
export function userRequestedOverwrite(latestUserText: string): boolean {
  return OVERWRITE_RE.test(latestUserText) && !NEGATED_OVERWRITE_RE.test(latestUserText);
}

function normalizePathText(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when a user message in this session contains the directory as a whole path. */
export function userMentionedDirectory(messages: readonly AgentMessage[], directory: string): boolean {
  const target = normalizePathText(directory);
  if (target.length < 3 || !/[/:]/.test(target)) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // ASCII path characters must not continue the match on either side; CJK text may.
  const whole = new RegExp(`(?<![\\w.\\-/])${escaped}(?!/?[\\w\\-]|\\.[\\w])`);
  return messages.some((message) => message.role === "user" && whole.test(normalizePathText(message.content)));
}

export function latestUserMessageText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content;
  }
  return "";
}
