import type { EntityGroup } from './ipc-contract';

export type KnowledgeResourceRef = { group: EntityGroup; id: string; revision: number; digest: string };
export type KnowledgeTaskReference = {
  documentId: string; taskId: string; trackId: string; recordId: string; displayName: string;
  status: 'active' | 'retained'; resources: KnowledgeResourceRef[];
};
export type KnowledgeReferenceInventory = {
  references: KnowledgeTaskReference[]; unknownDocuments: number; digest: string;
};
/** Application composition shares this gate between admission/resume and permanent clearing. */
export interface KnowledgeTaskGate { run<T>(operation: () => Promise<T>): Promise<T> }
export interface KnowledgeTaskTracking {
  gate: KnowledgeTaskGate;
  inspect(): Promise<KnowledgeReferenceInventory>;
}
