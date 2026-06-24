import { encode } from "gpt-tokenizer";

export function countTextTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return estimateTextTokens(text);
  }
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Array.from(text).length * 0.75));
}
