import { z } from 'zod';
import { idSchema, LIMITS } from './domain';
import type { TranslationConfig } from './translation-contract';

export const readExecutionRecordSchema = z.object({
  documentId: idSchema, trackId: idSchema,
  batchOffset: z.number().int().min(0).max(LIMITS.cues),
}).strict();

/** One batch per read; private record tables never enter a document page. */
export type ExecutionRecordPage = { state: 'legacy' | 'unavailable' } | {
  state: 'available'; recordId: string; createdAt: string; config: TranslationConfig;
  policyVersion: string; totalBatches: number; preparedBatches: number; batchOffset: number;
  batch: {
    id: string; items: { id: string; text: string }[]; before: string[]; after: string[];
    request: null | {
      createdAt: string; priorModelTranslations: string[]; httpBody: string;
    };
  };
};
