import { tool } from "ai";
import { z } from "zod";
import i18n from "@/i18n";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { Collection, Entry } from "@/translation-knowledge/schemas";
import { entrySummary } from "@/translation-knowledge/summary";
import { buildKnowledgeProposal, PROPOSAL_LIMITS, type ProposalInput, type ProposalItem } from "@/translation-knowledge/proposal";
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
const pairText = (pair: { source: string; target: string }) => ({ source: safeText(pair.source, 32), target: safeText(pair.target, 32) });
function paginate(offset: number, limit: number, total: number) {
  return { total, hasMore: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null };
}
const byName = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));

/**
 * Parse failures name what was wrong, so the model can correct its call. A collection is the work
 * itself, so a call written for works or subjects gets told that directly.
 */
async function runKnowledge<S extends z.ZodType>(schema: S, args: unknown, options: { abortSignal?: AbortSignal } | undefined,
  execute: Parameters<typeof run<S>>[3]): Promise<PreparedActionResult> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return run(schema, args, options, execute);
  const issues = parsed.error.issues.slice(0, 5).map(issue => issue.code === "unrecognized_keys" && issue.keys.includes("subjects")
    ? "There are no subjects: a collection is the work itself. Name the collection after the work or streamer and give its language pair."
    : `${issue.path.join(".") || "input"}: ${issue.message}`);
  return failed("invalid_tool_arguments", { issues });
}

export const knowledgeSearchSchema = z.object({ ...page, query: z.string().max(200).default(""),
  collectionId: id.optional(),
  kind: z.enum(["all", "term", "context", "rule"]).default("all"),
  languagePair: z.object({ source: z.string().max(35).optional(), target: z.string().max(35).optional() }).strict().optional(),
  enabled: z.enum(["all", "enabled", "disabled"]).default("all"),
  includeArchived: z.boolean().default(false) }).strict();
export const knowledgeCatalogSchema = z.object({ ...page, includeArchived: z.boolean().default(false) }).strict();

const ref = z.union([z.object({ id }).strict(), z.object({ ref: z.string().trim().min(1).max(40) }).strict()]);
const languagePair = z.object({ source: z.string().trim().min(2).max(35), target: z.string().trim().min(2).max(35) }).strict();
const shortText = (length: number) => z.string().max(length);
export const prepareKnowledgeChangesSchema = z.object({
  languagePair: languagePair.optional(),
  collections: z.array(z.object({ ref: z.string().trim().min(1).max(40), name: shortText(200), description: shortText(1000).optional(),
    languagePair: languagePair.optional() }).strict()).max(PROPOSAL_LIMITS.collections).optional(),
  entries: z.array(z.object({
    action: z.enum(["create", "update", "disable", "enable"]), entryId: id.optional(), revision: z.number().int().positive().safe().optional(),
    collection: ref.optional(), kind: z.enum(["term", "rule", "context"]).optional(),
    source: shortText(500).optional(), target: shortText(500).optional(), aliases: z.array(shortText(200)).max(10).optional(), note: shortText(500).optional(),
    strength: z.enum(["preferred", "required", "keep_source"]).optional(),
    text: shortText(2000).optional(), required: z.boolean().optional(),
    basis: z.enum(["user_stated", "user_revision", "document", "agent_inferred", "web"]),
    evidence: shortText(600).optional(), url: shortText(2000).optional(), urlTitle: shortText(300).optional(),
  }).strict()).max(PROPOSAL_LIMITS.entries).optional(),
}).strict().refine(value => (value.collections?.length ?? 0) + (value.entries?.length ?? 0) > 0, "Prepare at least one collection or entry.");

/** A web-sourced entry keeps the title of the page it was read on and when, as web_read saw them. */
function withWebPages<T extends ProposalInput>(input: T): T {
  if (!input.entries?.some(entry => entry.basis === "web")) return input;
  return { ...input, entries: input.entries.map(entry => {
    if (entry.basis !== "web") return entry;
    const page = readWebPage(entry.url);
    return page ? { ...entry, urlTitle: entry.urlTitle || page.title, accessedAt: page.accessedAt } : entry;
  }) };
}
/** What the model sees of a proposal: status and wording per item, never ids it did not send. */
function brief(items: ProposalItem[]) {
  return items.slice(0, 60).map(item => ({ status: item.status, group: item.group, ...(item.kind ? { kind: item.kind } : {}), label: safeText(item.label, 160),
    ...(item.collectionName ? { collection: safeText(item.collectionName, 120) } : {}), ...(item.sourceSite ? { site: item.sourceSite } : {}), ...(item.reason ? { reason: item.reason } : {}),
    ...(item.warnings.length ? { warnings: item.warnings.map(warning => `${warning.code}: ${safeText(warning.target ?? "", 120)} in ${safeText(warning.collectionName ?? "", 120)}`) } : {}) }));
}

/** Rebuild against the newest library with the same ids, then save in one transaction. */
async function saveProposal(input: ProposalInput, ids: Record<string, string>): Promise<PreparedActionResult> {
  try {
    const library = await readLibrary();
    const proposal = buildKnowledgeProposal(input, library, { ids });
    if (proposal.items.some(item => item.status === "invalid")) return failed("knowledge_changed", { items: brief(proposal.items) });
    const result = { executionStatus: "saved", counts: proposal.counts, collectionIds: proposal.collectionIds, focusCollectionId: proposal.collectionIds[0] ?? null };
    // Nothing left: an earlier attempt (or another save) already holds every record.
    if (proposal.nothingToSave) return succeeded({ ...result, alreadySaved: true });
    const saved = await knowledgeApi().saveRecords(proposal.request(library.generation));
    if (!saved.ok) return failed(saved.error === "revision_conflict" ? "knowledge_changed" : saved.error);
    announceKnowledgeChange(saved.value);
    return succeeded(result);
  } catch (error) {
    return failed(error instanceof ToolFailure ? error.message : "prepared_action_failed");
  }
}

export const knowledgeAgentTools = {
  search_translation_knowledge: tool({ description: "Search translation materials. Every word of the query must match an entry's wording, aliases, note or text, or the name or description of its collection, so a work's or streamer's name finds its collection and entries. Filter by collection, kind, language pair (the collection's direction) or enabled state. Returns bounded summaries with ids and revisions. Read only.",
    inputSchema: knowledgeSearchSchema, execute: (args, options) => runKnowledge(knowledgeSearchSchema, args, options, async (input, ctx) => {
      const library = await readLibrary(); ctx.check();
      const { collections: allCollections, entries: allEntries, presets: allPresets } = library.data;
      const collectionById = new Map(allCollections.map(item => [item.id, item]));
      const tokens = input.query.split(/\s+/).map(token => fold(token.trim())).filter(Boolean).slice(0, 8);
      const matches = (words: (string | undefined)[]) => { const haystack = fold(words.filter(Boolean).join("\n")); return tokens.every(token => haystack.includes(token)); };
      const collectionWords = (collection: Collection | undefined) => collection ? [collection.name, collection.description] : [];
      const entryWords = (entry: Entry) => entry.kind === "term"
        ? [entry.payload.source, entry.payload.target, ...entry.payload.aliases, entry.payload.note] : [entry.payload.text];
      const directionMatches = (pair: { source: string; target: string }) => (!input.languagePair?.source || pair.source === input.languagePair.source)
        && (!input.languagePair?.target || pair.target === input.languagePair.target);
      const entries = allEntries.filter(entry => {
        const collection = collectionById.get(entry.collectionId);
        if (!collection || (!input.includeArchived && collection.archived)) return false;
        if (input.collectionId && entry.collectionId !== input.collectionId) return false;
        if (input.kind !== "all" && entry.kind !== input.kind) return false;
        if (!directionMatches(collection.languagePair)) return false;
        if (input.enabled !== "all" && entry.enabled !== (input.enabled === "enabled")) return false;
        return matches([...entryWords(entry), ...collectionWords(collection)]);
      });
      const collections = allCollections.filter(item => (input.includeArchived || !item.archived) && (!input.collectionId || item.id === input.collectionId)
        && directionMatches(item.languagePair) && matches(collectionWords(item)));
      const presets = allPresets.filter(item => directionMatches(item.languagePair) && matches([item.name]));
      const window = <T>(items: T[]) => items.slice(input.offset, input.offset + input.limit);
      return succeeded({ generation: library.generation, counts: { entries: allEntries.length, collections: allCollections.length, presets: allPresets.length },
        pagination: { offset: input.offset, limit: input.limit, entries: paginate(input.offset, input.limit, entries.length),
          collections: paginate(input.offset, input.limit, collections.length), presets: paginate(input.offset, input.limit, presets.length) },
        total: entries.length, offset: input.offset,
        entries: window(entries).map(item => ({ id: item.id, revision: item.revision, kind: item.kind, collectionId: item.collectionId,
          collection: safeText(collectionById.get(item.collectionId)?.name ?? "", 120), enabled: item.enabled, summary: safeText(entrySummary(item), 400) })),
        collections: window(collections).map(item => ({ id: item.id, name: safeText(item.name), languagePair: pairText(item.languagePair),
          entryCount: allEntries.filter(entry => entry.collectionId === item.id).length, ...(item.archived ? { archived: true } : {}) })),
        presets: window(presets).map(item => ({ id: item.id, name: safeText(item.name), languagePair: pairText(item.languagePair), collectionIds: item.collectionIds })) });
    }) }),
  list_translation_knowledge_catalog: tool({ description: "List the translation materials catalog: collections (one per work, streamer or topic, each with its language pair and entry counts) and presets (named sets of collections used together in Subtitle Studio). Use it to choose where new entries belong, or which collections or preset a translation should use. Read only.",
    inputSchema: knowledgeCatalogSchema, execute: (args, options) => runKnowledge(knowledgeCatalogSchema, args, options, async (input, ctx) => {
      const library = await readLibrary(); ctx.check();
      const collections = byName(library.data.collections.filter(item => input.includeArchived || !item.archived));
      const presets = byName(library.data.presets);
      const collectionName = (collectionId: string) => safeText(library.data.collections.find(item => item.id === collectionId)?.name ?? "", 120);
      const window = <T>(items: T[]) => items.slice(input.offset, input.offset + input.limit);
      return succeeded({ generation: library.generation,
        pagination: { offset: input.offset, limit: input.limit, collections: paginate(input.offset, input.limit, collections.length),
          presets: paginate(input.offset, input.limit, presets.length) },
        collections: window(collections).map(item => {
          const entries = library.data.entries.filter(entry => entry.collectionId === item.id);
          return { id: item.id, name: safeText(item.name), description: safeText(item.description, 200), languagePair: pairText(item.languagePair),
            ...(item.archived ? { archived: true } : {}), entryCount: entries.length, enabledCount: entries.filter(entry => entry.enabled).length };
        }),
        presets: window(presets).map(item => ({ id: item.id, name: safeText(item.name), languagePair: pairText(item.languagePair), collectionIds: item.collectionIds,
          collections: item.collectionIds.map(collectionName).filter(Boolean) })) });
    }) }),
  prepare_knowledge_changes: tool({ description: "Prepare changes to translation materials for the user to confirm on a card: create collections, create or edit term/rule/context entries, disable or enable entries. Nothing is saved until the user confirms, in every execution mode; confirmed entries are enabled at once and the outcome arrives as an interface event. A collection is the work, streamer or topic itself (there are no separate subjects): look for it with list_translation_knowledge_catalog first, and when none fits, create one named after the work with its languagePair. Reference existing records by id (edits, disables and enables also need the entry's revision); name a new collection with a short ref and point to it with {ref}. Terms take the exact source-language wording (from the subtitle source text or the user) and the target wording; rules and context take text, with required=true only for what must always hold. basis: user_stated = the user said this wording; user_revision = it comes from a revision the user applied; document = read from the subtitles; agent_inferred = your own knowledge (say it needs checking); web = read on a page with web_read, with url = that page's link and evidence = the sentence that shows it. evidence: a short quote supporting it. Language tags such as ja, en, zh-Hans, zh-Hant.",
    inputSchema: prepareKnowledgeChangesSchema, execute: (args, options) => runKnowledge(prepareKnowledgeChangesSchema, args, options, async (raw, ctx) => {
      const input = withWebPages(raw);
      const library = await readLibrary(); ctx.check();
      const proposal = buildKnowledgeProposal(input, library);
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
          knowledge: { items: proposal.items, counts: proposal.counts },
          execute: () => saveProposal(input, proposal.ids) });
      } catch (error) { throw new ToolFailure(error instanceof Error ? error.message : "prepared_action_failed"); }
      return exposePrepared(action, ctx, { items: brief(proposal.items) });
    }) }),
};
