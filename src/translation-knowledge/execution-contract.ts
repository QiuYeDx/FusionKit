import { z } from 'zod';
import type { Entry, Origin } from './schemas';

const id = z.string().uuid();
const ids = (max: number) => z.array(id).max(max).refine(values => new Set(values).size === values.length);
const language = z.string().min(2).max(80).refine(value => {
  try {
    const locale = new Intl.Locale(value);
    return Intl.getCanonicalLocales(value)[0] === value &&
      !['auto', 'und', 'mul'].includes(value.split('-')[0]) &&
      (locale.language !== 'zh' || ['Hans', 'Hant'].includes(locale.script ?? ''));
  } catch { return false; }
});
export const KNOWLEDGE_SELECTION_LIMITS = Object.freeze({ collections: 50, disabledEntries: 2000, textChars: 4000 });
/** The materials one translation run uses. Never part of the portable FK-TK file. */
export const knowledgeSelectionSchema = z.strictObject({
  version: z.literal(2), languagePair: z.strictObject({ source: language, target: language }),
  collectionIds: ids(KNOWLEDGE_SELECTION_LIMITS.collections), disabledEntryIds: ids(KNOWLEDGE_SELECTION_LIMITS.disabledEntries),
  instructions: z.string().max(KNOWLEDGE_SELECTION_LIMITS.textChars).optional(), context: z.string().max(KNOWLEDGE_SELECTION_LIMITS.textChars).optional(),
});
export type KnowledgeSelection = z.infer<typeof knowledgeSelectionSchema>;
/** IPC structured clone preserves explicit undefined optional properties. Omit
 * them before hashing so an absent choice and an omitted key digest alike. */
export function normalizeKnowledgeSelection(input: KnowledgeSelection): KnowledgeSelection {
  const selection = structuredClone(input);
  for (const key of ['instructions', 'context'] as const) if (selection[key] === undefined) delete selection[key];
  return selection;
}
export type KnowledgeCue = { id: string; text: string; sourceLanguage: string };
export const KNOWLEDGE_ISSUE_CODES = ['selection_invalid', 'resource_limit', 'resource_missing', 'resource_archived', 'language_mismatch', 'disabled', 'no_match', 'term_conflict', 'budget_excluded', 'budget_required', 'required_term_suspect'] as const;
export type KnowledgeIssueCode = typeof KNOWLEDGE_ISSUE_CODES[number];
export type KnowledgeIssue = { code: KnowledgeIssueCode; severity: 'warning' | 'error'; entryIds: string[]; cueIds: string[] };
export type CompiledKnowledgeItem = {
  entryId: string; revision: number; digest: string; kind: Entry['kind'];
  applicableCueIds: string[]; required: boolean; payload: Entry['payload']; origin?: Origin;
  matches: Array<{ cueId: string; start: number; end: number; text: string; target: string }>;
};
export type KnowledgeEnvironment = {
  policyVersion: string; generation: number; sourceDigest: string; configDigest: string; digest: string;
  selection: KnowledgeSelection; cues: KnowledgeCue[]; instructions: string; context: string;
  items: CompiledKnowledgeItem[]; issues: KnowledgeIssue[];
  collections: Array<{ id: string; name: string }>;
};
export type BatchKnowledge = { policyVersion: string; environmentDigest: string; instructions: string; context: string; required: CompiledKnowledgeItem[]; optional: CompiledKnowledgeItem[]; issues: KnowledgeIssue[] };
export type CompiledKnowledge = { policyVersion: string; environmentDigest: string; instructions: string; context: string; items: CompiledKnowledgeItem[]; issues: KnowledgeIssue[] };
