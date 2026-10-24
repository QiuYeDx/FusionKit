import { LONG_TEXT_LIMITS } from './contract';

/**
 * Batch response parsing (design §6.7.2): lenient about shape, strict about ids. Unknown top-level
 * keys and unknown keys inside items are ignored; `terms` is a side channel that never fails a batch.
 */

export interface TermPair { source: string; target: string }
export type BatchError = 'not_json' | 'shape' | 'ids' | 'too_large';
export interface ParsedBatch {
  /** Translation text by item id, in response order. */
  items: Map<string, string>;
  terms: TermPair[];
}
export type BatchParseResult = ParsedBatch | { error: BatchError };

const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The JSON object from the first `{` to the last `}`, which also drops a wrapping code fence and any
 * text around it; undefined when that is not valid JSON.
 */
function extractObject(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const termLength = (text: string) => text.length >= 1 && text.length <= LONG_TEXT_LIMITS.termChars;

/**
 * The usable entries of a response's `terms`: nothing unless it is an array of at most
 * `termsPerResponse` entries; entries that are not `{ source, target }` strings of 1–80 characters
 * after trimming are dropped.
 */
export function validateTerms(value: unknown): TermPair[] {
  if (!Array.isArray(value) || value.length > LONG_TEXT_LIMITS.termsPerResponse) return [];
  const terms: TermPair[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.source !== 'string' || typeof entry.target !== 'string') continue;
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (termLength(source) && termLength(target)) terms.push({ source, target });
  }
  return terms;
}

/**
 * Parses a model's answer to one batch. The answer must be at most `maxBytes` UTF-8 bytes and hold an
 * object with an `items` array of `{ id, text }` (numeric ids count as strings) whose ids are exactly
 * `expectedIds`, each once.
 */
export function parseBatchResponse(content: string, expectedIds: readonly string[], maxBytes: number): BatchParseResult {
  // A UTF-16 code unit never takes less than one UTF-8 byte.
  if (content.length > maxBytes || utf8.encode(content).length > maxBytes) return { error: 'too_large' };
  const response = extractObject(content);
  if (response === undefined) return { error: 'not_json' };
  if (!isRecord(response) || !Array.isArray(response.items)) return { error: 'shape' };

  const entries: Array<[string, string]> = [];
  for (const item of response.items) {
    if (!isRecord(item) || typeof item.text !== 'string') return { error: 'shape' };
    const id = typeof item.id === 'number' && Number.isFinite(item.id) ? String(item.id) : item.id;
    if (typeof id !== 'string') return { error: 'shape' };
    entries.push([id, item.text]);
  }
  const items = new Map(entries);
  const expected = new Set(expectedIds);
  if (entries.length !== expectedIds.length || items.size !== entries.length || expectedIds.some(id => !items.has(id)) || expected.size !== items.size) {
    return { error: 'ids' };
  }
  return { items, terms: validateTerms(response.terms) };
}
