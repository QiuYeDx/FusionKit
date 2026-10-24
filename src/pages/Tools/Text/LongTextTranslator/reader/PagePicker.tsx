import { useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { PageInfo } from '@/long-text/contract';
import { StudioScrollFade } from '../../../Subtitle/SubtitleStudio/StudioScrollFade';
import { searchKey } from './InlineText';

/** At most this many pages are listed; typing narrows the rest down (design §4.6). */
export const PICKER_LIMIT = 300;

/** Pages whose number or chapter title contains the query, the first `PICKER_LIMIT` of them. */
export function filterPages(pages: readonly PageInfo[], query: string): { items: PageInfo[]; more: boolean } {
  const needle = searchKey(query.trim());
  const matches = needle
    ? pages.filter(page => String(page.index + 1).includes(needle) || (page.title !== null && searchKey(page.title).includes(needle)))
    : pages;
  return { items: matches.slice(0, PICKER_LIMIT), more: matches.length > PICKER_LIMIT };
}

/** The page a typed number (full-width digits too) names, from 0; null when it is not a page number. */
export function pageNumber(query: string, count: number): number | null {
  const text = query.trim().normalize('NFKC');
  if (!/^\d+$/.test(text)) return null;
  const page = Number(text) - 1;
  return page >= 0 && page < count ? page : null;
}

/** "3 · 第三章", or "3 / 40" for a page without a chapter title. */
export function pageLabel(t: TFunction<'text'>, page: PageInfo, count: number): string {
  return page.title ? t('reader.page_title', { page: page.index + 1, title: page.title }) : `${page.index + 1} / ${count}`;
}

/**
 * The footer's page button and its picker (design §4.6): filter by number or chapter name, Enter on
 * a page number jumps there. `onJump` says whether the keyboard chose, so the reader can focus the
 * new page's first row.
 */
export function PagePicker({ pages, current, onJump }: {
  pages: readonly PageInfo[];
  current: number;
  onJump: (page: number, keyboard: boolean) => void;
}) {
  const { t, i18n } = useTranslation('text');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  /** A keyboard jump hands focus to the new page's first row instead of the trigger. */
  const handedOff = useRef(false);
  const { items, more } = useMemo(() => filterPages(pages, query), [pages, query]);
  const page = pages[current];
  if (!page) return null;
  const label = pageLabel(t, page, pages.length);
  const jump = (target: number, keyboard: boolean) => {
    handedOff.current = keyboard;
    setOpen(false);
    onJump(target, keyboard);
  };
  const percent = (info: PageInfo) => `${Math.floor((info.translatable ? info.done / info.translatable : 1) * 100)}%`;
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}>
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" className="lt-page-trigger" data-testid="long-text-page-picker" aria-label={`${t('reader.page_picker')}: ${label}`}>
            <span>{label}</span><ChevronDown />
          </Button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{t('reader.page_picker')}</TooltipContent>
    </Tooltip>
    <PopoverContent side="top" align="end" collisionPadding={8} className="lt-page-picker" data-testid="long-text-page-picker-content"
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}
      onCloseAutoFocus={event => {
        if (handedOff.current) event.preventDefault();
        handedOff.current = false;
      }}>
      <Input ref={input} value={query} maxLength={120} aria-label={t('reader.page_picker_placeholder')} placeholder={t('reader.page_picker_placeholder')}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const target = pageNumber(query, pages.length) ?? items[0]?.index;
          if (target !== undefined) jump(target, true);
        }} />
      {items.length > 0 && <StudioScrollFade className="lt-page-options" maxHeight={280}>
        <div className="lt-page-options-list">
          {items.map(info => <button key={info.index} type="button" className="lt-page-option" aria-current={info.index === current ? 'true' : undefined}
            onClick={event => jump(info.index, event.detail === 0)}>
            <span>{(info.index + 1).toLocaleString(i18n.language)}</span>
            <span>{info.title ?? t('reader.page', { page: info.index + 1 })}</span>
            <span>{percent(info)}</span>
          </button>)}
        </div>
      </StudioScrollFade>}
      {more && <p className="lt-page-hint">{t('reader.page_picker_more')}</p>}
    </PopoverContent>
  </Popover>;
}
