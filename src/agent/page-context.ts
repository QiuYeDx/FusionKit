import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

/**
 * A tool a page lends to the assistant, shaped like an AI SDK tool. Kept
 * structural so that pages depend only on this neutral module.
 */
export interface PageTool {
  description?: string;
  inputSchema: unknown;
  execute?: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal } & Record<string, unknown>) => Promise<unknown> | unknown;
}
export type PageToolSet = Record<string, PageTool>;

/** Page context sent with a turn, in characters of serialized JSON. */
export const PAGE_SNAPSHOT_LIMIT = 6000;

export type PageSuggestion = { labelKey: string; promptKey: string };

/**
 * What a page tells the agent while it is open. The snapshot is application
 * data, never user authorization; tools act on the page instance that
 * registered them and stop working once it is gone.
 */
export interface AgentPageContext {
  route: string;
  /** i18n key of the page name shown to the user and the model. */
  titleKey: string;
  /** What the page is showing, such as the open document's name. */
  subject?: string;
  /** Prompt suggestions for an empty conversation. */
  suggestions?: readonly PageSuggestion[];
  /** Bounded JSON describing what the user sees now; read once per turn. */
  describe?: () => unknown;
  /** Short guidance for the model about this page's tools. */
  instructions?: string;
  tools?: PageToolSet;
}

/**
 * A registration keeps one identity while the page is mounted. Display fields
 * are copied into the store when they change; everything else is read from the
 * page's latest render through `read`.
 */
export interface RegisteredPageContext {
  id: string;
  route: string;
  titleKey: string;
  subject?: string;
  suggestions?: readonly PageSuggestion[];
  read: () => AgentPageContext | null;
}

interface PageContextState {
  pathname: string;
  pages: RegisteredPageContext[];
  setPathname: (pathname: string) => void;
}

/** No persistence: page contexts and their tools live only while the page is mounted. */
export const usePageContextStore = create<PageContextState>((set) => ({
  pathname: "/",
  pages: [],
  setPathname: (pathname) => set((state) => state.pathname === pathname ? state : { pathname }),
}));

let sequence = 0;

/** Registers a page; the latest registration for a route wins. */
export function registerPageContext(entry: Omit<RegisteredPageContext, "id">): { id: string; unregister: () => void } {
  const id = `page-${++sequence}`;
  usePageContextStore.setState((state) => ({ pages: [...state.pages, { ...entry, id }] }));
  return { id, unregister: () => usePageContextStore.setState((state) => ({ pages: state.pages.filter((page) => page.id !== id) })) };
}

export function updatePageDisplay(id: string, display: Pick<RegisteredPageContext, "titleKey" | "subject" | "suggestions">): void {
  usePageContextStore.setState((state) => ({ pages: state.pages.map((page) => page.id === id ? { ...page, ...display } : page) }));
}

export function isPageContextActive(id: string): boolean {
  return usePageContextStore.getState().pages.some((page) => page.id === id);
}

export function resolvePageContext(pathname = usePageContextStore.getState().pathname): RegisteredPageContext | undefined {
  return [...usePageContextStore.getState().pages].reverse().find((page) => page.route === pathname);
}

/** Something the user did on a page the assistant prepared, such as applying a revision. */
export type PageEvent = { kind: string; values?: Record<string, string | number | boolean> };
let pageEventSink: ((event: PageEvent) => void) | null = null;
/** The assistant's runtime receives page events; pages stay independent of it. */
export function setPageEventSink(sink: ((event: PageEvent) => void) | null): void { pageEventSink = sink; }
/** Reports a page event to the assistant, when one is running in this window. */
export function reportPageEvent(event: PageEvent): void { pageEventSink?.(event); }

/** Known page names by route, for pages that register no context. Set by the application. */
let routeTitleKeys: Readonly<Record<string, string>> = { "/": "home:agent_title" };
export function setRouteTitleKeys(keys: Readonly<Record<string, string>>): void { routeTitleKeys = { "/": "home:agent_title", ...keys }; }

/** The page name key for a route, from its registration or the known routes. */
export function pageTitleKey(pathname: string, page?: Pick<RegisteredPageContext, "titleKey">): string | undefined {
  return page?.titleKey ?? routeTitleKeys[pathname];
}

/**
 * Registers the page while the component is mounted. The factory runs on
 * every render, so describe() and tools always see the current state; the
 * store only changes when the route, title, subject or suggestions change.
 */
export function useAgentPageContext(factory: () => AgentPageContext | null): void {
  const latest = useRef(factory);
  latest.current = factory;
  const entry = factory();
  const [id, setId] = useState<string | null>(null);
  const route = entry?.route;
  useEffect(() => {
    const current = latest.current();
    if (!current) return;
    const registration = registerPageContext({
      route: current.route, titleKey: current.titleKey, subject: current.subject, suggestions: current.suggestions,
      read: () => latest.current(),
    });
    setId(registration.id);
    return () => { registration.unregister(); setId(null); };
  }, [route]);
  const suggestions = JSON.stringify(entry?.suggestions ?? null);
  useEffect(() => {
    const current = latest.current();
    if (id && current) updatePageDisplay(id, { titleKey: current.titleKey, subject: current.subject, suggestions: current.suggestions });
  }, [id, entry?.titleKey, entry?.subject, suggestions]);
}

export interface PageContextSection {
  route: string;
  title?: string;
  subject?: string;
  instructions?: string;
  snapshot?: unknown;
  snapshotTruncated?: boolean;
  /** Why the snapshot is missing, for the session log. */
  snapshotError?: string;
}

/** The "Current Page" data for a turn. Never throws: a broken snapshot only drops the snapshot. */
export function buildPageContextSection(pathname: string, page: RegisteredPageContext | undefined, translate: (key: string) => string): PageContextSection {
  const titleKey = pageTitleKey(pathname, page);
  const section: PageContextSection = { route: pathname, ...(titleKey ? { title: translate(titleKey) } : {}) };
  if (!page) return section;
  let current: AgentPageContext | null;
  try { current = page.read(); }
  catch (error) { return { ...section, snapshotError: error instanceof Error ? error.message.slice(0, 300) : "page_context_failed" }; }
  if (!current) return section;
  if (current.subject) section.subject = current.subject.slice(0, 300);
  if (current.instructions) section.instructions = current.instructions.slice(0, 2000);
  if (!current.describe) return section;
  try {
    const value = current.describe();
    const json = JSON.stringify(value);
    if (json === undefined) return { ...section, snapshotError: "snapshot_not_serializable" };
    if (json.length > PAGE_SNAPSHOT_LIMIT) return { ...section, snapshot: json.slice(0, PAGE_SNAPSHOT_LIMIT), snapshotTruncated: true };
    return { ...section, snapshot: value };
  } catch (error) {
    return { ...section, snapshotError: error instanceof Error ? error.message.slice(0, 300) : "snapshot_failed" };
  }
}

/**
 * The page's tools for one turn. Each call runs the page's current tool of
 * that name and refuses once the registration is gone (page unmounted or
 * replaced), so a turn never acts on a page the user has left.
 */
export function pageTools(page: RegisteredPageContext): PageToolSet {
  let tools: PageToolSet;
  try { tools = page.read()?.tools ?? {}; }
  catch { return {}; }
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (!definition.execute) return [name, definition];
    return [name, {
      ...definition,
      execute: async (input: unknown, options: Parameters<NonNullable<PageTool["execute"]>>[1]) => {
        const live = isPageContextActive(page.id) ? page.read()?.tools?.[name]?.execute : undefined;
        return live ? live(input, options) : { success: false, error: "page_unavailable" };
      },
    }];
  }));
}
