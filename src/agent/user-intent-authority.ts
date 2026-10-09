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
  return messages.some((message) => isTypedUserMessage(message) && whole.test(normalizePathText(message.content)));
}

/** True when the user typed this path, or a directory that contains it, in a message of this session. */
export function userMentionedPath(messages: readonly AgentMessage[], target: string): boolean {
  let current = normalizePathText(target);
  while (current.length >= 3 && /[/:]/.test(current)) {
    if (userMentionedDirectory(messages, current)) return true;
    const separator = current.lastIndexOf("/");
    if (separator <= 0) return false;
    current = current.slice(0, separator);
  }
  return false;
}

/** A message the user typed; interface events written by FusionKit share the user role but are not. */
export function isTypedUserMessage(message: AgentMessage): boolean {
  return message.role === "user" && !message.event;
}

export function latestUserMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isTypedUserMessage(messages[index])) return messages[index];
  }
  return undefined;
}

export function latestUserMessageText(messages: readonly AgentMessage[]): string {
  return latestUserMessage(messages)?.content ?? "";
}
