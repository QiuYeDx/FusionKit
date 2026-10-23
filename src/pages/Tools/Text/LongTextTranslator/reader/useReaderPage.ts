import { useCallback, useEffect, useRef, useState } from 'react';
import type { LongTextChangeEvent } from '@/long-text/channels';
import { LONG_TEXT_LIMITS, type LongTextErrorCode, type PageInfo, type QueryFilter, type SegmentRow } from '@/long-text/contract';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { useLongTextStore } from '@/store/tools/text/useLongTextStore';
import type { ChangeListener } from '../hooks/useDocuments';
import type { ReaderFilter } from '../labels';

/** A filter tab other than "all". */
export type ResultFilter = Exclude<ReaderFilter, 'all'>;

/** What the reader shows: one page of the document, or a page of filter or search results. */
export type ReaderView =
  | { kind: 'page'; page: number }
  | { kind: 'filter'; filter: ResultFilter; offset: number }
  | { kind: 'search'; text: string; offset: number };

/** Rows per page of filter and search results (the query limit is 100). */
export const RESULT_PAGE_SIZE = 60;
/** Filter and search views refresh at most this often while segments change (design §5.4). */
export const RESULT_REFRESH_MS = 500;

export interface ReaderRows {
  /** The view these rows were read for. */
  view: ReaderView;
  rows: SegmentRow[];
  /** Matching segments of a result view; the row count of a page. */
  total: number;
  /** The search stopped at its limit. */
  truncated: boolean;
  /** Rows that became done since the previous read of the same view: they fade in (design §4.9). */
  filled: ReadonlySet<number>;
  /** Attention rows that no longer match; they stay, shown as handled, until the view changes (§4.6). */
  dropped: ReadonlySet<number>;
}

export type ReaderLoad = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; error: LongTextErrorCode };

interface ReadResult { rows: SegmentRow[]; total: number; truncated: boolean }

const NONE: ReadonlySet<number> = new Set();

export function viewKey(view: ReaderView): string {
  if (view.kind === 'page') return `page:${view.page}`;
  if (view.kind === 'filter') return `filter:${view.filter}:${view.offset}`;
  return `search:${view.offset}:${view.text}`;
}

export function emptyRows(view: ReaderView): ReaderRows {
  return { view, rows: [], total: 0, truncated: false, filled: NONE, dropped: NONE };
}

/** The query filter of a result view. */
export function queryFilter(view: Exclude<ReaderView, { kind: 'page' }>): QueryFilter {
  return view.kind === 'search' ? { kind: 'search', text: view.text } : { kind: view.filter };
}

/**
 * Needs attention as the main process counts it (design §0.4): failed, or a flag that is not
 * dismissed on an unlocked segment; a locked one only counts `markup_missing`.
 */
export function needsAttention(row: Pick<SegmentRow, 'status' | 'flags' | 'locked'>): boolean {
  return row.status === 'failed' || row.flags.some(flag => !row.locked || flag.code === 'markup_missing');
}

/** Whether a `segments` event may have changed the rows of the page `info`. */
export function eventTouchesPage(event: Pick<LongTextChangeEvent, 'range' | 'pages'>, info: Pick<PageInfo, 'index' | 'start' | 'end'>): boolean {
  if (!event.range && !event.pages) return true;
  if (event.pages?.includes(info.index)) return true;
  return !!event.range && event.range.start <= info.end && event.range.end >= info.start;
}

/**
 * A fresh read of the same view laid over the previous one: rows that became done are `filled`;
 * in the attention view rows that left the results stay where they were and are `dropped`.
 */
export function mergeRefresh(previous: ReaderRows, view: ReaderView, next: ReadResult): ReaderRows {
  if (viewKey(previous.view) !== viewKey(view)) return { view, ...next, filled: NONE, dropped: NONE };
  const before = new Map(previous.rows.map(row => [row.index, row]));
  const filled = new Set<number>();
  for (const row of next.rows) {
    const old = before.get(row.index);
    if (old && old.status !== 'done' && row.status === 'done') filled.add(row.index);
  }
  let rows = next.rows;
  let dropped: ReadonlySet<number> = NONE;
  if (view.kind === 'filter' && view.filter === 'attention') {
    const present = new Set(next.rows.map(row => row.index));
    const kept = previous.rows.filter(row => !present.has(row.index));
    if (kept.length) {
      rows = [...next.rows, ...kept].sort((a, b) => a.index - b.index);
      dropped = new Set([...previous.dropped].filter(index => !present.has(index)).concat(kept.map(row => row.index)));
    }
  }
  return { view, rows, total: next.total, truncated: next.truncated, filled: filled.size ? filled : NONE, dropped };
}

/** The rows with `row` in place of the one with its index. */
export function replaceRow(rows: readonly SegmentRow[], row: SegmentRow): SegmentRow[] {
  return rows.map(item => item.index === row.index ? row : item);
}

/** The page to open a document on: the remembered one when it still exists. */
export function initialPage(remembered: number | undefined, pageCount: number): number {
  return remembered !== undefined && remembered >= 0 && remembered < pageCount ? remembered : 0;
}

function read(documentId: string, view: ReaderView): Promise<ReadResult> {
  if (view.kind === 'page') {
    return unwrap(window.longText.readPage({ documentId, page: view.page }))
      .then(result => ({ rows: result.rows, total: result.rows.length, truncated: false }));
  }
  return unwrap(window.longText.query({ documentId, filter: queryFilter(view), offset: view.offset, limit: Math.min(RESULT_PAGE_SIZE, LONG_TEXT_LIMITS.queryLimit) }))
    .then(result => ({ rows: result.rows, total: result.total, truncated: result.truncated }));
}

/**
 * The rows on screen (design §5.4–5.5): a page or a page of results, read again in place when change
 * events touch them. At most one read is in flight; events meanwhile mark the rows dirty and one more
 * read follows. Result views refresh at most every 500 ms. A view change replaces the rows and drops
 * whatever an older read returns.
 */
export function useReaderPage({ documentId, pages, revision, subscribe }: {
  documentId: string;
  pages: readonly PageInfo[];
  /** A new revision (settings saved, segmentation changed) reads the rows again. */
  revision: number;
  subscribe: (listener: ChangeListener) => () => void;
}) {
  const [view, setViewState] = useState<ReaderView>(() =>
    ({ kind: 'page', page: initialPage(useLongTextStore.getState().pageByDocument[documentId], pages.length) }));
  const [data, setData] = useState<ReaderRows>(() => emptyRows(view));
  const [load, setLoad] = useState<ReaderLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const latest = useRef({ view, pages });
  latest.current = { view, pages };
  const refreshing = useRef({ inFlight: false, dirty: false, timer: undefined as ReturnType<typeof setTimeout> | undefined, last: 0 });

  const key = viewKey(view);
  useEffect(() => {
    const id = ++sequence.current;
    const pending = refreshing.current;
    clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.dirty = false;
    setLoad({ status: 'loading' });
    read(documentId, view).then(result => {
      if (id !== sequence.current) return;
      setData({ view, ...result, filled: NONE, dropped: NONE });
      setLoad({ status: 'ready' });
    }, (error: unknown) => {
      if (id === sequence.current) setLoad({ status: 'failed', error: errorCodeOf(error) });
    });
    // The key stands for the view.
  }, [documentId, key, attempt]);

  const refresh = useCallback(function again() {
    const pending = refreshing.current;
    if (pending.inFlight) { pending.dirty = true; return; }
    pending.inFlight = true;
    pending.last = Date.now();
    const id = sequence.current;
    const current = latest.current.view;
    read(documentId, current)
      .then(result => { if (id === sequence.current) setData(previous => mergeRefresh(previous, current, result)); }, () => undefined)
      .finally(() => {
        pending.inFlight = false;
        if (pending.dirty) { pending.dirty = false; again(); }
      });
  }, [documentId]);

  /** Page views refresh at once; result views wait for their 500 ms. */
  const schedule = useCallback(() => {
    const pending = refreshing.current;
    if (latest.current.view.kind === 'page') { refresh(); return; }
    if (pending.timer) return;
    pending.timer = setTimeout(() => { pending.timer = undefined; refresh(); }, Math.max(0, pending.last + RESULT_REFRESH_MS - Date.now()));
  }, [refresh]);

  useEffect(() => subscribe(event => {
    if (event.documentId !== documentId || event.kind !== 'segments') return;
    const current = latest.current.view;
    if (current.kind === 'page') {
      const info = latest.current.pages[current.page];
      if (info && !eventTouchesPage(event, info)) return;
    }
    schedule();
  }), [subscribe, documentId, schedule]);

  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision !== firstRevision.current) refresh();
  }, [revision, refresh]);

  // A new segmentation can leave fewer pages.
  useEffect(() => {
    if (view.kind === 'page' && view.page >= pages.length && pages.length) setViewState({ kind: 'page', page: pages.length - 1 });
  }, [view, pages.length]);

  useEffect(() => {
    if (view.kind === 'page') useLongTextStore.getState().rememberPage(documentId, view.page);
  }, [documentId, view]);

  useEffect(() => () => clearTimeout(refreshing.current.timer), []);

  const setView = useCallback((next: ReaderView) => {
    setViewState(current => viewKey(current) === viewKey(next) ? current : next);
  }, []);

  /** Puts a row returned by a segment command in place. */
  const apply = useCallback((row: SegmentRow) => {
    setData(previous => previous.rows.some(item => item.index === row.index) ? { ...previous, rows: replaceRow(previous.rows, row) } : previous);
  }, []);

  return {
    view,
    setView,
    /** The rows of `view` once read; until then the previous rows stay on screen. */
    data,
    load,
    retry: useCallback(() => setAttempt(value => value + 1), []),
    refresh,
    apply,
  };
}
