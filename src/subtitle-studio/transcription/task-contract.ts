import { z } from 'zod';
import { errorCodeSchema } from '../domain';
import { LOCAL_SUBTITLE_DEVICE_PREFERENCES, LOCAL_SUBTITLE_ERROR_CODES, LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT, LOCAL_SUBTITLE_WINDOW_STRATEGIES } from './domain';

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const language = z.string().min(2).max(32).refine(value => value === 'auto' || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value));
export const transcriptionTaskConfigSchema = z.object({
  modelId: opaqueId,
  devicePreference: z.enum(LOCAL_SUBTITLE_DEVICE_PREFERENCES),
  language,
  taskMode: z.enum(['transcribe', 'translate_to_english']),
  vadEnabled: z.boolean(),
  windowStrategy: z.enum(LOCAL_SUBTITLE_WINDOW_STRATEGIES).optional(),
  advanced: z.object({
    initialPrompt: z.string().max(LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars)
      .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)).optional(),
    beamSize: z.number().int().min(1).max(10),
    temperature: z.number().finite().min(0).max(1),
    vadMinSilenceMs: z.number().int().min(100).max(5000),
    maxCueDurationMs: z.number().int().min(500).max(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs),
    maxCueChars: z.number().int().min(20).max(LOCAL_SUBTITLE_LIMITS.maxCueTextChars),
    maxLineChars: z.number().int().min(10).max(LOCAL_SUBTITLE_LIMITS.maxLineChars),
  }).strict(),
}).strict();

/** Public requests contain ephemeral capabilities and choices, never native paths or proofs. */
export const enqueueTranscriptionRequestSchema = z.object({
  files: z.array(z.object({ fileToken: opaqueId, audioStreamId: opaqueId.optional() }).strict()).min(1).max(20),
  config: transcriptionTaskConfigSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.files.map(file => file.fileToken)).size !== value.files.length)
    context.addIssue({ code: 'custom', path: ['files'], message: 'File tokens must be unique.' });
  if (value.config.windowStrategy === 'acoustic_quiet_v1' && !value.config.vadEnabled)
    context.addIssue({ code: 'custom', path: ['config', 'vadEnabled'], message: 'Pause-based chunking requires VAD.' });
});

export const transcriptionTaskSummarySchema = z.object({
  taskId: opaqueId, batchId: opaqueId, generation: z.literal(1),
  displayName: z.string().min(1).max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars),
  status: z.enum(['queued', 'preparing_media', 'loading_model', 'transcribing', 'post_processing', 'completed', 'cancelled', 'failed']),
  progress: z.number().finite().min(0).max(100),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), modelId: opaqueId,
  resolvedBackend: z.enum(['cpu', 'metal', 'cuda']),
  durationMs: z.number().int().safe().nonnegative().max(LOCAL_SUBTITLE_LIMITS.maxDurationMs).optional(),
  documentId: z.string().uuid().optional(), documentDurability: z.enum(['confirmed', 'uncertain']).optional(),
  error: z.object({ code: z.union([z.enum(LOCAL_SUBTITLE_ERROR_CODES), errorCodeSchema]) }).strict().optional(),
  cleanupPending: z.literal(true).optional(),
}).strict();
export type EnqueueTranscriptionRequest = z.infer<typeof enqueueTranscriptionRequestSchema>;
export type TranscriptionTaskSummary = Readonly<z.infer<typeof transcriptionTaskSummarySchema>>;
export type TranscriptionBatchAdmission = Readonly<{ batchId: string; tasks: readonly TranscriptionTaskSummary[] }>;
