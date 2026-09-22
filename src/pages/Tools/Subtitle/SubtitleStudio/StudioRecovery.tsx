import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, FolderOpen, LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import type { UnavailableDocument } from '@/subtitle-studio/batch-contract';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import { StudioIconButton } from './StudioControls';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';

type Props = { open: boolean; onOpenChange: (value: boolean) => void; documents: UnavailableDocument[]; onChanged: (cleanupPending: boolean) => void; onError: (code: ErrorCode) => void };
const keyOf = (doc: UnavailableDocument) => `${doc.id}:${doc.token}`;
export function StudioRecovery({ open, onOpenChange, documents, onChanged, onError }: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState('');
  const operation = useRef(false);
  const [confirm, setConfirm] = useState<UnavailableDocument[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [result, setResult] = useState<{ count: number; failed: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const visible = documents.filter(doc => !removed.has(keyOf(doc)));
  const chosen = visible.filter(doc => selected.has(keyOf(doc)));
  useEffect(() => {
    if (open) { setSelected(new Set()); setRemoved(new Set()); setFailures(new Set()); setConfirm(null); setResult(null); setFailed(false); }
  }, [open]);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  useEffect(() => { if (result) document.getElementById('studio-recovery-close')?.focus(); }, [result]);
  const close = (value: boolean) => { if (!operation.current) { onOpenChange(value); setConfirm(null); setFailed(false); } };
  const requestRemoval = (docs: UnavailableDocument[]) => {
    if (operation.current || !docs.length) return;
    // Freeze the exact reviewed tokens; later list refreshes cannot expand this deletion.
    setConfirm(docs.map(doc => ({ ...doc }))); setResult(null); setFailed(false);
  };
  const reveal = async (doc: UnavailableDocument) => {
    if (operation.current) return;
    operation.current = true; setPending(doc.id); setFailed(false); setResult(null);
    try {
      await unwrapStudio(window.subtitleStudio.revealUnavailable({ documentId: doc.id, token: doc.token }));
    } catch (error) { setFailed(true); onError(error instanceof StudioError ? error.code : 'document_unavailable'); }
    finally { operation.current = false; setPending(''); }
  };
  const removeConfirmed = async () => {
    if (operation.current || !confirm?.length) return;
    const targets = confirm;
    operation.current = true; setPending('delete'); setFailed(false); setFailures(new Set());
    setProgress({ completed: 0, total: targets.length });
    let count = 0, cleanupPending = false;
    let firstError: ErrorCode | undefined;
    const unsuccessful = new Set<string>();
    try {
      for (const doc of targets) {
        const key = keyOf(doc);
        try {
          const value = await unwrapStudio(window.subtitleStudio.deleteUnavailable({ documentId: doc.id, token: doc.token }));
          cleanupPending ||= value.cleanupPending; count++;
          setRemoved(previous => new Set(previous).add(key));
          setSelected(previous => { const next = new Set(previous); next.delete(key); return next; });
        } catch (error) {
          unsuccessful.add(doc.id);
          firstError ??= error instanceof StudioError ? error.code : 'document_unavailable';
        }
        setProgress({ completed: count + unsuccessful.size, total: targets.length });
      }
      setConfirm(null); setFailures(unsuccessful); setResult({ count, failed: unsuccessful.size });
      onChanged(cleanupPending);
      if (firstError) onError(firstError);
    } finally { operation.current = false; setPending(''); }
  };
  return <ScrollableDialog open={open} onOpenChange={close} maxWidth="sm:max-w-[640px]" contentClassName="studio-recovery-dialog" onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-recovery-close')?.focus(); }}>
    <ScrollableDialogHeader><DialogTitle>{t('studio:recovery.title')}</DialogTitle><DialogDescription>{t('studio:recovery.description')}</DialogDescription>
      {!!visible.length && <div className="studio-recovery-selection"><label><Checkbox checked={chosen.length === visible.length ? true : chosen.length ? 'indeterminate' : false} disabled={!!pending || !!confirm} onCheckedChange={checked => setSelected(checked === true ? new Set(visible.map(keyOf)) : new Set())} />{t('studio:recovery.select_all')}</label><span>{t('studio:recovery.selected_count', { count: chosen.length, total: visible.length })}</span></div>}
    </ScrollableDialogHeader>
    <ScrollableDialogContent fadeMaskHeight={16}><div data-testid="studio-recovery-dialog" className="studio-recovery-content">
      {!visible.length && <p className="py-6 text-center text-sm text-muted-foreground">{t('studio:recovery.empty')}</p>}
      <StudioDocumentList scroll={false}>{visible.map(doc => <StudioDocumentRow key={keyOf(doc)} density="detail" data-testid={`studio-recovery-item-${doc.id}`} data-state={failures.has(doc.id) ? 'failed' : undefined} status={failures.has(doc.id) ? t('studio:recovery.item_failed') : undefined} title={<label className="flex items-center gap-2 min-w-0"><Checkbox aria-label={t('studio:recovery.select_document', { id: doc.id })} checked={selected.has(keyOf(doc))} disabled={!!pending || !!confirm} onCheckedChange={checked => setSelected(previous => { const next = new Set(previous); if (checked === true) next.add(keyOf(doc)); else next.delete(keyOf(doc)); return next; })} /><AlertCircle className="size-4 shrink-0 text-amber-600" /><span className="min-w-0 font-mono text-xs break-all">{doc.id}</span></label>} actions={<><StudioIconButton label={t('studio:recovery.reveal')} disabled={!!pending || !!confirm} onClick={() => void reveal(doc)}><FolderOpen /></StudioIconButton><StudioIconButton label={t('studio:recovery.remove')} disabled={!!pending || !!confirm} onClick={() => requestRemoval([doc])}><Trash2 /></StudioIconButton></>}>
        <p className="text-xs leading-5 text-muted-foreground">{t('studio:recovery.reason')}</p>
        <p className="studio-recovery-path"><span>{t('studio:recovery.location')}</span><code>{doc.directory}</code></p>
      </StudioDocumentRow>)}</StudioDocumentList>
    </div></ScrollableDialogContent>
    <ScrollableDialogFooter className="studio-recovery-footer">
      {confirm && <p className="text-xs leading-5" data-testid="studio-recovery-confirm">{confirm.length === 1 ? t('studio:recovery.confirm') : t('studio:recovery.confirm_batch', { count: confirm.length })}</p>}
      <div aria-live="polite" aria-atomic="true" className="studio-recovery-feedback">
        {pending === 'delete' ? <p role="status"><LoaderCircle className="size-3.5 studio-spin" />{t('studio:recovery.progress', { count: progress.completed, total: progress.total })}</p>
          : result ? <p role={result.failed ? 'alert' : 'status'} className={result.failed ? 'text-destructive' : 'text-muted-foreground'}>{t(result.failed ? 'studio:recovery.batch_result' : 'studio:recovery.batch_success', result)}</p>
          : failed ? <p role="alert" className="text-destructive">{t('studio:recovery.failed')}</p> : null}
      </div>
      <div className="studio-recovery-actions">{confirm ? <><Button ref={cancelRef} size="sm" variant="outline" disabled={!!pending} onClick={() => setConfirm(null)}>{t('studio:cancel')}</Button><Button size="sm" variant="destructive" disabled={!!pending} onClick={() => void removeConfirmed()}><Trash2 />{t('studio:recovery.confirm_remove')}</Button></> : <><Button id="studio-recovery-close" size="sm" variant="outline" disabled={!!pending} onClick={() => close(false)}>{t('studio:recovery.close')}</Button>{!!visible.length && <Button size="sm" variant="destructive" disabled={!!pending || !chosen.length} onClick={() => requestRemoval(chosen)}><Trash2 />{t('studio:recovery.remove_selected', { count: chosen.length })}</Button>}</>}</div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
