import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { groupedCount, useLongTextPage } from '../page-context';
import { DialogFrame, useDialogRequest } from './DialogFrame';
import { costRangeText, tokenRange } from './estimate-text';

/**
 * Confirmation of a run estimated above 500,000 tokens (420, design §2 F5-8). Focus starts on "取消",
 * which sends nothing; "开始翻译" continues with `page.start(run, { confirmed: true })`.
 */
export function RunConfirmDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const { request, shown } = useDialogRequest('runConfirm');
  if (!shown) return null;

  const { estimate, cost, model } = shown;
  const start = async () => {
    setPending(true);
    try {
      await page.start(shown.run, { confirmed: true });
      // A run that could not start may have opened the settings in this dialog's place.
      if (request && page.isDialogOpen(request)) page.closeDialog();
    } finally {
      setPending(false);
    }
  };

  return <DialogFrame open={!!request} width={420} testId="long-text-run-confirm" icon={<Play />} title={t('run_confirm.title')}
    busy={pending} initialFocus={() => cancel.current}
    footer={<>
      <Button ref={cancel} type="button" variant="ghost" size="sm" disabled={pending} onClick={page.closeDialog}>{t('run_confirm.cancel')}</Button>
      <Button type="button" size="sm" data-testid="long-text-run-confirm-start" disabled={pending} onClick={() => void start()}>
        {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Play />}{t('run_confirm.start')}
      </Button>
    </>}>
    <p className="lt-dialog-text">{t('run_confirm.body', {
      count: groupedCount(estimate.segments, i18n.language),
      tokens: tokenRange(estimate),
      cost: cost ? t('run_confirm.cost', { cost: costRangeText(cost) }) : '',
      model,
    })}</p>
  </DialogFrame>;
}
