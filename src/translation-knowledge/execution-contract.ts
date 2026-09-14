import { z } from 'zod';
import type { Entry, Source } from './schemas';

const id = z.string().uuid();
const cueId = z.string().min(1).max(200);
const ids = z.array(id).max(20000).refine(values => new Set(values).size === values.length);
const cueIds = z.array(cueId).min(1).max(20).refine(values => new Set(values).size === values.length);
const language = z.string().min(2).max(80).refine(value => {
  try {
    const locale = new Intl.Locale(value);
    return Intl.getCanonicalLocales(value)[0] === value &&
      !['auto', 'und', 'mul'].includes(value.split('-')[0]) &&
      (locale.language !== 'zh' || ['Hans', 'Hant'].includes(locale.script ?? ''));
  } catch { return false; }
});
/** Private task selection; these file-specific confirmations never enter FK-TK/1. */
export const knowledgeSelectionSchema = z.strictObject({
  version: z.literal(1), languagePair: z.strictObject({ source: language, target: language }),
  recipeId: id.optional(), collectionIds: ids,
  bindings: z.array(z.strictObject({ subjectId: id, role: z.enum(['topic', 'speaker', 'mentioned']), cueIds })).max(100),
  confirmations: z.array(z.strictObject({ entryId: id, cueIds })).max(20000),
  disabledEntryIds: ids, instructions: z.string().max(4000).optional(), context: z.string().max(4000).optional(),
});
export type KnowledgeSelection = z.infer<typeof knowledgeSelectionSchema>;
export type KnowledgeCue = { id: string; text: string; sourceLanguage: string };
export const KNOWLEDGE_ISSUE_CODES = ['selection_invalid', 'resource_limit', 'resource_missing', 'resource_archived', 'style_unavailable', 'language_mismatch', 'untrusted', 'unsupported_kind', 'subject_unbound', 'speaker_conflict', 'condition_unconfirmed', 'disabled', 'no_match', 'term_conflict', 'rule_conflict', 'budget_excluded', 'budget_required', 'preferences_not_applied', 'required_term_suspect'] as const;
export type KnowledgeIssueCode = typeof KNOWLEDGE_ISSUE_CODES[number];
export type KnowledgeIssue = { code: KnowledgeIssueCode; severity: 'warning' | 'error'; entryIds: string[]; cueIds: string[] };
export type CompiledKnowledgeItem = {
  entryId: string; revision: number; digest: string; title: string; kind: Entry['kind'];
  applicableCueIds: string[]; required: boolean; payload: Entry['payload'];
  condition?: string; evidence: Source[];
  matches: Array<{ cueId: string; start: number; end: number; text: string; target: string }>;
};
export type KnowledgeEnvironment = {
  policyVersion: string; generation: number; sourceDigest: string; configDigest: string; digest: string;
  selection: KnowledgeSelection; cues: KnowledgeCue[]; instructions: string; context: string;
  items: CompiledKnowledgeItem[]; issues: KnowledgeIssue[];
  collections: Array<{ id: string; name: string }>; recipeName?: string;
};
export type BatchKnowledge = { policyVersion: string; environmentDigest: string; instructions: string; context: string; required: CompiledKnowledgeItem[]; optional: CompiledKnowledgeItem[]; issues: KnowledgeIssue[] };
export type CompiledKnowledge = { policyVersion: string; environmentDigest: string; instructions: string; context: string; items: CompiledKnowledgeItem[]; issues: KnowledgeIssue[] };
