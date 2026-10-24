import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { SegmentRow } from '@/long-text/contract';
import { useLongTextStore } from '@/store/tools/text/useLongTextStore';
import type { ReaderRows, ReaderView } from './useReaderPage';

/** Following scrolls at most this often (design §4.5). */
export const FOLLOW_SCROLL_MS = 600;

/** The page following should show: the run's frontier page, when the reader is on another page. */
export function followPage({ following, view, editing, frontierPage }: {
  following: boolean;
  view: ReaderView;
  editing: boolean;
  frontierPage: number | null;
}): number | null {
  if (!following || editing || view.kind !== 'page' || frontierPage === null || frontierPage === view.page) return null;
  return frontierPage;
}

/** The row following scrolls to: the first one in flight, else the first one just filled. */
export function followRow(rows: readonly SegmentRow[], filled: ReadonlySet<number>): number | null {
  return rows.find(row => row.status === 'translating')?.index ?? rows.find(row => filled.has(row.index))?.index ?? null;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Following the run (design §4.5): while on and the reader shows a page, it moves to the run's
 * frontier page and keeps the row in flight in view. Wheel, touch and scrollbar drags on the reader
 * turn it off (as the reader does for keys, page changes, filters and the editor); the pill turns it
 * back on. The preference outlives the run.
 */
export function useFollowProgress({ running, frontierPage, view, editing, data, viewport, showPage }: {
  running: boolean;
  frontierPage: number | null;
  view: ReaderView;
  editing: boolean;
  data: ReaderRows;
  viewport: RefObject<HTMLDivElement | null>;
  /** Shows a page without counting as the user's move. */
  showPage: (page: number) => void;
}) {
  const follow = useLongTextStore(state => state.follow);
  const following = running && follow;
  const runningRef = useRef(running);
  runningRef.current = running;

  /** The user took over: only a running document stops following. */
  const stop = useCallback(() => {
    if (runningRef.current && useLongTextStore.getState().follow) useLongTextStore.getState().setFollow(false);
  }, []);
  const resume = useCallback(() => useLongTextStore.getState().setFollow(true), []);

  const target = followPage({ following, view, editing, frontierPage });
  useEffect(() => {
    if (target !== null) showPage(target);
  }, [target, showPage]);

  const lastScroll = useRef(0);
  useEffect(() => {
    if (!following || editing || view.kind !== 'page' || data.view.kind !== 'page') return;
    const index = followRow(data.rows, data.filled);
    if (index === null) return;
    const timer = setTimeout(() => {
      lastScroll.current = Date.now();
      viewport.current?.querySelector(`[data-row-index="${index}"]`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, Math.max(0, lastScroll.current + FOLLOW_SCROLL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [following, editing, view, data, viewport]);

  useEffect(() => {
    const element = viewport.current;
    const root = element?.closest<HTMLElement>('[data-slot=scroll-area]');
    if (!element || !root) return;
    const scrollbar = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest('[data-slot=scroll-area-scrollbar]')) stop();
    };
    element.addEventListener('wheel', stop, { passive: true });
    element.addEventListener('touchmove', stop, { passive: true });
    root.addEventListener('pointerdown', scrollbar);
    return () => {
      element.removeEventListener('wheel', stop);
      element.removeEventListener('touchmove', stop);
      root.removeEventListener('pointerdown', scrollbar);
    };
  }, [viewport, stop]);

  return { follow, following, stop, resume, pill: running && !follow };
}
