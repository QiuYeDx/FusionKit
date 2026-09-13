import { z } from 'zod';
import { encodingSchema, idSchema } from './domain';

export const exportDestinationSchema = z.enum(['choose-location', 'source-directory']);
export type ExportDestination = z.infer<typeof exportDestinationSchema>;
export const exportConflictPolicySchema = z.enum(['indexed', 'overwrite']);
export type ExportConflictPolicy = z.infer<typeof exportConflictPolicySchema>;
export type SourceLocationSummary = { status: 'ready' | 'missing' | 'unavailable'; origin?: 'input' | 'user-selected-directory' };
export const fileNameSuffixSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('preset'), preset: z.enum(['content-mode', 'target-language']) }).strict(),
  z.object({ mode: z.literal('custom'), value: z.string().min(1).max(40)
    .refine(value => value.trim() === value && !/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/.test(value) && !/\p{Surrogate}/u.test(value) && !/[. ]$/.test(value) && value !== '.' && value !== '..') }).strict(),
]);
export const exportOptionsSchema = z.object({
  mode: z.enum(['source', 'target', 'bilingual']),
  format: z.enum(['srt', 'lrc', 'vtt', 'ass']),
  fileNameSuffix: fileNameSuffixSchema.optional(),
  conflictPolicy: exportConflictPolicySchema.optional(),
  trackId: idSchema.optional(),
  order: z.enum(['source-first', 'target-first']),
  encoding: encodingSchema,
  bom: z.boolean(),
  newline: z.enum(['lf', 'crlf']),
  incomplete: z.enum(['block', 'skip', 'source-fallback']),
  missingEnd: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('block') }).strict(),
    z.object({ mode: z.literal('next-start'), finalDurationMs: z.number().int().min(1).max(3600000) }).strict(),
  ]),
}).strict();
export const exportIssueCodeSchema = z.enum([
  'track_missing', 'translation_missing', 'translation_stale', 'missing_end', 'estimated_end',
  'invalid_time', 'styles_removed', 'line_breaks_flattened', 'metadata_omitted', 'transcription_evidence_omitted', 'end_times_omitted',
  'unsupported_text', 'empty_output', 'encoding_unrepresentable', 'skipped_cues', 'source_fallback',
  'timing_precision_changed', 'positioning_omitted', 'effects_omitted', 'opaque_omitted', 'encoding_not_supported',
]);
export type ExportOptions = z.infer<typeof exportOptionsSchema>;
export type ExportIssueCode = z.infer<typeof exportIssueCodeSchema>;
export type ExportIssue = { code: ExportIssueCode; count: number; blocking: boolean; confirmation: boolean };
export type ExportPlanSummary = {
  planId: string | null;
  documentId: string;
  revision: number;
  options: ExportOptions;
  cueCount: number;
  sourceCueCount: number;
  missingCount: number;
  staleCount: number;
  byteLength: number;
  fileName: string;
  issues: ExportIssue[];
  preview: string;
  partial: boolean;
  sourceLocation?: SourceLocationSummary;
};
export type ExportResult = Pick<ExportPlanSummary, 'revision' | 'fileName' | 'partial'> & { mode: ExportOptions['mode']; incomplete: ExportOptions['incomplete'] };
