import { useRef, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { BellOff, ClipboardCopy, Copy, ListRestart, Lock, LockOpen, LocateFixed, PencilLine, RotateCcw, Undo2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SegmentRow } from '@/long-text/contract';
import { modelErrorGuide } from '@/services/ai-error-guide';
import { errorCodeOf, LongTextClientError, unwrap } from '@/services/long-text/client';
import { showToast } from '@/utils/toast';
import { isTranslating } from '../hooks/useDocuments';
import { ERROR_LABELS } from '../labels';
import { useLongTextPage, type LongTextPage, type RowOverlay } from '../page-context';

/** The row buttons an overlay anchors at. */
export type RowAnchor = 'retranslate' | 'menu';

/**
 * Where an overlay of a row opens: under the ⟲ button, right-aligned, for the retranslate popover; at
 * the ⋯ button's bottom-left for the menu. The ⟲ button is missing on some rows; the ⋯ one stands in.
 */
export function rowAnchor(index: number, anchor: RowAnchor): RowOverlay['point'] | null {
  const row = document.querySelector(`[data-row-index="${index}"]`);
  const button = row?.querySelector<HTMLElement>(`[data-row-action="${anchor}"]`) ?? row?.querySelector<HTMLElement>('[data-row-action="menu"]');
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return anchor === 'retranslate' ? { x: rect.right, y: rect.bottom } : { x: rect.left, y: rect.bottom };
}

/**
 * The message for a failed segment command: busy and stale rows say so in their own words (§2 F8),
 * and a failed retranslation names the model error's cause as the run notice does.
 */
export function rowErrorText(t: TFunction<'text'>, error: unknown): string {
  const code = errorCodeOf(error);
  if (code === 'busy') return t('row.busy');
  if (code === 'revision_conflict') return t('row.conflict');
  if (code === 'model_failed' && error instanceof LongTextClientError && error.category) {
    return t(modelErrorGuide(error.category, undefined, 'runtime').causeKey);
  }
  return t(ERROR_LABELS[code]);
}

/**
 * Whether a closed overlay may put focus back on its row: only when focus went away with it (Esc, an
 * item, submit), never when the user moved it into something else, another row's overlay included.
 */
export const focusWentWithOverlay = () => !document.activeElement || document.activeElement === document.body;

/** Runs a segment command and shows its row; a failure is a toast, and the change events bring the latest row. */
export async function segmentCommand(page: Pick<LongTextPage, 'reader'>, t: TFunction<'text'>, command: () => Promise<SegmentRow>): Promise<SegmentRow | null> {
  try {
    const row = await command();
    page.reader?.apply(row);
    return row;
  } catch (error) {
    showToast(rowErrorText(t, error), 'error');
    return null;
  }
}

/** Locks or unlocks a translated row (L, or the menu). */
export function toggleLock(page: Pick<LongTextPage, 'reader'>, t: TFunction<'text'>, documentId: string, row: SegmentRow): Promise<SegmentRow | null> {
  return segmentCommand(page, t, () => unwrap(window.longText.setLocked({ documentId, index: row.index, rev: row.rev, locked: !row.locked })));
}

/** Dismisses every flag of the row, one after the other, each on the revision the previous one left. */
export function dismissFlags(page: Pick<LongTextPage, 'reader'>, t: TFunction<'text'>, documentId: string, row: SegmentRow): Promise<SegmentRow | null> {
  return segmentCommand(page, t, async () => {
    let current = row;
    for (const flag of row.flags) current = await unwrap(window.longText.dismissFlag({ documentId, index: row.index, rev: current.rev, code: flag.code }));
    return current;
  });
}

/** Row-level copy happens here in the renderer (design §2 F10-3). */
export function copyText(page: Pick<LongTextPage, 'announce'>, t: TFunction<'text'>, text: string): void {
  navigator.clipboard.writeText(text).then(() => {
    showToast(t('row.copied'), 'success');
    page.announce(t('row.copied'));
  }, () => showToast(t('errors.copy_failed'), 'error'));
}

/** Whether a row has a translation that locking, copying and undo work on. */
export const hasTranslation = (row: Pick<SegmentRow, 'target' | 'status'>) => row.status === 'done' && row.target !== null;

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The row menu shared by the ⋯ button, Shift+F10 and the context menu (design §4.2): a page-level
 * controlled `DropdownMenu` on a fixed anchor at the overlay's point. Focus returns to the row unless
 * an item hands it on (editor, popover, dialog).
 */
export function RowMenu() {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const menu = page.rowMenu;
  const last = useRef(menu);
  if (menu) last.current = menu;
  const shown = menu ?? last.current;
  const handedOff = useRef(false);
  const detail = page.detail;
  if (!detail) return null;
  const documentId = detail.id;
  const running = isTranslating(detail);

  const close = () => page.setRowMenu(null);
  const handOff = (action: () => void) => {
    handedOff.current = true;
    close();
    action();
  };
  const items = (overlay: RowOverlay) => {
    const { row, inList } = overlay;
    if (row.status === 'translating') {
      return <DropdownMenuItem onSelect={() => copyText(page, t, row.source)}><ClipboardCopy />{t('row.copy_source')}</DropdownMenuItem>;
    }
    const translated = hasTranslation(row);
    const retranslate = () => handOff(() => page.setRetranslateTarget({ row, point: rowAnchor(row.index, 'retranslate') ?? overlay.point, inList }));
    const fromHere = () => handOff(() => {
      page.reader?.focusRow(row.index);
      page.openDialog({ kind: 'confirm', action: 'from', index: row.index, ordinal: row.ordinal, count: Math.max(1, detail.counts.translatable - row.ordinal + 1) });
    });
    return <>
      <DropdownMenuItem data-testid="long-text-menu-retranslate" onSelect={retranslate}><RotateCcw />{t('row.retranslate')}</DropdownMenuItem>
      <DropdownMenuItem data-testid="long-text-menu-edit" onSelect={() => handOff(() => page.reader?.edit(row.index))}><PencilLine />{t('row.edit')}</DropdownMenuItem>
      <DropdownMenuItem data-testid="long-text-menu-lock" disabled={!translated} onSelect={() => void toggleLock(page, t, documentId, row)}>
        {row.locked ? <LockOpen /> : <Lock />}{t(row.locked ? 'row.unlock' : 'row.lock')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!translated} onSelect={() => copyText(page, t, row.target ?? '')}><Copy />{t('row.copy')}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => copyText(page, t, row.source)}><ClipboardCopy />{t('row.copy_source')}</DropdownMenuItem>
      {row.canUndo && <DropdownMenuItem data-testid="long-text-menu-undo"
        onSelect={() => void segmentCommand(page, t, () => unwrap(window.longText.undo({ documentId, index: row.index, rev: row.rev })))}>
        <Undo2 />{t('row.undo')}
      </DropdownMenuItem>}
      {row.flags.length > 0 && <DropdownMenuItem data-testid="long-text-menu-dismiss" onSelect={() => void dismissFlags(page, t, documentId, row)}><BellOff />{t('row.dismiss')}</DropdownMenuItem>}
      <DropdownMenuSeparator />
      <DropdownMenuItem data-testid="long-text-menu-from" disabled={running} onSelect={fromHere}><ListRestart />{t('row.from_here')}</DropdownMenuItem>
      {running && <p className="lt-menu-note" role="note">{t('row.from_here_running')}</p>}
      {inList && <DropdownMenuItem data-testid="long-text-menu-locate" onSelect={() => handOff(() => page.reader?.locate(row.index, row.page))}>
        <LocateFixed />{t('row.locate')}
      </DropdownMenuItem>}
    </>;
  };

  return <DropdownMenu key={shown ? `${shown.row.index}:${shown.point.x}:${shown.point.y}` : 'none'} open={!!menu} modal={false} onOpenChange={open => { if (!open) close(); }}>
    {createPortal(<DropdownMenuTrigger tabIndex={-1} aria-hidden="true"
      style={{ position: 'fixed', left: shown?.point.x ?? 0, top: shown?.point.y ?? 0, width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />, document.body)}
    <DropdownMenuContent align="start" side="bottom" sideOffset={2} collisionPadding={8} className="min-w-52" data-testid="long-text-row-menu-content"
      onPointerDown={stop} onContextMenu={event => { event.preventDefault(); stop(event); }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (!handedOff.current && shown && focusWentWithOverlay()) page.reader?.focusRow(shown.row.index);
        handedOff.current = false;
      }}>
      {shown && items(shown)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
