import { z } from 'zod';
import { idSchema, LIMITS } from './domain';

export const bilingualOptionsSchema = z.object({
  sourceSide: z.enum(['first', 'second']),
  splitInline: z.boolean(),
  overrides: z.array(z.object({ cueId: idSchema, splitAt: z.number().int().nonnegative().max(LIMITS.cueBytes).nullable() }).strict()).max(1000),
}).strict().refine(value => new Set(value.overrides.map(item => item.cueId)).size === value.overrides.length);
export type BilingualOptions = z.infer<typeof bilingualOptionsSchema>;

export const bilingualLanguageSchema = z.enum(['ja', 'zh', 'en', 'ko', 'und']);
export const bilingualCandidateSchema = z.object({
  id: idSchema,
  kind: z.enum(['same_time', 'lines', 'inline']),
  startMs: z.number().int().safe(),
  first: z.string().max(LIMITS.cueBytes),
  second: z.string().max(LIMITS.cueBytes),
  needsReview: z.boolean(),
  splitAt: z.number().int().nonnegative().nullable(),
  splitChoices: z.array(z.object({ offset: z.number().int().nonnegative(), label: z.string().max(100) }).strict()).max(64),
}).strict();
export const bilingualPreviewSchema = z.object({
  revision: z.number().int().positive().safe(),
  originalCueCount: z.number().int().nonnegative().max(LIMITS.cues),
  cueCount: z.number().int().nonnegative().max(LIMITS.cues),
  totalCandidates: z.number().int().nonnegative().max(LIMITS.cues),
  pairedCount: z.number().int().nonnegative().max(LIMITS.cues),
  remainingCount: z.number().int().nonnegative().max(LIMITS.cues),
  reviewCount: z.number().int().nonnegative().max(LIMITS.cues),
  recommended: z.boolean(),
  sourceLanguage: bilingualLanguageSchema,
  targetLanguage: bilingualLanguageSchema,
  offset: z.number().int().nonnegative().max(LIMITS.cues),
  candidates: z.array(bilingualCandidateSchema).max(20),
}).strict();
export type BilingualCandidate = z.infer<typeof bilingualCandidateSchema>;
export type BilingualPreview = z.infer<typeof bilingualPreviewSchema>;
