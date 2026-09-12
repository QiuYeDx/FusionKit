import { z } from 'zod';
import { translationConfigSchema } from './translation-contract';

const uuid = z.string().uuid();
export const automaticTranslationRequestSchema = z.object({
  config: translationConfigSchema,
  apiKey: z.string().min(1).max(8000).refine(value => !!value.trim()),
}).strict();
/** Durable intent contains configuration and identity, never credentials or native capabilities. */
export const automaticTranslationIntentSchema = z.object({
  intentId: uuid, sourceTaskId: uuid, generation: z.literal(1), config: translationConfigSchema,
  state: z.enum(['pending', 'admitted', 'cancelled']), translationTaskId: uuid.optional(),
}).strict().refine(value => value.state === 'pending' ? !value.translationTaskId : !!value.translationTaskId);
export type AutomaticTranslationIntent = z.infer<typeof automaticTranslationIntentSchema>;
export type AutomaticTranslationRequest = z.infer<typeof automaticTranslationRequestSchema>;
