import { useTranslation } from 'react-i18next';
import { ClipboardPaste, FilePlus2, Library, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StudioFileName, StudioIconButton } from '../../Subtitle/SubtitleStudio/StudioControls';
import { useDocumentStatus } from './DocumentLibrary';
import { useLongTextPage } from './page-context';

/** Below `lg` the library column is hidden; this row opens it as a dialog and switches documents (design §3.4). */
export function MobileControls() {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const status = useDocumentStatus();
  const { documents, activeId } = page;
  const active = documents.find(summary => summary.id === activeId);
  return <div className="lt-mobile-controls lg:hidden">
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <Button id="long-text-library-trigger" data-testid="long-text-library-trigger" variant="ghost" size="sm" aria-label={t('library.open')}
          onClick={() => page.openDialog({ kind: 'library' })}>
          <Library /><span className="font-mono text-[11px] tabular-nums">{documents.length}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{t('library.open')}</TooltipContent>
    </Tooltip>
    <div className="lt-mobile-picker">
      {documents.length > 0 && <Select value={active?.id ?? ''} onValueChange={page.selectDocument}>
        <SelectTrigger id="long-text-document-select" size="sm" aria-label={t('library.select')} className="w-full min-w-0 text-xs">
          <SelectValue placeholder={t('library.select')}>
            {active && <span className="lt-mobile-current"><StudioFileName name={active.name} /><span>{status(active)}</span></span>}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-2rem)]">
          {documents.map(summary => <SelectItem key={summary.id} value={summary.id} className="whitespace-normal [overflow-wrap:anywhere]">
            {summary.name}
          </SelectItem>)}
        </SelectContent>
      </Select>}
    </div>
    <StudioIconButton label={t('import.paste')} onClick={() => page.openDialog({ kind: 'paste', text: '' })}><ClipboardPaste /></StudioIconButton>
    <StudioIconButton label={t('import.files')} disabled={page.importBusy} onClick={page.pickFiles}>
      {page.importBusy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <FilePlus2 />}
    </StudioIconButton>
  </div>;
}
