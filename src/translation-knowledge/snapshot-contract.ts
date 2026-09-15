import { z } from 'zod';
import { sha256Canonical } from './canonicalize';
import { KNOWLEDGE_ISSUE_CODES, knowledgeSelectionSchema, normalizeKnowledgeSelection, type CompiledKnowledge, type KnowledgeSelection } from './execution-contract';
import { ENTITY_ARRAYS, entrySchema, knowledgePackageSchema, sourceSchema, type KnowledgePackage } from './schemas';
import { validatePackage } from './validation';
import type { EntityGroup, KnowledgeEntity, LibrarySnapshot } from './ipc-contract';
import type { KnowledgeResourceRef } from './task-reference-contract';

const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const text = z.string().max(65536);
const uniqueIds = z.array(id).max(20000).refine(ids => new Set(ids).size === ids.length);
const approvalSchema = z.object({ revision: integer.positive(), digest, method: z.enum(['human', 'trusted_import']), approvedAt: z.string().datetime() }).strict();
const payloadSchema = z.union([
  entrySchema.options[0].shape.payload, entrySchema.options[1].shape.payload,
  entrySchema.options[2].shape.payload, entrySchema.options[3].shape.payload, entrySchema.options[4].shape.payload,
]);
export const compiledKnowledgeSchema = z.object({
  policyVersion: z.string().min(1).max(300), environmentDigest: digest, instructions: text, context: text,
  items: z.array(z.object({ entryId: id, revision: integer.positive(), digest, title: text,
    kind: z.enum(['context', 'term', 'expression', 'memory', 'rule']), applicableCueIds: uniqueIds,
    required: z.boolean(), payload: payloadSchema, condition: text.optional(), evidence: z.array(sourceSchema).max(20000),
    matches: z.array(z.object({ cueId: id, start: integer, end: integer, text, target: text }).strict()).max(5000),
  }).strict()).max(2000),
  issues: z.array(z.object({ code: z.enum(KNOWLEDGE_ISSUE_CODES), severity: z.enum(['warning', 'error']), entryIds: uniqueIds, cueIds: uniqueIds }).strict()).max(10000),
}).strict();
export const frozenKnowledgeSnapshotSchema = z.object({
  version: z.literal(1), generation: integer, policyVersion: z.string().min(1).max(300),
  selection: knowledgeSelectionSchema, documentTopicIds: uniqueIds.max(20),
  data: knowledgePackageSchema, approvals: z.record(id, approvalSchema),
  batches: z.record(z.string().min(1).max(100), compiledKnowledgeSchema), digest,
}).strict();
export type FrozenKnowledgeSnapshot = z.infer<typeof frozenKnowledgeSnapshotSchema>;
const same = (a: unknown, b: unknown) => sha256Canonical(a) === sha256Canonical(b);
const invalid = (): never => { throw new TypeError('Invalid frozen knowledge snapshot'); };

/** Capture every selected candidate and dependency, including excluded/untrusted
 * entries. A historical parent is provenance, not an instruction to read it. */
export function buildFrozenKnowledgeSnapshot(library: LibrarySnapshot, input: KnowledgeSelection,
  documentTopicIds: string[], batches: Record<string, CompiledKnowledge>): FrozenKnowledgeSnapshot {
  const selection = normalizeKnowledgeSelection(input);
  const included = new Set<string>(), records = new Map<string, { group: EntityGroup; entity: KnowledgeEntity }>();
  for (const group of ENTITY_ARRAYS) for (const entity of library.data[group]) records.set(entity.id, { group, entity });
  const add = (group: EntityGroup, entityId: string): void => {
    const found = records.get(entityId);
    if (!found || found.group !== group) invalid();
    if (included.has(entityId)) return;
    included.add(entityId);
    const entity = found!.entity;
    if ('aboutSubjectIds' in entity) entity.aboutSubjectIds.forEach(subjectId => add('subjects', subjectId));
    if ('scope' in entity) {
      add('collections', entity.collectionId);
      entity.scope.requiredSubjects.forEach(binding => add('subjects', binding.subjectId));
      entity.evidence.forEach(evidence => add('sources', evidence.sourceId));
      entity.derivedFrom.forEach(parent => add('sources', parent.evidenceSourceId));
    }
    if ('ruleEntryIds' in entity) entity.ruleEntryIds.forEach(ruleId => add('entries', ruleId));
    if ('readCollectionIds' in entity) {
      entity.readCollectionIds.forEach(collectionId => add('collections', collectionId));
      entity.subjectSuggestions.forEach(binding => add('subjects', binding.subjectId));
      if (entity.baseStyleId) add('styles', entity.baseStyleId);
      entity.modifierStyleIds.forEach(styleId => add('styles', styleId));
      if (entity.suggestedDestinationCollectionId) add('collections', entity.suggestedDestinationCollectionId);
    }
  };
  selection.collectionIds.forEach(collectionId => add('collections', collectionId));
  selection.bindings.forEach(binding => add('subjects', binding.subjectId));
  documentTopicIds.forEach(subjectId => add('subjects', subjectId));
  if (selection.recipeId) add('recipes', selection.recipeId);
  const recipe = library.data.recipes.find(item => item.id === selection.recipeId);
  const readCollections = new Set([...selection.collectionIds, ...recipe?.readCollectionIds ?? []]);
  for (const entry of library.data.entries) if (readCollections.has(entry.collectionId)) add('entries', entry.id);
  // Explicit disabled/confirmed records also remain explainable when outside a read collection.
  for (const entryId of [...selection.disabledEntryIds, ...selection.confirmations.map(item => item.entryId)]) add('entries', entryId);
  const data: KnowledgePackage = { ...structuredClone(library.data), subjects: [], collections: [], sources: [], entries: [], styles: [], recipes: [], preferenceTemplates: [] };
  delete data.extensions; // Library-wide extension data is unrelated to this selection.
  for (const group of ENTITY_ARRAYS) (data[group] as KnowledgeEntity[]) = structuredClone(library.data[group].filter(entity => included.has(entity.id)));
  const approvals = Object.fromEntries(data.entries.filter(entry => library.approvals[entry.id]).map(entry => [entry.id, structuredClone(library.approvals[entry.id])]));
  const policyVersion = Object.values(batches)[0]?.policyVersion;
  if (!policyVersion) invalid();
  const base = { version: 1 as const, generation: library.generation, policyVersion: policyVersion!, selection: structuredClone(selection),
    documentTopicIds: [...documentTopicIds], data, approvals, batches: structuredClone(batches) };
  return validateFrozenKnowledgeSnapshot({ ...base, digest: sha256Canonical(base) });
}

/** Validation is self-contained. Recovery must never consult the live library. */
export function validateFrozenKnowledgeSnapshot(value: unknown): FrozenKnowledgeSnapshot {
  const parsed = frozenKnowledgeSnapshotSchema.safeParse(value);
  if (!parsed.success) invalid();
  const snapshot = parsed.data!, { digest: expected, ...base } = snapshot;
  if (sha256Canonical(base) !== expected || !validatePackage(snapshot.data).valid) invalid();
  const entries = new Map(snapshot.data.entries.map(entry => [entry.id, entry]));
  const subjects = new Set(snapshot.data.subjects.map(subject => subject.id));
  if (snapshot.documentTopicIds.some(subjectId => !subjects.has(subjectId)) || snapshot.selection.bindings.some(binding => !subjects.has(binding.subjectId))
    || snapshot.selection.collectionIds.some(collectionId => !snapshot.data.collections.some(collection => collection.id === collectionId))
    || snapshot.selection.recipeId && !snapshot.data.recipes.some(recipe => recipe.id === snapshot.selection.recipeId)
    || [...snapshot.selection.disabledEntryIds, ...snapshot.selection.confirmations.map(item => item.entryId)].some(entryId => !entries.has(entryId))) invalid();
  for (const entryId of Object.keys(snapshot.approvals)) if (!entries.has(entryId)) invalid();
  const sources = new Map(snapshot.data.sources.map(source => [source.id, source]));
  const collectionById = new Map(snapshot.data.collections.map(collection => [collection.id, collection]));
  const subjectById = new Map(snapshot.data.subjects.map(subject => [subject.id, subject]));
  const recipe = snapshot.data.recipes.find(item => item.id === snapshot.selection.recipeId);
  const readCollections = new Set([...snapshot.selection.collectionIds, ...recipe?.readCollectionIds ?? []]);
  const disabled = new Set(snapshot.selection.disabledEntryIds);
  const confirmations = new Map<string, Set<string>>();
  for (const item of snapshot.selection.confirmations) {
    const confirmed = confirmations.get(item.entryId) ?? new Set<string>();
    item.cueIds.forEach(cueId => confirmed.add(cueId)); confirmations.set(item.entryId, confirmed);
  }
  const applies = (entry: KnowledgePackage['entries'][number], cueId: string) => {
    if (entry.scope.condition.mode === 'requires_confirmation' && !confirmations.get(entry.id)?.has(cueId)) return false;
    for (const required of entry.scope.requiredSubjects) {
      if (subjectById.get(required.subjectId)?.archived) return false;
      const topic = (required.role === 'topic' || required.role === 'present') && snapshot.documentTopicIds.includes(required.subjectId);
      if (!topic && !snapshot.selection.bindings.some(binding => binding.subjectId === required.subjectId
        && (required.role === 'present' || binding.role === required.role) && binding.cueIds.includes(cueId))) return false;
      if (required.role === 'speaker' && new Set(snapshot.selection.bindings.filter(binding => binding.role === 'speaker' && binding.cueIds.includes(cueId)).map(binding => binding.subjectId)).size > 1) return false;
    }
    return true;
  };
  if (!Object.keys(snapshot.batches).length) invalid();
  for (const batch of Object.values(snapshot.batches)) {
    if (batch.policyVersion !== snapshot.policyVersion || batch.instructions !== (snapshot.selection.instructions ?? recipe?.instructions ?? '')
      || batch.context !== (snapshot.selection.context ?? recipe?.context ?? '')
      || new Set(batch.items.map(item => item.entryId)).size !== batch.items.length) invalid();
    for (const item of batch.items) {
      const entry = entries.get(item.entryId), approval = snapshot.approvals[item.entryId];
      if (!entry || entry.state !== 'ready' || entry.kind !== item.kind || entry.revision !== item.revision || sha256Canonical(entry) !== item.digest
        || entry.title !== item.title || !same(entry.payload, item.payload) || !approval || approval.revision !== entry.revision || approval.digest !== item.digest
        || item.condition !== (entry.scope.condition.mode === 'none' ? undefined : entry.scope.condition.text)
        || disabled.has(entry.id) || !readCollections.has(entry.collectionId) || collectionById.get(entry.collectionId)?.archived
        || !same(entry.scope.languagePair, snapshot.selection.languagePair) || item.applicableCueIds.some(cueId => !applies(entry, cueId))
        || !item.applicableCueIds.length || !['context', 'term', 'rule'].includes(entry.kind)) invalid();
      const required = entry!.kind === 'context' ? entry!.payload.core : (entry!.kind === 'term' || entry!.kind === 'rule') && entry!.payload.strength !== 'preferred';
      const sourceIds = [...new Set([...entry!.evidence.map(evidence => evidence.sourceId), ...entry!.derivedFrom.map(parent => parent.evidenceSourceId)])];
      if (item.required !== required || !same(item.evidence, sourceIds.map(sourceId => sources.get(sourceId)))
        || item.matches.some(match => !item.applicableCueIds.includes(match.cueId) || match.end <= match.start)
        || item.kind !== 'term' && item.matches.length) invalid();
      if (entry!.kind === 'term') {
        const payload = entry!.payload;
        if (item.applicableCueIds.some(cueId => !item.matches.some(match => match.cueId === cueId))
          || item.matches.some(match => match.target !== (payload.strength === 'keep_source' ? match.text : payload.target))) invalid();
      }
    }
  }
  return snapshot;
}

export function knowledgeResourceReferences(snapshot: FrozenKnowledgeSnapshot): KnowledgeResourceRef[] {
  return ENTITY_ARRAYS.flatMap(group => snapshot.data[group].map(entity => ({ group, id: entity.id, revision: entity.revision, digest: sha256Canonical(entity) })));
}
