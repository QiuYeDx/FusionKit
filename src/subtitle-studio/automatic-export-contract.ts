import { z } from 'zod';
import { errorCodeSchema, SUBTITLE_TEXT_FORMATS } from './domain';
import { exportConflictPolicySchema } from './export-contract';
import { defaultExportFormat } from './export-defaults';

/**
 * What to write next to the source media once a transcript (and its automatic translation, when one
 * was asked for) is ready. `auto` picks LRC for audio and SRT for video.
 */
export const automaticExportSpecSchema = z.object({
  format: z.enum(['auto', ...SUBTITLE_TEXT_FORMATS]),
  mode: z.enum(['source', 'target', 'bilingual']),
  order: z.enum(['source-first', 'target-first']),
  conflictPolicy: exportConflictPolicySchema,
}).strict();
export type AutomaticExportSpec = z.infer<typeof automaticExportSpecSchema>;

/** Durable per document: pending until the export ran, then where it went or why it did not. */
export const automaticExportStateSchema = z.object({
  spec: automaticExportSpecSchema,
  state: z.enum(['pending', 'exported', 'failed']),
  fileName: z.string().min(1).max(1000).optional(),
  error: errorCodeSchema.optional(),
}).strict().refine(value => value.state === 'exported' ? !!value.fileName && !value.error : value.state === 'failed' ? !!value.error : !value.fileName && !value.error);
export type AutomaticExportState = z.infer<typeof automaticExportStateSchema>;
export type AutomaticExportSummary = Pick<AutomaticExportState, 'state' | 'fileName' | 'error'> & { format: AutomaticExportSpec['format'] };

export function resolveAutomaticExportFormat(spec: AutomaticExportSpec, origin: { format: string; displayName: string }) {
  return spec.format === 'auto' ? defaultExportFormat(origin) : spec.format;
}

export function summarizeAutomaticExport(value: AutomaticExportState | undefined): AutomaticExportSummary | undefined {
  if (!value) return undefined;
  return { state: value.state, format: value.spec.format, ...(value.fileName ? { fileName: value.fileName } : {}), ...(value.error ? { error: value.error } : {}) };
}
