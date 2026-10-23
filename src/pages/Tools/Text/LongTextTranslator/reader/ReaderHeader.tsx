import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BookA, Copy, Download, Ellipsis, Eraser, FileCode2, FolderOpen, PencilLine, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentDetail } from '@/long-text/contract';
import { labelKey } from '@/long-text/languages';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { useLongTextStore } from '@/store/tools/text/useLongTextStore';
import { showToast } from '@/utils/toast';
import { StudioFileName, StudioIconButton } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { compactCount } from '../dialogs/estimate-text';
import { isTranslating } from '../hooks/useDocuments';
import { ERROR_LABELS } from '../labels';
import { groupedCount, useLongTextPage, type PageDialog } from '../page-context';

/** The panel title: the document's name, then one line of facts (design §3.3-B). */
export function ReaderTitle({ detail }: { detail: DocumentDetail }) {
  const { t, i18n } = useTranslation('text');
  const { languages, stats } = detail;
  return <div className="lt-heading" data-testid="long-text-reader-title">
    <h2><StudioFileName name={detail.name} focusable /></h2>
    <div className="lt-heading-meta">
      <span className="lt-heading-format">{detail.format === 'markdown' ? 'Markdown' : 'TXT'}</span>
      <span>{detail.encoding ? detail.encoding.name.toUpperCase() : t('meta.pasted')}</span>
      <span>{t('meta.segments', { count: groupedCount(stats.translatable, i18n.language) })}</span>
      <span>{t('meta.characters', { count: compactCount(stats.characters, i18n.language) })}</span>
      <span>{t('meta.direction', { source: t(labelKey(languages.source)), target: t(labelKey(languages.target)) })}</span>
    </div>
  </div>;
}

/** The header's three 28px actions: export, glossary, and the document menu (design §3.1, U2). */
export function ReaderActions({ detail }: { detail: DocumentDetail }) {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const targetOnly = useLongTextStore(state => state.view.targetOnly);
  const translating = isTranslating(detail);
  const trigger = useRef<HTMLButtonElement>(null);
  const handedOff = useRef(false);
  /** The dialog returns focus to the ⋯ button, not to the menu item that opened it. */
  const open = (dialog: PageDialog) => {
    handedOff.current = true;
    trigger.current?.focus({ preventScroll: true });
    page.openDialog(dialog);
  };
  const copyAll = () => {
    unwrap(window.longText.copy({ documentId: detail.id, mode: 'target' })).then(({ characters }) => {
      const text = t('notices.copied_all', { count: compactCount(characters, i18n.language) });
      showToast(text, 'success');
      page.announce(text);
    }, (error: unknown) => {
      // The main process reports a clipboard it could not write as `internal`.
      const code = errorCodeOf(error);
      showToast(t(code === 'internal' ? 'errors.copy_failed' : ERROR_LABELS[code]), 'error');
    });
  };
  const revealSource = () => void unwrap(window.longText.reveal({ documentId: detail.id, target: 'source' })).catch(page.reportError);
  return <>
    <StudioIconButton data-testid="long-text-export" label={t('header.export')} onClick={() => page.openDialog({ kind: 'export' })}><Download /></StudioIconButton>
    <StudioIconButton data-testid="long-text-ledger" label={t('header.ledger')} onClick={() => page.openDialog({ kind: 'ledger' })}><BookA /></StudioIconButton>
    <DropdownMenu modal={false}>
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button ref={trigger} variant="ghost" size="icon-sm" data-testid="long-text-more" aria-label={t('header.more')}><Ellipsis /></Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t('header.more')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8} className="min-w-48" data-testid="long-text-more-menu"
        onCloseAutoFocus={event => { if (handedOff.current) { handedOff.current = false; event.preventDefault(); } }}>
        <DropdownMenuCheckboxItem data-testid="long-text-target-only" checked={targetOnly}
          onCheckedChange={checked => useLongTextStore.getState().setView({ targetOnly: checked === true })}>
          {t('header.target_only')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => open({ kind: 'rename' })}><PencilLine />{t('header.rename')}</DropdownMenuItem>
        {detail.source.kind === 'file' && <>
          <DropdownMenuItem disabled={translating} onSelect={() => open({ kind: 'encoding' })}><FileCode2 />{t('header.encoding')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={revealSource}><FolderOpen />{t('header.reveal_source')}</DropdownMenuItem>
        </>}
        <DropdownMenuItem disabled={detail.counts.done === 0} onSelect={copyAll}><Copy />{t('header.copy_all')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={translating || detail.counts.done + detail.counts.failed === 0} onSelect={() => open({ kind: 'confirm', action: 'clear' })}>
          <Eraser />{t('header.clear')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" data-testid="long-text-delete"
          onSelect={() => open({ kind: 'confirm', action: 'delete', documentId: detail.id, name: detail.name })}>
          <Trash2 />{t('header.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}
