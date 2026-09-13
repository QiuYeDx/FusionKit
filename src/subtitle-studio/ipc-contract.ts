import { z } from 'zod';
import { encodingSchema, idSchema, LIMITS, type ErrorCode, type SubtitleDocument } from './domain';
import { translationConfigSchema, translationModelSchema, type TranslationPlanSummary } from './translation-contract';
import type { DocumentSnapshot } from './persistence-contract';
import { bilingualOptionsSchema, type BilingualPreview } from './bilingual-contract';
import { hasBilingualCandidates, isBilingualRecommended } from './bilingual';
import { exportOptionsSchema, exportIssueCodeSchema, exportDestinationSchema, type SourceLocationSummary, type ExportPlanSummary, type ExportResult } from './export-contract';
import { batchRequestSchemas, type BatchImportResult, type TranslationBatchPlan, type TranslationBatchResult, type ExportBatchPlan, type ExportBatchResult, type SourceBatchResult, type UnavailableDocument } from './batch-contract';
import { enqueueTranscriptionRequestSchema, type TranscriptionTaskSummary, type TranscriptionBatchAdmission } from './transcription/task-contract';
import type { LocalSubtitleAuthorizedMedia, LocalSubtitleMediaProbeSummary, LocalSubtitleManagedResourceSummary } from './transcription/ipc-contract';
import type { LocalSubtitleResourceJobSummary } from './transcription/domain';
import type { SpeechResourcesStatus } from '../speech-resources/events';

export const STUDIO_CHANNELS = {
  register: 'subtitle-studio:internal:register',
  importDroppedSubtitles: 'subtitle-studio:internal:import-dropped-subtitles',
  dropTranscriptionMedia: 'subtitle-studio:internal:drop-transcription-media',
  listTranslationTasks: 'subtitle-studio:list-translation-tasks',
  revealSource: 'subtitle-studio:reveal-source',
  getSourceLocation: 'subtitle-studio:get-source-location',
  selectSourceDirectory: 'subtitle-studio:select-source-directory',
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
  selectTranscriptionMedia: 'subtitle-studio:select-transcription-media',
  probeTranscriptionMedia: 'subtitle-studio:probe-transcription-media',
  revokeTranscriptionMedia: 'subtitle-studio:revoke-transcription-media',
  inspectTranscriptionRuntime: 'subtitle-studio:inspect-transcription-runtime',
  listTranscriptionResources: 'subtitle-studio:list-transcription-resources',
  importTranscriptionModel: 'subtitle-studio:import-transcription-model',
  installTranscriptionResource: 'subtitle-studio:install-transcription-resource',
  deleteTranscriptionResource: 'subtitle-studio:delete-transcription-resource',
  cancelTranscriptionResourceJob: 'subtitle-studio:cancel-transcription-resource-job',
  enqueueTranscription: 'subtitle-studio:enqueue-transcription',
  listTranscriptionTasks: 'subtitle-studio:list-transcription-tasks',
  cancelTranscriptionTask: 'subtitle-studio:cancel-transcription-task',
  removeTranscriptionTask: 'subtitle-studio:remove-transcription-task',
} as const;
const transcriptionRefSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(value => value !== '.' && value !== '..');
export const transcriptionRequestSchemas = {
  selectTranscriptionMedia: z.object({}).strict(),
  probeTranscriptionMedia: z.object({ fileToken: transcriptionRefSchema }).strict(),
  revokeTranscriptionMedia: z.object({ fileToken: transcriptionRefSchema }).strict(),
  inspectTranscriptionRuntime: z.object({}).strict(),
  listTranscriptionResources: z.object({}).strict(),
  importTranscriptionModel: z.object({ modelId: transcriptionRefSchema }).strict(),
  installTranscriptionResource: z.object({ resourceId: transcriptionRefSchema }).strict(),
  deleteTranscriptionResource: z.object({ resourceId: transcriptionRefSchema }).strict(),
  cancelTranscriptionResourceJob: z.object({ jobId: transcriptionRefSchema }).strict(),
  enqueueTranscription: enqueueTranscriptionRequestSchema,
  listTranscriptionTasks: z.object({}).strict(),
  cancelTranscriptionTask: z.object({ taskId: idSchema }).strict(),
  removeTranscriptionTask: z.object({ taskId: idSchema }).strict(),
};
// Paths are sent only by the dedicated preload File method, never public invoke.
export const droppedSubtitlesRequestSchema = z.object({
  encoding: encodingSchema,
  paths: z.array(z.string().min(1).max(32768).refine(value => !value.includes('\0'))).min(1).max(100),
}).strict();
export const droppedTranscriptionMediaRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(32768).refine(value => !value.includes('\0'))).min(1).max(20),
}).strict();
export const requestSchemas = {
  ...transcriptionRequestSchemas,
  listTranslationTasks: z.object({ offset: z.number().int().min(0).max(100000000), pageSize: z.number().int().min(1).max(100), taskIds: z.array(idSchema).max(100).refine(ids => new Set(ids).size === ids.length).optional() }).strict(),
  revealSource: z.object({ kind: z.enum(['document', 'transcription']), id: idSchema }).strict(),
  getSourceLocation: z.object({ documentId: idSchema }).strict(),
  selectSourceDirectory: z.object({ documentId: idSchema }).strict(),
  importSubtitle: z.object({ encoding: encodingSchema }).strict(),
  importSubtitles: z.object({ encoding: encodingSchema }).strict(),
  revealUnavailable: z.object({ documentId: idSchema, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  deleteUnavailable: z.object({ documentId: idSchema, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ...batchRequestSchemas,
  listDocuments: z.object({ offset: z.number().int().min(0).max(LIMITS.cues), query: z.string().max(500).optional(), format: z.enum(['all', 'srt', 'lrc', 'vtt', 'ass', 'media']).optional(), status: z.enum(['all', 'untranslated', 'translated', 'active', 'attention']).optional(), sort: z.enum(['default', 'name-asc', 'name-desc', 'cue-count-asc', 'cue-count-desc', 'recent', 'oldest']).optional(), pageSize: z.number().int().min(1).max(LIMITS.pageSize).optional() }).strict(),
  readDocumentPage: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), offset: z.number().int().min(0).max(LIMITS.cues), nodeOffset: z.number().int().min(0).max(LIMITS.nodes).optional() }).strict(),
  exportSource: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), destination: exportDestinationSchema.optional() }).strict(),
  planExport: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), options: exportOptionsSchema }).strict(),
  exportDocument: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), planId: idSchema, acceptedLosses: z.array(exportIssueCodeSchema).max(32), destination: exportDestinationSchema.optional() }).strict(),
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
export type TranslationTaskStatus = StoredTask['status'];
export type TranslationTaskSummary = {
  documentId: string; revision: number; taskId: string; trackId: string;
  displayName: string; status: TranslationTaskStatus; language: string; modelKey: string;
  completedBatches: number; totalBatches: number; notBefore?: number; canResume: boolean;
  error?: NonNullable<StoredTask['translation']>['error'];
};
export type TranslationTasksSnapshot = {
  sequence: number; total: number; unavailableDocuments: number;
  counts: Record<TranslationTaskStatus, number>; completedBatches: number; totalBatches: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number;
    unknownInput: number; unknownOutput: number; unknownTotal: number };
  items: TranslationTaskSummary[];
};
export type DocumentTask = Omit<StoredTask, 'translation'> & { translation?: Omit<NonNullable<StoredTask['translation']>, 'checkpoint'> & { checkpoint?: { version: 1 } } };
export type DocumentPage = { summary: DocumentSummary; offset: number; cues: SubtitleDocument['cues']; nodeOffset: number; nodeCount: number; rawNodes: { id: string; text: string }[]; translationTracks: SubtitleDocument['translationTracks']; tasks: DocumentTask[] };
export type StudioResult<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };
export type TranscriptionMediaSelection = { items: Array<
  { displayName: string; ok: true; media: LocalSubtitleAuthorizedMedia; probe: LocalSubtitleMediaProbeSummary }
  | { displayName: string; ok: false; error: ErrorCode; media?: LocalSubtitleAuthorizedMedia }
> };
export type TranscriptionResourceJob = Omit<LocalSubtitleResourceJobSummary, 'error'> & { error?: Pick<NonNullable<LocalSubtitleResourceJobSummary['error']>, 'code'> };
export type TranscriptionResources = { resources: LocalSubtitleManagedResourceSummary[]; jobs: TranscriptionResourceJob[]; shared?: SpeechResourcesStatus };
export type TranscriptionRuntimeSummary = { status: 'verified'; runtimeGeneration: string; target: { platform: 'darwin' | 'win32'; arch: 'arm64' | 'x64' } }
  | { status: 'missing' | 'invalid'; code: string; stage: string };
export interface SubtitleStudioApi {
  revealSource(request: z.infer<typeof requestSchemas.revealSource>): Promise<StudioResult<null>>;
  getSourceLocation(request: z.infer<typeof requestSchemas.getSourceLocation>): Promise<StudioResult<SourceLocationSummary>>;
  selectSourceDirectory(request: z.infer<typeof requestSchemas.selectSourceDirectory>): Promise<StudioResult<SourceLocationSummary | null>>;
  importDroppedSubtitles(files: readonly File[], request: z.infer<typeof requestSchemas.importSubtitles>): Promise<StudioResult<BatchImportResult>>;
  listTranslationTasks(request: z.infer<typeof requestSchemas.listTranslationTasks>): Promise<StudioResult<TranslationTasksSnapshot>>;
  selectTranscriptionMedia(request: z.infer<typeof requestSchemas.selectTranscriptionMedia>): Promise<StudioResult<TranscriptionMediaSelection | null>>;
  dropTranscriptionMedia(files: readonly File[]): Promise<StudioResult<TranscriptionMediaSelection>>;
  probeTranscriptionMedia(request: z.infer<typeof requestSchemas.probeTranscriptionMedia>): Promise<StudioResult<LocalSubtitleMediaProbeSummary>>;
  revokeTranscriptionMedia(request: z.infer<typeof requestSchemas.revokeTranscriptionMedia>): Promise<StudioResult<{ revoked: boolean }>>;
  inspectTranscriptionRuntime(request: z.infer<typeof requestSchemas.inspectTranscriptionRuntime>): Promise<StudioResult<TranscriptionRuntimeSummary>>;
  listTranscriptionResources(request: z.infer<typeof requestSchemas.listTranscriptionResources>): Promise<StudioResult<TranscriptionResources>>;
  importTranscriptionModel(request: z.infer<typeof requestSchemas.importTranscriptionModel>): Promise<StudioResult<TranscriptionResourceJob | null>>;
  installTranscriptionResource(request: z.infer<typeof requestSchemas.installTranscriptionResource>): Promise<StudioResult<TranscriptionResourceJob>>;
  deleteTranscriptionResource(request: z.infer<typeof requestSchemas.deleteTranscriptionResource>): Promise<StudioResult<{ deleted: boolean }>>;
  cancelTranscriptionResourceJob(request: z.infer<typeof requestSchemas.cancelTranscriptionResourceJob>): Promise<StudioResult<{ cancelled: boolean }>>;
  enqueueTranscription(request: z.infer<typeof requestSchemas.enqueueTranscription>): Promise<StudioResult<TranscriptionBatchAdmission>>;
  listTranscriptionTasks(request: z.infer<typeof requestSchemas.listTranscriptionTasks>): Promise<StudioResult<readonly TranscriptionTaskSummary[]>>;
  cancelTranscriptionTask(request: z.infer<typeof requestSchemas.cancelTranscriptionTask>): Promise<StudioResult<TranscriptionTaskSummary>>;
  removeTranscriptionTask(request: z.infer<typeof requestSchemas.removeTranscriptionTask>): Promise<StudioResult<null>>;
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
