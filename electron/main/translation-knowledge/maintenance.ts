import { z } from 'zod';
import { ENTITY_ARRAYS, type Entry } from '../../../src/translation-knowledge/schemas';
import type { KnowledgeEntity } from '../../../src/translation-knowledge/ipc-contract';
import type { MaintenanceImpact, MaintenancePreview, MaintenanceRequest, RecordTarget } from '../../../src/translation-knowledge/maintenance-contract';
import { sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { validatePackage } from '../../../src/translation-knowledge/validation';
import { diagnostic, KnowledgeServiceError } from './errors';
import type { StoredLibrary } from './repository';
import { catalog, references, type ImportChangeSet } from './maintenance-storage';

const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const target = z.strictObject({ group: z.enum(ENTITY_ARRAYS), id: z.uuid() });
export const maintenanceRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ generation, action: z.literal('archive'), targets: z.array(target).min(1).max(20_000) }),
  z.strictObject({ generation, action: z.literal('restore'), targets: z.array(target).min(1).max(20_000) }),
  z.strictObject({ generation, action: z.literal('purge'), targets: z.array(target).min(1).max(20_000), includeCollectionContents: z.literal(true).optional() })
    .refine(request => !request.includeCollectionContents || request.targets.every(item => item.group === 'collections'), { message: 'Deleting collection contents requires collection targets only.', path: ['targets'] }),
  z.strictObject({ generation, action: z.literal('undo_import'), importId: z.uuid() }),
]);
export const maintenanceCommitRequestSchema = z.strictObject({ planId: z.uuid(), confirmHistoryRemoval: z.boolean().optional() });
const title = (record: KnowledgeEntity) => 'title' in record ? record.title : record.name;
const approvalDigest = (state: Pick<StoredLibrary, 'approvals'>, id: string) => state.approvals[id] ? sha256Canonical(state.approvals[id]) : undefined;
const same = (left: unknown, right: unknown) => left === undefined || right === undefined ? left === right : sha256Canonical(left) === sha256Canonical(right);
const revision = (current: number): number => {
  if (current >= Number.MAX_SAFE_INTEGER) throw new KnowledgeServiceError('limit_exceeded');
  return current + 1;
};
function impact(item: { group: RecordTarget['group']; record: KnowledgeEntity }, effect: MaintenanceImpact['effect'], reason: MaintenanceImpact['reason']): MaintenanceImpact {
  return { group: item.group, id: item.record.id, title: title(item.record), effect, reason };
}
function inboundIndex(records: ReturnType<typeof catalog>): Map<string, ImportChangeSet['changes'][number]['inboundAfter']> {
  const incoming = new Map<string, ImportChangeSet['changes'][number]['inboundAfter']>();
  for (const item of records.values()) {
    const ref = { group: item.group, id: item.record.id, digest: sha256Canonical(item.record) };
    for (const targetId of new Set(references(item.group, item.record))) {
      const list = incoming.get(targetId) ?? []; list.push(ref); incoming.set(targetId, list);
    }
  }
  return incoming;
}
export function captureImportChanges(before: Pick<StoredLibrary, 'data' | 'approvals'>, after: StoredLibrary, importId: string): ImportChangeSet {
  const previous = catalog(before.data), current = catalog(after.data);
  const inbound = inboundIndex(current);
  const changes: ImportChangeSet['changes'] = [];
  for (const [id, item] of current) {
    const old = previous.get(id);
    if (old && same(old.record, item.record) && approvalDigest(before, id) === approvalDigest(after, id)) continue;
    const inboundAfter = inbound.get(id) ?? [];
    changes.push({ group: item.group, id, ...(old ? { before: structuredClone(old.record) } : {}), afterDigest: sha256Canonical(item.record), afterRevision: item.record.revision, ...(approvalDigest(after, id) ? { afterApprovalDigest: approvalDigest(after, id) } : {}), inboundAfter });
  }
  return { id: importId, generation: after.generation + 1, changes };
}

/** Pause use through actual required scopes, not display-only subject associations. */
function pauseDependents(state: StoredLibrary, changed: Set<string>, alreadyRevised: Set<string>): void {
  const affected = new Set(changed);
  const dependents = new Map<string, string[]>();
  for (const entry of state.data.entries) for (const id of [entry.collectionId, ...entry.scope.requiredSubjects.map(item => item.subjectId), ...entry.evidence.map(item => item.sourceId), ...entry.derivedFrom.flatMap(item => [item.entryId, item.evidenceSourceId])]) {
    const list = dependents.get(id) ?? []; list.push(entry.id); dependents.set(id, list);
  }
  const pending = [...changed];
  for (let index = 0; index < pending.length; index++) {
    for (const id of dependents.get(pending[index]) ?? []) if (!affected.has(id)) { affected.add(id); pending.push(id); }
  }
  for (const entry of state.data.entries) if (affected.has(entry.id)) {
    delete state.approvals[entry.id];
    if (entry.state === 'ready') {
      entry.state = 'needs_review';
      if (!alreadyRevised.has(entry.id)) entry.revision = revision(entry.revision);
    }
  }
}

export function buildMaintenance(state: StoredLibrary, request: MaintenanceRequest, planId: string, snapshots = 0): { preview: MaintenancePreview; state: StoredLibrary; changed: number } {
  if (request.generation !== state.generation) throw new KnowledgeServiceError('revision_conflict');
  const next = structuredClone(state), initial = catalog(state.data), current = catalog(next.data);
  const incomingReferences = inboundIndex(initial);
  const items: MaintenanceImpact[] = [], blockers: MaintenancePreview['blockers'] = [];
  const changed = new Set<string>(), revised = new Set<string>();
  const block = (item: { group: RecordTarget['group']; record: KnowledgeEntity }, reason: MaintenanceImpact['reason'], code: string, message: string) => { items.push(impact(item, 'blocked', reason)); blockers.push(diagnostic(code, message, `/${item.group}/${item.record.id}`)); };
  if (state.cleanupPending) blockers.push(diagnostic('PURGE_CLEANUP_PENDING', 'Finish the pending history cleanup before making another change.'));

  if (request.action === 'undo_import') {
    const receipt = state.imports.find(item => item.id === request.importId);
    if (!receipt) throw new KnowledgeServiceError('not_found');
    const changeSet = state.importChanges[request.importId];
    if (state.undoneImportIds.includes(request.importId)) blockers.push(diagnostic('IMPORT_ALREADY_UNDONE', 'This import was already undone.'));
    else if (!changeSet) blockers.push(diagnostic('LEGACY_IMPORT_NO_UNDO', 'This import has no retained change record, or its history was permanently cleared.'));
    else {
      for (const change of changeSet.changes) {
        const item = current.get(change.id);
        if (!item || item.group !== change.group) {
          blockers.push(diagnostic('UNDO_LATER_EDIT', 'An imported record was subsequently removed or replaced.', `/${change.group}/${change.id}`));
          if (change.before) items.push(impact({ group: change.group, record: change.before }, 'blocked', 'later_edit'));
          continue;
        }
        if (sha256Canonical(item.record) !== change.afterDigest || item.record.revision !== change.afterRevision || approvalDigest(state, change.id) !== change.afterApprovalDigest) { block(item, 'later_edit', 'UNDO_LATER_EDIT', 'This record or its local approval changed after the import.'); continue; }
        const originalReferences = new Set(change.inboundAfter.map(ref => `${ref.group}:${ref.id}:${ref.digest}`));
        const newReference = (incomingReferences.get(change.id) ?? []).some(ref => !originalReferences.has(`${ref.group}:${ref.id}:${ref.digest}`));
        if (newReference) { block(item, 'new_reference', 'UNDO_NEW_REFERENCE', 'A new or subsequently edited record now references this imported record.'); continue; }
        if (!change.before && change.group === 'sources') { items.push(impact(item, 'retain', 'retained_source')); continue; }
        const restored = change.before ? structuredClone(change.before) : structuredClone(item.record);
        restored.revision = revision(item.record.revision);
        if (change.group === 'entries') {
          const entry = restored as Entry;
          entry.state = change.before ? entry.state === 'ready' ? 'needs_review' : entry.state : 'archived';
        } else if ('archived' in restored && !change.before) restored.archived = true;
        const list = next.data[change.group] as KnowledgeEntity[];
        list[list.findIndex(value => value.id === change.id)] = restored;
        delete next.approvals[change.id]; changed.add(change.id); revised.add(change.id);
        items.push(impact(item, change.before ? 'restore' : 'archive', 'selected'));
      }
      if (!blockers.length) { pauseDependents(next, changed, revised); next.undoneImportIds.push(request.importId); }
    }
  } else {
    if (new Set(request.targets.map(item => item.id)).size !== request.targets.length) throw new KnowledgeServiceError('invalid_input', [diagnostic('DUPLICATE_TARGET', 'Select each maintenance record once.')]);
    const deletingCollections = request.action === 'purge' && request.includeCollectionContents === true;
    const collectionIds = new Set(deletingCollections ? request.targets.map(item => item.id) : []);
    // Expand from the exact repository generation used by this preview/commit. Do
    // not rely on a renderer-provided member list or mutate archive state first.
    const targets: RecordTarget[] = deletingCollections
      ? [...request.targets, ...state.data.entries.filter(entry => collectionIds.has(entry.collectionId)).map(entry => ({ group: 'entries' as const, id: entry.id }))]
      : request.targets;
    const selected = new Set(targets.map(item => item.id));
    for (const target of targets) {
      const item = current.get(target.id);
      if (!item || item.group !== target.group) throw new KnowledgeServiceError('not_found');
      if (request.action === 'purge') {
        if (!deletingCollections && (item.group === 'entries' ? (item.record as Entry).state !== 'archived' : 'archived' in item.record && !item.record.archived)) { block(item, 'active_record', 'PURGE_ARCHIVE_FIRST', 'Archive this record before permanently clearing it.'); continue; }
        const inbound = (incomingReferences.get(item.record.id) ?? []).filter(value => !selected.has(value.id)).map(value => initial.get(value.id)!);
        if (inbound.length) {
          block(item, 'referenced', 'PURGE_REFERENCED', 'Records outside this selection still reference it. Include or edit those references first.');
          for (const ref of inbound) items.push(impact(ref, 'blocked', 'referenced'));
          continue;
        }
        items.push(impact(item, 'purge', 'selected')); changed.add(item.record.id); delete next.approvals[item.record.id];
        if (item.group === 'entries') for (const sourceId of [...(item.record as Entry).evidence.map(value => value.sourceId), ...(item.record as Entry).derivedFrom.map(value => value.evidenceSourceId)]) {
          const source = initial.get(sourceId);
          if (source && !selected.has(sourceId)) items.push(impact(source, 'retain', 'retained_source'));
        }
      } else {
        if (item.group === 'sources') { block(item, 'unavailable', 'SOURCE_ARCHIVE_UNSUPPORTED', 'Sources remain available as evidence; only unreferenced sources can be permanently cleared.'); continue; }
        const entity = item.record;
        const archived = item.group === 'entries' ? (entity as Entry).state === 'archived' : 'archived' in entity && entity.archived;
        if (archived === (request.action === 'archive')) { items.push(impact(item, 'retain', 'selected')); continue; }
        entity.revision = revision(entity.revision);
        if (item.group === 'entries') (entity as Entry).state = request.action === 'archive' ? 'archived' : 'needs_review';
        else if ('archived' in entity) entity.archived = request.action === 'archive';
        changed.add(entity.id); revised.add(entity.id); delete next.approvals[entity.id];
        items.push(impact(item, request.action, 'selected'));
      }
    }
    if (!blockers.length) {
      if (request.action === 'purge') {
        for (const group of ENTITY_ARRAYS) (next.data[group] as KnowledgeEntity[]) = next.data[group].filter(item => !selected.has(item.id));
        next.importChanges = {};
        delete next.importedOriginal;
      } else pauseDependents(next, changed, revised);
    }
  }

  const final = catalog(next.data);
  const directImpactIds = new Set(items.map(item => item.id));
  for (const [id, item] of final) {
    const original = initial.get(id);
    if (!original || same(original.record, item.record) && approvalDigest(state, id) === approvalDigest(next, id)) continue;
    changed.add(id);
    if (!directImpactIds.has(id)) { items.push(impact(item, 'review', 'dependency')); directImpactIds.add(id); }
  }
  const impacted = new Set(changed);
  const impactQueue = [...changed], shownIds = new Set(items.map(item => item.id));
  for (let index = 0; index < impactQueue.length; index++) {
    for (const ref of incomingReferences.get(impactQueue[index]) ?? []) if (!impacted.has(ref.id)) {
      impacted.add(ref.id); impactQueue.push(ref.id);
      if (!shownIds.has(ref.id)) { items.push(impact(initial.get(ref.id)!, 'retain', 'dependency')); shownIds.add(ref.id); }
    }
  }
  if (!blockers.length) {
    const checked = validatePackage(next.data);
    if (!checked.valid) blockers.push(...checked.errors);
  }
  const uniqueItems = [...new Map(items.map(item => [`${item.group}:${item.id}:${item.effect}:${item.reason}`, item])).values()];
  return { state: next, changed: changed.size, preview: { planId, generation: state.generation, action: request.action, items: uniqueItems, blockers: blockers.slice(0, 100), canCommit: blockers.length === 0, history: { snapshots: request.action === 'purge' ? snapshots : 0, importsLosingUndo: request.action === 'purge' ? Object.keys(state.importChanges).filter(id => !state.undoneImportIds.includes(id)).length : 0, scope: request.action === 'purge' ? 'all' : 'none' }, taskTracking: 'not_connected' } };
}
