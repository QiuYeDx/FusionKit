import type { DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { StudioPlanDocuments } from './StudioPlanDocuments';

/** Compatibility wrapper: confirmations keep the affected documents visible. */
export function StudioSelectedDocuments({ documents, collapsible = true }: { documents: readonly DocumentSummary[]; collapsible?: boolean }) {
  return <StudioPlanDocuments documents={documents} collapsible={collapsible} />;
}
