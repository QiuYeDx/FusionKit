import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DocumentSummary } from '@/long-text/contract';
import { showToast } from '@/utils/toast';
import ToolPageHeader from '../../_shared/ToolPageHeader';
import { TOOL_META } from '../../_shared/toolMeta';
import { ToolDetailLayout } from '../../_shared/ui/ToolDetailLayout';
import { useToolFileDropTarget } from '../../_shared/ui/ToolFileDropScope';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { StudioFileName } from '../../Subtitle/SubtitleStudio/StudioControls';
import { DocumentLibrary } from './DocumentLibrary';
import { LibraryDialog } from './LibraryDialog';
import { LiveRegion } from './LiveRegion';
import { MobileControls } from './MobileControls';
import { Notices } from './Notices';
import { PasteDialog } from './PasteDialog';
import { StartPanel } from './StartPanel';
import { useLongTextAgentContext } from './agent-context';
import { ConfirmDialog } from './dialogs/ConfirmDialog';
import { EncodingDialog } from './dialogs/EncodingDialog';
import { ExportDialog } from './dialogs/ExportDialog';
import { LedgerDialog } from './dialogs/LedgerDialog';
import { RenameDialog } from './dialogs/RenameDialog';
import { RunConfirmDialog } from './dialogs/RunConfirmDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { isTranslating } from './hooks/useDocuments';
import { usePageShortcuts } from './hooks/usePageShortcuts';
import { ERROR_LABELS } from './labels';
import { LongTextPageProvider, useLongTextPage, useSettledFlag } from './page-context';
import { ReaderPanel } from './reader/ReaderPanel';
import { RetranslatePopover } from './reader/RetranslatePopover';
import { RowMenu } from './reader/RowMenu';
import './long-text.css';

/** Long text translator (长文本翻译): TXT, Markdown or pasted text read and reviewed side by side with its translation. */
export default function LongTextTranslator() {
  return <LongTextPageProvider><LongTextPage /></LongTextPageProvider>;
}

/** Runs continue in the main process; leaving the page while one does says so. */
function useBackgroundNotice(documents: readonly DocumentSummary[]) {
  const { t } = useTranslation('text');
  const notice = t('notices.background');
  const latest = useRef({ documents, notice });
  latest.current = { documents, notice };
  useEffect(() => () => {
    if (latest.current.documents.some(isTranslating)) showToast(latest.current.notice);
  }, []);
}

/** The last non-null value, so a card keeps its content while it fades out. */
function useRetained<T>(value: T | null): T | null {
  const [retained, setRetained] = useState(value);
  if (value !== null && value !== retained) setRetained(value);
  return value ?? retained;
}

type Overlay =
  | { kind: 'loading'; name: string | null }
  | { kind: 'importing' }
  | { kind: 'failed'; name: string | null; message: string };

/** A document the main process cannot open: an explanation and the only thing left to do (design §4.7). */
function UnavailablePanel({ summary }: { summary: DocumentSummary }) {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  return <ToolPanel title={<StudioFileName name={summary.name} />} bodyClassName="lt-unavailable">
    <AlertCircle aria-hidden="true" />
    <p>{t(summary.unavailable === 'newer_version' ? 'library.unavailable_newer' : 'library.unavailable_damaged')}</p>
    <Button variant="outline" size="sm" className="text-destructive" onClick={() => page.openDialog({ kind: 'confirm', action: 'delete', documentId: summary.id, name: summary.name })}>
      <Trash2 />{t('header.delete')}
    </Button>
  </ToolPanel>;
}

function LongTextPage() {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const { documents, activeId, detail, detailState } = page;
  const { dropProps, dragging } = useToolFileDropTarget({
    label: t('import.drop_label'),
    pageWide: true,
    disabled: page.importBusy,
    onDrop: event => page.importDropped(Array.from(event.dataTransfer.files)),
  });
  // While another document loads, the one still on screen is not what search and the assistant work on.
  const current = detail?.id === activeId ? detail : null;
  usePageShortcuts({ canFind: !!current, onFind: page.requestSearch, onPaste: text => page.openDialog({ kind: 'paste', text }) });
  useBackgroundNotice(documents);
  useLongTextAgentContext(current);

  const active = documents.find(summary => summary.id === activeId);
  const opening = useSettledFlag(detailState.status === 'loading');
  const importing = page.importing !== null;
  const name = active?.name ?? null;
  const overlay = useMemo((): Overlay | null => {
    if (detailState.status === 'failed') return { kind: 'failed', name, message: t(ERROR_LABELS[detailState.error]) };
    if (importing) return { kind: 'importing' };
    return opening ? { kind: 'loading', name } : null;
  }, [detailState, importing, opening, name, t]);
  const shownOverlay = useRetained(overlay);
  const pending = !!overlay;

  const content = page.listState === 'loading' ? null
    : !documents.length ? <StartPanel dragging={dragging} />
      : active?.unavailable ? <UnavailablePanel summary={active} />
        : detail ? <ReaderPanel /> : null;

  return <div className="lt" data-testid="long-text" {...dropProps}>
    <ToolDetailLayout
      className="lt-layout"
      asideClassName="order-2 hidden lg:order-1 lg:flex lg:flex-col"
      mainClassName="lt-main order-1 lg:order-2"
      header={<ToolPageHeader meta={TOOL_META.textTranslator} title={t('title')} description={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{t('description')}</span>
        <Link to="/tools/translation-knowledge" className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">{t('materials_link')}</Link>
      </span>} />}
      aside={page.wide ? <DocumentLibrary /> : undefined}
    >
      <MobileControls />
      <Notices />
      <div className="lt-doc-region" data-pending={pending || undefined} aria-busy={pending && overlay?.kind !== 'failed'}>
        <div className="lt-doc-surface" inert={pending} aria-hidden={pending || undefined}>{content}</div>
        <div className="lt-doc-loading" data-testid="long-text-doc-loading" data-visible={pending} aria-hidden={!pending} inert={!pending}>
          {shownOverlay && <div role={shownOverlay.kind === 'failed' ? 'alert' : 'status'}>
            {shownOverlay.kind === 'failed' ? <AlertCircle className="text-destructive" /> : <LoaderCircle className="animate-spin motion-reduce:animate-none" />}
            {shownOverlay.kind !== 'importing' && shownOverlay.name && <strong><StudioFileName name={shownOverlay.name} /></strong>}
            <span>{shownOverlay.kind === 'failed' ? shownOverlay.message : t(shownOverlay.kind === 'importing' ? 'import.reading' : 'status.loading')}</span>
            {shownOverlay.kind === 'failed' && <Button size="sm" variant="outline" onClick={page.retryDetail}>{t('status.retry')}</Button>}
          </div>}
        </div>
      </div>
    </ToolDetailLayout>
    <LiveRegion />
    <RowMenu />
    <RetranslatePopover />
    <SettingsDialog />
    <RunConfirmDialog />
    <ExportDialog />
    <PasteDialog />
    <LedgerDialog />
    <EncodingDialog />
    <ConfirmDialog />
    <RenameDialog />
    <LibraryDialog />
  </div>;
}
