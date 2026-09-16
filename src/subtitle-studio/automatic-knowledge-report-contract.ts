import { z } from 'zod';
import { idSchema } from './domain';
import type { TranslationConfig } from './translation-contract';
import type { KnowledgeIssue, KnowledgeSelection } from '../translation-knowledge/execution-contract';

export const readAutomaticKnowledgeReportSchema = z.object({ documentId: idSchema, trackId: idSchema }).strict();
export const AUTOMATIC_KNOWLEDGE_REPORT_LIMITS = { bytes: 256 * 1024, seedBytes: 256 * 1024,
  issues: 100, references: 20, name: 160, excerpt: 240 } as const;
export const AUTOMATIC_KNOWLEDGE_FAILURE_CODES = ['needs_configuration', 'translation_protocol_invalid', 'translation_output_limit',
  'translation_record_unavailable', 'translation_failed', 'knowledge_check_failed', 'limit_exceeded', 'revision_conflict', 'interrupted'] as const;
export type AutomaticKnowledgeFailureCode = typeof AUTOMATIC_KNOWLEDGE_FAILURE_CODES[number];
/** Choices for a new, explicit check against the current library and document.
 * This is never an execution capability, approval, or frozen knowledge payload. */
export type AutomaticKnowledgeRecheckSeed = {
  documentId: string; trackId: string; intentId: string; taskId: string;
  config: TranslationConfig; selection: KnowledgeSelection; documentTopicIds: string[];
};
export type AutomaticKnowledgeReportIssue = Pick<KnowledgeIssue, 'code' | 'severity'> & {
  entryCount: number; cueCount: number;
  entries: { entryId: string; title: string }[];
  cues: { cueId: string; number: number; text: string }[];
};
export type AutomaticKnowledgeMaterialSummary = {
  recipeName?: string; resourceCount: number; collectionCount: number; collections: string[];
  documentTopicCount: number; documentTopics: string[];
};
/** Saved issues are the ones discovered before preparation stopped, not a claim
 * that every possible issue in the entire document has been checked. */
export type AutomaticKnowledgeReportPage = { state: 'none' | 'unavailable' } | {
  state: 'legacy'; seed: AutomaticKnowledgeRecheckSeed | null;
} | {
  state: 'available'; createdAt: string; documentRevision: number;
  stale: boolean; sourceChanged: boolean; error: AutomaticKnowledgeFailureCode;
  issueCount: number; issuesTruncated: boolean; issues: AutomaticKnowledgeReportIssue[];
  material: AutomaticKnowledgeMaterialSummary; seed: AutomaticKnowledgeRecheckSeed | null;
};
