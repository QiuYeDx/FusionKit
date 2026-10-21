import { z } from 'zod';
import { idSchema, type ErrorCode } from './domain';
import { exportDestinationSchema, exportIssueCodeSchema, exportOptionsSchema, type ExportPlanSummary, type ExportResult } from './export-contract';
import { translationConfigSchema, type TranslationPlanSummary } from './translation-contract';
import type { DocumentSummary } from './ipc-contract';

export const STUDIO_BATCH_LIMIT = 100;
export const documentReferenceSchema = z.object({ documentId: idSchema, revision: z.number().int().positive().safe() }).strict();
export const documentReferencesSchema = z.array(documentReferenceSchema).min(1).max(STUDIO_BATCH_LIMIT)
  .refine(items => new Set(items.map(item => item.documentId)).size === items.length);
const exportReferencesSchema = z.array(documentReferenceSchema.extend({ trackId: idSchema.optional() }).strict()).min(1).max(STUDIO_BATCH_LIMIT)
  .refine(items => new Set(items.map(item => item.documentId)).size === items.length);
export const batchRequestSchemas = {
  planTranslationBatch: z.object({ documents: documentReferencesSchema, config: translationConfigSchema }).strict(),
  createTranslationBatch: z.object({ batchId: idSchema, apiKey: z.string().min(1).max(8000) }).strict(),
  planExportBatch: z.object({ documents: exportReferencesSchema, options: exportOptionsSchema.omit({ trackId: true }).strict() }).strict(),
  exportBatch: z.object({ batchId: idSchema, destination: exportDestinationSchema.optional(), acceptedLosses: z.array(z.object({ documentId: idSchema, codes: z.array(exportIssueCodeSchema).max(32) }).strict()).max(STUDIO_BATCH_LIMIT)
    .refine(items => new Set(items.map(item => item.documentId)).size === items.length) }).strict(),
  exportSources: z.object({ documents: documentReferencesSchema, destination: exportDestinationSchema.optional() }).strict(),
  /** Each `revision` is the newest one the window has seen: a document is deleted at whatever revision it has committed, as long as it is at least that one. */
  deleteDocuments: z.object({ documents: documentReferencesSchema }).strict(),
};
export type DocumentReference = z.infer<typeof documentReferenceSchema>;
export type BatchFailure = { documentId: string; displayName: string; ok: false; error: ErrorCode };
export type BatchItem<T extends object> = ({ documentId: string; displayName: string; ok: true } & T) | BatchFailure;
export type BatchImportResult = { items: ({ fileName: string; ok: true; document: DocumentSummary } | { fileName: string; ok: false; error: ErrorCode })[] };
export type TranslationBatchPlan = { batchId: string; items: BatchItem<{ plan: Omit<TranslationPlanSummary, 'planId'> }>[]; totalEstimatedInputTokens: number; totalOutputTokenReserve: number };
export type TranslationBatchResult = { items: BatchItem<{ taskId: string }>[] };
export type ExportBatchPlan = { batchId: string; items: BatchItem<{ plan: ExportPlanSummary }>[] };
export type ExportBatchResult = { items: BatchItem<{ result: ExportResult }>[] };
export type SourceBatchResult = { items: BatchItem<{ fileName: string }>[] };
/** One item per requested document, in request order; `cleanupPending` when any removed folder is left for the next listing. */
export type DocumentDeletion = { documentId: string; ok: true } | { documentId: string; ok: false; error: ErrorCode };
export type DeleteBatchResult = { items: DocumentDeletion[]; cleanupPending: boolean };
export type UnavailableDocument = { id: string; token: string; directory: string; reason: 'document_unavailable' };
