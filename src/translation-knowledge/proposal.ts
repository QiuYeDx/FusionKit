import type { Collection, Entry, KnowledgePackage, LanguagePair, Origin } from './schemas';
import type { LibrarySnapshot, SaveRecordsRequest } from './ipc-contract';
import { entrySummary } from './summary';
import { validatePackage } from './validation';

/**
 * A knowledge change proposal: records an assistant or a capture dialog wants to create or edit.
 * Building one never writes; the result is shown for confirmation, then saved in one
 * transaction with saveRecords. Confirming is the review: saved entries take effect at once.
 * Pure, so the renderer and tests share it.
 */

/** Where a proposed wording comes from; recorded as the entry origin and shown on the card. */
export type ProposalBasis = 'user_stated' | 'user_revision' | 'document' | 'agent_inferred' | 'web';
/** An existing record id, or a key naming a collection created by the same proposal. */
export type ProposalRef = { id: string } | { ref: string };
export interface ProposalCollectionInput { ref: string; name: string; description?: string; languagePair?: LanguagePair }
export interface ProposalEntryInput {
  action: 'create' | 'update' | 'disable' | 'enable';
  /** update/disable/enable: the entry and the revision the proposal was based on. */
  entryId?: string; revision?: number;
  /** create: destination collection. */
  collection?: ProposalRef;
  kind?: Entry['kind'];
  source?: string; target?: string; aliases?: string[]; note?: string;
  strength?: 'preferred' | 'required' | 'keep_source';
  text?: string; required?: boolean;
  basis?: ProposalBasis;
  /** A short quote supporting the entry: the user's words, a subtitle line, a page summary. */
  evidence?: string;
  /** web basis: where it was read. */
  url?: string; urlTitle?: string; accessedAt?: string;
}
export interface ProposalInput {
  /** Default direction for new collections. */
  languagePair?: LanguagePair;
  collections?: ProposalCollectionInput[];
  entries?: ProposalEntryInput[];
}

export type ProposalItemStatus = 'new' | 'update' | 'disable' | 'enable' | 'exists' | 'invalid';
export interface ProposalWarning { code: 'term_conflict'; collectionName?: string; target?: string }
export interface ProposalItem {
  key: string;
  group: 'collections' | 'entries';
  status: ProposalItemStatus;
  reason?: string;
  kind?: Entry['kind'];
  /** term: source and target; rule/context: text; collection: name. */
  label: string;
  source?: string; target?: string;
  collectionName?: string;
  note?: string;
  basis?: ProposalBasis;
  /** Inferred by the assistant or read on a web page rather than stated by the user. */
  aiSourced: boolean;
  /** web basis: the site it was read on, such as "zh.wikipedia.org". */
  sourceSite?: string;
  warnings: ProposalWarning[];
}
export interface ProposalCounts { collections: number; created: number; updated: number; disabled: number; enabled: number; existing: number }
export interface KnowledgeProposal {
  items: ProposalItem[];
  saveable: boolean;
  nothingToSave: boolean;
  counts: ProposalCounts;
  /** Collections the saved entries go to, the first one being where to look afterwards. */
  collectionIds: string[];
  /** Ids assigned to new records; pass back to rebuild the same proposal against a newer library. */
  ids: Record<string, string>;
  request(generation?: number): SaveRecordsRequest;
}
export interface ProposalOptions {
  ids?: Record<string, string>;
  newId?: () => string;
}

export const PROPOSAL_LIMITS = Object.freeze({ collections: 5, entries: 50, evidence: 300 });
const AI_BASES: readonly ProposalBasis[] = ['agent_inferred', 'web'];
const ORIGIN_KIND: Record<ProposalBasis, Origin['kind']> = { user_stated: 'manual', user_revision: 'revision', document: 'import', agent_inferred: 'agent', web: 'web' };
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

export function buildKnowledgeProposal(input: ProposalInput, snapshot: Pick<LibrarySnapshot, 'generation' | 'data'>, options: ProposalOptions = {}): KnowledgeProposal {
  const ids: Record<string, string> = { ...options.ids };
  const newId = options.newId ?? (() => crypto.randomUUID());
  const idFor = (key: string) => (ids[key] ??= newId());
  const data = snapshot.data;
  const items: ProposalItem[] = [];
  const collectionsByRef = new Map<string, Collection>();
  const newCollections: Collection[] = [];
  const entryRecords = new Map<string, Entry>();
  const defaultPair = normalizePair(input.languagePair);
  const resolveCollection = (ref: ProposalRef): Collection | undefined => 'id' in ref
    ? data.collections.find(item => item.id === ref.id) : collectionsByRef.get(ref.ref);

  for (const collection of input.collections ?? []) {
    const key = `collection:${collection.ref}`;
    const name = clean(collection.name);
    const item: ProposalItem = { key, group: 'collections', status: 'new', label: name, aiSourced: false, warnings: [] };
    items.push(item);
    if (!name) { item.status = 'invalid'; item.reason = 'missing_name'; continue; }
    if (collectionsByRef.has(collection.ref)) { item.status = 'invalid'; item.reason = 'duplicate_ref'; continue; }
    const explicit = normalizePair(collection.languagePair);
    if (collection.languagePair && explicit === null) { item.status = 'invalid'; item.reason = 'invalid_language'; continue; }
    const pair = explicit ?? defaultPair ?? undefined;
    // Saved by an earlier attempt of this same proposal, or a live collection of the same name and direction.
    const saved = ids[key] && data.collections.find(existing => existing.id === ids[key]);
    const same = saved || data.collections.find(existing => !existing.archived && sameText(existing.name, name) && (!pair || samePair(existing.languagePair, pair)));
    if (same) { item.status = 'exists'; collectionsByRef.set(collection.ref, same); continue; }
    if (!pair) { item.status = 'invalid'; item.reason = defaultPair === null ? 'invalid_language' : 'missing_language'; continue; }
    const record: Collection = { id: idFor(key), revision: 1, name, description: clean(collection.description), languagePair: pair, archived: false };
    collectionsByRef.set(collection.ref, record); newCollections.push(record);
  }

  const originFor = (entry: ProposalEntryInput, basis: ProposalBasis): Origin => {
    const note = clean(entry.evidence).slice(0, PROPOSAL_LIMITS.evidence);
    const url = basis === 'web' ? clean(entry.url) : '';
    const title = basis === 'web' ? clean(entry.urlTitle) : '';
    return { kind: ORIGIN_KIND[basis], ...(note ? { note } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}), ...(basis === 'web' && entry.accessedAt ? { at: entry.accessedAt } : {}) };
  };
  const collectionName = (id: string) => newCollections.find(item => item.id === id)?.name ?? data.collections.find(item => item.id === id)?.name;

  (input.entries ?? []).forEach((proposed, index) => {
    const key = `entry:${index}`;
    const basis = proposed.basis ?? 'agent_inferred';
    const status: ProposalItemStatus = proposed.action === 'create' ? 'new' : proposed.action;
    const item: ProposalItem = { key, group: 'entries', status, label: '', basis, aiSourced: AI_BASES.includes(basis), warnings: [] };
    items.push(item);
    const invalid = (reason: string) => { item.status = 'invalid'; item.reason = reason; };
    if (basis === 'web' && (proposed.action === 'create' || proposed.action === 'update')) {
      const site = webSite(proposed.url);
      if (!site) return invalid('missing_url');
      item.sourceSite = site;
      // A web origin records when the page was read; a link only seen in search results is not a source.
      if (!utcTime(proposed.accessedAt)) return invalid('page_not_read');
    }
    let entry: Entry;
    if (proposed.action === 'create') {
      const saved = ids[key] && data.entries.find(existing => existing.id === ids[key]);
      if (saved) { item.status = 'exists'; item.kind = saved.kind; item.label = entrySummary(saved); item.collectionName = collectionName(saved.collectionId); return; }
      if (!proposed.collection) return invalid('missing_collection');
      const collection = resolveCollection(proposed.collection);
      if (!collection) return invalid('unknown_collection');
      if (collection.archived) return invalid('archived_collection');
      item.collectionName = collection.name;
      const base = { id: idFor(key), revision: 1, collectionId: collection.id, enabled: true, origin: originFor(proposed, basis) };
      const kind = proposed.kind ?? 'term';
      if (kind === 'term') {
        const source = clean(proposed.source), target = clean(proposed.target);
        if (!source) return invalid('missing_source');
        if (!target && proposed.strength !== 'keep_source') return invalid('missing_target');
        entry = { ...base, kind, payload: { source, target: proposed.strength === 'keep_source' ? source : target,
          aliases: cleanList(proposed.aliases).filter(alias => !sameText(alias, source)), note: clean(proposed.note),
          strength: proposed.strength ?? 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } } };
      } else {
        const text = clean(proposed.text);
        if (!text) return invalid('missing_text');
        entry = { ...base, kind, payload: { text, required: proposed.required ?? false } };
      }
    } else {
      const current = data.entries.find(candidate => candidate.id === proposed.entryId);
      if (!current) return invalid('unknown_entry');
      item.kind = current.kind;
      item.collectionName = collectionName(current.collectionId);
      item.label = entrySummary(current);
      if (proposed.revision !== current.revision) return invalid('stale_revision');
      if (proposed.action === 'disable' || proposed.action === 'enable') {
        const enabled = proposed.action === 'enable';
        if (current.enabled === enabled) { item.status = 'exists'; return; }
        entryRecords.set(key, { ...structuredClone(current), enabled });
        return;
      }
      if (proposed.kind && proposed.kind !== current.kind) return invalid('kind_mismatch');
      const next = structuredClone(current);
      if (next.kind === 'term') {
        const source = proposed.source !== undefined ? clean(proposed.source) : next.payload.source;
        const target = proposed.target !== undefined ? clean(proposed.target) : next.payload.target;
        if (!source) return invalid('missing_source');
        if (!target) return invalid('missing_target');
        const strength = proposed.strength ?? next.payload.strength;
        next.payload = { ...next.payload, source, target: strength === 'keep_source' ? source : target, strength,
          ...(proposed.aliases ? { aliases: cleanList(proposed.aliases).filter(alias => !sameText(alias, source)) } : {}),
          ...(proposed.note !== undefined ? { note: clean(proposed.note) } : {}) };
      } else {
        const text = proposed.text !== undefined ? clean(proposed.text) : next.payload.text;
        if (!text) return invalid('missing_text');
        next.payload = { text, required: proposed.required ?? next.payload.required };
      }
      if (JSON.stringify(next.payload) === JSON.stringify(current.payload)) { item.status = 'exists'; return; }
      next.origin = originFor(proposed, basis);
      entry = next;
    }
    item.kind = entry.kind;
    item.label = entrySummary(entry);
    if (entry.kind === 'term') { item.source = entry.payload.source; item.target = entry.payload.target; item.note = entry.payload.note || undefined; }
    entryRecords.set(key, entry);
  });

  // Already in the collection (or earlier in this proposal): skip rather than save a duplicate.
  const seen: Entry[] = [];
  for (const item of items) {
    const entry = entryRecords.get(item.key);
    if (!entry || item.status !== 'new') continue;
    const duplicate = (other: Entry) => other.id !== entry.id && other.collectionId === entry.collectionId && other.kind === entry.kind
      && (entry.kind === 'term' && other.kind === 'term'
        ? sameText(other.payload.source, entry.payload.source) && sameText(other.payload.target, entry.payload.target)
        : sameText(entrySummary(other), entrySummary(entry)));
    if (data.entries.some(duplicate) || seen.some(duplicate)) { item.status = 'exists'; entryRecords.delete(item.key); continue; }
    seen.push(entry);
  }

  // A different target for the same source elsewhere is shown so the user can decide before saving.
  const proposedEntries = [...entryRecords.values()];
  const pairOf = (entry: Entry) => [...newCollections, ...data.collections].find(collection => collection.id === entry.collectionId)?.languagePair;
  for (const item of items) {
    const entry = entryRecords.get(item.key);
    if (!entry || entry.kind !== 'term' || item.status === 'disable') continue;
    const pair = pairOf(entry);
    const keys = [entry.payload.source, ...entry.payload.aliases].map(fold);
    const others = [...data.entries.filter(other => !proposedEntries.some(proposedEntry => proposedEntry.id === other.id)), ...proposedEntries];
    for (const other of others) {
      if (other.id === entry.id || other.kind !== 'term' || !other.enabled) continue;
      const otherPair = pairOf(other);
      if (!pair || !otherPair || !samePair(pair, otherPair) || fold(other.payload.target) === fold(entry.payload.target)) continue;
      if (![other.payload.source, ...other.payload.aliases].some(source => keys.includes(fold(source)))) continue;
      if (item.warnings.some(warning => warning.target === other.payload.target)) continue;
      item.warnings.push({ code: 'term_conflict', collectionName: collectionName(other.collectionId), target: other.payload.target });
    }
  }

  // New collections are only saved when something uses them or they were asked for on their own.
  const usedCollections = new Set(proposedEntries.map(entry => entry.collectionId));
  const savedCollections = newCollections.filter(collection => usedCollections.has(collection.id) || !(input.entries ?? []).length);
  for (const item of items) if (item.group === 'collections' && item.status === 'new' && !savedCollections.some(collection => collection.id === ids[item.key])) item.status = 'exists';

  const buildRequest = (generation = snapshot.generation): SaveRecordsRequest => ({ generation, items: [
    ...savedCollections.map(record => ({ group: 'collections' as const, record })),
    ...items.flatMap(item => { const record = entryRecords.get(item.key); return record ? [{ group: 'entries' as const, record }] : []; }),
  ] });

  // Validate the result as the service will, and attribute any error to the item that caused it.
  if (!items.some(item => item.status === 'invalid')) {
    const request = buildRequest();
    if (request.items.length) {
      const merged = structuredClone(data) as KnowledgePackage;
      for (const { group, record } of request.items) {
        const list = merged[group] as { id: string }[];
        const at = list.findIndex(existing => existing.id === record.id);
        if (at >= 0) list[at] = record; else list.push(record);
      }
      for (const error of validatePackage(merged).errors) {
        const match = /^\/(collections|entries)\/(\d+)/.exec(error.path);
        const record = match ? (merged[match[1] as 'entries'] as { id: string }[])[Number(match[2])] : undefined;
        const owner = record && items.find(item => ids[item.key] === record.id || entryRecords.get(item.key)?.id === record.id);
        const target = owner ?? items.find(item => item.status !== 'exists') ?? items[0];
        if (target && target.status !== 'invalid') { target.status = 'invalid'; target.reason = `validation_${error.code}`; }
      }
    }
  }

  const pending = items.filter(item => ['new', 'update', 'disable', 'enable'].includes(item.status));
  const counts: ProposalCounts = {
    collections: items.filter(item => item.group === 'collections' && item.status === 'new').length,
    created: items.filter(item => item.group === 'entries' && item.status === 'new').length,
    updated: items.filter(item => item.status === 'update').length,
    disabled: items.filter(item => item.status === 'disable').length,
    enabled: items.filter(item => item.status === 'enable').length,
    existing: items.filter(item => item.status === 'exists').length,
  };
  const collectionIds = [...new Set([...proposedEntries.map(entry => entry.collectionId), ...savedCollections.map(collection => collection.id)])];
  const invalid = items.some(item => item.status === 'invalid');
  return { items, counts, ids, collectionIds, nothingToSave: !invalid && !pending.length, saveable: !invalid && pending.length > 0, request: buildRequest };
}
