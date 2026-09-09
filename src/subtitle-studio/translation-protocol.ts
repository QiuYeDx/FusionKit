import { LIMITS, StudioError, type SubtitleCue, type SubtitleDocument, type SubtitleText } from './domain';

type Mark = SubtitleText['spans'][number]['marks'][number];
type ProtectedMark = { id: number; mark: Mark; parentId: number | null };

export type TranslationUnit = {
  id: string;
  cueId: string;
  sourceRevision: number;
  sourceHash: string;
  text: string;
  protectedMarks: ProtectedMark[];
};

const MAX_PROTECTED_MARKS = 512;
const MAX_BATCH_UNITS = 100;
const utf8 = new TextEncoder();
const invalid = () => new StudioError('translation_protocol_invalid');

function validCharacters(text: string): boolean {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function sourceFingerprint(cue: SubtitleCue): string {
  return JSON.stringify(cue.source);
}

export function projectTranslationUnits(doc: SubtitleDocument): TranslationUnit[] {
  if (!doc.capabilities.translate) throw new StudioError('unsupported_feature');
  if (doc.cues.length > LIMITS.cues) throw new StudioError('limit_exceeded');
  const units: TranslationUnit[] = [];
  for (const cue of doc.cues) {
    if (!validCharacters(cue.source.plain) || /[<>]/.test(cue.source.plain)) throw new StudioError('unsupported_feature');
    if (!/\S/u.test(cue.source.plain)) continue;
    if (utf8.encode(cue.source.plain).length > LIMITS.cueBytes) throw new StudioError('limit_exceeded');
    const protectedMarks: ProtectedMark[] = [];
    const stack: ProtectedMark[] = [];
    const parts: string[] = [];
    for (const span of cue.source.spans) {
      if (!span.text) continue;
      if (span.marks.length > 32 || span.marks.some(mark => !['b', 'i', 'u'].includes(mark))) throw new StudioError('unsupported_feature');
      let shared = 0;
      while (shared < stack.length && shared < span.marks.length && stack[shared].mark === span.marks[shared]) shared++;
      while (stack.length > shared) parts.push(`</m${stack.pop()!.id}>`);
      for (const mark of span.marks.slice(shared)) {
        if (protectedMarks.length >= MAX_PROTECTED_MARKS) throw new StudioError('limit_exceeded');
        const item = { id: protectedMarks.length + 1, mark, parentId: stack.at(-1)?.id ?? null };
        protectedMarks.push(item);
        stack.push(item);
        parts.push(`<m${item.id}>`);
      }
      parts.push(span.text);
    }
    while (stack.length) parts.push(`</m${stack.pop()!.id}>`);
    if (cue.source.spans.map(span => span.text).join('') !== cue.source.plain) throw new StudioError('invalid_input');
    units.push({
      id: `u${units.length + 1}`, cueId: cue.id, sourceRevision: cue.sourceRevision,
      // The main-process planner hashes this fingerprint before freezing or persisting a plan.
      sourceHash: sourceFingerprint(cue), text: parts.join(''), protectedMarks,
    });
  }
  if (!units.length) throw new StudioError('unsupported_feature');
  return units;
}

function decodeText(text: string, unit: TranslationUnit): SubtitleText {
  if (text.length > LIMITS.cueBytes + MAX_PROTECTED_MARKS * 16 || !validCharacters(text)) throw invalid();
  const expected = new Map(unit.protectedMarks.map(mark => [mark.id, mark]));
  const opened = new Set<number>();
  const stack: ProtectedMark[] = [];
  const spans: SubtitleText['spans'] = [];
  // Tags are protocol tokens only. Their local parent relationships survive response reordering.
  for (const token of text.split(/(<[^>]*>)/g)) {
    const match = /^<(\/?)m([1-9]\d{0,2})>$/.exec(token);
    if (match) {
      const id = Number(match[2]);
      const item = expected.get(id);
      if (!item) throw invalid();
      if (match[1]) {
        if (stack.pop()?.id !== id) throw invalid();
      } else {
        if (opened.has(id) || (stack.at(-1)?.id ?? null) !== item.parentId) throw invalid();
        opened.add(id);
        stack.push(item);
      }
    } else if (token) {
      if (/[<>]/.test(token)) throw invalid();
      const marks = stack.map(mark => mark.mark);
      const previous = spans.at(-1);
      if (previous && previous.marks.length === marks.length && previous.marks.every((mark, index) => mark === marks[index])) previous.text += token;
      else spans.push({ text: token, marks });
    }
  }
  if (stack.length || opened.size !== expected.size) throw invalid();
  const plain = spans.map(span => span.text).join('');
  if (!/\S/u.test(plain) || utf8.encode(plain).length > LIMITS.cueBytes) throw invalid();
  return { plain, spans };
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validateTranslationResponse(content: string, units: TranslationUnit[], maxBytes: number): Map<string, SubtitleText> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || units.length > MAX_BATCH_UNITS) throw new StudioError('limit_exceeded');
  if (content.length > maxBytes || utf8.encode(content).length > maxBytes) throw new StudioError('limit_exceeded');
  if (!units.length) throw invalid();
  let response: unknown;
  try { response = JSON.parse(content); } catch { throw invalid(); }
  if (!exactObject(response, ['items']) || !Array.isArray(response.items) || response.items.length !== units.length) throw invalid();
  const expected = new Map(units.map(unit => [unit.id, unit]));
  const cueIds = new Set(units.map(unit => unit.cueId));
  if (expected.size !== units.length || cueIds.size !== units.length) throw invalid();
  const translated = new Map<string, SubtitleText>();
  for (const item of response.items) {
    if (!exactObject(item, ['id', 'text']) || typeof item.id !== 'string' || typeof item.text !== 'string') throw invalid();
    const unit = expected.get(item.id);
    if (!unit || translated.has(unit.cueId)) throw invalid();
    translated.set(unit.cueId, decodeText(item.text, unit));
  }
  return translated;
}
