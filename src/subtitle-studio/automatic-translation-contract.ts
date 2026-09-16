import { z } from 'zod';
import { translationConfigSchema } from './translation-contract';
import { automaticKnowledgeRequestSchema, frozenAutomaticKnowledgeSchema } from '../translation-knowledge/automatic-snapshot-contract';

const uuid = z.string().uuid();
export const automaticTranslationRequestSchema = z.object({
  config: translationConfigSchema,
  apiKey: z.string().min(1).max(8000).refine(value => !!value.trim()),
  knowledge: automaticKnowledgeRequestSchema.optional(),
}).strict().refine(value => !value.knowledge || value.knowledge.selection.languagePair.target ===
  (value.config.language === 'zh' ? 'zh-Hans' : value.config.language));
/** Durable intent contains configuration and identity, never credentials or native capabilities. */
export const automaticTranslationIntentSchema = z.object({
  intentId: uuid, sourceTaskId: uuid, generation: z.literal(1), config: translationConfigSchema,
  state: z.enum(['pending', 'admitted', 'cancelled']), translationTaskId: uuid.optional(),
  knowledge: frozenAutomaticKnowledgeSchema.optional(),
  // Private diagnostics are validated on admission/inspection. An unreadable
  // historical report must not roll the document back to an older generation.
  preparationReport: z.unknown().optional(),
}).strict().refine(value => value.state === 'pending' ? !value.translationTaskId : !!value.translationTaskId);
export type AutomaticTranslationIntent = z.infer<typeof automaticTranslationIntentSchema>;
export type AutomaticTranslationRequest = z.infer<typeof automaticTranslationRequestSchema>;
