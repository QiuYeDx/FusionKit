import { z } from 'zod';
import { encodingSchema, idSchema, LIMITS, type ErrorCode, type SubtitleDocument } from './domain';
import { translationConfigSchema, translationModelSchema, type TranslationPlanSummary } from './translation-contract';
import type { DocumentSnapshot } from './persistence-contract';
import { bilingualOptionsSchema, type BilingualPreview } from './bilingual-contract';
import { hasBilingualCandidates, isBilingualRecommended } from './bilingual';
import { exportOptionsSchema, exportIssueCodeSchema, type ExportPlanSummary, type ExportResult } from './export-contract';
import { batchRequestSchemas, type BatchImportResult, type TranslationBatchPlan, type TranslationBatchResult, type ExportBatchPlan, type ExportBatchResult, type SourceBatchResult, type UnavailableDocument } from './batch-contract';

export const STUDIO_CHANNELS = {
  register: 'subtitle-studio:internal:register',
  importSubtitle: 'subtitle-studio:import',
  importSubtitles: 'subtitle-studio:import-many',
  revealUnavailable: 'subtitle-studio:reveal-unavailable',
  deleteUnavailable: 'subtitle-studio:delete-unavailable',
  planTranslationBatch: 'subtitle-studio:plan-translation-batch',
  createTranslationBatch: 'subtitle-studio:create-translation-batch',
  planExportBatch: 'subtitle-studio:plan-export-batch',
  exportBatch: 'subtitle-studio:export-batch',
  exportSources: 'subtitle-studio:export-sources',
  listDocuments: 'subtitle-studio:list',
  readDocumentPage: 'subtitle-studio:read-page',
  exportSource: 'subtitle-studio:export-source',
  planExport: 'subtitle-studio:plan-export',
  exportDocument: 'subtitle-studio:export-document',
  deleteDocument: 'subtitle-studio:delete-document',
  removeTask: 'subtitle-studio:remove-task',
  planTranslation: 'subtitle-studio:plan-translation',
  createTranslation: 'subtitle-studio:create-translation',
  cancelTask: 'subtitle-studio:cancel-task',
  resumeTask: 'subtitle-studio:resume-task',
  previewBilingual: 'subtitle-studio:preview-bilingual',
  applyBilingual: 'subtitle-studio:apply-bilingual',
  removeTranslationTrack: 'subtitle-studio:remove-translation-track',
  changed: 'subtitle-studio:changed',
} as const;
export const requestSchemas = {
  importSubtitle: z.object({ encoding: encodingSchema }).strict(),
  importSubtitles: z.object({ encoding: encodingSchema }).strict(),
  revealUnavailable: z.object({ documentId: idSchema, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  deleteUnavailable: z.object({ documentId: idSchema, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ...batchRequestSchemas,
  listDocuments: z.object({ offset: z.number().int().min(0).max(LIMITS.cues), query: z.string().max(500).optional(), format: z.enum(['all', 'srt', 'lrc', 'media']).optional(), status: z.enum(['all', 'untranslated', 'translated', 'active', 'attention']).optional(), sort: z.enum(['default', 'name-asc', 'name-desc', 'cue-count-asc', 'cue-count-desc', 'recent', 'oldest']).optional(), pageSize: z.number().int().min(1).max(LIMITS.pageSize).optional() }).strict(),
  readDocumentPage: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), offset: z.number().int().min(0).max(LIMITS.cues), nodeOffset: z.number().int().min(0).max(LIMITS.nodes).optional() }).strict(),
  exportSource: z.object({ documentId: idSchema, revision: z.number().int().positive().safe() }).strict(),
  planExport: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), options: exportOptionsSchema }).strict(),
  exportDocument: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), planId: idSchema, acceptedLosses: z.array(exportIssueCodeSchema).max(32) }).strict(),
  deleteDocument: z.object({ documentId: idSchema, revision: z.number().int().positive().safe() }).strict(),
  removeTask: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), taskId: idSchema }).strict(),
  planTranslation: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), config: translationConfigSchema }).strict(),
  createTranslation: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), planId: idSchema, apiKey: z.string().min(1).max(8000) }).strict(),
  cancelTask: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), taskId: idSchema }).strict(),
  resumeTask: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), taskId: idSchema, model: translationModelSchema.nullable(), apiKey: z.string().max(8000) }).strict(),
  previewBilingual: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), options: bilingualOptionsSchema, offset: z.number().int().min(0).max(LIMITS.cues), reviewOnly: z.boolean().optional() }).strict(),
  applyBilingual: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), options: bilingualOptionsSchema }).strict(),
  removeTranslationTrack: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), trackId: idSchema }).strict(),
};
export const studioEventSchema = z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), sequence: z.number().int().positive().safe(), deleted: z.boolean() }).strict();
export type StudioEvent = z.infer<typeof studioEventSchema>;
export type DocumentListSnapshot = { documents: DocumentSummary[]; total: number; unavailableDocuments: number; sequence: number; allTotal?: number; unavailable?: UnavailableDocument[] };
export type DocumentSummary = Pick<SubtitleDocument, 'id' | 'revision' | 'origin' | 'capabilities' | 'diagnostics' | 'bilingualImport'> & {
  cueCount: number; bilingualAvailable?: boolean; bilingualRecommended?: boolean; updatedAt?: number;
  translationStatus?: 'none' | 'partial' | 'complete';
  translationTracks?: Pick<SubtitleDocument['translationTracks'][number], 'id' | 'language' | 'origin'>[];
  task?: { id: string; status: DocumentSnapshot['tasks'][number]['status']; model?: z.infer<typeof translationModelSchema>; completedBatches: number; totalBatches: number } | null;
};
type StoredTask = DocumentSnapshot['tasks'][number];
export type DocumentTask = Omit<StoredTask, 'translation'> & { translation?: Omit<NonNullable<StoredTask['translation']>, 'checkpoint'> & { checkpoint?: { version: 1 } } };
export type DocumentPage = { summary: DocumentSummary; offset: number; cues: SubtitleDocument['cues']; nodeOffset: number; nodeCount: number; rawNodes: { id: string; text: string }[]; translationTracks: SubtitleDocument['translationTracks']; tasks: DocumentTask[] };
export type StudioResult<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };
export interface SubtitleStudioApi {
  importSubtitle(request: z.infer<typeof requestSchemas.importSubtitle>): Promise<StudioResult<DocumentSummary | null>>;
  importSubtitles(request: z.infer<typeof requestSchemas.importSubtitles>): Promise<StudioResult<BatchImportResult | null>>;
  revealUnavailable(request: z.infer<typeof requestSchemas.revealUnavailable>): Promise<StudioResult<null>>;
  deleteUnavailable(request: z.infer<typeof requestSchemas.deleteUnavailable>): Promise<StudioResult<{ cleanupPending: boolean }>>;
  planTranslationBatch(request: z.infer<typeof requestSchemas.planTranslationBatch>): Promise<StudioResult<TranslationBatchPlan>>;
  createTranslationBatch(request: z.infer<typeof requestSchemas.createTranslationBatch>): Promise<StudioResult<TranslationBatchResult>>;
  planExportBatch(request: z.infer<typeof requestSchemas.planExportBatch>): Promise<StudioResult<ExportBatchPlan>>;
  exportBatch(request: z.infer<typeof requestSchemas.exportBatch>): Promise<StudioResult<ExportBatchResult | null>>;
  exportSources(request: z.infer<typeof requestSchemas.exportSources>): Promise<StudioResult<SourceBatchResult | null>>;
  listDocuments(request: z.infer<typeof requestSchemas.listDocuments>): Promise<StudioResult<DocumentListSnapshot>>;
  readDocumentPage(request: z.infer<typeof requestSchemas.readDocumentPage>): Promise<StudioResult<DocumentPage>>;
  exportSource(request: z.infer<typeof requestSchemas.exportSource>): Promise<StudioResult<{ fileName: string } | null>>;
  planExport(request: z.infer<typeof requestSchemas.planExport>): Promise<StudioResult<ExportPlanSummary>>;
  exportDocument(request: z.infer<typeof requestSchemas.exportDocument>): Promise<StudioResult<ExportResult | null>>;
  deleteDocument(request: z.infer<typeof requestSchemas.deleteDocument>): Promise<StudioResult<{ cleanupPending: boolean }>>;
  removeTask(request: z.infer<typeof requestSchemas.removeTask>): Promise<StudioResult<DocumentSummary>>;
  planTranslation(request: z.infer<typeof requestSchemas.planTranslation>): Promise<StudioResult<TranslationPlanSummary>>;
  createTranslation(request: z.infer<typeof requestSchemas.createTranslation>): Promise<StudioResult<{ taskId: string }>>;
  cancelTask(request: z.infer<typeof requestSchemas.cancelTask>): Promise<StudioResult<{ taskId: string }>>;
  resumeTask(request: z.infer<typeof requestSchemas.resumeTask>): Promise<StudioResult<{ taskId: string }>>;
  previewBilingual(request: z.infer<typeof requestSchemas.previewBilingual>): Promise<StudioResult<BilingualPreview>>;
  applyBilingual(request: z.infer<typeof requestSchemas.applyBilingual>): Promise<StudioResult<DocumentSummary>>;
  removeTranslationTrack(request: z.infer<typeof requestSchemas.removeTranslationTrack>): Promise<StudioResult<DocumentSummary>>;
  subscribe(listener: (event: StudioEvent) => void): () => void;
}

export function summarizeDocument(doc: SubtitleDocument, tasks: DocumentSnapshot['tasks'] = [], updatedAt?: number): DocumentSummary {
  const nonempty = doc.cues.filter(cue => cue.source.plain.trim());
  const translated = Math.max(0, ...doc.translationTracks.map(track => nonempty.filter(cue => track.entries[cue.id]?.sourceRevision === cue.sourceRevision).length));
  const task = tasks.find(item => ['queued', 'running'].includes(item.status)) ?? [...tasks].reverse().find(item => ['interrupted', 'failed', 'needs_configuration'].includes(item.status)) ?? tasks.at(-1);
  return { id: doc.id, revision: doc.revision, origin: doc.origin, capabilities: doc.capabilities, diagnostics: doc.diagnostics, cueCount: doc.cues.length,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    translationStatus: translated ? translated === nonempty.length ? 'complete' : 'partial' : 'none',
    translationTracks: doc.translationTracks.map(({ id, language, origin }) => ({ id, language, ...(origin ? { origin } : {}) })),
    task: task ? { id: task.id, status: task.status, ...(task.translation ? { model: task.translation.config.model } : {}), completedBatches: task.completedBatchIds.length, totalBatches: task.translation?.totalBatches ?? 0 } : null,
    ...(doc.bilingualImport ? { bilingualImport: doc.bilingualImport } : {}),
    bilingualAvailable: !doc.translationTracks.length && !doc.bilingualImport && hasBilingualCandidates(doc),
    bilingualRecommended: !doc.translationTracks.length && !doc.bilingualImport && isBilingualRecommended(doc) };
}

export function summarizeTask(task: StoredTask): DocumentTask {
  if (!task.translation) return task;
  const { checkpoint, ...progress } = task.translation;
  return { ...task, translation: { ...progress, ...(checkpoint ? { checkpoint: { version: checkpoint.version } } : {}) } };
}
