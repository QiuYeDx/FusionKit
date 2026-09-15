import type { EntityGroup } from './ipc-contract';

export type KnowledgeResourceRef = { group: EntityGroup; id: string; revision: number; digest: string };
export type KnowledgeExecutionReference = {
  kind?: 'execution';
  documentId: string; taskId: string; trackId: string; recordId: string; displayName: string;
  status: 'active' | 'retained'; resources: KnowledgeResourceRef[];
};
/** A capture can precede document/task creation; never invent execution identities. */
export type AutomaticKnowledgeReference = {
  kind: 'automatic_preparation'; preparationId: string; documentId?: string;
  taskId?: never; trackId?: never; recordId?: never;
  displayName: string; status: 'active' | 'retained'; resources: KnowledgeResourceRef[];
};
export type KnowledgeTaskReference = KnowledgeExecutionReference | AutomaticKnowledgeReference;
export const knowledgeReferenceKey = (ref: KnowledgeTaskReference): string => ref.kind === 'automatic_preparation'
  ? `automatic:${ref.documentId ?? 'queue'}:${ref.preparationId}` : `${ref.documentId}:${ref.recordId}`;
export type KnowledgeReferenceInventory = {
  references: KnowledgeTaskReference[]; unknownDocuments: number; digest: string;
};
/** Application composition shares this gate between admission/resume and permanent clearing. */
export interface KnowledgeTaskGate { run<T>(operation: () => Promise<T>): Promise<T> }
export interface KnowledgeTaskTracking {
  gate: KnowledgeTaskGate;
  inspect(): Promise<KnowledgeReferenceInventory>;
}
