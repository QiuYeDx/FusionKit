import type { EntityGroup } from './ipc-contract';
import type { Diagnostic } from './validation';

export interface RecordTarget { group: EntityGroup; id: string }
export type MaintenanceAction = 'archive' | 'restore' | 'undo_import' | 'purge';
export type MaintenanceRequest =
  | { generation: number; action: 'archive' | 'restore' | 'purge'; targets: RecordTarget[] }
  | { generation: number; action: 'undo_import'; importId: string };
export interface MaintenanceImpact extends RecordTarget {
  title: string;
  effect: 'archive' | 'restore' | 'review' | 'purge' | 'retain' | 'blocked';
  reason: 'selected' | 'dependency' | 'later_edit' | 'new_reference' | 'retained_source' | 'legacy_import' | 'active_record' | 'referenced' | 'unavailable';
}
export interface MaintenancePreview {
  planId: string;
  generation: number;
  action: MaintenanceAction;
  items: MaintenanceImpact[];
  blockers: Diagnostic[];
  canCommit: boolean;
  history: { snapshots: number; importsLosingUndo: number; scope: 'none' | 'all' };
  taskTracking: 'not_connected';
}
export interface MaintenanceCommit { planId: string; confirmHistoryRemoval?: boolean }
export interface MaintenanceReceipt {
  id: string;
  action: MaintenanceAction;
  generation: number;
  changed: number;
  cleanupPending: boolean;
}
export interface LibraryMaintenanceState {
  undoableImportIds: string[];
  undoneImportIds: string[];
  cleanupPending: boolean;
}
