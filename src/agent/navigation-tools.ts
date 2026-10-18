import { tool } from "ai";
import { z } from "zod";
import i18n from "@/i18n";
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";
import { studioResourcesPath } from "@/pages/Tools/Subtitle/SubtitleStudio/navigation";
import { buildPageContextSection, resolvePageContext, usePageContextStore } from "./page-context";

/** Pages the agent may open, by key; never an arbitrary path. */
export const AGENT_PAGES = {
  home: "/",
  tools: "/tools",
  subtitle_studio: "/tools/subtitle/studio",
  translation_knowledge: "/tools/translation-knowledge",
  subtitle_translator: "/tools/subtitle/translator",
  subtitle_converter: "/tools/subtitle/converter",
  subtitle_extractor: "/tools/subtitle/extractor",
  local_subtitle_transcriber: LOCAL_SUBTITLE_TRANSCRIBER_ROUTE,
  name_translator: "/tools/rename/name-translator",
  text_translator: "/tools/text/translator",
  model_settings: "/setting",
  agent_settings: "/setting",
  network_settings: "/setting",
  help: "/help",
} as const satisfies Record<string, string>;
export type AgentPageKey = keyof typeof AGENT_PAGES;

/** How long to wait for the destination page to describe itself. */
export const PAGE_READY_TIMEOUT = 2000;

let navigator: ((to: string) => void) | null = null;
/** Set by the application shell, which owns the router. */
export function setAgentNavigator(next: ((to: string) => void) | null): void { navigator = next; }

export const openAppPageSchema = z.object({
  page: z.enum(Object.keys(AGENT_PAGES) as [AgentPageKey, ...AgentPageKey[]]),
  studioView: z.enum(["documents", "transcription", "resources"]).optional()
    .describe("Only for subtitle_studio: the documents or transcription workspace, or resources (the transcription workspace with its resource manager open, where one-click prepare installs the model and voice detection)."),
}).strict();

function target(input: z.output<typeof openAppPageSchema>): { route: string; to: string } {
  const route = AGENT_PAGES[input.page];
  if (input.page === "subtitle_studio" && input.studioView === "resources") return { route, to: studioResourcesPath() };
  if (input.page === "subtitle_studio" && input.studioView) return { route, to: `${route}?view=${input.studioView}` };
  if (input.page === "model_settings") return { route, to: `${route}?tab=model` };
  if (input.page === "agent_settings") return { route, to: `${route}?tab=agent` };
  if (input.page === "network_settings") return { route, to: `${route}?tab=proxy` };
  return { route, to: route };
}

/** Resolves once a page context for the route is registered, or after the timeout. */
function pageReady(route: string, timeout: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (resolvePageContext(route)) { resolve(); return; }
    let unsubscribe = () => {};
    const done = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, timeout);
    unsubscribe = usePageContextStore.subscribe((state) => { if (state.pages.some((page) => page.route === route)) done(); });
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The window's current location with its query ("/setting?tab=model"), when there is one to read (hash routing). */
function currentLocation(): string | undefined {
  try { return typeof window !== "undefined" && window.location?.hash ? window.location.hash.slice(1) : undefined; } catch { return undefined; }
}

export async function executeOpenAppPage(input: unknown, signal?: AbortSignal, timeout = PAGE_READY_TIMEOUT) {
  const parsed = openAppPageSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "invalid_tool_arguments" };
  if (!navigator) return { success: false, error: "navigation_unavailable" };
  const { route, to } = target(parsed.data);
  const current = usePageContextStore.getState().pathname;
  // The settings pages share one route: another tab (network after model) is a page to open.
  const here = to === route ? undefined : currentLocation();
  const alreadyThere = current === route && !parsed.data.studioView && (here === undefined || here === to);
  if (!alreadyThere) navigator(to);
  await pageReady(route, timeout, signal);
  if (signal?.aborted) return { success: false, error: "agent_cancelled" };
  const section = buildPageContextSection(route, resolvePageContext(route), (key) => i18n.t(key));
  return {
    success: true,
    data: {
      route, title: section.title, ...(alreadyThere ? { alreadyOpen: true } : {}),
      ...(section.subject ? { subject: section.subject } : {}),
      ...(section.snapshot !== undefined ? { snapshot: section.snapshot } : {}),
      note: "The page is open for the user. Its own page tools become available from the user's next message; this turn keeps the tools it started with.",
    },
  };
}

export const navigationAgentTools = {
  open_app_page: tool({
    description: "Open a FusionKit page for the user, for example the subtitle translator after queueing translation tasks there, or a tool the user asks to see. " +
      "Only known pages; it changes no data. Returns the opened page and what it shows. Do not open pages the user did not need.",
    inputSchema: openAppPageSchema,
    execute: (input, options) => executeOpenAppPage(input, options.abortSignal),
  }),
};
