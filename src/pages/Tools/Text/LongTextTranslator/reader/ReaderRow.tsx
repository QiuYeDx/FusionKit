import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ellipsis, Lock, PencilLine, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FlagCode, LongTextFormat, SegmentRow } from '@/long-text/contract';
import { StudioIconButton } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { isEditableTarget } from '../hooks/usePageShortcuts';
import { FAILURE_LABELS, FLAG_LABELS, REPAIR_KIND_LABELS, ROW_STATUS_LABELS, VERBATIM_LABELS } from '../labels';
import { InlineText } from './InlineText';
import { RowEditor, type EditorNext } from './RowEditor';
import { needsAttention } from './useReaderPage';

type RowFlag = SegmentRow['flags'][number];

/** What a row asks the reader to do; one stable object for every row. */
export interface RowHandlers {
  focus: (index: number) => void;
  /** A context menu at the pointer, or at the ⋯ button when the keyboard asked for it. */
  contextMenu: (row: SegmentRow, point: { x: number; y: number } | null) => void;
  menu: (row: SegmentRow) => void;
  retranslate: (row: SegmentRow) => void;
  /** "重试" on a failed row: translate it again at once. */
  retry: (row: SegmentRow) => void;
  edit: (row: SegmentRow) => void;
  save: (row: SegmentRow, text: string, next?: EditorNext) => void;
  cancel: (row: SegmentRow) => void;
  draft: (text: string) => void;
  dismiss: (row: SegmentRow, code: FlagCode) => void;
  toggleExpanded: (index: number) => void;
}

/** A list of short items in the interface language ("代码和链接"). */
const listOf = (items: readonly string[], language: string) => new Intl.ListFormat(language, { type: 'conjunction' }).format(items);

/** The sentence of a quality flag with its details (design §7). */
export function flagText(t: TFunction<'text'>, language: string, flag: RowFlag): string {
  const detail = flag.detail ?? {};
  switch (flag.code) {
    case 'length_short':
    case 'length_long':
      return t(FLAG_LABELS[flag.code], { ratio: 'ratio' in detail ? detail.ratio.toFixed(2) : '' });
    case 'term_missing': {
      const terms = 'source' in detail ? detail : { source: '', target: '', more: 0 };
      return terms.more > 0
        ? t('flags.term_missing_more', { source: terms.source, target: terms.target, count: terms.more })
        : t(FLAG_LABELS.term_missing, { source: terms.source, target: terms.target });
    }
    case 'placeholder_repaired': {
      const kinds = 'kinds' in detail ? [...new Set(detail.kinds.map(kind => t(REPAIR_KIND_LABELS[kind])))] : [];
      return t(FLAG_LABELS.placeholder_repaired, { kinds: listOf(kinds, language) });
    }
    case 'markup_missing':
      return t(FLAG_LABELS.markup_missing, { items: 'items' in detail ? detail.items.join('  ') : '' });
    case 'untranslated':
      return t(FLAG_LABELS.untranslated);
  }
}

/** The row's accessible name: "第 27 段，已完成，需关注：可能漏译…" (design §4.1). */
export function rowLabel(t: TFunction<'text'>, language: string, row: SegmentRow): string {
  // `ordinal` is also i18next's ordinal-plural switch, so the values go through `replace`.
  const label = t('reader.row_label', { replace: { ordinal: row.ordinal.toLocaleString(language), status: t(ROW_STATUS_LABELS[row.status]) } });
  if (!needsAttention(row)) return label;
  const flag = row.flags.find(item => !row.locked || item.code === 'markup_missing');
  const reason = row.failure ? t(FAILURE_LABELS[row.failure.code]) : flag ? flagText(t, language, flag) : t(ROW_STATUS_LABELS.failed);
  return label + t('reader.row_attention', { reason });
}

/** The gutter dot: failed, needs attention, in flight, or still to translate. */
export function rowDot(row: SegmentRow): 'failed' | 'attention' | 'translating' | 'pending' | null {
  if (row.status === 'failed') return 'failed';
  if (row.status === 'translating') return 'translating';
  if (needsAttention(row)) return 'attention';
  return row.status === 'pending' ? 'pending' : null;
}

/** A context menu the keyboard opened: Chromium sends it as a pointer event without a pointer type. */
export function isKeyboardContextMenu(event: MouseEvent): boolean {
  return 'pointerType' in event && event.pointerType === '';
}

/** List items indent 14px per nesting level (design §3.6). */
const indent = (row: SegmentRow): CSSProperties | undefined =>
  row.kind === 'list_item' && row.level > 1 ? { paddingLeft: (row.level - 1) * 14 } : undefined;

/** A 10px state icon of the gutter with its meaning on hover; the row's own label speaks for it. */
function GutterIcon({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild><span className="lt-gutter-icon">{children}</span></TooltipTrigger>
    <TooltipContent sideOffset={4}>{label}</TooltipContent>
  </Tooltip>;
}

/** A verbatim block: monospace, three lines until expanded. */
function VerbatimBlock({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation('text');
  const block = useRef<HTMLPreElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = block.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [expanded, text]);
  return <div className="lt-verbatim">
    <pre ref={block} data-clipped={overflows && !expanded ? true : undefined} data-expanded={expanded || undefined}>{text}</pre>
    {(overflows || expanded) && <Button variant="ghost" size="xs" aria-expanded={expanded} onClick={onToggle}>{t(expanded ? 'reader.collapse' : 'reader.expand')}</Button>}
  </div>;
}

export interface ReaderRowProps {
  row: SegmentRow;
  format: LongTextFormat;
  /** The roving tab stop of the list. */
  tabbable: boolean;
  editing: boolean;
  /** Just translated: the target fades in. */
  filled: boolean;
  /** A jump landed here. */
  flash: boolean;
  /** No longer needing attention in the attention view. */
  handled: boolean;
  /** Filter or search results: the row shows its page. */
  inList: boolean;
  search?: string;
  targetOnly: boolean;
  /** Its menu or retranslate popover is open; the action column stays visible. */
  overlayOpen: boolean;
  expanded: boolean;
  handlers: RowHandlers;
}

/**
 * One segment (design §3.3, §3.6): ordinal and status in the gutter, source and target side by side
 * (stacked in a narrow reader), flags and failures under the target, and the action column.
 */
export const ReaderRow = memo(function ReaderRow(props: ReaderRowProps) {
  const { row, format, tabbable, editing, filled, flash, handled, inList, search, targetOnly, overlayOpen, expanded, handlers } = props;
  const { t, i18n } = useTranslation('text');

  if (!row.translatable) {
    const kind = t(VERBATIM_LABELS[row.verbatimKind ?? 'other']);
    return <div role="listitem" className="lt-row" data-row-index={row.index} data-kind="verbatim" aria-label={kind}>
      <div className="lt-gutter" aria-hidden="true"><span className="lt-verbatim-kind">{kind}</span></div>
      <VerbatimBlock text={row.source} expanded={expanded} onToggle={() => handlers.toggleExpanded(row.index)} />
    </div>;
  }

  const dot = rowDot(row);
  const failed = row.status === 'failed';
  const marker = row.marker ? <span className="lt-marker">{row.marker}</span> : null;
  const target = row.status === 'translating'
    ? <div className="lt-skeleton animate-pulse motion-reduce:animate-none" aria-hidden="true"><span /><span /></div>
    : failed && row.failure
      ? <p className="lt-failure">
        <span>{t(FAILURE_LABELS[row.failure.code])}</span>
        <Button variant="link" size="xs" tabIndex={-1} onClick={() => handlers.retry(row)}>{t('row.retry')}</Button>
      </p>
      : row.target !== null
        ? <div className={filled ? 'lt-text lt-fill' : 'lt-text'}>{targetOnly && marker}<InlineText text={row.target} kind={row.kind} format={format} search={search} /></div>
        : targetOnly
          ? <div className="lt-text lt-untranslated">{marker}<InlineText text={row.source} kind={row.kind} format={format} search={search} /><span className="lt-tag">{t('reader.untranslated_tag')}</span></div>
          : <div className="lt-text lt-pending">{t('reader.pending')}</div>;

  return <div role="listitem" className="lt-row" data-row-index={row.index} data-kind={row.kind}
    data-level={row.kind === 'heading' ? Math.min(row.level, 3) : undefined} data-status={row.status}
    data-locked={row.locked || undefined} data-handled={handled || undefined} data-flash={flash || undefined}
    data-focused={editing || undefined} data-target-only={targetOnly || undefined}
    tabIndex={tabbable ? 0 : -1} aria-label={rowLabel(t, i18n.language, row)}
    onFocus={() => handlers.focus(row.index)}
    onContextMenu={event => {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      // Shift+F10 and the menu key may also fire this, with no pointer: the reader's key opened it already.
      handlers.contextMenu(row, isKeyboardContextMenu(event.nativeEvent) ? null : { x: event.clientX, y: event.clientY });
    }}>
    <div className="lt-gutter" aria-hidden="true">
      <span className="lt-ordinal">{row.ordinal.toLocaleString(i18n.language)}</span>
      <span className="lt-gutter-marks">
        {dot && <span className={dot === 'translating' ? 'lt-dot animate-pulse motion-reduce:animate-none' : 'lt-dot'} data-state={dot} />}
        {row.origin === 'user' && <GutterIcon label={t('row.edited')}><PencilLine /></GutterIcon>}
        {row.locked && <GutterIcon label={t('row.locked')}><Lock /></GutterIcon>}
      </span>
      {inList && <span className="lt-gutter-page">{t('search.page_tag', { page: row.page + 1 })}</span>}
    </div>
    {!targetOnly && <div className="lt-source lt-text" style={indent(row)}>
      {marker}<InlineText text={row.source} kind={row.kind} format={format} search={search} />
    </div>}
    <div className="lt-target" style={targetOnly ? indent(row) : undefined}
      onDoubleClick={() => { if (!editing && row.status !== 'translating') handlers.edit(row); }}>
      {editing
        ? <RowEditor initial={row.target ?? ''} onSave={(text, next) => handlers.save(row, text, next)} onCancel={() => handlers.cancel(row)} onDraft={handlers.draft} />
        : target}
      {!editing && row.flags.length > 0 && <div className="lt-flags">
        {row.flags.map(flag => <p key={flag.code} className="lt-flag" data-code={flag.code}>
          <AlertTriangle aria-hidden="true" />
          <span>{flagText(t, i18n.language, flag)}</span>
          <Button variant="ghost" size="xs" tabIndex={-1} onClick={() => handlers.dismiss(row, flag.code)}>{t('flags.dismiss')}</Button>
        </p>)}
      </div>}
      {handled && <span className="lt-tag" data-testid="long-text-row-handled">{t('filter.handled')}</span>}
    </div>
    <div className="lt-actions" data-open={overlayOpen || undefined}>
      {(row.status === 'done' || failed) && <StudioIconButton size="icon-xs" tabIndex={-1} data-row-action="retranslate" data-testid="long-text-row-retranslate"
        label={t(failed ? 'row.retry' : 'row.retranslate')} onClick={() => (failed ? handlers.retry(row) : handlers.retranslate(row))}>
        <RotateCcw />
      </StudioIconButton>}
      <StudioIconButton size="icon-xs" tabIndex={-1} data-row-action="menu" data-testid="long-text-row-menu" label={t('row.menu')} onClick={() => handlers.menu(row)}>
        <Ellipsis />
      </StudioIconButton>
    </div>
  </div>;
});
