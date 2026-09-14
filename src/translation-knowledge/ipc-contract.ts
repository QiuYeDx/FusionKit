import type { KnowledgePackage, Entry, Source } from './schemas';
import type { Diagnostic } from './validation';
import type { LibraryMaintenanceState, MaintenanceRequest, MaintenancePreview, MaintenanceCommit, MaintenanceReceipt } from './maintenance-contract';
import type { ExportSelectionRequest, ExportPreview, ExportCommit } from './export-contract';

export type EntityGroup = 'subjects' | 'collections' | 'sources' | 'entries' | 'styles' | 'recipes' | 'preferenceTemplates';
export type KnowledgeEntity = KnowledgePackage[EntityGroup][number];
export type KnowledgeErrorCode = 'invalid_input' | 'access_denied' | 'storage_unavailable' | 'revision_conflict' | 'plan_expired' | 'import_conflict' | 'not_found' | 'write_failed' | 'limit_exceeded' | 'file_exists' | 'unsupported_destination';
export type KnowledgeResult<T> = { ok: true; value: T } | { ok: false; error: KnowledgeErrorCode; diagnostics?: Diagnostic[] };
export interface Approval { revision: number; digest: string; method: 'human' | 'trusted_import'; approvedAt: string }
export interface ImportReceipt { id: string; packageName: string; createdAt: string; added: number; updated: number; skipped: number; adopted: number; generation: number }
export interface LibrarySnapshot { generation: number; data: KnowledgePackage; approvals: Record<string, Approval>; imports: ImportReceipt[]; maintenance?: LibraryMaintenanceState }
export interface ImportItem { id: string; group: EntityGroup; title: string; status: 'new' | 'unchanged' | 'conflict'; sameRevision: boolean; incoming: KnowledgeEntity; local?: KnowledgeEntity }
export interface ImportPreview { planId: string; generation: number; packageName: string; items: ImportItem[]; warnings: Diagnostic[]; counts: { added: number; unchanged: number; conflicts: number } }
export interface ImportDecision { id: string; action: 'keep' | 'replace' | 'copy' | 'skip' }
export interface CommitImportRequest { planId: string; decisions: ImportDecision[]; adoptReady: boolean }
export interface SaveRecordRequest { generation: number; group: EntityGroup; record: KnowledgeEntity; source?: Source; adopt?: boolean }
export interface ReviewEntriesRequest { generation: number; ids: string[]; action: 'adopt' | 'reject' | 'archive' }
export interface ExportRequest { generation: number; purpose: 'backup' | 'share'; collectionIds: string[]; includeMemories: boolean }
export interface ExportReceipt { fileName: string; entries: number; purpose: 'backup' | 'share' }
export interface TranslationKnowledgeApi {
  read(): Promise<KnowledgeResult<LibrarySnapshot>>;
  selectImport(): Promise<KnowledgeResult<ImportPreview | null>>;
  importDroppedFile(file: File): Promise<KnowledgeResult<ImportPreview>>;
  commitImport(request: CommitImportRequest): Promise<KnowledgeResult<ImportReceipt>>;
  saveRecord(request: SaveRecordRequest): Promise<KnowledgeResult<LibrarySnapshot>>;
  reviewEntries(request: ReviewEntriesRequest): Promise<KnowledgeResult<LibrarySnapshot>>;
  planMaintenance(request: MaintenanceRequest): Promise<KnowledgeResult<MaintenancePreview>>;
  commitMaintenance(request: MaintenanceCommit): Promise<KnowledgeResult<MaintenanceReceipt>>;
  planExport(request: ExportSelectionRequest): Promise<KnowledgeResult<ExportPreview>>;
  exportFile(request: ExportCommit): Promise<KnowledgeResult<ExportReceipt | null>>;
}
export const KNOWLEDGE_CHANNELS = {
  register: 'translation-knowledge:internal:register',
  read: 'translation-knowledge:read',
  selectImport: 'translation-knowledge:select-import',
  importDroppedFile: 'translation-knowledge:import-dropped-file',
  commitImport: 'translation-knowledge:commit-import',
  saveRecord: 'translation-knowledge:save-record',
  reviewEntries: 'translation-knowledge:review-entries',
  planMaintenance: 'translation-knowledge:plan-maintenance',
  commitMaintenance: 'translation-knowledge:commit-maintenance',
  planExport: 'translation-knowledge:plan-export',
  exportFile: 'translation-knowledge:export-file',
} as const;

export const entrySummary = (entry: Entry): string => {
  if (entry.kind === 'term') return `${entry.payload.source} → ${entry.payload.target}`;
  if (entry.kind === 'memory') return `${entry.payload.source} → ${entry.payload.target}`;
  if (entry.kind === 'expression') return entry.payload.interpretation;
  return entry.payload.text;
};
