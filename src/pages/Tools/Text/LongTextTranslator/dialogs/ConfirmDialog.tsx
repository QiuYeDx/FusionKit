import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Button } from '@/components/ui/button';
import type { Counts } from '@/long-text/contract';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { ToolSwitchRow } from '../../../_shared/ui/ToolSwitchRow';
import { ERROR_LABELS } from '../labels';
import { groupedCount, useLongTextPage } from '../page-context';
import { DialogFrame, DialogNote, useDialogRequest } from './DialogFrame';

/** Translations "清除译文" removes: every done or failed segment, except the locked ones when they are kept. */
export function clearedCount(counts: Pick<Counts, 'done' | 'failed' | 'locked'>, keepLocked: boolean): number {
  return counts.done + counts.failed - (keepLocked ? counts.locked : 0);
}

interface Confirmation { title: string; body: string; label: string; icon: ReactNode; run: () => Promise<void> }

/**
 * Delete, clear and "从此段起重新翻译" confirmations (420) for `page.dialog` of kind `confirm`. Focus
 * starts on "取消"; the destructive button acts and closes the dialog. Deleting goes through
 * `page.removeDocument`, which then hands focus to the library; "清除并翻译" goes through
 * `page.start({ kind: 'from', fromIndex })`, which reports a run that cannot start itself.
 */
export function ConfirmDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const cancel = useRef<HTMLButtonElement>(null);
  const [keepLocked, setKeepLocked] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const deleting = page.dialog?.kind === 'confirm' && page.dialog.action === 'delete';
  const { request, shown, detail } = useDialogRequest('confirm', () => {
    setKeepLocked(true);
    setError('');
  }, { bound: !deleting });
  if (!shown) return null;

  const count = (value: number) => groupedCount(value, i18n.language);
  let confirmation: Confirmation;
  if (shown.action === 'delete') {
    confirmation = {
      title: t('confirm.delete_title'), body: t('confirm.delete_body', { name: shown.name }),
      label: t('confirm.delete'), icon: <Trash2 />,
      run: () => page.removeDocument(shown.documentId),
    };
  } else if (shown.action === 'clear') {
    confirmation = {
      title: t('confirm.clear_title'), body: t('confirm.clear_body', { count: count(detail ? clearedCount(detail.counts, keepLocked) : 0) }),
      label: t('confirm.clear'), icon: <Eraser />,
      run: async () => {
        if (!detail) return;
        await unwrap(window.longText.clear({ documentId: detail.id, keepLocked }));
        page.refreshDetail();
      },
    };
  } else {
    // `ordinal` is also i18next's ordinal-plural switch, so the values go through `replace`.
    const values = { ordinal: shown.ordinal.toLocaleString(i18n.language), count: shown.count.toLocaleString(i18n.language) };
    confirmation = {
      title: t('confirm.from_here_title'), body: t('confirm.from_here_body', { replace: values }),
      label: t('confirm.from_here'), icon: <RotateCcw />,
      run: async () => { await page.start({ kind: 'from', fromIndex: shown.index }); },
    };
  }

  const confirm = async () => {
    setPending(true);
    setError('');
    try {
      await confirmation.run();
      // A run that could not start may have opened another dialog in this one's place.
      if (request && page.isDialogOpen(request)) page.closeDialog();
    } catch (failure) {
      setError(t(ERROR_LABELS[errorCodeOf(failure)]));
    } finally {
      setPending(false);
    }
  };

  return <DialogFrame open={!!request} width={420} testId="long-text-confirm" title={confirmation.title} busy={pending}
    icon={confirmation.icon} initialFocus={() => cancel.current}
    footer={<>
      <Button ref={cancel} type="button" variant="ghost" size="sm" disabled={pending} onClick={page.closeDialog}>{t('confirm.cancel')}</Button>
      <Button type="button" variant="destructive" size="sm" data-testid="long-text-confirm-submit" disabled={pending} onClick={() => void confirm()}>
        {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : confirmation.icon}{confirmation.label}
      </Button>
    </>}>
    <div className="lt-dialog-body">
      <p className="lt-dialog-text">{confirmation.body}</p>
      {shown.action === 'clear' && <ToolSwitchRow testId="long-text-confirm-keep-locked" label={t('confirm.keep_locked')}
        checked={keepLocked} disabled={pending} onCheckedChange={setKeepLocked} />}
    </div>
    <DialogTransition transitionKey="error" stageClassName="pt-3">{error ? <DialogNote tone="error">{error}</DialogNote> : null}</DialogTransition>
  </DialogFrame>;
}
