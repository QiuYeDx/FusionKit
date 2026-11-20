import { z } from 'zod';
import { errorCodeSchema } from '../domain';
import { automaticTranslationRequestSchema } from '../automatic-translation-contract';
import { automaticExportSpecSchema } from '../automatic-export-contract';
import { TRANSCRIPTION_AUDIO_PROFILES } from '../transcription-audio-profiles';
import { STUDIO_TRANSCRIPTION_MODES, JAPANESE_ASMR_MODEL_ID, JAPANESE_ASMR_VAD_MODEL_ID } from './japanese-asmr-contract';
import { LOCAL_SUBTITLE_DEVICE_PREFERENCES, LOCAL_SUBTITLE_ERROR_CODES, LOCAL_SUBTITLE_LIMITS, LOCAL_SUBTITLE_OPERATION_STAGES,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT, LOCAL_SUBTITLE_WINDOW_STRATEGIES } from './domain';

/** One transcription batch takes at most this many media files (the native batch limit). */
export const STUDIO_TRANSCRIPTION_MAX_FILES = LOCAL_SUBTITLE_LIMITS.maxBatchFiles;

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const language = z.string().min(2).max(32).refine(value => value === 'auto' || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value));
export const transcriptionTaskConfigSchema = z.object({
  mode: z.enum(STUDIO_TRANSCRIPTION_MODES).optional(),
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
    /** Absent is the standard audio type; a profile tunes voice detection and needs it on. */
    audioProfile: z.enum(TRANSCRIPTION_AUDIO_PROFILES).optional(),
  }).strict(),
}).strict();

/** Public requests contain ephemeral capabilities and choices, never native paths or proofs. */
export const enqueueTranscriptionRequestSchema = z.object({
  files: z.array(z.object({ fileToken: opaqueId, audioStreamId: opaqueId.optional() }).strict()).min(1).max(STUDIO_TRANSCRIPTION_MAX_FILES),
  config: transcriptionTaskConfigSchema,
  autoTranslation: automaticTranslationRequestSchema.optional(),
  autoExport: automaticExportSpecSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.autoExport && value.autoExport.mode !== 'source' && !value.autoTranslation)
    context.addIssue({ code: 'custom', path: ['autoExport', 'mode'], message: 'Translated output requires automatic translation.' });
  if (new Set(value.files.map(file => file.fileToken)).size !== value.files.length)
    context.addIssue({ code: 'custom', path: ['files'], message: 'File tokens must be unique.' });
  if (value.config.windowStrategy === 'acoustic_quiet_v1' && !value.config.vadEnabled)
    context.addIssue({ code: 'custom', path: ['config', 'vadEnabled'], message: 'Pause-based chunking requires VAD.' });
  if (value.config.advanced.audioProfile !== undefined && !value.config.vadEnabled)
    context.addIssue({ code: 'custom', path: ['config', 'advanced', 'audioProfile'], message: 'An audio profile requires VAD.' });
  if (value.config.mode === 'japanese_asmr' && (value.config.modelId !== JAPANESE_ASMR_MODEL_ID || value.config.language !== 'ja' || value.config.taskMode !== 'transcribe' || !value.config.vadEnabled || value.config.advanced.initialPrompt !== undefined
    || value.config.advanced.audioProfile !== undefined || value.config.windowStrategy === 'acoustic_quiet_v1'))
    context.addIssue({ code: 'custom', path: ['config', 'mode'], message: 'Japanese ASMR mode requires the Japanese model, Japanese transcription, and VAD.' });
  if (value.config.mode === 'japanese_asmr' && value.autoTranslation?.knowledge
    && value.autoTranslation.knowledge.selection.languagePair.source !== 'ja')
    context.addIssue({ code: 'custom', path: ['autoTranslation', 'knowledge', 'selection', 'languagePair', 'source'], message: 'Japanese ASMR output requires Japanese knowledge source.' });
  if (value.config.taskMode === 'translate_to_english' && value.autoTranslation?.knowledge
    && value.autoTranslation.knowledge.selection.languagePair.source !== 'en')
    context.addIssue({ code: 'custom', path: ['autoTranslation', 'knowledge', 'selection', 'languagePair', 'source'], message: 'English transcription output requires English knowledge source.' });
});

export const japaneseAsmrReviewRangeSchema = z.object({
  startMs: z.number().int().nonnegative().max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
  endMs: z.number().int().positive().max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
  reason: z.enum(['empty', 'too_long']),
}).strict().refine(range => range.endMs > range.startMs);
export type JapaneseAsmrReviewRange = Readonly<z.infer<typeof japaneseAsmrReviewRangeSchema>>;
export const japaneseAsmrPhaseSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('timing') }).strict(),
  z.object({ stage: z.literal('recognizing'), done: z.number().int().nonnegative().max(LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments),
    total: z.number().int().positive().max(LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments) }).strict(),
]);
export type JapaneseAsmrPhase = z.infer<typeof japaneseAsmrPhaseSchema>;

export const transcriptionTaskSummarySchema = z.object({
  taskId: opaqueId, batchId: opaqueId, generation: z.literal(1),
  displayName: z.string().min(1).max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars),
  status: z.enum(['queued', 'preparing_media', 'loading_model', 'transcribing', 'post_processing', 'completed', 'no_content', 'cancelled', 'failed']),
  progress: z.number().finite().min(0).max(100),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), modelId: opaqueId,
  mode: z.enum(STUDIO_TRANSCRIPTION_MODES).optional(),
  phase: japaneseAsmrPhaseSchema.optional(),
  asmrTimingModel: z.object({ id: z.literal(JAPANESE_ASMR_VAD_MODEL_ID), backend: z.literal('cpu'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  asmrReviewCount: z.number().int().positive().max(LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments).optional(),
  asmrNoContent: z.enum(['no_speech', 'review']).optional(),
  resolvedBackend: z.enum(['cpu', 'metal', 'cuda']),
  /** The task's non-standard audio type; absent for standard. */
  audioProfile: z.enum(TRANSCRIPTION_AUDIO_PROFILES).optional(),
  durationMs: z.number().int().safe().nonnegative().max(LOCAL_SUBTITLE_LIMITS.maxDurationMs).optional(),
  documentId: z.string().uuid().optional(), documentDurability: z.enum(['confirmed', 'uncertain']).optional(),
  automaticTranslation: z.object({ status: z.enum(['pending', 'admitted', 'needs_configuration']), taskId: z.string().uuid().optional() }).strict().optional(),
  /** `stage`: where a native failure happened, so a window's failed recognition is told from a broken program. */
  error: z.object({ code: z.union([z.enum(LOCAL_SUBTITLE_ERROR_CODES), errorCodeSchema]), stage: z.enum(LOCAL_SUBTITLE_OPERATION_STAGES).optional() }).strict().optional(),
  cleanupPending: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.phase?.stage === 'recognizing' && value.phase.done > value.phase.total)
    context.addIssue({ code: 'custom', path: ['phase', 'done'], message: 'Recognized intervals cannot exceed the total.' });
  if (value.status !== 'no_content') return;
  if (value.progress !== 100) context.addIssue({ code: 'custom', path: ['progress'], message: 'An empty result is fully processed.' });
  for (const key of ['documentId', 'documentDurability', 'automaticTranslation', 'error'] as const) {
    if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: 'An empty result has no document, translation or error.' });
  }
});
export type EnqueueTranscriptionRequest = z.infer<typeof enqueueTranscriptionRequestSchema>;
export type TranscriptionTaskSummary = Readonly<z.infer<typeof transcriptionTaskSummarySchema>>;
export type TranscriptionBatchAdmission = Readonly<{ batchId: string; tasks: readonly TranscriptionTaskSummary[] }>;
