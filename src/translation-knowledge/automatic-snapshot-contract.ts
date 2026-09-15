import { z } from 'zod';
import { StudioError } from '../subtitle-studio/domain';
import { batchKnowledgeSelectionSchema } from '../subtitle-studio/knowledge-batch-contract';
import { documentTopicIdsSchema } from '../subtitle-studio/knowledge-translation-contract';
import { sha256Canonical } from './canonicalize';
import { normalizeKnowledgeSelection } from './execution-contract';
import { KNOWLEDGE_EXECUTION_POLICY } from './execution';
import { captureKnowledgeSelectionData, frozenKnowledgeSnapshotSchema } from './snapshot-contract';
import { ENTITY_ARRAYS, knowledgePackageSchema } from './schemas';
import { validatePackage } from './validation';
import type { LibrarySnapshot } from './ipc-contract';
import type { KnowledgeResourceRef } from './task-reference-contract';

// Pending intents may outlive an app upgrade. A changed matching/compiler policy
// must be an explicit incompatibility instead of silently reinterpreting inputs.
export const AUTOMATIC_KNOWLEDGE_POLICY = `automatic-knowledge-preparation/1;${KNOWLEDGE_EXECUTION_POLICY}`;
export const AUTOMATIC_KNOWLEDGE_MAX_BYTES = 4 * 1024 * 1024;
export const automaticKnowledgeRequestSchema = z.object({
  knowledgeGeneration: z.number().int().nonnegative().safe(), selection: batchKnowledgeSelectionSchema,
  documentTopicIds: documentTopicIdsSchema,
}).strict();
export type AutomaticKnowledgeRequest = z.infer<typeof automaticKnowledgeRequestSchema>;
/** Private durable selection, captured before any subtitle cues exist. */
export const frozenAutomaticKnowledgeSchema = z.object({
  version: z.literal(1), policyVersion: z.string().min(1).max(300), generation: z.number().int().nonnegative().safe(),
  selection: batchKnowledgeSelectionSchema, documentTopicIds: documentTopicIdsSchema,
  data: knowledgePackageSchema, approvals: frozenKnowledgeSnapshotSchema.shape.approvals,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FrozenAutomaticKnowledge = z.infer<typeof frozenAutomaticKnowledgeSchema>;
const invalid = (): never => { throw new TypeError('Invalid frozen automatic knowledge'); };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fullSelection = (input: FrozenAutomaticKnowledge['selection']) => normalizeKnowledgeSelection({ ...input, bindings: [], confirmations: [] });

/** Validate choices that do not depend on subtitle text; matching and conflicts
 * remain deferred until the actual transcript has been published. */
function assertSelection(snapshot: Pick<FrozenAutomaticKnowledge, 'selection' | 'documentTopicIds' | 'data' | 'approvals'>): void {
  const { selection, data, approvals } = snapshot;
  const recipe = selection.recipeId ? data.recipes.find(item => item.id === selection.recipeId) : undefined;
  const pairMatches = (pair: { source: string; target: string }) => pair.source === selection.languagePair.source && pair.target === selection.languagePair.target;
  if (selection.recipeId && (!recipe || recipe.archived || !pairMatches(recipe.languagePair))) invalid();
  const collections = new Set([...selection.collectionIds, ...recipe?.readCollectionIds ?? []]);
  if ([...collections].some(id => !data.collections.some(item => item.id === id && !item.archived))) invalid();
  if (snapshot.documentTopicIds.some(id => !data.subjects.some(item => item.id === id && !item.archived))) invalid();
  if (selection.disabledEntryIds.some(id => !data.entries.some(entry => entry.id === id))) invalid();
  const styles = recipe ? [...(recipe.baseStyleId ? [recipe.baseStyleId] : []), ...recipe.modifierStyleIds] : [];
  for (const id of styles) {
    const style = data.styles.find(item => item.id === id);
    if (!style || style.archived || !pairMatches(style.languagePair)) invalid();
    for (const ruleId of style!.ruleEntryIds) {
      const rule = data.entries.find(entry => entry.id === ruleId), approval = approvals[ruleId];
      if (!rule || rule.kind !== 'rule' || rule.state !== 'ready' || !collections.has(rule.collectionId)
        || !approval || approval.revision !== rule.revision || approval.digest !== sha256Canonical(rule)
        || rule.scope.requiredSubjects.some(required => !data.subjects.some(subject => subject.id === required.subjectId && !subject.archived))) invalid();
    }
  }
}

export function buildFrozenAutomaticKnowledge(library: LibrarySnapshot, input: AutomaticKnowledgeRequest): FrozenAutomaticKnowledge {
  const parsed = automaticKnowledgeRequestSchema.safeParse(input);
  if (!parsed.success) throw new StudioError('invalid_input');
  if (library.generation !== parsed.data.knowledgeGeneration || library.maintenance?.cleanupPending) throw new StudioError('revision_conflict');
  try {
    const selection = fullSelection(parsed.data.selection);
    const { bindings: _bindings, confirmations: _confirmations, ...sharedSelection } = selection;
    const material = captureKnowledgeSelectionData(library, selection, parsed.data.documentTopicIds);
    const base = { version: 1 as const, policyVersion: AUTOMATIC_KNOWLEDGE_POLICY, generation: library.generation,
      selection: sharedSelection, documentTopicIds: [...parsed.data.documentTopicIds], ...material };
    const snapshot = { ...base, digest: sha256Canonical(base) };
    if (bytes(snapshot) > AUTOMATIC_KNOWLEDGE_MAX_BYTES) throw new StudioError('limit_exceeded');
    return validateFrozenAutomaticKnowledge(snapshot);
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError('knowledge_check_failed');
  }
}

/** Never consult the live library or silently migrate an unknown preparation policy. */
export function validateFrozenAutomaticKnowledge(value: unknown): FrozenAutomaticKnowledge {
  if (bytes(value) > AUTOMATIC_KNOWLEDGE_MAX_BYTES) invalid();
  const parsed = frozenAutomaticKnowledgeSchema.safeParse(value);
  if (!parsed.success) invalid();
  const snapshot = parsed.data!, { digest, ...base } = snapshot;
  if (snapshot.policyVersion !== AUTOMATIC_KNOWLEDGE_POLICY || sha256Canonical(base) !== digest || !validatePackage(snapshot.data).valid) invalid();
  assertSelection(snapshot);
  const library: LibrarySnapshot = { generation: snapshot.generation, data: snapshot.data, approvals: snapshot.approvals, imports: [] };
  const closure = captureKnowledgeSelectionData(library, fullSelection(snapshot.selection), snapshot.documentTopicIds);
  if (sha256Canonical(closure) !== sha256Canonical({ data: snapshot.data, approvals: snapshot.approvals })) invalid();
  return snapshot;
}

export function automaticKnowledgeResourceReferences(snapshot: FrozenAutomaticKnowledge): KnowledgeResourceRef[] {
  return ENTITY_ARRAYS.flatMap(group => snapshot.data[group].map(entity => ({ group, id: entity.id, revision: entity.revision, digest: sha256Canonical(entity) })));
}
