import type { Collection, Entry, KnowledgePackage, Preset } from './schemas';
import type { Diagnostic } from './validation';
import type { ExportSelectionRequest, ExportPreview, ExportCommit } from './export-contract';

export type EntityGroup = 'collections' | 'entries' | 'presets';
export type KnowledgeEntity = Collection | Entry | Preset;
export type KnowledgeErrorCode = 'invalid_input' | 'access_denied' | 'storage_unavailable' | 'revision_conflict' | 'plan_expired' | 'import_conflict' | 'not_found' | 'write_failed' | 'limit_exceeded' | 'file_exists' | 'unsupported_destination';
export type KnowledgeResult<T> = { ok: true; value: T } | { ok: false; error: KnowledgeErrorCode; diagnostics?: Diagnostic[] };
export interface LibrarySnapshot { generation: number; data: KnowledgePackage }
export const SAVE_BATCH_LIMIT = 200;
export const DELETE_BATCH_LIMIT = 500;
export interface SaveItem { group: EntityGroup; record: KnowledgeEntity }
/** Up to 200 records in one transaction: all are published together or none is. */
export interface SaveRecordsRequest { generation: number; items: SaveItem[] }
export interface DeleteRecordsRequest { generation: number; items: { group: EntityGroup; id: string }[] }
/** Everything a deletion removed or changed, exactly as it was before. Passed back to undo it. */
export interface DeletedRecords { collections: Collection[]; entries: Entry[]; presets: Preset[] }
export interface DeleteRecordsResult { snapshot: LibrarySnapshot; deleted: DeletedRecords }
export interface RestoreRecordsRequest { generation: number; records: DeletedRecords }

export type ImportCollectionStatus = 'new' | 'existing';
export interface ImportCollectionPreview {
  id: string; name: string; languagePair: Collection['languagePair']; status: ImportCollectionStatus;
  entries: number; added: number; changed: number; unchanged: number;
}
export interface ImportPreview {
  planId: string; generation: number; packageName: string; collections: ImportCollectionPreview[];
  presets: { id: string; name: string; status: 'new' | 'existing' }[]; warnings: Diagnostic[];
}
export type ImportCollectionAction = 'add' | 'merge' | 'copy' | 'skip';
export interface CommitImportRequest {
  planId: string; collections: { id: string; action: ImportCollectionAction }[];
  conflict: 'keep_local' | 'use_incoming'; presets: 'add' | 'skip';
}
export interface ImportReceipt { planId: string; packageName: string; collectionIds: string[]; added: number; updated: number; skipped: number; generation: number }
export interface ExportReceipt { fileName: string; entries: number }
export interface TranslationKnowledgeApi {
  read(): Promise<KnowledgeResult<LibrarySnapshot>>;
  saveRecords(request: SaveRecordsRequest): Promise<KnowledgeResult<LibrarySnapshot>>;
  deleteRecords(request: DeleteRecordsRequest): Promise<KnowledgeResult<DeleteRecordsResult>>;
  restoreRecords(request: RestoreRecordsRequest): Promise<KnowledgeResult<LibrarySnapshot>>;
  selectImport(): Promise<KnowledgeResult<ImportPreview | null>>;
  importDroppedFile(file: File): Promise<KnowledgeResult<ImportPreview>>;
  commitImport(request: CommitImportRequest): Promise<KnowledgeResult<ImportReceipt>>;
  planExport(request: ExportSelectionRequest): Promise<KnowledgeResult<ExportPreview>>;
  exportFile(request: ExportCommit): Promise<KnowledgeResult<ExportReceipt | null>>;
  exportSkill(): Promise<KnowledgeResult<{ fileName: string } | null>>;
}
export const KNOWLEDGE_CHANNELS = {
  register: 'translation-knowledge:internal:register',
  read: 'translation-knowledge:read',
  saveRecords: 'translation-knowledge:save-records',
  deleteRecords: 'translation-knowledge:delete-records',
  restoreRecords: 'translation-knowledge:restore-records',
  selectImport: 'translation-knowledge:select-import',
  importDroppedFile: 'translation-knowledge:import-dropped-file',
  commitImport: 'translation-knowledge:commit-import',
  planExport: 'translation-knowledge:plan-export',
  exportFile: 'translation-knowledge:export-file',
  exportSkill: 'translation-knowledge:export-skill',
} as const;
