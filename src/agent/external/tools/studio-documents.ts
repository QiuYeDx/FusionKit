import type { z } from "zod";
import { documentSummary } from "@/agent/modern-tools";
import type { EXTERNAL_TOOLS } from "../catalog";
import { checkActive, type ExternalToolContext } from "../errors";
import { studioApi, unwrapStudio } from "./studio";

type ListInput = z.output<typeof EXTERNAL_TOOLS.list_studio_documents.inputSchema>;

export async function listStudioDocuments(input: ListInput, ctx: ExternalToolContext) {
  const snapshot = unwrapStudio(await studioApi().listDocuments({
    offset: input.offset, pageSize: input.limit, query: input.query, format: input.format, status: input.status,
  }));
  checkActive(ctx);
  const items = snapshot.documents.slice(0, input.limit).map(documentSummary);
  const next = input.offset + items.length;
  return { total: snapshot.total, offset: input.offset, nextOffset: next < snapshot.total ? next : null, items, unavailableCount: snapshot.unavailableDocuments };
}
