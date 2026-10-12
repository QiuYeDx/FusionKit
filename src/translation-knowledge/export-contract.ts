import type { Diagnostic } from './validation';

export interface ExportSelectionRequest {
  generation: number;
  collectionIds: string[];
  includeDisabled: boolean;
  /** Presets whose collections are all exported. */
  includePresets: boolean;
}
export interface ExportPreview {
  planId: string;
  generation: number;
  counts: { collections: number; entries: number; presets: number };
  /** Local paths or credential-like text. Shown to the user; exporting is still allowed. */
  warnings: Diagnostic[];
  bytes: number;
  digest: string;
}
export interface ExportCommit { planId: string }
