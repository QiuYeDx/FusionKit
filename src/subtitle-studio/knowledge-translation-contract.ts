import { z } from 'zod';
import { idSchema } from './domain';
import { translationConfigSchema } from './translation-contract';
import { knowledgeSelectionSchema, type KnowledgeIssue } from '../translation-knowledge/execution-contract';

export const documentTopicIdsSchema = z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length);
export const knowledgeTranslationRequestSchemas = {
  planKnowledgeTranslation: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(),
    knowledgeGeneration: z.number().int().nonnegative().safe(), config: translationConfigSchema,
    knowledge: knowledgeSelectionSchema, documentTopicIds: documentTopicIdsSchema }).strict(),
  createKnowledgeTranslation: z.object({ planId: idSchema, apiKey: z.string().min(1).max(8000) }).strict(),
  cancelKnowledgeTranslationPlan: z.object({}).strict(),
};
export type KnowledgeTranslationRequest = z.infer<typeof knowledgeTranslationRequestSchemas.planKnowledgeTranslation>;
export type KnowledgeTranslationPreview = {
  planId: string; documentId: string; revision: number; expiresAt: number; canRun: boolean;
  cueCount: number; batchCount: number; estimatedInputTokens: number; outputTokenReserve: number;
  knowledgeDigest: string; resourceCount: number; includedEntryCount: number;
  issues: KnowledgeIssue[];
};
