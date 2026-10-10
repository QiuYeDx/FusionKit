import { tool } from "ai";
import { z } from "zod";
import i18n from "@/i18n";
import { entrySummary, type LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { Collection, Entry, Subject } from "@/translation-knowledge/schemas";
import { buildKnowledgeProposal, PROPOSAL_LIMITS, type ProposalBasis, type ProposalInput, type ProposalItem } from "@/translation-knowledge/proposal";
import { announceKnowledgeChange } from "@/translation-knowledge/library-events";
import { exposePrepared, failed, id, page, run, safeText, succeeded, ToolFailure } from "./modern-tools";
import { registerPreparedAction, usePreparedActionsStore, type PreparedActionResult } from "./prepared-actions";
import { readWebPage } from "./web-tools";

function knowledgeApi() {
  if (typeof window === "undefined" || !window.translationKnowledge) throw new ToolFailure("translation_knowledge_unavailable");
  return window.translationKnowledge;
}
async function readLibrary(): Promise<LibrarySnapshot> {
  const response = await knowledgeApi().read();
  if (!response.ok) throw new ToolFailure(response.error);
  return response.value;
}
const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
const pairText = (pair: { source: string; target: string } | undefined) => pair ? { source: safeText(pair.source, 32), target: safeText(pair.target, 32) } : undefined;
const trusted = (library: LibrarySnapshot, entry: Entry) => entry.state === "ready" && library.approvals[entry.id]?.revision === entry.revision;
const reviewState = (library: LibrarySnapshot, entry: Entry) => entry.state === "ready" && !trusted(library, entry) ? "unconfirmed" : entry.state;
const subjectWords = (subject: Subject | undefined) => subject ? [subject.name, ...(subject.aliases ?? []), ...(subject.tags ?? [])] : [];
function paginate(offset: number, limit: number, total: number) {
  return { total, hasMore: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null };
}

export const knowledgeSearchSchema = z.object({ ...page, query: z.string().max(200).default(""),
  collectionId: id.optional(), subjectId: id.optional(),
  kind: z.enum(["all", "term", "context", "expression", "memory", "rule"]).default("all"),
  languagePair: z.object({ source: z.string().max(35).optional(), target: z.string().max(35).optional() }).strict().optional(),
  state: z.enum(["all", "usable", "review"]).default("all"),
  includeArchived: z.boolean().default(false) }).strict();
export const knowledgeCatalogSchema = z.object({ ...page, includeArchived: z.boolean().default(false) }).strict();

const ref = z.union([z.object({ id }).strict(), z.object({ ref: z.string().trim().min(1).max(40) }).strict()]);
const languagePair = z.object({ source: z.string().trim().min(2).max(35), target: z.string().trim().min(2).max(35) }).strict();
const shortText = (length: number) => z.string().max(length);
export const prepareKnowledgeChangesSchema = z.object({
  languagePair: languagePair.optional(),
  subjects: z.array(z.object({ ref: z.string().trim().min(1).max(40), name: shortText(200), kind: z.enum(["work", "person", "domain", "other"]),
    aliases: z.array(shortText(200)).max(10).optional(), description: shortText(1000).optional() }).strict()).max(PROPOSAL_LIMITS.subjects).optional(),
  collections: z.array(z.object({ ref: z.string().trim().min(1).max(40), name: shortText(200), description: shortText(1000).optional(),
    subjects: z.array(ref).max(5).optional(), languagePair: languagePair.optional() }).strict()).max(PROPOSAL_LIMITS.collections).optional(),
  entries: z.array(z.object({
    action: z.enum(["create", "update", "archive"]), entryId: id.optional(), revision: z.number().int().positive().safe().optional(),
    collection: ref.optional(), kind: z.enum(["term", "rule", "context"]).optional(),
    source: shortText(500).optional(), target: shortText(500).optional(), aliases: z.array(shortText(200)).max(10).optional(), note: shortText(500).optional(),
    strength: z.enum(["preferred", "required", "keep_source"]).optional(),
    text: shortText(2000).optional(), dimension: z.enum(["register", "honorifics", "person_reference", "fidelity", "other"]).optional(), core: z.boolean().optional(),
    basis: z.enum(["user_stated", "user_revision", "document", "agent_inferred", "web"]),
    evidence: shortText(600).optional(), url: shortText(2000).optional(), urlTitle: shortText(300).optional(), subjects: z.array(ref).max(5).optional(), languagePair: languagePair.optional(),
  }).strict()).max(PROPOSAL_LIMITS.entries).optional(),
}).strict().refine(value => (value.subjects?.length ?? 0) + (value.collections?.length ?? 0) + (value.entries?.length ?? 0) > 0);

/** Evidence source titles in the interface language; they are stored with the entry. */
function sourceTitles(): Record<ProposalBasis, string> {
  return { user_stated: i18n.t("home:knowledge_source_user_stated"), user_revision: i18n.t("home:knowledge_source_user_revision"),
    document: i18n.t("home:knowledge_source_document"), agent_inferred: i18n.t("home:knowledge_source_agent_inferred"), web: i18n.t("home:knowledge_source_web") };
}
/** A web-sourced entry keeps the title of the page it was read on and when, as web_read saw them. */
function withWebPages<T extends ProposalInput>(input: T): T {
  if (!input.entries?.some(entry => entry.basis === "web")) return input;
  return { ...input, entries: input.entries.map(entry => {
    if (entry.basis !== "web") return entry;
    const page = readWebPage(entry.url);
    return page ? { ...entry, urlTitle: entry.urlTitle || page.title, accessedAt: page.accessedAt } : entry;
  }) };
}
/** What the model sees of a proposal: status and wording per item, never evidence or ids it did not send. */
function brief(items: ProposalItem[]) {
  return items.slice(0, 60).map(item => ({ status: item.status, group: item.group, ...(item.kind ? { kind: item.kind } : {}), label: safeText(item.label, 160),
    ...(item.collectionName ? { collection: safeText(item.collectionName, 120) } : {}), ...(item.sourceSite ? { site: item.sourceSite } : {}), ...(item.reason ? { reason: item.reason } : {}),
    ...(item.warnings.length ? { warnings: item.warnings.map(warning => warning.code === "term_conflict"
      ? `${warning.code}: ${safeText(warning.target ?? "", 120)} in ${safeText(warning.collectionName ?? "", 120)}` : warning.code) } : {}) }));
}

/** Rebuild against the newest library with the same ids, then save in one transaction. */
async function saveProposal(input: ProposalInput, ids: Record<string, string>, adopt: boolean): Promise<PreparedActionResult> {
  try {
    const library = await readLibrary();
    const proposal = buildKnowledgeProposal(input, library, { ids, sourceTitles: sourceTitles() });
    if (proposal.items.some(item => item.status === "invalid")) return failed("knowledge_changed", { items: brief(proposal.items) });
    const result = { executionStatus: "saved", counts: proposal.counts, adopted: 0, collectionIds: proposal.collectionIds, focusCollectionId: proposal.collectionIds[0] ?? null };
    // Nothing left: an earlier attempt (or another save) already holds every record.
    if (proposal.nothingToSave) return succeeded({ ...result, alreadySaved: true });
    const saved = await knowledgeApi().saveRecords(proposal.request(adopt, library.generation));
    if (!saved.ok) return failed(saved.error === "revision_conflict" ? "knowledge_changed" : saved.error);
    announceKnowledgeChange(saved.value);
    return succeeded({ ...result, adopted: adopt ? proposal.adoptable : 0 });
  } catch (error) {
    return failed(error instanceof ToolFailure ? error.message : "prepared_action_failed");
  }
}

export const knowledgeAgentTools = {
  search_translation_knowledge: tool({ description: "Search translation materials. Every word of the query must match an entry's wording, aliases or note, or the name, aliases or description of its collection or work (subject), so a work's title or nickname finds its collections and entries. Filter by collection, subject, kind, language pair or state (usable = enabled for translation; review = waiting for review). Returns bounded summaries with ids and revisions; never raw evidence. Read only.",
    inputSchema: knowledgeSearchSchema, execute: (args, options) => run(knowledgeSearchSchema, args, options, async (input, ctx) => {
      const library = await readLibrary(); ctx.check();
      const { subjects, collections: allCollections, entries: allEntries, recipes: allRecipes } = library.data;
      const subjectById = new Map(subjects.map(item => [item.id, item]));
      const collectionById = new Map(allCollections.map(item => [item.id, item]));
      const tokens = input.query.split(/\s+/).map(token => fold(token.trim())).filter(Boolean).slice(0, 8);
      const matches = (words: (string | undefined)[]) => { const haystack = fold(words.filter(Boolean).join("\n")); return tokens.every(token => haystack.includes(token)); };
      const collectionWords = (collection: Collection | undefined) => collection
        ? [collection.name, collection.description, ...(collection.aboutSubjectIds ?? []).flatMap(subject => subjectWords(subjectById.get(subject)))] : [];
      const entryCount = (collectionId: string) => allEntries.filter(entry => entry.collectionId === collectionId && entry.state !== "archived").length;
      const entries = allEntries.filter(entry => {
        const collection = collectionById.get(entry.collectionId);
        if (!input.includeArchived && (entry.state === "archived" || collection?.archived)) return false;
        if (input.collectionId && entry.collectionId !== input.collectionId) return false;
        if (input.subjectId && !(entry.aboutSubjectIds ?? []).includes(input.subjectId) && !(collection?.aboutSubjectIds ?? []).includes(input.subjectId)) return false;
        if (input.kind !== "all" && entry.kind !== input.kind) return false;
        if (input.languagePair?.source && entry.scope.languagePair.source !== input.languagePair.source) return false;
        if (input.languagePair?.target && entry.scope.languagePair.target !== input.languagePair.target) return false;
        if (input.state === "usable" && !trusted(library, entry)) return false;
        if (input.state === "review" && !["candidate", "needs_review", "unconfirmed"].includes(reviewState(library, entry))) return false;
        const payload = entry.payload as { aliases?: string[]; sense?: string };
        return matches([entry.title, entrySummary(entry), ...(payload.aliases ?? []), payload.sense, ...collectionWords(collection),
          ...(entry.aboutSubjectIds ?? []).flatMap(subject => subjectWords(subjectById.get(subject)))]);
      });
      const collections = allCollections.filter(item => (input.includeArchived || !item.archived)
        && (!input.subjectId || (item.aboutSubjectIds ?? []).includes(input.subjectId)) && matches(collectionWords(item)));
      const recipes = allRecipes.filter(item => (input.includeArchived || !item.archived) && matches([item.name, item.description]));
      const foundSubjects = subjects.filter(item => (input.includeArchived || !item.archived) && matches(subjectWords(item)));
      const window = <T>(items: T[]) => items.slice(input.offset, input.offset + input.limit);
      return succeeded({ generation: library.generation, counts: { entries: allEntries.length, collections: allCollections.length, recipes: allRecipes.length },
        pagination: { offset: input.offset, limit: input.limit, entries: paginate(input.offset, input.limit, entries.length), collections: paginate(input.offset, input.limit, collections.length),
          recipes: paginate(input.offset, input.limit, recipes.length), subjects: paginate(input.offset, input.limit, foundSubjects.length) },
        total: entries.length, offset: input.offset,
        entries: window(entries).map(item => ({ id: item.id, revision: item.revision, kind: item.kind, title: safeText(item.title), collectionId: item.collectionId,
          languagePair: pairText(item.scope.languagePair), state: reviewState(library, item), summary: safeText(entrySummary(item), 400) })),
        collections: window(collections).map(item => ({ id: item.id, name: safeText(item.name), ...(item.defaultLanguagePair ? { languagePair: pairText(item.defaultLanguagePair) } : {}),
          entryCount: entryCount(item.id), subjects: (item.aboutSubjectIds ?? []).map(subject => safeText(subjectById.get(subject)?.name ?? "", 120)).filter(Boolean) })),
        recipes: window(recipes).map(item => ({ id: item.id, name: safeText(item.name), languagePair: pairText(item.languagePair) })),
        subjects: window(foundSubjects).map(item => ({ id: item.id, name: safeText(item.name, 120), kind: item.kind, aliases: (item.aliases ?? []).slice(0, 5).map(alias => safeText(alias, 80)) })) });
    }) }),
  list_translation_knowledge_catalog: tool({ description: "List the translation materials catalog: works and other subjects, collections (with language pair, entry counts and the works they are about) and recipes. Use it to choose where new entries belong. Read only.",
    inputSchema: knowledgeCatalogSchema, execute: (args, options) => run(knowledgeCatalogSchema, args, options, async (input, ctx) => {
      const library = await readLibrary(); ctx.check();
      const visible = <T extends { archived: boolean; name: string }>(items: T[]) => items.filter(item => input.includeArchived || !item.archived)
        .sort((a, b) => a.name.localeCompare(b.name));
      const subjects = visible(library.data.subjects), collections = visible(library.data.collections), recipes = visible(library.data.recipes);
      const subjectName = (subjectId: string) => safeText(library.data.subjects.find(item => item.id === subjectId)?.name ?? "", 120);
      const collectionName = (collectionId: string) => safeText(library.data.collections.find(item => item.id === collectionId)?.name ?? "", 120);
      const window = <T>(items: T[]) => items.slice(input.offset, input.offset + input.limit);
      return succeeded({ generation: library.generation,
        pagination: { offset: input.offset, limit: input.limit, subjects: paginate(input.offset, input.limit, subjects.length),
          collections: paginate(input.offset, input.limit, collections.length), recipes: paginate(input.offset, input.limit, recipes.length) },
        subjects: window(subjects).map(item => ({ id: item.id, name: safeText(item.name, 120), kind: item.kind, aliases: (item.aliases ?? []).slice(0, 5).map(alias => safeText(alias, 80)) })),
        collections: window(collections).map(item => {
          const entries = library.data.entries.filter(entry => entry.collectionId === item.id && entry.state !== "archived");
          return { id: item.id, name: safeText(item.name), description: safeText(item.description ?? "", 200),
            ...(item.defaultLanguagePair ? { languagePair: pairText(item.defaultLanguagePair) } : {}), ...(item.archived ? { archived: true } : {}),
            entryCount: entries.length, usableCount: entries.filter(entry => trusted(library, entry)).length,
            reviewCount: entries.filter(entry => ["candidate", "needs_review", "unconfirmed"].includes(reviewState(library, entry))).length,
            subjects: (item.aboutSubjectIds ?? []).map(subjectName).filter(Boolean) };
        }),
        recipes: window(recipes).map(item => ({ id: item.id, name: safeText(item.name), languagePair: pairText(item.languagePair),
          collections: item.readCollectionIds.map(collectionName).filter(Boolean) })) });
    }) }),
  prepare_knowledge_changes: tool({ description: "Prepare changes to translation materials for the user to confirm on a card: create works/subjects and collections, create or edit term/rule/context entries, archive entries. Nothing is saved until the user confirms, in every execution mode; the outcome arrives as an interface event. Reference existing records by id (edits and archives also need the entry's revision); name new subjects/collections with a short ref and point to it with {ref}. Terms take the exact source-language wording (from the subtitle source text or the user) and the target wording. basis: user_stated = the user said this wording; user_revision = it comes from a revision the user applied; document = read from the subtitles; agent_inferred = your own knowledge (say it needs checking); web = read on a page with web_read, with url = that page's link and evidence = the sentence that shows it. evidence: a short quote supporting it. Language tags such as ja, en, zh-Hans, zh-Hant.",
    inputSchema: prepareKnowledgeChangesSchema, execute: (args, options) => run(prepareKnowledgeChangesSchema, args, options, async (raw, ctx) => {
      const input = withWebPages(raw);
      const library = await readLibrary(); ctx.check();
      const proposal = buildKnowledgeProposal(input, library, { sourceTitles: sourceTitles() });
      if (proposal.items.some(item => item.status === "invalid")) return failed("knowledge_proposal_invalid", { items: brief(proposal.items) });
      if (proposal.nothingToSave) return succeeded({ executionStatus: "unchanged", items: brief(proposal.items) });
      // A newer proposal replaces an unconfirmed older one, so two cards never disagree.
      const store = usePreparedActionsStore.getState();
      for (const action of store.actions) if (action.knowledge && action.status === "ready" && action.sessionId === ctx.sessionId) store.dismissAction(action.id);
      let action;
      try {
        action = registerPreparedAction({ sessionId: ctx.sessionId, toolKey: "translationKnowledge", requiresConfirmation: true,
          title: i18n.t("home:prepared_knowledge_title"), summary: i18n.t("home:prepared_knowledge_summary", { ...proposal.counts }),
          summaryKey: "home:prepared_knowledge_summary", summaryValues: { ...proposal.counts },
          knowledge: { items: proposal.items, counts: proposal.counts, adoptDefault: proposal.adoptDefault, adoptable: proposal.adoptable },
          execute: choice => saveProposal(input, proposal.ids, choice?.adopt ?? proposal.adoptDefault) });
      } catch (error) { throw new ToolFailure(error instanceof Error ? error.message : "prepared_action_failed"); }
      return exposePrepared(action, ctx, { items: brief(proposal.items), enabledByDefault: proposal.adoptDefault });
    }) }),
};
