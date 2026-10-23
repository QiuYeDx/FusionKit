import { useAgentPageContext, type AgentPageContext } from '@/agent/page-context';
import type { DocumentDetail } from '@/long-text/contract';
import { useLongTextStore } from '@/store/tools/text/useLongTextStore';
import { initialPage } from './reader/useReaderPage';

export const LONG_TEXT_ROUTE = '/tools/text/translator';
export const LONG_TEXT_AGENT_INSTRUCTIONS = 'Read-only page snapshot. This tool cannot be operated by the assistant yet; describe the state and point the user to the page controls.';

/** Serialized characters per name and page title; a title holds up to 60 code points. */
const NAME_CHARS = 120;
const TITLE_CHARS = 120;

/** The longest prefix of `value` that takes at most `max` characters as JSON, so escapes cannot stretch the snapshot. */
function clip(value: string, max: number): string {
  let length = 0;
  let end = 0;
  for (const char of value) {
    length += JSON.stringify(char).length - 2;
    if (length > max) break;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * The open document as the assistant may see it, in at most 1,000 characters of JSON: name,
 * format, languages, counts, the latest run and the reader's page. Never source or translated text.
 */
export function longTextSnapshot(detail: DocumentDetail | null, rememberedPage: number | undefined) {
  if (!detail) return { document: null };
  const { languages, counts, run, pages } = detail;
  const index = initialPage(rememberedPage, pages.length);
  const title = pages[index]?.title;
  return {
    document: {
      name: clip(detail.name, NAME_CHARS),
      format: detail.format,
      languages: { source: languages.source, target: languages.target, sourceIsAuto: languages.sourceIsAuto },
      counts: {
        translatable: counts.translatable, done: counts.done, pending: counts.pending, failed: counts.failed,
        attention: counts.attention, edited: counts.edited, locked: counts.locked,
      },
      run: run && { kind: run.kind, status: run.status, done: run.done, total: run.total },
      page: pages.length ? { number: index + 1, of: pages.length, ...(title ? { title: clip(title, TITLE_CHARS) } : {}) } : null,
    },
  };
}

/** A read-only registration: the page lends the assistant no tools and offers no suggestions (R-LT-21). */
export function longTextAgentContext(detail: DocumentDetail | null): AgentPageContext {
  return {
    route: LONG_TEXT_ROUTE,
    titleKey: 'tools:fields.text_translator',
    ...(detail ? { subject: detail.name } : {}),
    instructions: LONG_TEXT_AGENT_INSTRUCTIONS,
    // The reader remembers its page per document; the snapshot reads it when a turn starts.
    describe: () => longTextSnapshot(detail, detail ? useLongTextStore.getState().pageByDocument[detail.id] : undefined),
  };
}

/** Tells the in-app assistant what the long text translator shows while the page is open. */
export function useLongTextAgentContext(detail: DocumentDetail | null): void {
  useAgentPageContext(() => longTextAgentContext(detail));
}
