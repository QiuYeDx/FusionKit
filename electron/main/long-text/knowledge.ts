import type { LanguageTag } from '../../../src/long-text/contract';
import type { TermPair } from '../../../src/long-text/protocol';
import {
  knowledgeSelectionSchema,
  type BatchKnowledge, type CompiledKnowledge, type KnowledgeEnvironment, type KnowledgeIssueCode, type KnowledgeSelection,
} from '../../../src/translation-knowledge/execution-contract';
import { checkRequiredTerms, resolveEnvironment, selectBatchKnowledge } from '../../../src/translation-knowledge/execution';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import type { KnowledgeItemPayload } from './prompt';
import { ledgerKey } from './ledger';
import { LongTextOperationError } from './repository';

/**
 * Translation materials in long text runs (design §6.9.5). A run reads the library once and keeps
 * that snapshot; every batch resolves its own segments against it. Required items are never dropped.
 */

export type ReadKnowledge = () => Promise<LibrarySnapshot> | LibrarySnapshot;

/** The materials of one run or retranslation: the library snapshot and the selection with the document's languages. */
export interface RunKnowledge {
  library: Pick<LibrarySnapshot, 'generation' | 'data'>;
  selection: KnowledgeSelection;
  sourceLanguage: LanguageTag;
}

/** Problems of the selection as a whole; they block every batch. */
const BLOCKING: ReadonlySet<KnowledgeIssueCode> = new Set(['resource_missing', 'resource_archived', 'language_mismatch', 'selection_invalid', 'resource_limit']);

/** Most UTF-8 bytes of one cue `resolveEnvironment` accepts. */
export const KNOWLEDGE_CUE_BYTES = 65_536;
/** At most 3 UTF-8 bytes per UTF-16 unit: a probe this long is always a valid cue. */
const PROBE_CHARS = Math.floor(KNOWLEDGE_CUE_BYTES / 3);

/** A materials selection with the document's languages; null without collections. Rejects with knowledge_invalid. */
export function selectionForLanguages(selection: KnowledgeSelection | null, languages: { source: LanguageTag; target: LanguageTag }): KnowledgeSelection | null {
  if (!selection?.collectionIds.length) return null;
  const parsed = knowledgeSelectionSchema.safeParse({ ...selection, languagePair: { source: languages.source, target: languages.target } });
  if (!parsed.success) throw new LongTextOperationError('knowledge_invalid', { cause: parsed.error });
  return parsed.data;
}

/**
 * Reads the library and checks the selection against it with one segment (`probe`). Null when the
 * settings use no materials. Rejects with `knowledge_unavailable` when the library cannot be read and
 * with `knowledge_invalid` when the selection is not usable.
 */
export async function prepareKnowledge(
  selection: KnowledgeSelection | null,
  languages: { source: LanguageTag; target: LanguageTag },
  readKnowledge: ReadKnowledge,
  probe: { index: number; text: string },
): Promise<RunKnowledge | null> {
  const selected = selectionForLanguages(selection, languages);
  if (!selected) return null;
  let library: LibrarySnapshot;
  try {
    library = await readKnowledge();
  } catch (error) {
    throw new LongTextOperationError('knowledge_unavailable', { cause: error });
  }
  const knowledge: RunKnowledge = { library, selection: selected, sourceLanguage: languages.source };
  let environment: KnowledgeEnvironment;
  try {
    // Only problems of the selection matter here; `resolveEnvironment` refuses cues over 64 KiB.
    environment = resolveKnowledge(knowledge, [{ index: probe.index, text: probe.text.slice(0, PROBE_CHARS) }]);
  } catch (error) {
    throw new LongTextOperationError('knowledge_invalid', { cause: error });
  }
  if (environment.issues.some(issue => issue.severity === 'error' && !issue.cueIds.length && BLOCKING.has(issue.code))) {
    throw new LongTextOperationError('knowledge_invalid');
  }
  return knowledge;
}

/** Cue ids are segment indices. */
export const cueId = (index: number) => String(index);

/** Resolves up to 20 segments (display sources) against the run's materials. */
export function resolveKnowledge(knowledge: RunKnowledge, segments: ReadonlyArray<{ index: number; text: string }>): KnowledgeEnvironment {
  const cues = segments.map(({ index, text }) => ({ id: cueId(index), text, sourceLanguage: knowledge.sourceLanguage }));
  return resolveEnvironment(knowledge.library, knowledge.selection, cues);
}

/** The materials of the batch made of `indices`, which must all have been resolved in `environment`. */
export function batchKnowledge(environment: KnowledgeEnvironment, indices: readonly number[]): BatchKnowledge {
  return selectBatchKnowledge(environment, indices.map(cueId));
}

/** `translationKnowledge.items` with item ids in place of segment indices. */
export function knowledgeItems(compiled: CompiledKnowledge, itemIds: ReadonlyMap<number, string>): KnowledgeItemPayload[] {
  return compiled.items.map(item => ({
    kind: item.kind,
    required: item.required,
    payload: item.payload,
    applicableItemIds: item.applicableCueIds.map(id => itemIds.get(Number(id))).filter((id): id is string => id !== undefined),
  }));
}

/** `ledgerKey`s of every term source and alias of the compiled materials: glossary entries equal to one are not sent. */
export function knowledgeTermKeys(compiled: CompiledKnowledge | null): Set<string> {
  const keys = new Set<string>();
  for (const item of compiled?.items ?? []) {
    if (item.kind !== 'term') continue;
    const payload = item.payload as { source: string; aliases: string[] };
    for (const term of [payload.source, ...payload.aliases]) keys.add(ledgerKey(term));
  }
  return keys;
}

/** The material terms found in segment `index`, as source text and expected target. */
export function materialHits(compiled: CompiledKnowledge | null, index: number): TermPair[] {
  const id = cueId(index);
  const hits: TermPair[] = [];
  for (const item of compiled?.items ?? []) {
    if (item.kind !== 'term') continue;
    for (const match of item.matches) if (match.cueId === id) hits.push({ source: match.text, target: match.target });
  }
  return unique(hits);
}

/**
 * Required material terms a translation seems not to use (`required_term_suspect`), per segment.
 * `outputs` are the decoded translations; markup does not matter for the containment check.
 */
export function requiredTermIssues(compiled: CompiledKnowledge | null, outputs: ReadonlyArray<{ index: number; text: string }>): Map<number, TermPair[]> {
  const result = new Map<number, TermPair[]>();
  if (!compiled?.items.length || !outputs.length) return result;
  const issues = checkRequiredTerms(compiled, outputs.map(({ index, text }) => ({ cueId: cueId(index), text })));
  for (const issue of issues) {
    if (issue.code !== 'required_term_suspect') continue;
    for (const entryId of issue.entryIds) {
      const item = compiled.items.find(candidate => candidate.entryId === entryId);
      for (const id of issue.cueIds) {
        const match = item?.matches.find(candidate => candidate.cueId === id);
        if (!match) continue;
        const index = Number(id);
        result.set(index, unique([...(result.get(index) ?? []), { source: match.text, target: match.target }]));
      }
    }
  }
  return result;
}

function unique(terms: readonly TermPair[]): TermPair[] {
  const seen = new Set<string>();
  return terms.filter(term => {
    const key = `${term.source}\u0000${term.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
