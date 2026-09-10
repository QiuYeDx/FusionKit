import { z } from 'zod';
import { idSchema, LIMITS, StudioError } from './domain';

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
export type TranslationModel = z.infer<typeof translationModelSchema>;
export function normalizeTranslationModel(input: TranslationModel): TranslationModel {
  const parsed = translationModelSchema.safeParse(input);
  if (!parsed.success) throw new StudioError('invalid_input');
  const model = parsed.data;
  if (model.apiFormat === 'chat_completions' && model.modelKey.toLowerCase().startsWith('deepseek-')) model.thinkingEnabled ??= false;
  return model;
}
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
export const translationCheckpointSchema = z.object({
  version: z.literal(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  trackRevision: z.number().int().positive().safe(),
  batches: z.array(z.object({
    id: z.string().min(1).max(100),
    cueIds: z.array(idSchema).min(1).max(100),
    before: z.array(z.string().max(LIMITS.cueBytes)).max(2),
    after: z.array(z.string().max(LIMITS.cueBytes)).max(2),
    estimatedInputTokens: tokenCount,
    priorContextReserve: tokenCount,
  }).strict()).min(1).max(LIMITS.cues),
}).strict();
export type TranslationCheckpoint = z.infer<typeof translationCheckpointSchema>;
export const translationProgressSchema = z.object({
  config: translationConfigSchema,
  totalBatches: z.number().int().positive().max(100000),
  estimatedInputTokens: tokenCount,
  outputTokenReserve: tokenCount,
  usage: translationUsageSchema,
  checkpoint: translationCheckpointSchema.optional(),
  inFlightBatchId: z.string().min(1).max(100).optional(),
  uncertainAttempts: tokenCount.optional(),
  notBefore: tokenCount.optional(),
  error: z.enum(['needs_configuration', 'translation_protocol_invalid', 'translation_output_limit', 'translation_failed', 'limit_exceeded', 'revision_conflict', 'interrupted']).optional(),
}).strict();
export type TranslationConfig = z.infer<typeof translationConfigSchema>;
export type TranslationUsage = z.infer<typeof translationUsageSchema>;
export type TranslationProgress = z.infer<typeof translationProgressSchema>;
export type TranslationPlanSummary = { planId: string; documentId: string; revision: number; cueCount: number; batchCount: number; estimatedInputTokens: number; outputTokenReserve: number; contextTokenReserve: number };
