import type { z } from "zod";
import { brief, knowledgeCatalog, readLibrary, saveProposal, searchKnowledgeLibrary } from "@/agent/knowledge-tools";
import { buildKnowledgeProposal, type ProposalInput } from "@/translation-knowledge/proposal";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed } from "../confirmations";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";

type SearchInput = z.output<typeof EXTERNAL_TOOLS.search_translation_knowledge.inputSchema>;
type CatalogInput = z.output<typeof EXTERNAL_TOOLS.list_translation_knowledge_catalog.inputSchema>;
type ChangesInput = z.output<typeof EXTERNAL_TOOLS.prepare_knowledge_changes.inputSchema>;

/** The library, with the built-in tools' failures turned into stable codes. */
async function library(ctx: ExternalToolContext) {
  try {
    const value = await readLibrary();
    checkActive(ctx);
    return value;
  } catch (error) {
    if (error instanceof ExternalToolError) throw error;
    throw new ExternalToolError(error instanceof Error ? error.message : "translation_knowledge_unavailable");
  }
}

export async function searchTranslationKnowledge(input: SearchInput, ctx: ExternalToolContext) {
  return searchKnowledgeLibrary(input as Parameters<typeof searchKnowledgeLibrary>[0], await library(ctx));
}

export async function listTranslationKnowledgeCatalog(input: CatalogInput, ctx: ExternalToolContext) {
  return knowledgeCatalog(input as Parameters<typeof knowledgeCatalog>[0], await library(ctx));
}

export async function prepareKnowledgeChanges(input: ChangesInput, ctx: ExternalToolContext) {
  const proposalInput = input as unknown as ProposalInput;
  const proposal = buildKnowledgeProposal(proposalInput, await library(ctx));
  if (proposal.items.some(item => item.status === "invalid")) throw new ExternalToolError("knowledge_proposal_invalid", { items: brief(proposal.items) });
  if (proposal.nothingToSave) return { status: "unchanged", items: brief(proposal.items) };
  const changes = proposal.items.filter(item => item.status !== "exists");
  const shown = (changes.length ? changes : proposal.items).map(item => ({ text: item.label, tag: item.kind ?? "collection" as const, ...(item.kind && item.collectionName ? { detail: item.collectionName } : {}) }));
  return confirmed(ctx, "prepare_knowledge_changes", {
    action: "knowledge", summary: "knowledge", values: { count: shown.length }, items: shown,
  }, async () => {
    const saved = await saveProposal(proposalInput, proposal.ids);
    if (!saved.success) throw new ExternalToolError(saved.error ?? "knowledge_save_failed", saved.data && typeof saved.data === "object" ? saved.data as Record<string, unknown> : undefined);
    return { status: "saved", ...(saved.data as Record<string, unknown>), items: brief(proposal.items) };
  });
}
