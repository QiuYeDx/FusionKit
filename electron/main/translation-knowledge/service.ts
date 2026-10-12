import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collectionSchema, entrySchema, presetSchema, type KnowledgePackage, type Preset } from '../../../src/translation-knowledge/schemas';
import { canonicalize, sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { parseKnowledgePackage, validatePackage } from '../../../src/translation-knowledge/validation';
import {
  DELETE_BATCH_LIMIT, SAVE_BATCH_LIMIT,
  type CommitImportRequest, type DeletedRecords, type DeleteRecordsRequest, type DeleteRecordsResult, type EntityGroup, type ImportCollectionPreview,
  type ImportPreview, type ImportReceipt, type KnowledgeEntity, type LibrarySnapshot, type RestoreRecordsRequest, type SaveRecordsRequest,
} from '../../../src/translation-knowledge/ipc-contract';
import { diagnostic, KnowledgeServiceError } from './errors';
import { KnowledgeRepository, type RepositoryOptions, type StoredLibrary } from './repository';
export { KnowledgeServiceError } from './errors';

const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const groupSchema = z.enum(['collections', 'entries', 'presets']);
const saveSchema = z.strictObject({ generation, items: z.array(z.strictObject({ group: groupSchema, record: z.unknown() })).min(1).max(SAVE_BATCH_LIMIT) });
const deleteSchema = z.strictObject({ generation, items: z.array(z.strictObject({ group: groupSchema, id: z.uuid() })).min(1).max(DELETE_BATCH_LIMIT) });
const restoreSchema = z.strictObject({ generation, records: z.strictObject({ collections: z.array(collectionSchema), entries: z.array(entrySchema), presets: z.array(presetSchema) }) });
const commitSchema = z.strictObject({
  planId: z.uuid(), collections: z.array(z.strictObject({ id: z.uuid(), action: z.enum(['add', 'merge', 'copy', 'skip']) })).max(20_000),
  conflict: z.enum(['keep_local', 'use_incoming']), presets: z.enum(['add', 'skip']),
});
const entitySchemas = { collections: collectionSchema, entries: entrySchema, presets: presetSchema };
const PLAN_TTL_MS = 15 * 60 * 1000;
interface Plan { owner: string; expiresAt: number; data: KnowledgePackage; preview: ImportPreview; committed?: { requestDigest: string; receipt: ImportReceipt } }
const clone = <T>(value: T): T => structuredClone(value);
const snapshot = (state: StoredLibrary): LibrarySnapshot => clone({ generation: state.generation, data: state.data });
const fail = (code: string, message: string, path?: string): never => { throw new KnowledgeServiceError('invalid_input', [diagnostic(code, message, path)]); };
const sameContent = (a: KnowledgeEntity, b: KnowledgeEntity) => canonicalize({ ...a, revision: 0 }) === canonicalize({ ...b, revision: 0 });
function parse<T>(schema: z.ZodType<T>, input: unknown, prefix = ''): T {
  const checked = schema.safeParse(input);
  if (!checked.success) throw new KnowledgeServiceError('invalid_input', checked.error.issues.slice(0, 100).map(issue => diagnostic('REQUEST_FORMAT', issue.message, `${prefix}/${issue.path.join('/')}`)));
  return checked.data;
}
function checkPackage(data: KnowledgePackage): void {
  const checked = validatePackage(data);
  if (!checked.valid) throw new KnowledgeServiceError('invalid_input', checked.errors);
}
function nextRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new KnowledgeServiceError('limit_exceeded', [diagnostic('REVISION_LIMIT', 'This record has reached the maximum supported revision.')]);
  return current + 1;
}
function requireGeneration(state: StoredLibrary, expected: number): void {
  if (state.generation !== expected) throw new KnowledgeServiceError('revision_conflict');
}
function list(data: KnowledgePackage, group: EntityGroup): KnowledgeEntity[] { return data[group]; }
function find(data: KnowledgePackage, id: string): { group: EntityGroup; record: KnowledgeEntity } | undefined {
  for (const group of ['collections', 'entries', 'presets'] as const) {
    const record = list(data, group).find(item => item.id === id);
    if (record) return { group, record };
  }
  return undefined;
}
function put(data: KnowledgePackage, group: EntityGroup, record: KnowledgeEntity): void {
  const items = list(data, group);
  const index = items.findIndex(item => item.id === record.id);
  if (index < 0) items.push(record); else items[index] = record;
}

export class KnowledgeService {
  private readonly repository: KnowledgeRepository;
  private readonly plans = new Map<string, Plan>();
  private readonly released = new Set<string>();
  private disposed = false;
  constructor(rootPath: string, options: RepositoryOptions = {}) { this.repository = new KnowledgeRepository(rootPath, options); }

  async read(): Promise<LibrarySnapshot> { return snapshot(await this.repository.read()); }

  /** Several records as one transaction: one generation check, one validation, all or nothing. */
  async saveRecords(request: SaveRecordsRequest, guard?: () => void): Promise<LibrarySnapshot> {
    const input = parse(saveSchema, request);
    const items = input.items.map((item, index) => ({ group: item.group, record: parse(entitySchemas[item.group] as z.ZodType<KnowledgeEntity>, item.record, `/items/${index}/record`) }));
    if (new Set(items.map(item => item.record.id)).size !== items.length) fail('DUPLICATE_BATCH_RECORD', 'Each record may appear once in a batch.', '/items');
    return this.repository.transact(state => {
      requireGeneration(state, input.generation);
      let changed = false;
      items.forEach(({ group, record }, index) => {
        const local = find(state.data, record.id);
        if (local && (local.group !== group || local.record.revision !== record.revision)) throw new KnowledgeServiceError('revision_conflict', [diagnostic('RECORD_REVISION', 'This record changed elsewhere. Reload and try again.', `/items/${index}`)]);
        if (!local && record.revision !== 1) fail('NEW_RECORD_REVISION', 'A new record must start at revision 1.', `/items/${index}/record/revision`);
        if (local && canonicalize(local.record) === canonicalize(record)) return;
        put(state.data, group, { ...clone(record), revision: local ? nextRevision(local.record.revision) : 1 });
        changed = true;
      });
      if (!changed) return { result: snapshot };
      checkPackage(state.data);
      return { state, result: snapshot };
    }, guard);
  }

  /** Deleting a collection removes its entries and its place in every preset. */
  async deleteRecords(request: DeleteRecordsRequest, guard?: () => void): Promise<DeleteRecordsResult> {
    const input = parse(deleteSchema, request);
    if (new Set(input.items.map(item => item.id)).size !== input.items.length) fail('DUPLICATE_BATCH_RECORD', 'Each record may appear once in a batch.', '/items');
    return this.repository.transact(state => {
      requireGeneration(state, input.generation);
      for (const item of input.items) if (find(state.data, item.id)?.group !== item.group) throw new KnowledgeServiceError('not_found');
      const ids = (group: EntityGroup) => new Set(input.items.filter(item => item.group === group).map(item => item.id));
      const collections = ids('collections'), entries = ids('entries'), presets = ids('presets');
      const deleted: DeletedRecords = {
        collections: clone(state.data.collections.filter(item => collections.has(item.id))),
        entries: clone(state.data.entries.filter(item => entries.has(item.id) || collections.has(item.collectionId))),
        presets: clone(state.data.presets.filter(item => presets.has(item.id) || item.collectionIds.some(id => collections.has(id)))),
      };
      const removedEntries = new Set(deleted.entries.map(item => item.id));
      state.data.collections = state.data.collections.filter(item => !collections.has(item.id));
      state.data.entries = state.data.entries.filter(item => !removedEntries.has(item.id));
      state.data.presets = state.data.presets.filter(item => !presets.has(item.id)).map(item => item.collectionIds.some(id => collections.has(id))
        ? { ...item, collectionIds: item.collectionIds.filter(id => !collections.has(id)), revision: nextRevision(item.revision) } : item);
      checkPackage(state.data);
      return { state, result: published => ({ snapshot: snapshot(published), deleted }) };
    }, guard);
  }

  /** Undo a deletion with the records it returned. Partial restoration is never published. */
  async restoreRecords(request: RestoreRecordsRequest, guard?: () => void): Promise<LibrarySnapshot> {
    const input = parse(restoreSchema, request);
    const { collections, entries, presets } = input.records;
    const all = [...collections, ...entries, ...presets];
    if (!all.length) fail('RESTORE_EMPTY', 'There is nothing to restore.');
    if (new Set(all.map(item => item.id)).size !== all.length) fail('DUPLICATE_BATCH_RECORD', 'Each record may appear once.', '/records');
    return this.repository.transact(state => {
      requireGeneration(state, input.generation);
      for (const record of [...collections, ...entries]) if (find(state.data, record.id)) throw new KnowledgeServiceError('import_conflict', [diagnostic('RESTORE_ID_EXISTS', 'A record with this identity already exists; the deletion can no longer be undone.')]);
      for (const preset of presets) { const local = find(state.data, preset.id); if (local && local.group !== 'presets') throw new KnowledgeServiceError('import_conflict', [diagnostic('RESTORE_ID_EXISTS', 'A record with this identity already exists; the deletion can no longer be undone.')]); }
      for (const collection of collections) state.data.collections.push({ ...clone(collection), revision: 1 });
      for (const entry of entries) state.data.entries.push({ ...clone(entry), revision: 1 });
      for (const preset of presets) {
        const local = state.data.presets.find(item => item.id === preset.id);
        put(state.data, 'presets', { ...clone(preset), revision: local ? nextRevision(local.revision) : 1 });
      }
      checkPackage(state.data);
      return { state, result: snapshot };
    }, guard);
  }

  async planImport(owner: string, text: string): Promise<ImportPreview> {
    this.checkOwner(owner);
    if (typeof text !== 'string') fail('IMPORT_TEXT', 'Import contents must be UTF-8 JSON text.');
    const checked = parseKnowledgePackage(text);
    if (!checked.valid || !checked.data) throw new KnowledgeServiceError('invalid_input', checked.errors);
    const state = await this.repository.read();
    this.checkOwner(owner);
    for (const [id, existing] of this.plans) if (existing.expiresAt <= Date.now() || existing.owner === owner) this.plans.delete(id);
    if (this.plans.size >= 64) throw new KnowledgeServiceError('limit_exceeded');
    const incoming = checked.data;
    const localEntries = new Map(state.data.entries.map(entry => [entry.id, entry]));
    const collections: ImportCollectionPreview[] = incoming.collections.map(collection => {
      const entries = incoming.entries.filter(entry => entry.collectionId === collection.id);
      const existing = state.data.collections.some(item => item.id === collection.id);
      let added = 0, changed = 0, unchanged = 0;
      for (const entry of entries) {
        const local = localEntries.get(entry.id);
        if (!existing || !local || local.collectionId !== collection.id) added++;
        else if (sameContent(local, entry)) unchanged++;
        else changed++;
      }
      return { id: collection.id, name: collection.name, languagePair: clone(collection.languagePair), status: existing ? 'existing' : 'new', entries: entries.length, added, changed, unchanged };
    });
    const presets = incoming.presets.map(preset => ({ id: preset.id, name: preset.name, status: state.data.presets.some(item => item.id === preset.id) ? 'existing' as const : 'new' as const }));
    const preview: ImportPreview = { planId: randomUUID(), generation: state.generation, packageName: incoming.package.name, collections, presets, warnings: [...checked.warnings] };
    this.plans.set(preview.planId, { owner, expiresAt: Date.now() + PLAN_TTL_MS, data: clone(incoming), preview: clone(preview) });
    return preview;
  }

  async commitImport(owner: string, request: CommitImportRequest, guard?: () => void): Promise<ImportReceipt> {
    this.checkOwner(owner);
    const input = parse(commitSchema, request);
    if (new Set(input.collections.map(item => item.id)).size !== input.collections.length) fail('DUPLICATE_DECISION', 'Each collection may have only one decision.');
    const requestDigest = sha256Canonical({ ...input, collections: [...input.collections].sort((a, b) => a.id.localeCompare(b.id)) });
    const fence = () => { this.checkOwner(owner); guard?.(); };
    return this.repository.transact(state => {
      const plan = this.plans.get(input.planId);
      if (!plan) throw new KnowledgeServiceError('plan_expired');
      if (plan.owner !== owner) throw new KnowledgeServiceError('access_denied');
      if (plan.committed) {
        if (plan.committed.requestDigest !== requestDigest) throw new KnowledgeServiceError('import_conflict', [diagnostic('COMMITTED_DECISION_CHANGED', 'This import already committed with different decisions.')]);
        return { result: () => clone(plan.committed!.receipt) };
      }
      if (plan.expiresAt <= Date.now() || plan.preview.generation !== state.generation) throw new KnowledgeServiceError('plan_expired');
      const choices = new Map(input.collections.map(item => [item.id, item.action]));
      for (const id of choices.keys()) if (!plan.preview.collections.some(item => item.id === id)) fail('UNKNOWN_DECISION', 'An import decision refers to a collection outside this preview.');
      const ids = new Map<string, string>();
      const mapped = (id: string) => ids.get(id) ?? id;
      const importedCollections: string[] = [];
      let added = 0, updated = 0, skipped = 0;
      for (const item of plan.preview.collections) {
        const action = choices.get(item.id) ?? (item.status === 'new' ? 'add' : 'merge');
        if (item.status === 'new' && action === 'merge' || item.status === 'existing' && action === 'add') fail('IMPORT_ACTION', `Action ${action} does not apply to this collection.`, `/collections/${item.id}`);
        const collection = plan.data.collections.find(value => value.id === item.id)!;
        const entries = plan.data.entries.filter(entry => entry.collectionId === item.id);
        if (action === 'skip') { skipped += entries.length; continue; }
        if (action === 'copy' || find(state.data, collection.id) && action === 'add') ids.set(collection.id, randomUUID());
        const collectionId = mapped(collection.id);
        const local = state.data.collections.find(value => value.id === collectionId);
        if (!local) state.data.collections.push({ ...clone(collection), id: collectionId, revision: 1 });
        else if (input.conflict === 'use_incoming' && !sameContent(local, collection)) put(state.data, 'collections', { ...clone(collection), revision: nextRevision(local.revision) });
        importedCollections.push(collectionId);
        for (const entry of entries) {
          const existing = action === 'merge' ? state.data.entries.find(value => value.id === entry.id) : undefined;
          if (existing && existing.collectionId === collectionId) {
            if (sameContent(existing, entry) || input.conflict === 'keep_local') { skipped++; continue; }
            put(state.data, 'entries', { ...clone(entry), revision: nextRevision(existing.revision) });
            updated++;
            continue;
          }
          // Keep the incoming identity unless it already names a different local record.
          const id = action === 'copy' || find(state.data, entry.id) ? randomUUID() : entry.id;
          state.data.entries.push({ ...clone(entry), id, collectionId, revision: 1 });
          added++;
        }
      }
      if (input.presets === 'add') {
        const available = new Set(state.data.collections.map(item => item.id));
        for (const preset of plan.data.presets) {
          const next: Preset = { ...clone(preset), collectionIds: preset.collectionIds.map(mapped).filter(id => available.has(id)) };
          const local = find(state.data, preset.id);
          if (!local) state.data.presets.push({ ...next, revision: 1 });
          else if (local.group === 'presets' && input.conflict === 'use_incoming' && !sameContent(local.record, next)) put(state.data, 'presets', { ...next, revision: nextRevision(local.record.revision) });
          else if (local.group !== 'presets') state.data.presets.push({ ...next, id: randomUUID(), revision: 1 });
        }
      }
      checkPackage(state.data);
      const receipt: ImportReceipt = { planId: input.planId, packageName: plan.data.package.name, collectionIds: importedCollections, added, updated, skipped, generation: state.generation + 1 };
      // Remembered only once published, so a failed attempt can be retried.
      return { state, result: () => { plan.committed = { requestDigest, receipt }; return clone(receipt); } };
    }, fence);
  }

  releaseOwner(owner: string): void {
    this.released.add(owner);
    for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
  }
  async dispose(): Promise<void> { this.disposed = true; this.plans.clear(); await this.repository.dispose(); }
  private checkOwner(owner: string): void {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 512 || this.disposed || this.released.has(owner)) throw new KnowledgeServiceError('access_denied');
  }
}

