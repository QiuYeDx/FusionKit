import { z } from 'zod';

const tokenCount = z.number().int().nonnegative().safe();
export const translationModelSchema = z.object({
  profileId: z.string().min(1).max(200),
  modelKey: z.string().trim().min(1).max(200),
  endpoint: z.string().url().max(2000).refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  apiFormat: z.enum(['chat_completions', 'responses']),
  outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  thinkingEnabled: z.boolean().optional(),
}).strict();
export const translationConfigSchema = z.object({
  model: translationModelSchema,
  language: z.string().trim().min(1).max(100),
  instructions: z.string().max(4000),
  contextWindow: z.number().int().min(2048).max(1000000),
  maxOutputTokens: z.number().int().min(256).max(32768),
  maxBatchCues: z.number().int().min(1).max(100),
}).strict().refine(config => config.maxOutputTokens < config.contextWindow);
export const translationUsageSchema = z.object({
  inputTokens: tokenCount.nullable(), outputTokens: tokenCount.nullable(), totalTokens: tokenCount.nullable(),
}).strict();
export const translationProgressSchema = z.object({
  config: translationConfigSchema,
  totalBatches: z.number().int().positive().max(100000),
  estimatedInputTokens: tokenCount,
  outputTokenReserve: tokenCount,
  usage: translationUsageSchema,
  error: z.enum(['needs_configuration', 'translation_protocol_invalid', 'translation_output_limit', 'translation_failed', 'limit_exceeded', 'revision_conflict', 'interrupted']).optional(),
}).strict();
export type TranslationConfig = z.infer<typeof translationConfigSchema>;
export type TranslationUsage = z.infer<typeof translationUsageSchema>;
export type TranslationProgress = z.infer<typeof translationProgressSchema>;
export type TranslationPlanSummary = { planId: string; documentId: string; revision: number; cueCount: number; batchCount: number; estimatedInputTokens: number; outputTokenReserve: number; contextTokenReserve: number };
