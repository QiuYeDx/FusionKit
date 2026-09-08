import { z } from 'zod';
import { encodingSchema, idSchema, LIMITS, type ErrorCode, type SubtitleDocument } from './domain';

export const STUDIO_CHANNELS = {
  register: 'subtitle-studio:internal:register',
  importSubtitle: 'subtitle-studio:import',
  listDocuments: 'subtitle-studio:list',
  readDocumentPage: 'subtitle-studio:read-page',
  exportSource: 'subtitle-studio:export-source',
  deleteDocument: 'subtitle-studio:delete-document',
  removeTask: 'subtitle-studio:remove-task',
  changed: 'subtitle-studio:changed',
} as const;
export const requestSchemas = {
  importSubtitle: z.object({ encoding: encodingSchema }).strict(),
  listDocuments: z.object({ offset: z.number().int().min(0).max(LIMITS.cues) }).strict(),
  readDocumentPage: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), offset: z.number().int().min(0).max(LIMITS.cues), nodeOffset: z.number().int().min(0).max(LIMITS.nodes).optional() }).strict(),
  exportSource: z.object({ documentId: idSchema, revision: z.number().int().positive().safe() }).strict(),
  deleteDocument: z.object({ documentId: idSchema, revision: z.number().int().positive().safe() }).strict(),
  removeTask: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), taskId: idSchema }).strict(),
};
export const studioEventSchema = z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), sequence: z.number().int().positive().safe(), deleted: z.boolean() }).strict();
export type StudioEvent = z.infer<typeof studioEventSchema>;
export type DocumentListSnapshot = { documents: DocumentSummary[]; total: number; sequence: number };
export type DocumentSummary = Pick<SubtitleDocument, 'id' | 'revision' | 'origin' | 'capabilities' | 'diagnostics'> & { cueCount: number };
export type DocumentPage = { summary: DocumentSummary; offset: number; cues: SubtitleDocument['cues']; nodeOffset: number; nodeCount: number; rawNodes: { id: string; text: string }[] };
export type StudioResult<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };
export interface SubtitleStudioApi {
  importSubtitle(request: z.infer<typeof requestSchemas.importSubtitle>): Promise<StudioResult<DocumentSummary | null>>;
  listDocuments(request: z.infer<typeof requestSchemas.listDocuments>): Promise<StudioResult<DocumentListSnapshot>>;
  readDocumentPage(request: z.infer<typeof requestSchemas.readDocumentPage>): Promise<StudioResult<DocumentPage>>;
  exportSource(request: z.infer<typeof requestSchemas.exportSource>): Promise<StudioResult<{ fileName: string } | null>>;
  deleteDocument(request: z.infer<typeof requestSchemas.deleteDocument>): Promise<StudioResult<{ cleanupPending: boolean }>>;
  removeTask(request: z.infer<typeof requestSchemas.removeTask>): Promise<StudioResult<DocumentSummary>>;
  subscribe(listener: (event: StudioEvent) => void): () => void;
}

export function summarizeDocument(doc: SubtitleDocument): DocumentSummary {
  return { id: doc.id, revision: doc.revision, origin: doc.origin, capabilities: doc.capabilities, diagnostics: doc.diagnostics, cueCount: doc.cues.length };
}
