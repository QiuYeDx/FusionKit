import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, FolderOpen, LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import type { UnavailableDocument } from '@/subtitle-studio/batch-contract';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import { StudioIconButton } from './StudioControls';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';

type Props = { open: boolean; onOpenChange: (value: boolean) => void; documents: UnavailableDocument[]; onChanged: (cleanupPending: boolean) => void; onError: (code: ErrorCode) => void };
export function StudioRecovery({ open, onOpenChange, documents, onChanged, onError }: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState('');
  const operation = useRef(false);
  const [confirm, setConfirm] = useState<UnavailableDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const run = async (doc: UnavailableDocument, remove: boolean) => {
    if (operation.current) return;
    operation.current = true; setPending(doc.id); setFailed(false);
    try {
      const request = { documentId: doc.id, token: doc.token };
      if (remove) {
        const result = await unwrapStudio(window.subtitleStudio.deleteUnavailable(request));
        setConfirm(null); onChanged(result.cleanupPending);
      } else await unwrapStudio(window.subtitleStudio.revealUnavailable(request));
    } catch (error) { setFailed(true); onError(error instanceof StudioError ? error.code : 'document_unavailable'); }
    finally { operation.current = false; setPending(''); }
  };
  return <ScrollableDialog open={open} onOpenChange={value => { if (!pending) { onOpenChange(value); setConfirm(null); setFailed(false); } }} maxWidth="sm:max-w-[640px]" contentClassName="studio-recovery-dialog" onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-recovery-close')?.focus(); }}>
    <ScrollableDialogHeader><DialogTitle>{t('studio:recovery.title')}</DialogTitle><DialogDescription>{t('studio:recovery.description')}</DialogDescription></ScrollableDialogHeader>
    <ScrollableDialogContent fadeMaskHeight={16}><div data-testid="studio-recovery-dialog" className="studio-recovery-content">
      {failed && <p role="alert" className="text-xs text-destructive">{t('studio:recovery.failed')}</p>}
      {!documents.length && <p className="py-6 text-center text-sm text-muted-foreground">{t('studio:recovery.empty')}</p>}
      <StudioDocumentList scroll={false}>{documents.map(doc => <StudioDocumentRow key={doc.id} density="detail" title={<span className="flex items-center gap-2 min-w-0"><AlertCircle className="size-4 shrink-0 text-amber-600" /><span className="min-w-0 font-mono text-xs break-all">{doc.id}</span></span>} actions={<><StudioIconButton label={t('studio:recovery.reveal')} disabled={!!pending} onClick={() => void run(doc, false)}><FolderOpen /></StudioIconButton><StudioIconButton label={t('studio:recovery.remove')} disabled={!!pending} onClick={() => setConfirm(doc)}><Trash2 /></StudioIconButton></>}>
        <p className="text-xs leading-5 text-muted-foreground">{t('studio:recovery.reason')}</p>
        <p className="studio-recovery-path"><span>{t('studio:recovery.location')}</span><code>{doc.directory}</code></p>
        {confirm?.id === doc.id && <div className="studio-recovery-confirm"><p>{t('studio:recovery.confirm')}</p><div><Button size="sm" variant="ghost" disabled={!!pending} onClick={() => setConfirm(null)}>{t('studio:cancel')}</Button><Button size="sm" variant="destructive" disabled={!!pending} onClick={() => void run(confirm, true)}>{pending ? <LoaderCircle className="studio-spin" /> : <Trash2 />}{t('studio:recovery.confirm_remove')}</Button></div></div>}
      </StudioDocumentRow>)}</StudioDocumentList>
    </div></ScrollableDialogContent>
    <ScrollableDialogFooter className="flex justify-end"><Button id="studio-recovery-close" size="sm" variant="outline" disabled={!!pending} onClick={() => { onOpenChange(false); setConfirm(null); }}>{t('studio:recovery.close')}</Button></ScrollableDialogFooter>
  </ScrollableDialog>;
}
