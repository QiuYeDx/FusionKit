import type { SubtitleCue, SubtitleText, TranslationEntry } from './domain';
import { editedText, type CueEditOperation } from './cue-edit-contract';

/**
 * Structural cue edits the renderer and the revision preview prepare: what merging consecutive
 * cues yields, and reading the times a user types. Pure, so the table, the preview and tests share it.
 */
export const MERGE_LIMIT = 50;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
/** Text as a repeated recognition would match it: width, case, spacing and punctuation ignored. */
export const foldWording = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Two texts say the same thing: equal once folded, or one holds the other and is at least half as long. */
export function repeats(first: string, second: string): boolean {
  const a = foldWording(first), b = foldWording(second);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length * 2 >= long.length;
}

/** A recognizer that restarts a sentence: one text begins the other (two characters at least). */
function restarts(first: string, second: string): boolean {
  const a = foldWording(first), b = foldWording(second);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && long.startsWith(short);
}

/**
 * Joins texts in order. A text that repeats or restarts the one before keeps only the fuller of
 * the two (the longer, or the earlier when equal); others are joined directly after CJK text and
 * with a space otherwise.
 */
export function mergeTexts(texts: readonly string[]): string {
  const pieces: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    const last = pieces.at(-1);
    if (last !== undefined && (repeats(last, text) || restarts(last, text))) {
      const fuller = foldWording(text).length > foldWording(last).length || (foldWording(text).length === foldWording(last).length && text.length > last.length);
      if (fuller) pieces[pieces.length - 1] = text;
      continue;
    }
    pieces.push(text);
  }
  return pieces.reduce((joined, piece) => !joined ? piece
    : CJK.test(joined.at(-1)!) || CJK.test(piece[0]) ? `${joined}${piece}` : `${joined} ${piece}`, '');
}

/** Whether the cues are next to each other, in document order. */
export function consecutive(cueIds: readonly string[], order: readonly string[]): boolean {
  const positions = cueIds.map(id => order.indexOf(id));
  if (positions.some(position => position < 0)) return false;
  const sorted = [...positions].sort((a, b) => a - b);
  return sorted.every((position, index) => !index || position === sorted[index - 1] + 1);
}

type Track = { id: string; entries: Record<string, TranslationEntry> };
const current = (track: Track, cue: SubtitleCue) => {
  const entry = track.entries[cue.id];
  return entry && entry.sourceRevision === cue.sourceRevision ? entry : undefined;
};

/**
 * The merge of consecutive cues (in document order): source and translation joined by
 * `mergeTexts`. The translation stays current only when every cue had a current one; otherwise the
 * translations there are joined and marked as made for an older source.
 */
export function mergeOperation(cues: readonly SubtitleCue[], track?: Track, origin: 'human' | 'ai' = 'human'): Extract<CueEditOperation, { kind: 'merge' }> {
  const source = editedText(cues[0].source, mergeTexts(cues.map(cue => cue.source.plain)));
  const operation: Extract<CueEditOperation, { kind: 'merge' }> = { kind: 'merge', cueIds: cues.map(cue => cue.id), source, origin };
  if (!track) return operation;
  const entries = cues.map(cue => track.entries[cue.id]);
  if (!entries.some(Boolean)) return operation;
  const allCurrent = cues.every(cue => current(track, cue));
  const target = mergeTexts(entries.flatMap(entry => entry ? [entry.text.plain] : []));
  return { ...operation, trackId: track.id, target: editedText(entries.find(Boolean)!.text, target), ...(allCurrent ? {} : { targetStale: true }) };
}

/** The span a merge gives: from the first cue's start to the last cue's end (unknown stays unknown). */
export function mergedTiming(cues: readonly SubtitleCue[]) {
  return { startMs: cues[0].timing.startMs, endMs: cues.at(-1)!.timing.endMs };
}

/**
 * A time the user typed, in milliseconds: `HH:MM:SS.mmm`, `MM:SS.mmm` or seconds, with a dot or a
 * comma before the fraction. Returns null for anything else.
 */
export function parseStudioTime(value: string): number | null {
  const match = /^\s*(?:(\d+):)??(?:(\d+):)?(\d+)(?:[.,](\d{1,3}))?\s*$/.exec(value);
  if (!match) return null;
  const [, first, second, seconds, fraction] = match;
  const hours = first !== undefined && second !== undefined ? Number(first) : 0;
  const minutes = second !== undefined ? Number(second) : first !== undefined ? Number(first) : 0;
  if ((first !== undefined || second !== undefined) && Number(seconds) >= 60) return null;
  if (second !== undefined && minutes >= 60) return null;
  const ms = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  const total = ((hours * 60 + minutes) * 60 + Number(seconds)) * 1000 + ms;
  return Number.isSafeInteger(total) ? total : null;
}

/** A cue's texts when a structure proposal was made: its source and current translation, if any. */
export type CueStructureCurrent = { source: SubtitleText; target?: SubtitleText };
export type CueTiming = { startMs: number; endMs: number | null };
/**
 * A structural change the revision preview offers: consecutive cues merged into one, a cue
 * deleted, or a cue retimed. Positions count from 0; times come from the cues, never a model.
 */
export type CueStructureProposal =
  | { kind: 'merge'; cueIds: string[]; indexes: number[]; current: CueStructureCurrent[]; source: string; target?: string; targetStale?: true; timing: CueTiming; origin: 'human' | 'ai' }
  | { kind: 'delete'; cueId: string; index: number; current: CueStructureCurrent; timing: CueTiming }
  | { kind: 'timing'; cueId: string; index: number; current: CueStructureCurrent; before: CueTiming; timing: CueTiming };

/** Identifies a structure proposal in the preview, next to text proposals keyed by cue id. */
export const structureKey = (proposal: CueStructureProposal) => `${proposal.kind}:${proposal.kind === 'merge' ? proposal.cueIds[0] : proposal.cueId}`;
/** The cues a proposal takes over, so a text change to them is not applied as well. */
export const structureCueIds = (proposal: CueStructureProposal) => proposal.kind === 'merge' ? proposal.cueIds : [proposal.cueId];

const currentTexts = (cue: SubtitleCue, track?: Track): CueStructureCurrent => {
  const entry = track && current(track, cue);
  return { source: cue.source, ...(entry ? { target: entry.text } : {}) };
};

/** The merge proposal for consecutive cues, texts joined as a manual merge joins them. */
export function mergeProposal(cues: readonly (SubtitleCue & { index: number })[], track?: Track, origin: 'human' | 'ai' = 'human'): Extract<CueStructureProposal, { kind: 'merge' }> {
  const operation = mergeOperation(cues, track, origin);
  return { kind: 'merge', cueIds: cues.map(cue => cue.id), indexes: cues.map(cue => cue.index), current: cues.map(cue => currentTexts(cue, track)),
    source: operation.source.plain, ...(operation.target ? { target: operation.target.plain } : {}), ...(operation.targetStale ? { targetStale: true as const } : {}),
    timing: mergedTiming(cues), origin };
}

/** Lines further apart than this are not one recognition repeated. */
export const DUPLICATE_GAP_MS = 10_000;

/**
 * Neighbouring cues whose source says the same thing (see `repeats`) and that start within
 * ten seconds of each other, as merge proposals; a run of several becomes one proposal.
 * `cues` are consecutive in the document, with their positions.
 */
export function findAdjacentDuplicates(cues: readonly (SubtitleCue & { index: number })[], track?: Track): Extract<CueStructureProposal, { kind: 'merge' }>[] {
  const proposals: Extract<CueStructureProposal, { kind: 'merge' }>[] = [];
  let run: (SubtitleCue & { index: number })[] = [];
  const close = () => {
    if (run.length >= 2) for (let offset = 0; offset < run.length; offset += MERGE_LIMIT) {
      const part = run.slice(offset, offset + MERGE_LIMIT);
      if (part.length >= 2) proposals.push(mergeProposal(part, track));
    }
    run = [];
  };
  for (const cue of cues) {
    const last = run.at(-1);
    const joins = last && cue.index === last.index + 1 && cue.timing.startMs - last.timing.startMs <= DUPLICATE_GAP_MS && cue.timing.startMs >= last.timing.startMs
      && repeats(last.source.plain, cue.source.plain);
    if (!joins) close();
    run.push(cue);
  }
  close();
  return proposals;
}

/**
 * The single edit that applies the accepted proposals: text changes first, then merges and
 * deletions, then new times. Only text changes stay one `revise`, as before.
 */
export function revisionOperation(texts: Extract<CueEditOperation, { kind: 'revise' }> | null, structure: readonly CueStructureProposal[], trackId?: string): CueEditOperation | null {
  const operations: Exclude<CueEditOperation, { kind: 'batch' }>[] = [];
  if (texts && (Object.keys(texts.sources).length || Object.keys(texts.targets ?? {}).length)) operations.push(texts);
  for (const proposal of structure) if (proposal.kind === 'merge') {
    const first = proposal.current[0];
    operations.push({ kind: 'merge', cueIds: proposal.cueIds, source: editedText(first.source, proposal.source), origin: proposal.origin,
      ...(trackId && proposal.target !== undefined ? { trackId, target: editedText(proposal.current.find(item => item.target)?.target, proposal.target), ...(proposal.targetStale ? { targetStale: true as const } : {}) } : {}) });
  }
  const deletes = structure.flatMap(proposal => proposal.kind === 'delete' ? [proposal.cueId] : []);
  if (deletes.length) operations.push({ kind: 'delete', cueIds: deletes });
  const timings = structure.flatMap(proposal => proposal.kind === 'timing' ? [[proposal.cueId, proposal.timing] as const] : []);
  if (timings.length) operations.push({ kind: 'timing', changes: Object.fromEntries(timings) });
  if (!operations.length) return null;
  return operations.length === 1 ? operations[0] : { kind: 'batch', operations };
}
