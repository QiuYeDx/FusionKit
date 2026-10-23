import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileType2, LoaderCircle } from 'lucide-react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LONG_TEXT_ENCODINGS, type LongTextErrorCode, type LongTextValues, type SupportedEncoding } from '@/long-text/contract';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { ToolField } from '../../../_shared/ui/ToolField';
import { isTranslating } from '../hooks/useDocuments';
import { ENCODING_LABELS, ERROR_LABELS } from '../labels';
import { groupedCount, useLongTextPage, useSettledFlag } from '../page-context';
import { clearedCount } from './ConfirmDialog';
import { DialogFrame, DialogNote, useDialogRequest } from './DialogFrame';

type PreviewResult = ({ status: 'ready' } & LongTextValues['previewEncoding']) | { status: 'failed'; error: LongTextErrorCode };
/** The latest preview and the encoding it decoded; while another one loads it stays on screen, faded. */
interface Preview { encoding: SupportedEncoding | null; result: PreviewResult | null }

/**
 * Checking and changing the encoding of an imported file (560, design §3.5). The chosen encoding's
 * first lines are decoded from the kept original bytes; the current one is confirmed with "编码正确",
 * another one decodes and segments the document again ("用此编码重新打开"), clearing its translations
 * when it has any.
 */
export function EncodingDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [encoding, setEncoding] = useState<SupportedEncoding>('utf-8');
  const [preview, setPreview] = useState<Preview>({ encoding: null, result: null });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { request, detail } = useDialogRequest('encoding', (_request, current) => {
    setEncoding(current?.encoding?.name ?? 'utf-8');
    setPreview({ encoding: null, result: null });
    setError('');
  });
  const open = !!request && !!detail?.encoding;
  const documentId = detail?.id;

  useEffect(() => {
    if (!open || !documentId) return;
    let current = true;
    unwrap(window.longText.previewEncoding({ documentId, encoding })).then(
      value => { if (current) setPreview({ encoding, result: { status: 'ready', ...value } }); },
      (failure: unknown) => { if (current) setPreview({ encoding, result: { status: 'failed', error: errorCodeOf(failure) } }); },
    );
    return () => { current = false; };
  }, [open, documentId, encoding]);
  const loading = open && preview.encoding !== encoding;
  const slow = useSettledFlag(loading);

  if (!detail?.encoding) return null;
  const currentEncoding = detail.encoding.name;
  const changed = encoding !== currentEncoding;
  const translations = clearedCount(detail.counts, false);
  const translating = isTranslating(detail);
  const { result } = preview;

  const apply = async () => {
    setPending(true);
    setError('');
    try {
      if (changed) {
        page.applyDetail(await unwrap(window.longText.resegment({ documentId: detail.id, encoding, discardTranslations: translations > 0 })));
      } else {
        page.applyDetail(await unwrap(window.longText.confirmEncoding({ documentId: detail.id })));
      }
      page.closeDialog();
    } catch (failure) {
      setError(t(ERROR_LABELS[errorCodeOf(failure)]));
    } finally {
      setPending(false);
    }
  };
  const label = (value: SupportedEncoding) => value === currentEncoding
    ? t('encoding.current', { name: t(ENCODING_LABELS[value]) })
    : t(ENCODING_LABELS[value]);
  const submitLabel = !changed ? t('encoding.confirm') : translations > 0 ? t('encoding.reopen_clear') : t('encoding.reopen');
  const submitIcon = pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" />;

  return <DialogFrame open={open} width={560} testId="long-text-encoding-dialog" icon={<FileType2 />} title={t('encoding.title')} name={detail.name}
    busy={pending} initialFocus={() => trigger.current}
    footer={<>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={page.closeDialog}>{t('encoding.cancel')}</Button>
      {/* Clearing translations is the destructive variant of the same button (design §3.5). */}
      {changed && translations > 0
        ? <Button type="button" variant="destructive" size="sm" data-testid="long-text-encoding-submit" disabled={pending || translating} onClick={() => void apply()}>{submitIcon}{submitLabel}</Button>
        : <Button type="button" size="sm" data-testid="long-text-encoding-submit" disabled={pending || (changed && translating)} onClick={() => void apply()}>{submitIcon}{submitLabel}</Button>}
    </>}>
    <div className="lt-dialog-body">
      <div>
        <ToolField label={t('encoding.label')} htmlFor={`${id}-encoding`}>
          <Select value={encoding} disabled={pending} onValueChange={value => setEncoding(value as SupportedEncoding)}>
            <SelectTrigger ref={trigger} id={`${id}-encoding`} data-testid="long-text-encoding-select" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{LONG_TEXT_ENCODINGS.map(value => <SelectItem key={value} value={value}>{label(value)}</SelectItem>)}</SelectContent>
          </Select>
        </ToolField>
        <DialogTransition transitionKey="change" stageClassName="pt-3">
          {changed && translating ? <DialogNote tone="warning">{t('errors.busy')}</DialogNote>
            : changed && translations > 0 ? <DialogNote tone="warning" testId="long-text-encoding-clear-warning">
              {t('encoding.has_translations', { count: groupedCount(translations, i18n.language) })}</DialogNote>
              : null}
        </DialogTransition>
      </div>
      <ToolField label={t('encoding.preview')}>
        <div>
          <div className="lt-encoding-preview" data-testid="long-text-encoding-preview" aria-busy={loading} data-stale={loading || undefined}>
            {result?.status === 'ready' && result.lines.map((line, index) => <p key={index}>{line}</p>)}
            {result?.status === 'failed' && <p className="lt-encoding-preview-error">{t(ERROR_LABELS[result.error])}</p>}
            {!result && slow && <LoaderCircle className="lt-encoding-preview-spinner animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          </div>
          <DialogTransition transitionKey="replacement" stageClassName="pt-1.5">
            {result?.status === 'ready' && result.replacementChars > 0
              ? <p className="lt-dialog-hint" data-tone="warning">{t('encoding.replacement', { count: groupedCount(result.replacementChars, i18n.language) })}</p>
              : null}
          </DialogTransition>
        </div>
      </ToolField>
    </div>
    <DialogTransition transitionKey="error" stageClassName="pt-3">{error ? <DialogNote tone="error">{error}</DialogNote> : null}</DialogTransition>
  </DialogFrame>;
}
