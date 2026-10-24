import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, PencilLine } from 'lucide-react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LONG_TEXT_LIMITS } from '@/long-text/contract';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { ToolField } from '../../../_shared/ui/ToolField';
import { ERROR_LABELS } from '../labels';
import { useLongTextPage } from '../page-context';
import { DialogFrame, DialogNote, useDialogRequest } from './DialogFrame';

/** Renaming the open document (420): 1–120 characters; the list and the header follow the `list` event. */
export function RenameDialog() {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { request, detail } = useDialogRequest('rename', (_request, current) => {
    setName(current?.name ?? '');
    setError('');
  });

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= LONG_TEXT_LIMITS.nameChars;
  const save = async () => {
    if (!detail || !valid || pending) return;
    if (trimmed === detail.name) { page.closeDialog(); return; }
    setPending(true);
    setError('');
    try {
      await unwrap(window.longText.rename({ documentId: detail.id, name: trimmed }));
      page.closeDialog();
    } catch (failure) {
      setError(t(ERROR_LABELS[errorCodeOf(failure)]));
    } finally {
      setPending(false);
    }
  };

  return <DialogFrame open={!!request && !!detail} width={420} testId="long-text-rename" icon={<PencilLine />} title={t('rename.title')}
    busy={pending} onSubmit={() => void save()}
    initialFocus={() => {
      input.current?.focus();
      input.current?.select();
      return null;
    }}
    footer={<>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={page.closeDialog}>{t('rename.cancel')}</Button>
      <Button type="submit" size="sm" data-testid="long-text-rename-submit" disabled={!valid || pending}>
        {pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}{t('rename.save')}
      </Button>
    </>}>
    <ToolField label={t('rename.label')} htmlFor={`${id}-name`}>
      <Input ref={input} id={`${id}-name`} data-testid="long-text-rename-input" className="h-8 text-xs" value={name}
        maxLength={LONG_TEXT_LIMITS.nameChars} disabled={pending} aria-invalid={!valid || undefined} onChange={event => setName(event.target.value)} />
    </ToolField>
    <DialogTransition transitionKey="error" stageClassName="pt-3">{error ? <DialogNote tone="error">{error}</DialogNote> : null}</DialogTransition>
  </DialogFrame>;
}
