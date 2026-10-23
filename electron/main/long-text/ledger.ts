import { randomUUID } from 'node:crypto';
import { LONG_TEXT_LIMITS, type LedgerEntry, type LongTextRequest } from '../../../src/long-text/contract';
import type { TermPair } from '../../../src/long-text/protocol';
import { ledgerHits, termOccurs } from '../../../src/long-text/quality';
import { LongTextOperationError } from './repository';

/**
 * The document's glossary (design §6.9.4): what each batch is told (`termLedger`), the names the model
 * reports (first come, first served), and the user's edits. Entries live in the loaded document's
 * `ledger` array; model additions are saved within a second, user edits at once.
 */

/** What `LoadedDocument` offers for its ledger. */
export interface LedgerStore {
  ledger: LedgerEntry[];
  saveLedger(): Promise<void>;
}

export type LedgerUpsert = LongTextRequest<'updateLedger'>['upserts'][number];

const MODEL_SAVE_DELAY_MS = 1_000;

/** Two terms are the same entry when equal after NFKC, trimming and lower-casing. */
export const ledgerKey = (term: string) => term.normalize('NFKC').trim().toLowerCase();

export class DocumentLedger {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly store: LedgerStore, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get entries(): readonly LedgerEntry[] {
    return this.store.ledger;
  }

  get full(): boolean {
    return this.store.ledger.length >= LONG_TEXT_LIMITS.ledgerEntries;
  }

  /**
   * The `termLedger` of a batch: entries whose source occurs in at least one of `sources`, confirmed
   * ones first, then by how many sources contain them, at most 60. Entries equal to a term of the
   * batch's materials (`excluded`, as `ledgerKey`s) are left to the materials.
   */
  select(sources: readonly string[], excluded: ReadonlySet<string>): TermPair[] {
    const entries = this.store.ledger.filter(entry => !excluded.has(ledgerKey(entry.source)));
    if (!entries.length) return [];
    const bySource = new Map<string, number>();
    entries.forEach((entry, position) => { if (!bySource.has(entry.source)) bySource.set(entry.source, position); });
    const all = entries.map(entry => ({ source: entry.source, target: entry.target, confirmed: true }));
    const hits = new Array<number>(entries.length).fill(0);
    for (const source of sources) {
      for (const hit of ledgerHits(all, source)) hits[bySource.get(hit.source)!]++;
    }
    return entries
      .map((entry, position) => ({ entry, position, hits: hits[position] }))
      .filter(candidate => candidate.hits > 0)
      .sort((a, b) => Number(b.entry.confirmed) - Number(a.entry.confirmed) || b.hits - a.hits || a.position - b.position)
      .slice(0, LONG_TEXT_LIMITS.ledgerPerBatch)
      .map(({ entry }) => ({ source: entry.source, target: entry.target }));
  }

  /** Confirmed entries found in one segment's source: what `term_missing` checks. */
  confirmedHits(source: string): TermPair[] {
    return ledgerHits(this.store.ledger, source);
  }

  /**
   * Takes the terms the model reported for a batch when the source occurs in one of the batch's
   * sources and the target in one of its translations, and no entry has that source yet. `firstSeen`
   * is the first segment whose source contains it. Stops at 2,000 entries. Returns the new entries.
   */
  adopt(terms: readonly TermPair[], batch: { sources: ReadonlyArray<{ index: number; text: string }>; translations: readonly string[] }): LedgerEntry[] {
    const known = new Set(this.store.ledger.map(entry => ledgerKey(entry.source)));
    const added: LedgerEntry[] = [];
    const sources = [...batch.sources].sort((a, b) => a.index - b.index);
    for (const term of terms) {
      if (this.full) break;
      const source = term.source.trim();
      const target = term.target.trim();
      const key = ledgerKey(source);
      if (!source || !target || source.length > LONG_TEXT_LIMITS.termChars || target.length > LONG_TEXT_LIMITS.termChars || known.has(key)) continue;
      const first = sources.find(item => termOccurs(item.text, source));
      if (!first || !batch.translations.some(text => termOccurs(text, target))) continue;
      const entry: LedgerEntry = { id: randomUUID(), source, target, origin: 'model', confirmed: false, firstSeen: first.index, updatedAt: this.now() };
      known.add(key);
      this.store.ledger.push(entry);
      added.push(entry);
    }
    if (added.length) this.scheduleSave();
    return added;
  }

  /**
   * The user's edits (`updateLedger`): deletes first, then upserts by id, or by source when no id is
   * given; edited and new entries become `origin: 'user'`. Saved at once.
   */
  async update(upserts: readonly LedgerUpsert[], deletes: readonly string[]): Promise<LedgerEntry[]> {
    const removed = new Set(deletes);
    const next = this.store.ledger.filter(entry => !removed.has(entry.id)).map(entry => ({ ...entry }));
    const at = this.now();
    for (const upsert of upserts) {
      const existing = upsert.id !== undefined
        ? next.find(entry => entry.id === upsert.id)
        : next.find(entry => ledgerKey(entry.source) === ledgerKey(upsert.source));
      if (upsert.id !== undefined && !existing) throw new LongTextOperationError('not_found');
      if (existing) {
        // Confirming a model's entry keeps it the model's; changing either side makes it the user's.
        const origin = existing.source === upsert.source && existing.target === upsert.target ? existing.origin : 'user';
        Object.assign(existing, { source: upsert.source, target: upsert.target, confirmed: upsert.confirmed, origin, updatedAt: at });
      } else next.push({ id: randomUUID(), source: upsert.source, target: upsert.target, origin: 'user', confirmed: upsert.confirmed, firstSeen: null, updatedAt: at });
    }
    if (next.length > LONG_TEXT_LIMITS.ledgerEntries) throw new LongTextOperationError('limit_exceeded');
    this.store.ledger.splice(0, this.store.ledger.length, ...next);
    this.cancelSave();
    await this.store.saveLedger();
    return this.store.ledger.map(entry => ({ ...entry }));
  }

  /** Writes a pending model addition now; an unchanged glossary is not written again. */
  async flush(): Promise<void> {
    if (!this.saveTimer) return;
    this.cancelSave();
    await this.store.saveLedger();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.store.saveLedger().catch(error => console.warn('[long-text] Could not save the glossary', error));
    }, MODEL_SAVE_DELAY_MS);
  }

  private cancelSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
}
