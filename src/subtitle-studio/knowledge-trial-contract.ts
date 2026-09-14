import { z } from 'zod';
import { idSchema, type ErrorCode } from './domain';
import { translationConfigSchema, type TranslationUsage } from './translation-contract';
import { knowledgeSelectionSchema, type CompiledKnowledge, type KnowledgeIssue } from '../translation-knowledge/execution-contract';

export const knowledgeTrialRequestSchemas = {
  planKnowledgeTrial: z.strictObject({ documentId: idSchema, knowledgeGeneration: z.number().int().nonnegative().safe(), revision: z.number().int().positive().safe(), cueIds: z.array(idSchema).min(1).max(20).refine(ids => new Set(ids).size === ids.length).optional(), config: translationConfigSchema, knowledge: knowledgeSelectionSchema }),
  runKnowledgeTrial: z.strictObject({ planId: idSchema, apiKey: z.string().min(1).max(8000) }),
  cancelKnowledgeTrial: z.strictObject({}),
};
export type KnowledgeTrialRequest = z.infer<typeof knowledgeTrialRequestSchemas.planKnowledgeTrial>;
export type KnowledgeTrialPreview = {
  planId: string; documentId: string; revision: number; sourceDigest: string; knowledgeDigest: string;
  expiresAt: number; canRun: boolean; cueCount: number; batchCount: number; estimatedInputTokens: number; outputTokenReserve: number;
  cues: Array<{ id: string; text: string }>; issues: KnowledgeIssue[];
  batches: Array<{ id: string; cueIds: string[]; knowledge: CompiledKnowledge; estimatedInputTokens: number }>;
};
export type KnowledgeTrialResult = {
  status: 'completed' | 'failed' | 'cancelled'; error?: ErrorCode;
  planId: string; items: Array<{ cueId: string; source: string; target: string; issues: KnowledgeIssue[] }>;
  usage: TranslationUsage; requestCount: number;
};
