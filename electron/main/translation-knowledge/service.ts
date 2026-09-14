import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ENTITY_ARRAYS, subjectSchema, collectionSchema, entrySchema, sourceSchema, styleSchema, recipeSchema, preferenceTemplateSchema, knowledgePackageSchema, type Entry, type KnowledgePackage } from '../../../src/translation-knowledge/schemas';
import { canonicalize, sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { parseKnowledgePackage, validatePackage, type Diagnostic } from '../../../src/translation-knowledge/validation';
import type { CommitImportRequest, EntityGroup, ExportRequest, ImportItem, ImportPreview, ImportReceipt, KnowledgeEntity, LibrarySnapshot, ReviewEntriesRequest, SaveRecordRequest } from '../../../src/translation-knowledge/ipc-contract';
import { diagnostic, KnowledgeServiceError } from './errors';
import { emptyPackage, KnowledgeRepository, type RepositoryOptions, type StoredLibrary } from './repository';
import type { MaintenanceCommit, MaintenancePreview, MaintenanceReceipt, MaintenanceRequest } from '../../../src/translation-knowledge/maintenance-contract';
import { buildMaintenance, captureImportChanges, maintenanceCommitRequestSchema, maintenanceRequestSchema } from './maintenance';
export { KnowledgeServiceError } from './errors';

const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commitSchema = z.strictObject({ planId: z.uuid(), decisions: z.array(z.strictObject({ id: z.uuid(), action: z.enum(['keep', 'replace', 'copy', 'skip']) })).max(20_000), adoptReady: z.boolean() });
const saveSchema = z.strictObject({ generation, group: z.enum(ENTITY_ARRAYS), record: z.unknown(), source: sourceSchema.optional(), adopt: z.boolean().optional() });
const reviewSchema = z.strictObject({ generation, ids: z.array(z.uuid()).min(1).max(20_000), action: z.enum(['adopt', 'reject', 'archive']) });
const exportSchema = z.strictObject({ generation, purpose: z.enum(['backup', 'share']), collectionIds: z.array(z.uuid()).max(20_000), includeMemories: z.boolean() });
const entitySchemas = { subjects: subjectSchema, collections: collectionSchema, sources: sourceSchema, entries: entrySchema, styles: styleSchema, recipes: recipeSchema, preferenceTemplates: preferenceTemplateSchema };
const PLAN_TTL_MS = 15 * 60 * 1000;
interface Plan { owner: string; expiresAt: number; data: KnowledgePackage; preview: ImportPreview; requestDigest?: string }
interface MaintenancePlan { owner: string; expiresAt: number; request: MaintenanceRequest; preview: MaintenancePreview; historyDigest?: string; requestDigest?: string }
const ownerDigest = (owner: string) => createHash('sha256').update(owner).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const snapshot = (state: StoredLibrary): LibrarySnapshot => clone({ generation: state.generation, data: state.data, approvals: state.approvals, imports: state.imports, maintenance: { undoableImportIds: Object.keys(state.importChanges).filter(id => !state.undoneImportIds.includes(id)), undoneImportIds: state.undoneImportIds, cleanupPending: state.cleanupPending } });
const fail = (code: string, message: string, path?: string): never => { throw new KnowledgeServiceError('invalid_input', [diagnostic(code, message, path)]); };
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const checked = schema.safeParse(input);
  if (!checked.success) throw new KnowledgeServiceError('invalid_input', checked.error.issues.slice(0, 100).map(issue => diagnostic('REQUEST_FORMAT', issue.message, `/${issue.path.join('/')}`)));
  return checked.data;
}
function records(data: KnowledgePackage): Map<string, { group: EntityGroup; record: KnowledgeEntity }> {
  return new Map(ENTITY_ARRAYS.flatMap(group => data[group].map(record => [record.id, { group, record }] as const)));
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
function highRisk(entry: Entry): boolean {
  return (entry.kind === 'context' && entry.payload.core) || ((entry.kind === 'term' || entry.kind === 'rule') && entry.payload.strength === 'required');
}
function entryDependencies(entry: Entry): string[] {
  return [entry.collectionId, ...entry.scope.requiredSubjects.map(item => item.subjectId), ...entry.evidence.map(item => item.sourceId), ...entry.derivedFrom.flatMap(item => [item.entryId, item.evidenceSourceId])];
}
function unavailable(entry: Entry, data: KnowledgePackage): boolean {
  return data.collections.find(item => item.id === entry.collectionId)?.archived === true || data.subjects.some(item => item.archived && entry.scope.requiredSubjects.some(subject => subject.subjectId === item.id));
}
/** Preserve archived/rejected/candidate states; only formerly ready dependents need re-review. */
function invalidate(state: StoredLibrary, changed: Set<string>, explicitlyReviewed = new Set<string>()): void {
  const affected = new Set(changed);
  let found = true;
  while (found) {
    found = false;
    for (const entry of state.data.entries) {
      if (explicitlyReviewed.has(entry.id)) continue;
      if (!affected.has(entry.id) && entryDependencies(entry).some(id => affected.has(id))) { affected.add(entry.id); found = true; }
    }
  }
  for (const entry of state.data.entries) {
    if (!affected.has(entry.id) || explicitlyReviewed.has(entry.id)) continue;
    delete state.approvals[entry.id];
    if (!changed.has(entry.id) && entry.state === 'ready') { entry.state = 'needs_review'; entry.revision = nextRevision(entry.revision); }
  }
}
function approve(state: StoredLibrary, entry: Entry, method: 'human' | 'trusted_import'): void {
  state.approvals[entry.id] = { revision: entry.revision, digest: sha256Canonical(entry), method, approvedAt: new Date().toISOString() };
}
function isTrusted(state: StoredLibrary, entry: Entry): boolean {
  const approval = state.approvals[entry.id];
  return entry.state === 'ready' && !!approval && approval.revision === entry.revision && approval.digest === sha256Canonical(entry) && !unavailable(entry, state.data);
}
function put(data: KnowledgePackage, group: EntityGroup, entity: KnowledgeEntity): void {
  const list = data[group] as KnowledgeEntity[];
  const index = list.findIndex(item => item.id === entity.id);
  if (index < 0) list.push(entity); else list[index] = entity;
}
/** Only declared structural references are remapped; user text and unknown extensions are inert. */
function remap(group: EntityGroup, incoming: KnowledgeEntity, ids: Map<string, string>): KnowledgeEntity {
  const copy = clone(incoming);
  const id = (value: string) => ids.get(value) ?? value;
  copy.id = id(copy.id);
  if (group === 'collections') { const item = copy as KnowledgePackage['collections'][number]; item.aboutSubjectIds = item.aboutSubjectIds.map(id); }
  if (group === 'entries') {
    const item = copy as Entry;
    item.collectionId = id(item.collectionId); item.aboutSubjectIds = item.aboutSubjectIds.map(id);
    item.scope.requiredSubjects.forEach(binding => { binding.subjectId = id(binding.subjectId); });
    item.evidence.forEach(evidence => { evidence.sourceId = id(evidence.sourceId); });
    item.derivedFrom.forEach(parent => { parent.entryId = id(parent.entryId); parent.evidenceSourceId = id(parent.evidenceSourceId); });
  }
  if (group === 'styles') { const item = copy as KnowledgePackage['styles'][number]; item.ruleEntryIds = item.ruleEntryIds.map(id); }
  if (group === 'recipes') {
    const item = copy as KnowledgePackage['recipes'][number];
    item.readCollectionIds = item.readCollectionIds.map(id); item.subjectSuggestions.forEach(binding => { binding.subjectId = id(binding.subjectId); });
    if (item.baseStyleId) item.baseStyleId = id(item.baseStyleId);
    item.modifierStyleIds = item.modifierStyleIds.map(id);
    if (item.suggestedDestinationCollectionId) item.suggestedDestinationCollectionId = id(item.suggestedDestinationCollectionId);
  }
  return copy;
}

export class KnowledgeService {
  private readonly repository: KnowledgeRepository;
  private readonly plans = new Map<string, Plan>();
  private readonly maintenancePlans = new Map<string, MaintenancePlan>();
  private readonly released = new Set<string>();
  private disposed = false;
  constructor(rootPath: string, options: RepositoryOptions = {}) { this.repository = new KnowledgeRepository(rootPath, options); }

  async read(): Promise<LibrarySnapshot> { return snapshot(await this.repository.read()); }

  async planImport(owner: string, text: string): Promise<ImportPreview> {
    this.checkOwner(owner);
    if (typeof text !== 'string') fail('IMPORT_TEXT', 'Import contents must be UTF-8 JSON text.');
    const checked = parseKnowledgePackage(text);
    if (!checked.valid || !checked.data) throw new KnowledgeServiceError('invalid_input', checked.errors);
    const state = await this.repository.read();
    this.checkOwner(owner);
    for (const [id, existing] of this.plans) if (existing.expiresAt <= Date.now() || existing.owner === owner) this.plans.delete(id);
    if (this.plans.size >= 64) throw new KnowledgeServiceError('limit_exceeded');
    const local = records(state.data);
    const items: ImportItem[] = ENTITY_ARRAYS.flatMap(group => checked.data![group].map(incoming => {
      const found = local.get(incoming.id);
      const status: ImportItem['status'] = !found ? 'new' : found.group === group && sha256Canonical(incoming) === sha256Canonical(found.record) ? 'unchanged' : 'conflict';
      return { id: incoming.id, group, title: 'title' in incoming ? incoming.title : incoming.name, status, sameRevision: found?.record.revision === incoming.revision, incoming: clone(incoming), ...(found ? { local: clone(found.record) } : {}) };
    }));
    const warnings = [...checked.warnings];
    try { mergePackageMetadata(clone(state.data), checked.data); }
    catch (error) {
      if (!(error instanceof KnowledgeServiceError)) throw error;
      warnings.push(...error.diagnostics);
    }
    if (checked.data.entries.some(highRisk)) warnings.push(diagnostic('INDIVIDUAL_REVIEW_REQUIRED', 'Required rules and core facts are saved for individual review; bulk import acceptance does not approve them.'));
    if (items.some(item => item.status === 'conflict')) warnings.push(diagnostic('CONFLICT_REVIEW_REQUIRED', 'Imports with identity conflicts are saved for review; review the resulting versions after resolving their dependencies.'));
    if (checked.data.entries.length || checked.data.styles.length || checked.data.recipes.length || checked.data.preferenceTemplates.length) warnings.push(diagnostic('P0_PRESERVED_NOT_EXECUTED', 'This version manages and preserves translation knowledge. Translation retrieval, applying recipes and applying preference templates arrive in a later increment.'));
    const preview: ImportPreview = { planId: randomUUID(), generation: state.generation, packageName: checked.data.package.name, items, warnings, counts: { added: items.filter(item => item.status === 'new').length, unchanged: items.filter(item => item.status === 'unchanged').length, conflicts: items.filter(item => item.status === 'conflict').length } };
    this.plans.set(preview.planId, { owner, expiresAt: Date.now() + PLAN_TTL_MS, data: clone(checked.data), preview: clone(preview) });
    return preview;
  }

  async commitImport(owner: string, request: CommitImportRequest, guard?: () => void): Promise<ImportReceipt> {
    this.checkOwner(owner);
    const input = parse(commitSchema, request);
    if (new Set(input.decisions.map(item => item.id)).size !== input.decisions.length) fail('DUPLICATE_DECISION', 'Each import entity may have only one decision.');
    const requestDigest = sha256Canonical({ ...input, decisions: [...input.decisions].sort((a, b) => a.id.localeCompare(b.id)) });
    const fence = () => { this.checkOwner(owner); guard?.(); };
    return this.repository.transact(state => {
      const committed = state.commits[input.planId];
      if (committed) {
        if (committed.ownerDigest !== ownerDigest(owner)) throw new KnowledgeServiceError('access_denied');
        if (committed.requestDigest !== requestDigest) throw new KnowledgeServiceError('import_conflict', [diagnostic('COMMITTED_DECISION_CHANGED', 'This import already committed with different decisions.')]);
        return { result: () => clone(state.imports.find(item => item.id === committed.receiptId)!) };
      }
      const plan = this.plans.get(input.planId);
      if (!plan) throw new KnowledgeServiceError('plan_expired');
      if (plan.owner !== owner) throw new KnowledgeServiceError('access_denied');
      if (plan.expiresAt <= Date.now() || plan.preview.generation !== state.generation) throw new KnowledgeServiceError('plan_expired');
      if (plan.requestDigest && plan.requestDigest !== requestDigest) throw new KnowledgeServiceError('import_conflict', [diagnostic('PLAN_DECISION_CHANGED', 'Create a new preview before changing a previously attempted import.')]);
      const beforeImport = { data: clone(state.data), approvals: clone(state.approvals) };
      const choices = new Map(input.decisions.map(item => [item.id, item.action]));
      const incoming = records(plan.data);
      for (const id of choices.keys()) if (!incoming.has(id)) fail('UNKNOWN_DECISION', 'An import decision refers to a record outside this preview.');
      const local = records(state.data);
      const mappings = new Map<string, string>();
      const accepted: Array<{ group: EntityGroup; original: KnowledgeEntity; action: 'replace' | 'copy'; local?: KnowledgeEntity }> = [];
      let skipped = 0;
      for (const item of plan.preview.items) {
        const action = choices.get(item.id) ?? (item.status === 'new' ? 'replace' : 'keep');
        if (action === 'keep' || action === 'skip' || (item.status === 'unchanged' && action === 'replace')) { skipped++; continue; }
        const found = local.get(item.id);
        if (action === 'replace' && found && (found.group !== item.group || item.sameRevision)) throw new KnowledgeServiceError('import_conflict', [diagnostic('IDENTITY_CONFLICT', 'The same revision with different content, or an ID used by another entity type, must be kept or copied.')]);
        if (action === 'copy') mappings.set(item.id, randomUUID());
        accepted.push({ group: item.group, original: item.incoming, action, local: found?.record });
      }
      mergePackageMetadata(state.data, plan.data);
      const changed = new Set<string>();
      const inserted = new Set<string>();
      let added = 0, updated = 0;
      for (const item of accepted) {
        const entity = remap(item.group, item.original, mappings);
        if (item.action === 'copy') { entity.revision = 1; added++; }
        else if (item.local) { entity.revision = nextRevision(Math.max(item.local.revision, entity.revision)); updated++; changed.add(entity.id); }
        else { if (canonicalize(entity) !== canonicalize(item.original)) entity.revision = nextRevision(entity.revision); added++; }
        put(state.data, item.group, entity);
        inserted.add(entity.id);
        delete state.approvals[entity.id];
      }
      // Recompute copied current-parent claims against the new IDs/revisions; old
      // historical claims retain their evidence revision and are never approvals.
      const resolving = new Set<string>();
      const resolved = new Set<string>();
      const acceptedEntries = new Map(accepted.filter(item => item.group === 'entries').map(item => [mappings.get(item.original.id) ?? item.original.id, item]));
      const entryById = new Map(state.data.entries.map(entry => [entry.id, entry]));
      for (const first of state.data.entries) {
        if (resolved.has(first.id) || !inserted.has(first.id)) continue;
        const stack = [{ entry: first, next: 0 }];
        resolving.add(first.id);
        while (stack.length) {
          const frame = stack[stack.length - 1];
          const entry = frame.entry;
          const acceptedEntry = acceptedEntries.get(entry.id);
          const original = acceptedEntry?.original as Entry | undefined;
          if (frame.next >= entry.derivedFrom.length) {
            if (original && acceptedEntry?.action !== 'copy' && entry.revision === original.revision && canonicalize(entry) !== canonicalize(original)) entry.revision = nextRevision(entry.revision);
            resolving.delete(entry.id); resolved.add(entry.id); stack.pop(); continue;
          }
          const claim = entry.derivedFrom[frame.next];
          const originalClaim = original?.derivedFrom[frame.next];
          const incomingParent = originalClaim ? incoming.get(originalClaim.entryId)?.record : undefined;
          const parent = entryById.get(claim.entryId);
          if (parent && inserted.has(parent.id) && incomingParent && originalClaim?.revision === incomingParent.revision && originalClaim.digest === sha256Canonical(incomingParent)) {
            if (resolving.has(parent.id)) fail('DERIVATION_CYCLE', 'An imported parent chain contains a cycle.');
            if (!resolved.has(parent.id)) { resolving.add(parent.id); stack.push({ entry: parent, next: 0 }); continue; }
            claim.revision = parent.revision; claim.digest = sha256Canonical(parent);
          }
          frame.next++;
        }
      }
      invalidate(state, changed);
      checkPackage(state.data);
      let adopted = 0;
      if (input.adoptReady && plan.preview.counts.conflicts === 0) {
        for (const entry of state.data.entries) {
          if (inserted.has(entry.id) && entry.state === 'ready' && !highRisk(entry) && !unavailable(entry, state.data)) { approve(state, entry, 'trusted_import'); adopted++; }
        }
      }
      const receipt: ImportReceipt = { id: input.planId, packageName: plan.data.package.name, createdAt: new Date().toISOString(), added, updated, skipped, adopted, generation: state.generation + 1 };
      state.imports.push(receipt);
      state.commits[input.planId] = { ownerDigest: ownerDigest(owner), requestDigest, packageDigest: sha256Canonical(plan.data), receiptId: receipt.id };
      state.importedOriginal = clone(plan.data);
      state.importChanges[input.planId] = captureImportChanges(beforeImport, state, input.planId);
      plan.requestDigest = requestDigest;
      return { state, result: () => clone(receipt) };
    }, fence);
  }

  async saveRecord(request: SaveRecordRequest, guard?: () => void): Promise<LibrarySnapshot> {
    const input = parse(saveSchema, request);
    const identity = parse(entitySchemas[input.group] as z.ZodType<KnowledgeEntity>, input.record);
    if (input.group !== 'entries' && (input.source || input.adopt)) fail('ENTRY_ONLY_ACTION', 'Evidence creation and adoption apply to entries only.');
    return this.repository.transact(state => {
      requireGeneration(state, input.generation);
      const existing = records(state.data);
      const changed = new Set<string>();
      let hasChanges = false;
      const save = (group: EntityGroup, record: KnowledgeEntity): KnowledgeEntity => {
        const local = existing.get(record.id);
        if (local && (local.group !== group || local.record.revision !== record.revision)) throw new KnowledgeServiceError('revision_conflict');
        if (!local && record.revision !== 1) fail('NEW_RECORD_REVISION', 'A new record must start at revision 1.');
        if (local && canonicalize(local.record) === canonicalize(record)) return local.record;
        const next = clone(record);
        if (local) { next.revision = nextRevision(local.record.revision); changed.add(next.id); }
        put(state.data, group, next);
        delete state.approvals[next.id];
        hasChanges = true;
        return next;
      };
      if (input.source) {
        if (input.source.id === identity.id) fail('SOURCE_ID_COLLISION', 'An entry and its evidence source must have different identities.');
        const old = existing.get(input.source.id);
        if (!old || old.group !== 'sources' || canonicalize(old.record) !== canonicalize(input.source)) save('sources', input.source);
      }
      const entity = save(input.group, identity);
      const target = input.group === 'entries' ? entity as Entry : undefined;
      if (target && input.adopt && target.state !== 'ready') {
        if (existing.has(target.id) && !changed.has(target.id)) target.revision = nextRevision(target.revision);
        target.state = 'ready'; changed.add(target.id); hasChanges = true;
      }
      invalidate(state, changed, target && input.adopt ? new Set([target.id]) : undefined);
      checkPackage(state.data);
      if (target && input.adopt) {
        if (unavailable(target, state.data)) throw new KnowledgeServiceError('import_conflict', [diagnostic('REVIEW_DEPENDENCY_ARCHIVED', 'Restore the required archived dependencies before accepting this entry.')]);
        if (!isTrusted(state, target)) { approve(state, target, 'human'); hasChanges = true; }
      }
      if (!hasChanges) return { result: snapshot };
      delete state.importedOriginal;
      return { state, result: snapshot };
    }, guard);
  }

  async reviewEntries(request: ReviewEntriesRequest, guard?: () => void): Promise<LibrarySnapshot> {
    const input = parse(reviewSchema, request);
    if (new Set(input.ids).size !== input.ids.length) fail('DUPLICATE_REVIEW', 'Select each review entry once.');
    return this.repository.transact(state => {
      requireGeneration(state, input.generation);
      const selected = input.ids.map(id => { const entry = state.data.entries.find(item => item.id === id); if (!entry) throw new KnowledgeServiceError('not_found'); return entry; });
      if (input.action === 'adopt') {
        if (selected.length > 1 && selected.some(highRisk)) throw new KnowledgeServiceError('import_conflict', [diagnostic('INDIVIDUAL_REVIEW_REQUIRED', 'Required rules and core facts need individual review.')]);
        if (selected.some(entry => unavailable(entry, state.data))) throw new KnowledgeServiceError('import_conflict', [diagnostic('REVIEW_DEPENDENCY_ARCHIVED', 'Restore the required archived dependencies before accepting these entries.')]);
      }
      for (const entry of selected) {
        entry.state = input.action === 'adopt' ? 'ready' : input.action === 'archive' ? 'archived' : 'rejected';
        entry.revision = nextRevision(entry.revision);
        delete state.approvals[entry.id];
      }
      const changed = new Set(input.ids);
      invalidate(state, changed, input.action === 'adopt' ? changed : undefined);
      checkPackage(state.data);
      if (input.action === 'adopt') for (const entry of selected) approve(state, entry, 'human');
      delete state.importedOriginal;
      return { state, result: snapshot };
    }, guard);
  }

  async planMaintenance(owner: string, request: MaintenanceRequest): Promise<MaintenancePreview> {
    this.checkOwner(owner);
    const input = parse(maintenanceRequestSchema, request);
    const state = await this.repository.read();
    const history = input.action === 'purge' && !state.cleanupPending ? await this.repository.historyInventory() : undefined;
    this.checkOwner(owner);
    for (const [id, plan] of this.maintenancePlans) if (plan.owner === owner || plan.expiresAt <= Date.now()) this.maintenancePlans.delete(id);
    if (this.maintenancePlans.size >= 64) throw new KnowledgeServiceError('limit_exceeded');
    const { preview } = buildMaintenance(state, input, randomUUID(), history?.length);
    this.maintenancePlans.set(preview.planId, { owner, expiresAt: Date.now() + PLAN_TTL_MS, request: clone(input), preview: clone(preview), ...(history ? { historyDigest: sha256Canonical([...history].sort((a, b) => a.name.localeCompare(b.name))) } : {}) });
    return preview;
  }

  async commitMaintenance(owner: string, request: MaintenanceCommit, guard?: () => void): Promise<MaintenanceReceipt> {
    this.checkOwner(owner);
    const input = parse(maintenanceCommitRequestSchema, request);
    const requestDigest = sha256Canonical(input);
    const fence = () => { this.checkOwner(owner); guard?.(); };
    const pendingPlan = this.maintenancePlans.get(input.planId);
    let historyDigest: string | undefined;
    if (pendingPlan?.request.action === 'purge') {
      // Already-published retries must reach their receipt even while cleanup is
      // pending; the repository performs recovery before this transaction.
      const current = await this.repository.read();
      if (!current.maintenanceCommits[input.planId]) {
        const history = await this.repository.historyInventory();
        historyDigest = sha256Canonical([...history].sort((a, b) => a.name.localeCompare(b.name)));
      }
    }
    return this.repository.transact(state => {
      const committed = state.maintenanceCommits[input.planId];
      if (committed) {
        if (committed.ownerDigest !== ownerDigest(owner)) throw new KnowledgeServiceError('access_denied');
        if (committed.requestDigest !== requestDigest) throw new KnowledgeServiceError('import_conflict', [diagnostic('MAINTENANCE_DECISION_CHANGED', 'This maintenance operation already committed with different decisions.')]);
        return { result: current => ({ ...clone(committed.receipt), cleanupPending: committed.receipt.action === 'purge' && current.purgeOperationId === input.planId && current.cleanupPending }) };
      }
      const plan = this.maintenancePlans.get(input.planId);
      if (!plan || plan.expiresAt <= Date.now()) throw new KnowledgeServiceError('plan_expired');
      if (plan.owner !== owner) throw new KnowledgeServiceError('access_denied');
      if (plan.request.generation !== state.generation) throw new KnowledgeServiceError('plan_expired');
      if (plan.requestDigest && plan.requestDigest !== requestDigest) throw new KnowledgeServiceError('import_conflict');
      if (plan.request.action === 'purge' && input.confirmHistoryRemoval !== true) fail('HISTORY_REMOVAL_CONFIRMATION', 'Confirm that permanently clearing these records also removes all library history snapshots.');
      if (plan.request.action !== 'purge' && input.confirmHistoryRemoval !== undefined) fail('UNEXPECTED_HISTORY_CONFIRMATION', 'History removal confirmation applies only to permanent clearing.');
      if (plan.historyDigest !== historyDigest) throw new KnowledgeServiceError('plan_expired');
      const outcome = buildMaintenance(state, plan.request, input.planId, plan.preview.history.snapshots);
      if (!outcome.preview.canCommit) throw new KnowledgeServiceError('import_conflict', outcome.preview.blockers);
      const receipt: MaintenanceReceipt = { id: input.planId, action: plan.request.action, generation: state.generation + 1, changed: outcome.changed, cleanupPending: plan.request.action === 'purge' };
      outcome.state.maintenanceCommits[input.planId] = { ownerDigest: ownerDigest(owner), requestDigest, receipt };
      if (plan.request.action === 'purge') outcome.state.purgeOperationId = input.planId;
      delete outcome.state.importedOriginal;
      plan.requestDigest = requestDigest;
      return { state: outcome.state, ...(plan.request.action === 'purge' ? { purgeOperationId: input.planId } : {}), result: current => ({ ...clone(receipt), cleanupPending: receipt.action === 'purge' && current.cleanupPending }) };
    }, fence);
  }

  async exportPackage(request: ExportRequest): Promise<KnowledgePackage> {
    const input = parse(exportSchema, request);
    if (new Set(input.collectionIds).size !== input.collectionIds.length) fail('DUPLICATE_COLLECTION', 'Select each collection once.');
    const state = await this.repository.read();
    requireGeneration(state, input.generation);
    let data: KnowledgePackage;
    if (input.purpose === 'backup') data = clone(state.data);
    else {
      if (input.collectionIds.length === 0) fail('SHARE_SELECTION_REQUIRED', 'Select at least one collection to share.');
      if (input.collectionIds.some(id => !state.data.collections.some(item => item.id === id))) throw new KnowledgeServiceError('not_found');
      data = emptyPackage();
      data.collections = clone(state.data.collections.filter(item => input.collectionIds.includes(item.id) && !item.archived));
      const collectionIds = new Set(data.collections.map(item => item.id));
      data.entries = clone(state.data.entries.filter(entry => collectionIds.has(entry.collectionId) && isTrusted(state, entry) && (input.includeMemories || entry.kind !== 'memory')));
      const subjectIds = new Set([...data.collections.flatMap(item => item.aboutSubjectIds), ...data.entries.flatMap(item => [...item.aboutSubjectIds, ...item.scope.requiredSubjects.map(binding => binding.subjectId)])]);
      const sourceIds = new Set(data.entries.flatMap(item => [...item.evidence.map(evidence => evidence.sourceId), ...item.derivedFrom.map(parent => parent.evidenceSourceId)]));
      data.subjects = clone(state.data.subjects.filter(item => subjectIds.has(item.id)));
      data.sources = clone(state.data.sources.filter(item => sourceIds.has(item.id)));
    }
    data.package = { id: randomUUID(), revision: 1, name: input.purpose === 'backup' ? 'Translation knowledge backup' : data.collections.map(item => item.name).join(', ').slice(0, 300), description: '', purpose: input.purpose, createdAt: new Date().toISOString(), generator: { name: 'FusionKit', version: '0.3.1' } };
    if (!data.package.name.trim()) data.package.name = 'Translation knowledge';
    const privateContent = privacyDiagnostics(data);
    if (privateContent.length) throw new KnowledgeServiceError('invalid_input', privateContent);
    checkPackage(data);
    return data;
  }

  releaseOwner(owner: string): void {
    this.released.add(owner);
    for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
    for (const [id, plan] of this.maintenancePlans) if (plan.owner === owner) this.maintenancePlans.delete(id);
  }
  async dispose(): Promise<void> { this.disposed = true; this.plans.clear(); this.maintenancePlans.clear(); await this.repository.dispose(); }
  private checkOwner(owner: string): void {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 512 || this.disposed || this.released.has(owner)) throw new KnowledgeServiceError('access_denied');
  }
}

/** Never silently scrub a versioned entity: identified private values block export. */
function privacyDiagnostics(data: KnowledgePackage): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const visit = (value: unknown, location: string): void => {
    if (diagnostics.length >= 100) return;
    if (typeof value === 'string') {
      const absolutePath = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home|private|tmp|var|etc|Volumes|mnt|opt|root|Applications)\/)/.test(value) || /file:\/\//i.test(value);
      const credential = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i.test(value) || /[?&](?:api[_-]?key|access[_-]?token|token|secret|password)=\S+/i.test(value);
      if (absolutePath || credential) diagnostics.push(diagnostic('EXPORT_PRIVATE_CONTENT', 'This field contains a local path or credential-like value. Create a portable version before exporting.', location));
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${location}/${index}`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      const itemPath = `${location}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (/^(?:api[_-]?key|access[_-]?token|password|secret|authorization)$/i.test(key) && item) diagnostics.push(diagnostic('EXPORT_PRIVATE_CONTENT', 'Credential fields cannot be exported.', itemPath));
      else visit(item, itemPath);
    }
  };
  visit(data, '');
  return diagnostics.slice(0, 100);
}

const PROVENANCE_NAMESPACE = 'org.fusionkit.package-provenance';
const provenanceSchema = z.strictObject({ version: z.literal(1), packages: z.array(knowledgePackageSchema.shape.package) });
/** Package author/sharing declarations describe their source package, never the merged library. */
function mergePackageMetadata(local: KnowledgePackage, incoming: KnowledgePackage): void {
  const combined = clone(local.extensions ?? {});
  const packageHeaders: KnowledgePackage['package'][] = [];
  for (const data of [local, incoming]) {
    const provenance = data.extensions?.[PROVENANCE_NAMESPACE];
    if (provenance !== undefined) {
      const checked = provenanceSchema.safeParse(provenance);
      if (!checked.success) throw new KnowledgeServiceError('import_conflict', [diagnostic('PACKAGE_PROVENANCE_FORMAT', 'The FusionKit package-provenance extension has an incompatible shape; the library was not changed.')]);
      packageHeaders.push(...checked.data.packages);
    }
  }
  for (const [key, value] of Object.entries(incoming.extensions ?? {})) {
    if (key === PROVENANCE_NAMESPACE) continue;
    if (combined[key] !== undefined && canonicalize(combined[key]) !== canonicalize(value)) throw new KnowledgeServiceError('import_conflict', [diagnostic('IMPORT_METADATA_CONFLICT', `Package extension ${key} has a different local value. Export or revise the conflicting metadata before importing.`, `/extensions/${key}`)]);
    combined[key] = clone(value);
  }
  packageHeaders.push(clone(incoming.package));
  const uniqueHeaders = [...new Map(packageHeaders.map(header => [sha256Canonical(header), header])).values()];
  combined[PROVENANCE_NAMESPACE] = { version: 1, packages: uniqueHeaders };
  local.extensions = combined;
}
