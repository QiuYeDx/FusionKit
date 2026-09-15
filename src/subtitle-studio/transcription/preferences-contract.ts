import { z } from 'zod';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from './domain';
import { transcriptionTaskConfigSchema } from './task-contract';
import { knowledgeSelectionSchema } from '../../translation-knowledge/execution-contract';
import { documentTopicIdsSchema } from '../knowledge-translation-contract';

export const DEFAULT_STUDIO_TRANSCRIPTION_CONFIG = Object.freeze({
  modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id, devicePreference: 'auto' as const, language: 'auto', taskMode: 'transcribe' as const,
  vadEnabled: true, windowStrategy: 'acoustic_quiet_v1' as const, advanced: Object.freeze({ beamSize: 5, temperature: 0,
    vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 }),
});
/** Durable choices only. The library generation and prepared contents stay out of preferences. */
export const automaticKnowledgePreferencesSchema = knowledgeSelectionSchema.pick({ recipeId: true, collectionIds: true, disabledEntryIds: true, instructions: true, context: true })
  .extend({ enabled: z.boolean(), sourceLanguage: z.union([z.literal(''), knowledgeSelectionSchema.shape.languagePair.shape.source]), documentTopicIds: documentTopicIdsSchema }).strict();
export type AutomaticKnowledgePreferences = z.infer<typeof automaticKnowledgePreferencesSchema>;
export const DEFAULT_AUTOMATIC_KNOWLEDGE: AutomaticKnowledgePreferences = { enabled: false, sourceLanguage: '', collectionIds: [], disabledEntryIds: [], documentTopicIds: [] };
export const automaticTranslationPreferencesSchema = z.object({
  enabled: z.boolean(), profileId: z.string().max(200), language: z.string().trim().min(1).max(100), instructions: z.string().max(4000),
  contextWindow: z.number().int().min(2048).max(1000000), maxOutputTokens: z.number().int().min(256).max(32768),
  maxBatchCues: z.number().int().min(1).max(100),
  knowledge: automaticKnowledgePreferencesSchema.optional(),
}).strict().refine(value => value.maxOutputTokens < value.contextWindow);
export const transcriptionPreferencesSchema = z.object({
  version: z.literal(1),
  config: transcriptionTaskConfigSchema.refine(value => value.windowStrategy !== 'acoustic_quiet_v1' || value.vadEnabled),
  autoTranslation: automaticTranslationPreferencesSchema,
}).strict();
export type AutomaticTranslationPreferences = z.infer<typeof automaticTranslationPreferencesSchema>;
export type TranscriptionPreferences = z.infer<typeof transcriptionPreferencesSchema>;
export const DEFAULT_TRANSCRIPTION_PREFERENCES: TranscriptionPreferences = Object.freeze({ version: 1, config: DEFAULT_STUDIO_TRANSCRIPTION_CONFIG,
  autoTranslation: Object.freeze({ enabled: false, profileId: '', language: 'zh', instructions: '', contextWindow: 32768, maxOutputTokens: 4096, maxBatchCues: 32 }) });
export function readTranscriptionPreferences(value: unknown): TranscriptionPreferences {
  const parsed = transcriptionPreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES);
}
