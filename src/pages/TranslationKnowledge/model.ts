import type { Collection, Entry, LanguagePair, NoteEntry, TermEntry } from "@/translation-knowledge/schemas";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";

/** Rows per page in the term table and each notes section. */
export const PAGE_SIZE = 100;
/** Results the global search lists before asking for a narrower query. */
export const SEARCH_LIMIT = 50;
export type NoteKind = NoteEntry["kind"];
export type ContentView = "terms" | "notes";

export function freshId() {
  return crypto.randomUUID();
}
export function splitLines(value: string) {
  return [...new Set(value.split("\n").map(item => item.trim()).filter(Boolean))];
}
const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

export function newCollection(name: string, languagePair: LanguagePair, description = ""): Collection {
  return { id: freshId(), revision: 1, name: name.trim(), description: description.trim(), languagePair, archived: false };
}
export function newTerm(collectionId: string, source: string, target: string, strength: TermEntry["payload"]["strength"] = "preferred"): TermEntry {
  return { id: freshId(), revision: 1, kind: "term", collectionId, enabled: true, origin: { kind: "manual" },
    payload: { source: source.trim(), target: strength === "keep_source" ? source.trim() : target.trim(), aliases: [], note: "", strength,
      match: { mode: "literal_phrase", caseSensitive: false } } };
}
export function newNote(collectionId: string, kind: NoteKind, text: string, required: boolean): NoteEntry {
  return { id: freshId(), revision: 1, kind, collectionId, enabled: true, origin: { kind: "manual" }, payload: { text: text.trim(), required } };
}

/** Everything a person reads in an entry, for searching. */
export function entryText(entry: Entry) {
  return entry.kind === "term"
    ? [entry.payload.source, entry.payload.target, ...entry.payload.aliases, entry.payload.note].join("\n")
    : entry.payload.text;
}
/** Every word of the query must appear; words are separated by spaces. */
export function matchesQuery(text: string, query: string) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold(text);
  return words.every(word => haystack.includes(word));
}

export function termsOf(snapshot: LibrarySnapshot, collectionId: string, query = ""): TermEntry[] {
  return snapshot.data.entries.filter((entry): entry is TermEntry => entry.kind === "term" && entry.collectionId === collectionId && matchesQuery(entryText(entry), query));
}
export function notesOf(snapshot: LibrarySnapshot, collectionId: string, kind: NoteKind, query = ""): NoteEntry[] {
  return snapshot.data.entries.filter((entry): entry is NoteEntry => entry.kind === kind && entry.collectionId === collectionId && matchesQuery(entryText(entry), query));
}
export function entryCounts(snapshot: LibrarySnapshot) {
  const counts = new Map<string, { terms: number; notes: number }>();
  for (const entry of snapshot.data.entries) {
    const count = counts.get(entry.collectionId) ?? { terms: 0, notes: 0 };
    if (entry.kind === "term") count.terms++; else count.notes++;
    counts.set(entry.collectionId, count);
  }
  return counts;
}

export interface SearchGroup { collection: Collection; entries: Entry[] }
/** Matches across every collection, grouped by collection in sidebar order. */
export function searchLibrary(snapshot: LibrarySnapshot, query: string, limit = SEARCH_LIMIT): { groups: SearchGroup[]; total: number } {
  if (!query.trim()) return { groups: [], total: 0 };
  const matches = snapshot.data.entries.filter(entry => matchesQuery(entryText(entry), query));
  const groups: SearchGroup[] = [];
  let shown = 0;
  for (const collection of orderedCollections(snapshot)) {
    if (shown >= limit) break;
    const entries = matches.filter(entry => entry.collectionId === collection.id).slice(0, limit - shown);
    if (entries.length) { groups.push({ collection, entries }); shown += entries.length; }
  }
  return { groups, total: matches.length };
}
/** Live collections first, then archived ones, each by name. */
export function orderedCollections(snapshot: LibrarySnapshot) {
  const byName = (a: Collection, b: Collection) => a.name.localeCompare(b.name);
  return [...snapshot.data.collections.filter(item => !item.archived).sort(byName), ...snapshot.data.collections.filter(item => item.archived).sort(byName)];
}
/** The collection to show first: the requested one if it exists, else the first live one. */
export function defaultCollectionId(snapshot: LibrarySnapshot, requested?: string) {
  if (requested && snapshot.data.collections.some(item => item.id === requested)) return requested;
  return orderedCollections(snapshot).find(item => !item.archived)?.id ?? orderedCollections(snapshot)[0]?.id;
}
export function presetsUsing(snapshot: LibrarySnapshot, collectionId: string) {
  return snapshot.data.presets.filter(preset => preset.collectionIds.includes(collectionId));
}
const samePair = (a: LanguagePair, b: LanguagePair) => a.source === b.source && a.target === b.target;
/** Where entries may move: live collections translating the same direction. */
export function moveTargets(snapshot: LibrarySnapshot, from: Collection) {
  return orderedCollections(snapshot).filter(item => item.id !== from.id && !item.archived && samePair(item.languagePair, from.languagePair));
}

/** Same source in this collection: the same wording already saved, or another translation of it. */
export function termClash(snapshot: LibrarySnapshot, collectionId: string, source: string, target: string, exceptId?: string): "same" | "different" | null {
  const key = fold(source.trim());
  let found: "same" | "different" | null = null;
  for (const entry of snapshot.data.entries) {
    if (entry.kind !== "term" || entry.collectionId !== collectionId || entry.id === exceptId) continue;
    if (![entry.payload.source, ...entry.payload.aliases].some(value => fold(value.trim()) === key)) continue;
    if (fold(entry.payload.target.trim()) === fold(target.trim())) return "same";
    found = "different";
  }
  return found;
}

const LAST_PAIR_KEY = "translation-knowledge-last-pair";
export function rememberLanguagePair(pair: LanguagePair) {
  try { localStorage.setItem(LAST_PAIR_KEY, JSON.stringify(pair)); } catch { /* A convenience only. */ }
}
export function lastLanguagePair(fallbackTarget: string): LanguagePair {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_PAIR_KEY) ?? "null");
    if (value && typeof value.source === "string" && typeof value.target === "string") return { source: value.source, target: value.target };
  } catch { /* Falls back below. */ }
  return { source: "ja", target: fallbackTarget };
}

export function acceptsKnowledgeDrop(files: readonly { name: string }[]) {
  return files.length === 1 && files[0].name.toLowerCase().endsWith(".fktk.json");
}
