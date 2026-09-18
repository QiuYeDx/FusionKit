import type {
  Collection,
  Entry,
  KnowledgePackage,
  Subject,
  Source,
} from "@/translation-knowledge/schemas";
import type {
  ImportDecision,
  ImportItem,
  LibrarySnapshot,
  SaveRecordRequest,
} from "@/translation-knowledge/ipc-contract";
import type { MaintenanceCommit, MaintenancePreview } from "@/translation-knowledge/maintenance-contract";

export const PAGE_SIZE = 30;
export function maintenanceCommitFor(preview: Pick<MaintenancePreview, "planId" | "action" | "history">, confirmed: boolean): MaintenanceCommit {
  return preview.action === "purge" && preview.history.scope === "all"
    ? { planId: preview.planId, confirmHistoryRemoval: confirmed }
    : { planId: preview.planId };
}
export type EntryStatus = Entry["state"] | "unconfirmed";
export type LibraryQuery = {
  subject: string;
  collection: string;
  search: string;
  kind: string;
  language: string;
  status: string;
};
export const initialQuery: LibraryQuery = {
  subject: "all",
  collection: "all",
  search: "",
  kind: "all",
  language: "all",
  status: "all",
};
export function entryStatus(
  entry: Entry,
  snapshot: LibrarySnapshot,
): EntryStatus {
  if (
    entry.state === "ready" &&
    snapshot.approvals[entry.id]?.revision !== entry.revision
  )
    return "unconfirmed";
  return entry.state;
}
export function needsReview(entry: Entry, snapshot: LibrarySnapshot) {
  return ["candidate", "needs_review", "unconfirmed"].includes(
    entryStatus(entry, snapshot),
  );
}
export function filterEntries(
  snapshot: LibrarySnapshot,
  query: LibraryQuery,
  reviewOnly: boolean,
) {
  const queryText = query.search.trim().normalize("NFC").toLocaleLowerCase();
  const collections = new Map(
    snapshot.data.collections.map((item) => [item.id, item]),
  );
  return snapshot.data.entries.filter((entry) => {
    const collection = collections.get(entry.collectionId);
    const subjects = new Set([
      ...entry.aboutSubjectIds,
      ...(collection?.aboutSubjectIds ?? []),
    ]);
    if (
      query.subject === "none"
        ? subjects.size > 0
        : query.subject !== "all" && !subjects.has(query.subject)
    )
      return false;
    if (query.collection !== "all" && entry.collectionId !== query.collection)
      return false;
    if (query.kind !== "all" && entry.kind !== query.kind) return false;
    if (
      query.language !== "all" &&
      languageKey(entry.scope.languagePair) !== query.language
    )
      return false;
    if (query.status !== "all" && entryStatus(entry, snapshot) !== query.status)
      return false;
    if (reviewOnly && !needsReview(entry, snapshot)) return false;
    const text = `${entry.title} ${Object.values(entry.payload)
      .filter((value) => typeof value === "string")
      .join(" ")} ${entry.id}`;
    return (
      !queryText ||
      text.normalize("NFC").toLocaleLowerCase().includes(queryText)
    );
  });
}
export function languageKey(pair: { source: string; target: string }) {
  return `${pair.source} → ${pair.target}`;
}
export function defaultImportDecisions(items: ImportItem[]): ImportDecision[] {
  return items.map((item) => ({
    id: item.id,
    action: item.status === "new" ? "replace" : "keep",
  }));
}
export function importActions(item: ImportItem): ImportDecision["action"][] {
  if (item.status === "conflict")
    return item.sameRevision
      ? ["keep", "copy", "skip"]
      : ["keep", "replace", "copy", "skip"];
  return item.status === "new" ? ["replace", "skip"] : ["keep", "skip"];
}
export function splitLines(value: string) {
  return [
    ...new Set(
      value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
export function freshId() {
  return crypto.randomUUID();
}
export function titleOf(
  record:
    | KnowledgePackage["entries"][number]
    | KnowledgePackage["subjects"][number]
    | KnowledgePackage["collections"][number]
    | KnowledgePackage["sources"][number],
) {
  return "title" in record ? record.title : record.name;
}
/** Flatten structured records for a field-by-field import comparison without rendering raw JSON. */
export function recordFields(
  value: unknown,
  prefix = "",
): Record<string, string> {
  if (value === null || typeof value !== "object")
    return { [prefix]: String(value ?? "") };
  if (Array.isArray(value))
    return value.length
      ? Object.assign(
          {},
          ...value.map((item, index) =>
            recordFields(item, `${prefix}.${index + 1}`),
          ),
        )
      : { [prefix]: "—" };
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, item]) =>
      recordFields(item, prefix ? `${prefix}.${key}` : key),
    ),
  );
}

export function newEntry(
  collection: Collection,
  subjectId?: string,
  _availableSubjects: Subject[] = [],
): Entry {
  const subjects = subjectId ? [subjectId] : collection.aboutSubjectIds;
  return {
    id: freshId(),
    revision: 1,
    title: "",
    kind: "term",
    collectionId: collection.id,
    aboutSubjectIds: subjects,
    scope: {
      languagePair: collection.defaultLanguagePair ?? {
        source: "ja",
        target: "zh-Hans",
      },
      requiredSubjects: [],
      condition: { mode: "none" },
    },
    state: "candidate",
    evidence: [],
    derivedFrom: [],
    payload: {
      source: "",
      target: "",
      aliases: [],
      sense: "",
      match: { mode: "literal_phrase", caseSensitive: true },
      strength: "preferred",
    },
  };
}

/** Sources remain referenced by either direct evidence or historical derivation excerpts. */
export function isSourceUnreferenced(sourceId: string, data: KnowledgePackage) {
  return !data.entries.some(
    (entry) =>
      entry.evidence.some((evidence) => evidence.sourceId === sourceId) ||
      entry.derivedFrom.some((parent) => parent.evidenceSourceId === sourceId),
  );
}
export function acceptsKnowledgeDrop(files: readonly { name: string }[]) {
  return (
    files.length === 1 && files[0].name.toLowerCase().endsWith(".fktk.json")
  );
}
export function exportPreviewCurrent(
  preview: { generation: number } | null,
  generation: number,
) {
  return !!preview && preview.generation === generation;
}

/** A human action approves exactly this revision; it never changes task selection. */
export function manualEntryRequest(entry: Entry, snapshot: LibrarySnapshot, apply: boolean, sourceTitle: string, sourceNote = ""): SaveRecordRequest {
  const existing = snapshot.data.entries.some(item => item.id === entry.id);
  const summary = entry.kind === "term" || entry.kind === "memory"
    ? `${entry.payload.source} → ${entry.payload.target}`
    : entry.kind === "expression" ? entry.payload.interpretation : entry.payload.text;
  const source: Source | undefined = !existing || sourceNote.trim()
    ? { id: freshId(), revision: 1, kind: "user_note", title: sourceTitle, excerpt: sourceNote.trim() || summary }
    : undefined;
  const archived = existing && entry.state === "archived";
  return {
    generation: snapshot.generation,
    group: "entries",
    record: {
      ...entry,
      title: entry.title.trim() || (entry.kind === "term" || entry.kind === "memory" ? entry.payload.source : summary).trim().slice(0, 120),
      state: archived ? "archived" : apply ? "ready" : "candidate",
      evidence: source ? [...entry.evidence, { sourceId: source.id, support: "direct" }] : entry.evidence,
    },
    ...(source ? { source } : {}),
    adopt: !archived && apply,
  };
}

export function withEntryKind(entry: Entry, kind: "term" | "context" | "rule"): Entry {
  if (kind === "term") return entry;
  if (kind === "context") return { ...entry, kind, payload: { text: "", assertion: "fact", core: false } };
  return { ...entry, kind, payload: { dimension: "other", text: "", strength: "preferred" } };
}
