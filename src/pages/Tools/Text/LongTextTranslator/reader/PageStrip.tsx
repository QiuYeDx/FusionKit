import { useState, type CSSProperties, type MouseEvent } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { PageInfo } from '@/long-text/contract';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { groupedCount } from '../page-context';

/** Every cell is at least this wide (design §4.6, U9). */
export const STRIP_CELL_MIN_PX = 4;
/** Narrower footers hide the strip. */
export const STRIP_MIN_WIDTH_PX = 560;
/** Cells this wide get a 1px gap; narrower ones touch. */
const GAP_FROM_PX = 8;

/** One cell of the strip: a page, or a bucket of consecutive pages. */
export interface StripCell {
  from: number;
  to: number;
  translatable: number;
  done: number;
  attention: number;
  inFlight: boolean;
  /** The first page of the cell with something needing attention. */
  firstAttention: number | null;
}

/**
 * The strip's cells for `width` pixels: one page per cell while each gets 4px, otherwise buckets of
 * `ceil(pages / floor(width / 4))` pages. None for a single page or a footer under 560px.
 */
export function stripCells(pages: readonly PageInfo[], width: number): StripCell[] {
  if (pages.length <= 1 || width < STRIP_MIN_WIDTH_PX) return [];
  const slots = Math.min(pages.length, Math.floor(width / STRIP_CELL_MIN_PX));
  const bucket = Math.ceil(pages.length / slots);
  const cells: StripCell[] = [];
  for (let from = 0; from < pages.length; from += bucket) {
    const cell: StripCell = { from, to: Math.min(pages.length, from + bucket) - 1, translatable: 0, done: 0, attention: 0, inFlight: false, firstAttention: null };
    for (let page = cell.from; page <= cell.to; page++) {
      const info = pages[page];
      cell.translatable += info.translatable;
      cell.done += info.done;
      cell.attention += info.attention;
      cell.inFlight ||= info.inFlight;
      if (info.attention > 0 && cell.firstAttention === null) cell.firstAttention = page;
    }
    cells.push(cell);
  }
  return cells;
}

/** Share of the cell's translatable segments that are done; a cell without any counts as done. */
export function cellRatio(cell: Pick<StripCell, 'translatable' | 'done'>): number {
  return cell.translatable ? Math.min(1, cell.done / cell.translatable) : 1;
}

/** Where a click on the cell goes: its first page needing attention, otherwise its first page. */
export function cellTarget(cell: Pick<StripCell, 'from' | 'firstAttention'>): number {
  return cell.firstAttention ?? cell.from;
}

/** The hover text of a cell, with page numbers from 1. */
export function cellLabel(t: TFunction<'text'>, language: string, cell: StripCell, pages: readonly PageInfo[]): string {
  if (cell.from !== cell.to) {
    return t('reader.strip_bucket', { from: cell.from + 1, to: cell.to + 1, percent: Math.floor(cellRatio(cell) * 100), attention: groupedCount(cell.attention, language) });
  }
  const title = pages[cell.from]?.title;
  return [
    t('reader.page', { page: cell.from + 1 }),
    title,
    `${cell.done.toLocaleString(language)}/${cell.translatable.toLocaleString(language)}`,
    cell.attention ? t('status.attention', { count: groupedCount(cell.attention, language) }) : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The 4px page progress strip (design §4.6): shade for the share done, a 2px amber top for anything
 * needing attention, a pulse while in flight, an outline on the current page. Pointer only; the page
 * picker is the keyboard way to the same pages.
 */
export function PageStrip({ pages, width, current, onJump }: {
  pages: readonly PageInfo[];
  width: number;
  /** The page on screen, when the reader shows a page. */
  current: number | null;
  onJump: (page: number) => void;
}) {
  const { t, i18n } = useTranslation('text');
  const [hover, setHover] = useState<number | null>(null);
  const cells = stripCells(pages, width);
  if (!cells.length) return null;
  const cellAt = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(cells.length - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * cells.length)));
  };
  const hovered = hover === null ? null : cells[hover];
  return <Tooltip open={!!hovered}>
    <div className="lt-strip" data-testid="long-text-page-strip" aria-hidden="true" data-gapped={width / cells.length >= GAP_FROM_PX || undefined}
      onPointerMove={event => setHover(cellAt(event))} onPointerLeave={() => setHover(null)}
      onClick={event => onJump(cellTarget(cells[cellAt(event)]))}>
      {cells.map(cell => <span key={cell.from} className="lt-strip-cell" style={{ '--lt-done': `${Math.round(cellRatio(cell) * 85)}%` } as CSSProperties}
        data-attention={cell.attention > 0 || undefined} data-in-flight={cell.inFlight || undefined}
        data-current={current !== null && current >= cell.from && current <= cell.to ? true : undefined} />)}
      {hovered && <TooltipTrigger asChild>
        <span key={hovered.from} className="lt-strip-anchor" style={{ left: `${((hover! + 0.5) / cells.length) * 100}%` }} />
      </TooltipTrigger>}
    </div>
    {hovered && <TooltipContent side="top" sideOffset={6}>{cellLabel(t, i18n.language, hovered, pages)}</TooltipContent>}
  </Tooltip>;
}
