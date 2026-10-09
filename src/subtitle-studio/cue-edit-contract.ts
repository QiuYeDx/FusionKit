import { z } from 'zod';
import { bilingualImportSchema, cueSchema, diagnosticSchema, idSchema, LIMITS, textSchema, translationEntrySchema, type SubtitleText } from './domain';
import type { DocumentSummary } from './ipc-contract';

/** Upper bound for cues touched by one edit; the preview list shows at most one page. */
export const CUE_EDIT_LIMIT = 1000;
const cueIdsSchema = z.array(idSchema).min(1).max(CUE_EDIT_LIMIT).refine(ids => new Set(ids).size === ids.length);
const entriesSchema = z.record(idSchema, translationEntrySchema.nullable()).refine(entries => Object.keys(entries).length <= CUE_EDIT_LIMIT);
const textsSchema = z.record(idSchema, textSchema).refine(texts => Object.keys(texts).length <= CUE_EDIT_LIMIT);

/** Everything a deletion removed, so that undo can put it back exactly. */
export const removedCuesSchema = z.object({
  cues: z.array(z.object({
    /** Position in the cue list before the deletion. */
    index: z.number().int().min(0).max(LIMITS.cues),
    cue: cueSchema,
    /** Translation entries of the cue, by track id. */
    entries: z.record(idSchema, translationEntrySchema),
  }).strict()).min(1).max(CUE_EDIT_LIMIT),
  diagnostics: z.array(diagnosticSchema).max(CUE_EDIT_LIMIT * 4),
  bilingualImport: bilingualImportSchema.optional(),
  importedTrackIds: z.array(idSchema).max(100).optional(),
}).strict();

/**
 * One undoable change to the cues of a document. Every applied operation
 * returns its inverse, so undo and redo are ordinary operations too.
 */
export const cueEditOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), cueId: idSchema, text: textSchema }).strict(),
  /** A human translation; `null` clears it. */
  z.object({ kind: z.literal('target'), trackId: idSchema, cueId: idSchema, text: textSchema.nullable() }).strict(),
  z.object({ kind: z.literal('clear'), trackId: idSchema, cueIds: cueIdsSchema }).strict(),
  z.object({ kind: z.literal('review'), trackId: idSchema, cueIds: cueIdsSchema, reviewed: z.boolean() }).strict(),
  /** Puts exact entries back (undo of target, clear and review). */
  z.object({ kind: z.literal('entries'), trackId: idSchema, entries: entriesSchema }).strict(),
  /**
   * Several sources and translations changed together (an accepted AI revision).
   * `targets` become reviewed AI translations of the new sources, except that an
   * unchanged text only becomes current again; `entries` puts exact entries back
   * (its undo). Sources apply first, so translations refer to the new texts.
   */
  z.object({ kind: z.literal('revise'), sources: textsSchema, trackId: idSchema.optional(), targets: textsSchema.optional(), entries: entriesSchema.optional() }).strict(),
  z.object({ kind: z.literal('delete'), cueIds: cueIdsSchema }).strict(),
  z.object({ kind: z.literal('restore'), removed: removedCuesSchema }).strict(),
]);
export type CueEditOperation = z.infer<typeof cueEditOperationSchema>;
export type RemovedCues = z.infer<typeof removedCuesSchema>;
export type CueEditResult = {
  summary: DocumentSummary;
  /** Applying this operation reverts the edit. */
  undo: CueEditOperation;
  /** Cues whose content changed. */
  changed: number;
  /** Paused translation tasks that were stopped because they could no longer resume. */
  stoppedTasks: number;
};

const utf8 = new TextEncoder();
export type CueTextProblem = 'empty' | 'markup' | 'characters' | 'too_long';

/** Editor text as stored: LF newlines, no blank or trailing-space lines, trimmed. */
export function normalizeCueText(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/u, '')).filter(line => line.trim()).join('\n').trim();
}

function invalidCharacters(text: string): boolean {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return true;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Text the user typed. Angle brackets are reserved: translation requests use
 * them as markers and most subtitle formats read them as markup.
 */
export function cueTextProblem(value: string): CueTextProblem | null {
  if (!value.trim()) return 'empty';
  if (/[<>]/.test(value)) return 'markup';
  if (invalidCharacters(value)) return 'characters';
  if (utf8.encode(value).length > LIMITS.cueBytes) return 'too_long';
  return null;
}

/** Stored text the main process accepts, including text restored by undo. */
export function storedTextProblem(text: SubtitleText): CueTextProblem | null {
  if (!text.plain.trim()) return 'empty';
  if (text.spans.map(span => span.text).join('') !== text.plain) return 'characters';
  if (invalidCharacters(text.plain)) return 'characters';
  if (utf8.encode(text.plain).length > LIMITS.cueBytes) return 'too_long';
  return null;
}

const styledSpans = (text: SubtitleText) => text.spans.filter(span => span.text.trim());
const sameMarks = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((mark, index) => mark === b[index]);

/** The old text mixes styles (for example one bold word), which a plain edit cannot keep. */
export function hasMixedStyle(text: SubtitleText): boolean {
  const spans = styledSpans(text);
  return spans.some(span => !sameMarks(span.marks, spans[0].marks));
}

/** A plain edit keeps styling that covers the whole old text (such as an italic line) and drops mixed styling. */
export function editedText(previous: SubtitleText | undefined, plain: string): SubtitleText {
  if (previous && previous.plain === plain) return previous;
  const spans = previous ? styledSpans(previous) : [];
  const marks = spans.length && !hasMixedStyle(previous!) ? [...spans[0].marks] : [];
  return { plain, spans: [{ text: plain, marks }] };
}
