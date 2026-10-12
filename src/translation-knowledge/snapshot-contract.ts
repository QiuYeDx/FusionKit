import { z } from 'zod';
import { sha256Canonical } from './canonicalize';
import { KNOWLEDGE_ISSUE_CODES, knowledgeSelectionSchema, normalizeKnowledgeSelection, type CompiledKnowledge, type KnowledgeSelection } from './execution-contract';
import { isRequiredEntry, KNOWLEDGE_EXECUTION_POLICY } from './execution';
import { knowledgePackageSchema, notePayloadSchema, originSchema, termPayloadSchema, type KnowledgePackage } from './schemas';
import { validatePackage } from './validation';
import type { LibrarySnapshot } from './ipc-contract';

const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const text = z.string().max(65536);
const uniqueIds = z.array(id).max(20000).refine(ids => new Set(ids).size === ids.length);
const payloadSchema = z.union([termPayloadSchema, notePayloadSchema]);
export const compiledKnowledgeSchema = z.object({
  policyVersion: z.literal(KNOWLEDGE_EXECUTION_POLICY), environmentDigest: digest, instructions: text, context: text,
  items: z.array(z.object({ entryId: id, revision: integer.positive(), digest,
    kind: z.enum(['term', 'context', 'rule']), applicableCueIds: uniqueIds,
    required: z.boolean(), payload: payloadSchema, origin: originSchema.optional(),
    matches: z.array(z.object({ cueId: id, start: integer, end: integer, text, target: text }).strict()).max(5000),
  }).strict()).max(2000),
  issues: z.array(z.object({ code: z.enum(KNOWLEDGE_ISSUE_CODES), severity: z.enum(['warning', 'error']), entryIds: uniqueIds, cueIds: uniqueIds }).strict()).max(10000),
}).strict();
export const frozenKnowledgeSnapshotSchema = z.object({
  version: z.literal(2), generation: integer, policyVersion: z.literal(KNOWLEDGE_EXECUTION_POLICY),
  selection: knowledgeSelectionSchema, data: knowledgePackageSchema,
  batches: z.record(z.string().min(1).max(100), compiledKnowledgeSchema), digest,
}).strict();
export type FrozenKnowledgeSnapshot = z.infer<typeof frozenKnowledgeSnapshotSchema>;
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : sha256Canonical(a) === sha256Canonical(b);
const invalid = (): never => { throw new TypeError('Invalid frozen knowledge snapshot'); };

/** The selected collections and all of their entries, plus excluded entries named by
 * the selection so the record can still explain them. Used before transcription too. */
export function captureKnowledgeSelectionData(library: Pick<LibrarySnapshot, 'data'>, selection: KnowledgeSelection): KnowledgePackage {
  const selected = new Set(selection.collectionIds), excluded = new Set(selection.disabledEntryIds);
  if ([...selected].some(collectionId => !library.data.collections.some(collection => collection.id === collectionId))) invalid();
  const entries = library.data.entries.filter(entry => selected.has(entry.collectionId) || excluded.has(entry.id));
  if (entries.filter(entry => excluded.has(entry.id)).length !== excluded.size) invalid();
  const collectionIds = new Set([...selected, ...entries.map(entry => entry.collectionId)]);
  const { extensions: _extensions, ...data } = structuredClone(library.data);
  return { ...data, collections: structuredClone(library.data.collections.filter(collection => collectionIds.has(collection.id))), entries: structuredClone(entries), presets: [] };
}

export function buildFrozenKnowledgeSnapshot(library: LibrarySnapshot, input: KnowledgeSelection, batches: Record<string, CompiledKnowledge>): FrozenKnowledgeSnapshot {
  const selection = normalizeKnowledgeSelection(input);
  const base = { version: 2 as const, generation: library.generation, policyVersion: KNOWLEDGE_EXECUTION_POLICY, selection: structuredClone(selection),
    data: captureKnowledgeSelectionData(library, selection), batches: structuredClone(batches) };
  return validateFrozenKnowledgeSnapshot({ ...base, digest: sha256Canonical(base) });
}

/** Validation is self-contained. Recovery must never consult the live library. */
export function validateFrozenKnowledgeSnapshot(value: unknown): FrozenKnowledgeSnapshot {
  const parsed = frozenKnowledgeSnapshotSchema.safeParse(value);
  if (!parsed.success) invalid();
  const snapshot = parsed.data!, { digest: expected, ...base } = snapshot;
  if (sha256Canonical(base) !== expected || !validatePackage(snapshot.data).valid) invalid();
  if (!same(captureKnowledgeSelectionData(snapshot, snapshot.selection), snapshot.data)) invalid();
  const entries = new Map(snapshot.data.entries.map(entry => [entry.id, entry]));
  const collections = new Map(snapshot.data.collections.map(collection => [collection.id, collection]));
  const selected = new Set(snapshot.selection.collectionIds), disabled = new Set(snapshot.selection.disabledEntryIds);
  if (!Object.keys(snapshot.batches).length) invalid();
  for (const batch of Object.values(snapshot.batches)) {
    if (batch.instructions !== (snapshot.selection.instructions ?? '') || batch.context !== (snapshot.selection.context ?? '')
      || new Set(batch.items.map(item => item.entryId)).size !== batch.items.length) invalid();
    for (const item of batch.items) {
      const entry = entries.get(item.entryId), collection = entry && collections.get(entry.collectionId);
      if (!entry || !collection || !entry.enabled || entry.kind !== item.kind || entry.revision !== item.revision || sha256Canonical(entry) !== item.digest
        || !same(entry.payload, item.payload) || !same(entry.origin, item.origin) || item.required !== isRequiredEntry(entry)
        || disabled.has(entry.id) || !selected.has(entry.collectionId) || collection.archived || !same(collection.languagePair, snapshot.selection.languagePair)
        || !item.applicableCueIds.length || item.matches.some(match => !item.applicableCueIds.includes(match.cueId) || match.end <= match.start)
        || entry.kind !== 'term' && item.matches.length) invalid();
      if (entry!.kind === 'term') {
        const payload = entry!.payload;
        if (item.applicableCueIds.some(cueId => !item.matches.some(match => match.cueId === cueId))
          || item.matches.some(match => match.target !== (payload.strength === 'keep_source' ? match.text : payload.target))) invalid();
      }
    }
  }
  return snapshot;
}
