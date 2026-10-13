import type { z } from "zod";
import { executeOpenAppPage } from "@/agent/navigation-tools";
import { usePageContextStore } from "@/agent/page-context";
import type { EXTERNAL_TOOLS } from "../catalog";
import { awaitConfirmation } from "../confirmations";
import { ExternalToolError, type ExternalToolContext } from "../errors";

type PageInput = z.output<typeof EXTERNAL_TOOLS.open_fusionkit_page.inputSchema>;
type ConfirmationInput = z.output<typeof EXTERNAL_TOOLS.get_confirmation_result.inputSchema>;

const PAGES = { home: "home", subtitle_studio: "subtitle_studio", translation_knowledge: "translation_knowledge", settings: "agent_settings" } as const;

export async function openFusionkitPage(input: PageInput, ctx: ExternalToolContext) {
  const result = await executeOpenAppPage({ page: PAGES[input.page], ...(input.page === "subtitle_studio" && input.studioView ? { studioView: input.studioView } : {}) }, ctx.signal) as { success: boolean; error?: string };
  if (!result.success) throw new ExternalToolError(result.error ?? "navigation_failed");
  return { page: input.page, currentPage: usePageContextStore.getState().pathname };
}

export function getConfirmationResult(input: ConfirmationInput, ctx: ExternalToolContext) {
  return awaitConfirmation(ctx, input.confirmationId);
}
