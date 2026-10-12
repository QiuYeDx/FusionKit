import { z } from 'zod';
import { idSchema } from './domain';
import { documentReferenceSchema, type BatchItem, type BatchFailure } from './batch-contract';
import { translationConfigSchema } from './translation-contract';
import type { KnowledgeTranslationPreview } from './knowledge-translation-contract';
import { knowledgeSelectionSchema } from '../translation-knowledge/execution-contract';

export const KNOWLEDGE_BATCH_DOCUMENT_LIMIT = 20;
export const knowledgeBatchRequestSchemas = {
  planKnowledgeTranslationBatch: z.object({
    documents: z.array(documentReferenceSchema).min(1).max(KNOWLEDGE_BATCH_DOCUMENT_LIMIT)
      .refine(items => new Set(items.map(item => item.documentId)).size === items.length),
    knowledgeGeneration: z.number().int().nonnegative().safe(), config: translationConfigSchema,
    knowledge: knowledgeSelectionSchema,
  }).strict(),
  createKnowledgeTranslationBatch: z.object({ planId: idSchema, apiKey: z.string().min(1).max(8000) }).strict(),
  cancelKnowledgeTranslationBatchPlan: z.object({}).strict(),
};
export type KnowledgeBatchTranslationRequest = z.infer<typeof knowledgeBatchRequestSchemas.planKnowledgeTranslationBatch>;
export type KnowledgeBatchIssue = KnowledgeTranslationPreview['issues'][number] & { cueNumbers: number[] };
export type KnowledgeBatchDocumentPreview = Omit<KnowledgeTranslationPreview, 'planId' | 'expiresAt' | 'issues'> & {
  issues: KnowledgeBatchIssue[];
  /** The preview carries at most 100 issues and 20 cue IDs per issue. The record is complete. */
  issueCount: number;
};
export type KnowledgeBatchTranslationPreview = {
  planId: string; expiresAt: number; knowledgeGeneration: number;
  items: BatchItem<{ plan: KnowledgeBatchDocumentPreview }>[];
  readyCount: number; totalEstimatedInputTokens: number; totalOutputTokenReserve: number;
};
export type KnowledgeBatchTranslationResult = {
  items: Array<Exclude<BatchItem<{ taskId: string }>, BatchFailure> | (BatchFailure & { reason?: 'knowledge_check_failed' })>;
};
