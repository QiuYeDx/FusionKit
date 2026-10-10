import type { Collection, Entry, KnowledgePackage, LanguagePair, Source, Subject } from './schemas';
import type { LibrarySnapshot, SaveRecordsRequest } from './ipc-contract';
import { validatePackage } from './validation';

/**
 * A knowledge change proposal: records an assistant or a review step wants to create, edit or
 * archive. Building one never writes; the result is shown for confirmation, then saved in one
 * transaction with saveRecords. Pure, so the renderer and tests share it.
 */

/** Where a proposed wording comes from; it decides the evidence and whether saving enables it by default. */
export type ProposalBasis = 'user_stated' | 'user_revision' | 'document' | 'agent_inferred' | 'web';
/** An existing record id, or a key naming a subject/collection created by the same proposal. */
export type ProposalRef = { id: string } | { ref: string };
export interface ProposalSubjectInput { ref: string; name: string; kind: Subject['kind']; aliases?: string[]; description?: string }
export interface ProposalCollectionInput { ref: string; name: string; description?: string; subjects?: ProposalRef[]; languagePair?: LanguagePair }
export interface ProposalEntryInput {
  action: 'create' | 'update' | 'archive';
  /** update/archive: the entry and the revision the proposal was based on. */
  entryId?: string; revision?: number;
  /** create: destination collection. */
  collection?: ProposalRef;
  kind?: 'term' | 'rule' | 'context';
  source?: string; target?: string; aliases?: string[]; note?: string;
  strength?: 'preferred' | 'required' | 'keep_source';
  text?: string; dimension?: 'register' | 'honorifics' | 'person_reference' | 'fidelity' | 'other'; core?: boolean;
  basis?: ProposalBasis;
  /** A short quote supporting the entry: the user's words, a subtitle line, a page summary. */
  evidence?: string;
  /** web basis: where it was read. */
  url?: string; urlTitle?: string; accessedAt?: string;
  subjects?: ProposalRef[];
  languagePair?: LanguagePair;
}
export interface ProposalInput {
  languagePair?: LanguagePair;
  subjects?: ProposalSubjectInput[];
  collections?: ProposalCollectionInput[];
  entries?: ProposalEntryInput[];
}

export type ProposalItemStatus = 'new' | 'update' | 'archive' | 'exists' | 'invalid';
export interface ProposalWarning { code: 'term_conflict' | 'individual_review'; collectionName?: string; target?: string }
export interface ProposalItem {
  key: string;
  group: 'subjects' | 'collections' | 'entries';
  status: ProposalItemStatus;
  reason?: string;
  kind?: Entry['kind'] | Subject['kind'];
  /** term: source and target; rule/context: text; subject/collection: name. */
  label: string;
  source?: string; target?: string;
  collectionName?: string;
  note?: string;
  basis?: ProposalBasis;
  /** web basis: the site it was read on, such as "zh.wikipedia.org". */
  sourceSite?: string;
  warnings: ProposalWarning[];
}
export interface ProposalCounts { subjects: number; collections: number; created: number; updated: number; archived: number; existing: number }
export interface KnowledgeProposal {
  items: ProposalItem[];
  saveable: boolean;
  nothingToSave: boolean;
  /** Entries would be enabled on save unless the user turns it off: true only when every one is the user's own wording. */
  adoptDefault: boolean;
  /** Entries a save would add or edit; the enable choice applies to them. */
  adoptable: number;
  counts: ProposalCounts;
  /** Collections the saved entries go to, the first one being where to look afterwards. */
  collectionIds: string[];
  /** Ids assigned to new records; pass back to rebuild the same proposal against a newer library. */
  ids: Record<string, string>;
  request(adopt: boolean, generation?: number): SaveRecordsRequest;
}
export interface ProposalOptions {
  ids?: Record<string, string>;
  /** Evidence source titles by basis, in the interface language. */
  sourceTitles?: Partial<Record<ProposalBasis, string>>;
  newId?: () => string;
}

export const PROPOSAL_LIMITS = Object.freeze({ subjects: 5, collections: 5, entries: 50, evidence: 300 });
const USER_BASES: readonly ProposalBasis[] = ['user_stated', 'user_revision'];
const DEFAULT_TITLES: Record<ProposalBasis, string> = {
  user_stated: 'Stated in conversation', user_revision: 'Applied revision', document: 'Subtitle document', agent_inferred: 'AI proposal', web: 'Web page',
};
const fold = (value: string) => value.normalize('NFC').trim().toLowerCase();
const clean = (value: string | undefined) => (value ?? '').trim();
/** The host of an http(s) page link without credentials, minus a leading www.; undefined for anything else. */
export function webSite(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(clean(url));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password ? parsed.hostname.replace(/^www\./, '') : undefined;
  } catch { return undefined; }
}
const utcTime = (value: string | undefined) => value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
const cleanList = (values: string[] | undefined) => [...new Set((values ?? []).map(item => item.trim()).filter(Boolean))];

/** `zh`, `zh-CN`, `zh-TW`… as the explicit script tags the library requires; undefined when unusable. */
export function normalizeLanguageTag(tag: string | undefined): string | undefined {
  const value = clean(tag);
  if (!value) return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    const locale = new Intl.Locale(canonical);
    if (['auto', 'und', 'mul'].includes(locale.language)) return undefined;
    if (locale.language !== 'zh') return canonical;
    if (locale.script === 'Hans' || locale.script === 'Hant') return `zh-${locale.script}`;
    return ['TW', 'HK', 'MO'].includes(locale.region ?? '') ? 'zh-Hant' : 'zh-Hans';
  } catch { return undefined; }
}
function normalizePair(pair: LanguagePair | undefined): LanguagePair | null | undefined {
  if (!pair) return undefined;
  const source = normalizeLanguageTag(pair.source), target = normalizeLanguageTag(pair.target);
  return source && target ? { source, target } : null;
}
const sameText = (a: string, b: string) => fold(a) === fold(b);
const samePair = (a: LanguagePair, b: LanguagePair) => a.source === b.source && a.target === b.target;
function summary(entry: Entry): string {
  if (entry.kind === 'term' || entry.kind === 'memory') return `${entry.payload.source} → ${entry.payload.target}`;
  return entry.kind === 'expression' ? entry.payload.interpretation : entry.payload.text;
}

export function buildKnowledgeProposal(input: ProposalInput, snapshot: Pick<LibrarySnapshot, 'generation' | 'data'>, options: ProposalOptions = {}): KnowledgeProposal {
  const ids: Record<string, string> = { ...options.ids };
  const newId = options.newId ?? (() => crypto.randomUUID());
  const idFor = (key: string) => (ids[key] ??= newId());
  const titles = { ...DEFAULT_TITLES, ...options.sourceTitles };
  const data = snapshot.data;
  const items: ProposalItem[] = [];
  const subjectsByRef = new Map<string, Subject>();
  const collectionsByRef = new Map<string, Collection>();
  const newSubjects: Subject[] = [], newCollections: Collection[] = [];
  /** Per entry item: the record to save and, for create/update, its new evidence. */
  const entryRecords = new Map<string, { entry: Entry; source?: Source }>();
  const defaultPair = normalizePair(input.languagePair);

  const resolveSubject = (ref: ProposalRef): string | undefined => 'id' in ref
    ? data.subjects.find(item => item.id === ref.id && !item.archived)?.id
    : subjectsByRef.get(ref.ref)?.id;
  const resolveCollection = (ref: ProposalRef): Collection | undefined => 'id' in ref
    ? data.collections.find(item => item.id === ref.id) : collectionsByRef.get(ref.ref);

  for (const subject of input.subjects ?? []) {
    const key = `subject:${subject.ref}`;
    const name = clean(subject.name);
    const item: ProposalItem = { key, group: 'subjects', status: 'new', kind: subject.kind, label: name, warnings: [] };
    items.push(item);
    if (!name) { item.status = 'invalid'; item.reason = 'missing_name'; continue; }
    if (subjectsByRef.has(subject.ref)) { item.status = 'invalid'; item.reason = 'duplicate_ref'; continue; }
    // Saved by an earlier attempt of this same proposal.
    const saved = ids[key] && data.subjects.find(existing => existing.id === ids[key]);
    // A live subject of the same kind and name is the same subject; reuse it rather than duplicate it.
    const same = saved || data.subjects.find(existing => !existing.archived && existing.kind === subject.kind && sameText(existing.name, name));
    if (same) { item.status = 'exists'; subjectsByRef.set(subject.ref, same); continue; }
    const record: Subject = { id: idFor(key), revision: 1, archived: false, kind: subject.kind, name,
      aliases: cleanList(subject.aliases), tags: [], description: clean(subject.description) };
    subjectsByRef.set(subject.ref, record); newSubjects.push(record);
  }
  for (const collection of input.collections ?? []) {
    const key = `collection:${collection.ref}`;
    const name = clean(collection.name);
    const item: ProposalItem = { key, group: 'collections', status: 'new', label: name, warnings: [] };
    items.push(item);
    if (!name) { item.status = 'invalid'; item.reason = 'missing_name'; continue; }
    if (collectionsByRef.has(collection.ref)) { item.status = 'invalid'; item.reason = 'duplicate_ref'; continue; }
    const saved = ids[key] && data.collections.find(existing => existing.id === ids[key]);
    const same = saved || data.collections.find(existing => !existing.archived && sameText(existing.name, name));
    if (same) { item.status = 'exists'; collectionsByRef.set(collection.ref, same); continue; }
    const subjectIds = (collection.subjects ?? []).map(resolveSubject);
    if (subjectIds.some(id => !id)) { item.status = 'invalid'; item.reason = 'unknown_subject'; continue; }
    const pair = normalizePair(collection.languagePair) ?? defaultPair;
    if (collection.languagePair && pair === null) { item.status = 'invalid'; item.reason = 'invalid_language'; continue; }
    const record: Collection = { id: idFor(key), revision: 1, archived: false, name, description: clean(collection.description),
      aboutSubjectIds: [...new Set(subjectIds as string[])], ...(pair ? { defaultLanguagePair: pair } : {}) };
    collectionsByRef.set(collection.ref, record); newCollections.push(record);
  }

  const evidenceFor = (key: string, entry: ProposalEntryInput, fallback: string): Source => {
    const basis = entry.basis ?? 'agent_inferred';
    const excerpt = (clean(entry.evidence) || fallback).slice(0, PROPOSAL_LIMITS.evidence);
    const url = basis === 'web' ? clean(entry.url) : '';
    return { id: idFor(`${key}:source`), revision: 1,
      kind: basis === 'web' ? 'web' : USER_BASES.includes(basis) ? 'user_note' : 'ai_proposal',
      title: (basis === 'web' && clean(entry.urlTitle)) || titles[basis], excerpt,
      ...(url ? { url } : {}), ...(basis === 'web' ? { accessedAt: entry.accessedAt } : {}) };
  };
  const support = (basis: ProposalBasis | undefined) => basis && (USER_BASES.includes(basis) || basis === 'web') ? 'direct' as const : 'inferred' as const;
  const collectionName = (id: string) => newCollections.find(item => item.id === id)?.name ?? data.collections.find(item => item.id === id)?.name;

  (input.entries ?? []).forEach((proposed, index) => {
    const key = `entry:${index}`;
    const basis = proposed.basis ?? 'agent_inferred';
    const item: ProposalItem = { key, group: 'entries', status: proposed.action === 'create' ? 'new' : proposed.action, label: '', basis, warnings: [] };
    items.push(item);
    const invalid = (reason: string) => { item.status = 'invalid'; item.reason = reason; };
    if (basis === 'web' && proposed.action !== 'archive') {
      const site = webSite(proposed.url);
      if (!site) return invalid('missing_url');
      item.sourceSite = site;
      // A web source records when the page was read; a link only seen in search results is not evidence.
      if (!utcTime(proposed.accessedAt)) return invalid('page_not_read');
    }
    let entry: Entry;
    if (proposed.action === 'create') {
      const saved = ids[key] && data.entries.find(existing => existing.id === ids[key]);
      if (saved) { item.status = 'exists'; item.kind = saved.kind; item.label = summary(saved); item.collectionName = collectionName(saved.collectionId); return; }
      if (!proposed.collection) return invalid('missing_collection');
      const collection = resolveCollection(proposed.collection);
      if (!collection) return invalid('unknown_collection');
      if (collection.archived) return invalid('archived_collection');
      item.collectionName = collection.name;
      const subjectIds = proposed.subjects ? proposed.subjects.map(resolveSubject) : collection.aboutSubjectIds;
      if (subjectIds.some(id => !id)) return invalid('unknown_subject');
      const explicitPair = normalizePair(proposed.languagePair);
      if (proposed.languagePair && explicitPair === null) return invalid('invalid_language');
      const pair = explicitPair ?? defaultPair ?? collection.defaultLanguagePair;
      if (!pair) return invalid(defaultPair === null ? 'invalid_language' : 'missing_language');
      const base = { id: idFor(key), revision: 1, collectionId: collection.id, aboutSubjectIds: [...new Set(subjectIds as string[])],
        scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' as const } }, state: 'candidate' as const, evidence: [], derivedFrom: [] };
      const kind = proposed.kind ?? 'term';
      if (kind === 'term') {
        const source = clean(proposed.source), target = clean(proposed.target);
        if (!source) return invalid('missing_source');
        if (!target && proposed.strength !== 'keep_source') return invalid('missing_target');
        entry = { ...base, kind, title: source.slice(0, 120), payload: { source, target: proposed.strength === 'keep_source' ? source : target,
          aliases: cleanList(proposed.aliases).filter(alias => !sameText(alias, source)), sense: clean(proposed.note),
          match: { mode: 'literal_phrase', caseSensitive: false }, strength: proposed.strength ?? 'preferred' } };
      } else {
        const text = clean(proposed.text);
        if (!text) return invalid('missing_text');
        entry = kind === 'rule'
          ? { ...base, kind, title: text.slice(0, 120), payload: { dimension: proposed.dimension ?? 'other', text, strength: proposed.strength === 'required' ? 'required' : 'preferred' } }
          : { ...base, kind, title: text.slice(0, 120), payload: { text, assertion: 'fact', core: proposed.core ?? false } };
      }
    } else {
      const current = data.entries.find(candidate => candidate.id === proposed.entryId);
      if (!current) return invalid('unknown_entry');
      item.collectionName = collectionName(current.collectionId);
      item.label = summary(current);
      if (proposed.revision !== current.revision) return invalid('stale_revision');
      if (proposed.action === 'archive') {
        item.kind = current.kind;
        if (current.state === 'archived') { item.status = 'exists'; return; }
        entryRecords.set(key, { entry: { ...structuredClone(current), state: 'archived' } });
        return;
      }
      if (current.state === 'archived') return invalid('archived_entry');
      if (current.kind !== 'term' && current.kind !== 'rule' && current.kind !== 'context') return invalid('unsupported_kind');
      if (proposed.kind && proposed.kind !== current.kind) return invalid('kind_mismatch');
      const explicitPair = normalizePair(proposed.languagePair);
      if (proposed.languagePair && explicitPair === null) return invalid('invalid_language');
      const subjectIds = proposed.subjects?.map(resolveSubject);
      if (subjectIds?.some(id => !id)) return invalid('unknown_subject');
      const next = structuredClone(current) as Extract<Entry, { kind: 'term' | 'rule' | 'context' }>;
      if (explicitPair) next.scope.languagePair = explicitPair;
      if (subjectIds) next.aboutSubjectIds = [...new Set(subjectIds as string[])];
      if (next.kind === 'term') {
        const source = proposed.source !== undefined ? clean(proposed.source) : next.payload.source;
        const target = proposed.target !== undefined ? clean(proposed.target) : next.payload.target;
        if (!source) return invalid('missing_source');
        if (!target) return invalid('missing_target');
        const strength = proposed.strength ?? next.payload.strength;
        next.payload = { ...next.payload, source, target: strength === 'keep_source' ? source : target, strength,
          ...(proposed.aliases ? { aliases: cleanList(proposed.aliases).filter(alias => !sameText(alias, source)) } : {}),
          ...(proposed.note !== undefined ? { sense: clean(proposed.note) } : {}) };
        if (proposed.source !== undefined) next.title = source.slice(0, 120);
      } else {
        const text = proposed.text !== undefined ? clean(proposed.text) : next.payload.text;
        if (!text) return invalid('missing_text');
        if (next.kind === 'rule') next.payload = { ...next.payload, text, ...(proposed.dimension ? { dimension: proposed.dimension } : {}),
          ...(proposed.strength === 'required' || proposed.strength === 'preferred' ? { strength: proposed.strength } : {}) };
        else next.payload = { ...next.payload, text, ...(proposed.core !== undefined ? { core: proposed.core } : {}) };
        if (proposed.text !== undefined) next.title = text.slice(0, 120);
      }
      entry = next;
    }
    item.kind = entry.kind;
    item.label = summary(entry);
    if (entry.kind === 'term') { item.source = entry.payload.source; item.target = entry.payload.target; item.note = entry.payload.sense || undefined; }
    if (proposed.action === 'update' && JSON.stringify(entry.payload) === JSON.stringify(data.entries.find(candidate => candidate.id === entry.id)!.payload)
      && !proposed.languagePair && !proposed.subjects) { item.status = 'exists'; return; }
    const source = evidenceFor(key, proposed, summary(entry));
    entry.evidence = [...entry.evidence, { sourceId: source.id, support: support(basis) }];
    entryRecords.set(key, { entry, source });
  });

  // Already in the library (or earlier in this proposal): skip rather than save a duplicate.
  const seen: Entry[] = [];
  const live = (entry: Entry) => entry.state !== 'archived' && entry.state !== 'rejected';
  for (const item of items) {
    const record = entryRecords.get(item.key);
    if (!record || item.status !== 'new') continue;
    const { entry } = record;
    const duplicate = (other: Entry) => other.id !== entry.id && other.collectionId === entry.collectionId && live(other) && other.kind === entry.kind
      && samePair(other.scope.languagePair, entry.scope.languagePair)
      && (entry.kind === 'term' && other.kind === 'term'
        ? sameText(other.payload.source, entry.payload.source) && sameText(other.payload.target, entry.payload.target)
        : entry.kind !== 'term' && other.kind !== 'term' && sameText(summary(other), summary(entry)));
    if (data.entries.some(duplicate) || seen.some(duplicate)) { item.status = 'exists'; entryRecords.delete(item.key); continue; }
    seen.push(entry);
  }

  // Warnings: a different target for the same source elsewhere, and entries that need one-by-one review.
  const proposedEntries = [...entryRecords.values()].map(value => value.entry);
  for (const item of items) {
    const record = entryRecords.get(item.key);
    if (!record || item.status === 'archive') continue;
    const { entry } = record;
    if (entry.kind === 'term') {
      const keys = [entry.payload.source, ...entry.payload.aliases].map(fold);
      const others = [...data.entries.filter(other => !proposedEntries.some(proposedEntry => proposedEntry.id === other.id)), ...proposedEntries];
      for (const other of others) {
        if (other.id === entry.id || other.kind !== 'term' || !live(other) || !samePair(other.scope.languagePair, entry.scope.languagePair)) continue;
        if (fold(other.payload.target) === fold(entry.payload.target)) continue;
        if (![other.payload.source, ...other.payload.aliases].some(source => keys.includes(fold(source)))) continue;
        if (item.warnings.some(warning => warning.code === 'term_conflict' && warning.target === other.payload.target)) continue;
        item.warnings.push({ code: 'term_conflict', collectionName: collectionName(other.collectionId), target: other.payload.target });
      }
    }
    if ((entry.kind === 'context' && entry.payload.core) || ((entry.kind === 'term' || entry.kind === 'rule') && entry.payload.strength === 'required'))
      item.warnings.push({ code: 'individual_review' });
  }

  // New catalog records are only saved when something uses them or they were asked for on their own.
  const usedCollections = new Set(proposedEntries.map(entry => entry.collectionId));
  const savedCollections = newCollections.filter(collection => usedCollections.has(collection.id) || !(input.entries ?? []).length);
  const usedSubjects = new Set([...savedCollections.flatMap(collection => collection.aboutSubjectIds), ...proposedEntries.flatMap(entry => entry.aboutSubjectIds)]);
  const savedSubjects = newSubjects.filter(subject => usedSubjects.has(subject.id) || !(input.entries ?? []).length);
  for (const item of items) {
    if (item.status !== 'new') continue;
    if (item.group === 'collections' && !savedCollections.some(collection => collection.id === ids[item.key])) item.status = 'exists';
    if (item.group === 'subjects' && !savedSubjects.some(subject => subject.id === ids[item.key])) item.status = 'exists';
  }

  const buildRequest = (adopt: boolean, generation = snapshot.generation): SaveRecordsRequest => ({ generation, items: [
    ...savedSubjects.map(record => ({ group: 'subjects' as const, record })),
    ...savedCollections.map(record => ({ group: 'collections' as const, record })),
    ...items.flatMap(item => {
      const value = entryRecords.get(item.key);
      if (!value) return [];
      if (item.status === 'archive') return [{ group: 'entries' as const, record: value.entry }];
      return [{ group: 'entries' as const, record: { ...value.entry, state: adopt ? 'ready' as const : 'candidate' as const }, ...(value.source ? { source: value.source } : {}), ...(adopt ? { adopt: true } : {}) }];
    }),
  ] });

  // Validate the result as the service will, and attribute any error to the item that caused it.
  if (!items.some(item => item.status === 'invalid')) {
    const request = buildRequest(true);
    if (request.items.length) {
      const merged = structuredClone(data) as KnowledgePackage;
      for (const { group, record, source } of request.items) {
        if (source && !merged.sources.some(existing => existing.id === source.id)) merged.sources.push(source);
        const list = merged[group] as { id: string }[];
        const at = list.findIndex(existing => existing.id === record.id);
        if (at >= 0) list[at] = record; else list.push(record);
      }
      const checked = validatePackage(merged);
      for (const error of checked.errors) {
        const match = /^\/(subjects|collections|entries|sources)\/(\d+)/.exec(error.path);
        const record = match ? (merged[match[1] as 'entries'] as { id: string }[])[Number(match[2])] : undefined;
        const owner = record && items.find(item => ids[item.key] === record.id || entryRecords.get(item.key)?.entry.id === record.id
          || entryRecords.get(item.key)?.source?.id === record.id);
        const target = owner ?? items.find(item => item.status !== 'exists') ?? items[0];
        if (target && target.status !== 'invalid') { target.status = 'invalid'; target.reason = `validation_${error.code}`; }
      }
    }
  }

  const pending = items.filter(item => item.status === 'new' || item.status === 'update' || item.status === 'archive');
  const adoptableItems = items.filter(item => item.group === 'entries' && (item.status === 'new' || item.status === 'update'));
  const counts: ProposalCounts = {
    subjects: items.filter(item => item.group === 'subjects' && item.status === 'new').length,
    collections: items.filter(item => item.group === 'collections' && item.status === 'new').length,
    created: items.filter(item => item.group === 'entries' && item.status === 'new').length,
    updated: items.filter(item => item.status === 'update').length,
    archived: items.filter(item => item.status === 'archive').length,
    existing: items.filter(item => item.status === 'exists').length,
  };
  const collectionIds = [...new Set([...proposedEntries.map(entry => entry.collectionId), ...savedCollections.map(collection => collection.id)])];
  const invalid = items.some(item => item.status === 'invalid');
  return {
    items, counts, ids, collectionIds,
    nothingToSave: !invalid && !pending.length,
    saveable: !invalid && pending.length > 0,
    adoptable: adoptableItems.length,
    adoptDefault: adoptableItems.length > 0 && adoptableItems.every(item => item.basis && USER_BASES.includes(item.basis)),
    request: buildRequest,
  };
}
