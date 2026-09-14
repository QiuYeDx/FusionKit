import type { EntityGroup } from './ipc-contract';
import type { Diagnostic } from './validation';

export interface ExportSelectionRequest {
  generation: number;
  purpose: 'share' | 'backup';
  collectionIds: string[];
  recipeIds: string[];
  includeMemories: boolean;
  includeUnreviewed: boolean;
  includeInactive: boolean;
  excludedSourceIds: string[];
}
export interface ExportSelectionPreview {
  counts: Record<EntityGroup, number>;
  included: { id: string; group: EntityGroup; title: string; reason: 'selected' | 'dependency' | 'destination'; viaIds: string[] }[];
  excluded: { id: string; title: string; reason: 'unreviewed' | 'inactive' | 'memory' | 'source_excluded' | 'language' }[];
  collectionImpacts: { id: string; name: string; explicit: boolean; destinationOnly: boolean; totalEntries: number; includedEntries: number; excludedEntries: number; memories: number; viaIds: string[] }[];
  sourceExcerpts: { id: string; title: string; kind: string; excerpt: string; attribution?: string; entryIds: string[] }[];
  memoryExcerpts: { id: string; title: string; source: string; target: string }[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
export interface ExportPreview extends ExportSelectionPreview {
  planId: string;
  generation: number;
  purpose: 'share' | 'backup';
  bytes: number;
  digest: string;
  canExport: boolean;
}
export interface ExportCommit { planId: string }
