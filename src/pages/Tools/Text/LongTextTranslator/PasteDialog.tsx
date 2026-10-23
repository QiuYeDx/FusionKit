import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, LoaderCircle } from 'lucide-react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LONG_TEXT_LIMITS, type LongTextFormat } from '@/long-text/contract';
import { errorCodeOf } from '@/services/long-text/client';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import { DialogFrame, DialogNote } from './dialogs/DialogFrame';
import { ERROR_LABELS } from './labels';
import { groupedCount, useLongTextPage, type PageDialog } from './page-context';

/** Markdown detection looks at the start of the text only; pasting a book must not stall typing. */
const DETECTION_CHARS = 100_000;

/**
 * Whether pasted text looks like Markdown: at least two of ATX headings, code fences, three list
 * items, link syntax and a table separator row (design §2 F3).
 */
export function looksLikeMarkdown(text: string): boolean {
  const sample = text.slice(0, DETECTION_CHARS);
  const listItems = sample.match(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/gm)?.length ?? 0;
  const features = [
    /^ {0,3}#{1,6}[ \t]+\S/m.test(sample),
    /^ {0,3}(?:```|~~~)/m.test(sample),
    listItems >= 3,
    sample.includes(']('),
    /^[ \t]*(?:\|[ \t]*:?-{3,}|:?-{3,}:?[ \t]*\|)/m.test(sample),
  ];
  return features.filter(Boolean).length >= 2;
}

/** "MM-DD HH:mm" of the default name "粘贴的文本 10-22 14:05". */
export function pasteTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface Draft { name: string; text: string; format: LongTextFormat; formatChosen: boolean }

const draftFor = (text: string): Draft => ({ name: '', text, format: looksLikeMarkdown(text) ? 'markdown' : 'txt', formatChosen: false });

/** Pasted text becomes a document (design §2 F3); opened from the library, the empty state or a page paste. */
export function PasteDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const opened = useRef(false);
  const request = page.dialog?.kind === 'paste' ? page.dialog : null;
  const [shown, setShown] = useState<PageDialog | null>(request);
  const [draft, setDraft] = useState<Draft>(() => draftFor(request?.text ?? ''));
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => new Date());
  // Each opening starts from the text it was opened with; closing keeps the last draft on screen.
  if (request && request !== shown) {
    setShown(request);
    setDraft(draftFor(request.text));
    setError('');
    setOpenedAt(new Date());
  }

  // The placeholder is the name an empty field gives, so it shows what the document will be called.
  const defaultName = t('paste.default_name', { time: pasteTime(openedAt) });
  const length = draft.text.length;
  const tooLong = length > LONG_TEXT_LIMITS.pasteChars;
  const canSubmit = !!draft.text.trim() && !tooLong && !submitting && !page.importBusy;
  const change = (patch: Partial<Draft>) => setDraft(current => {
    const next = { ...current, ...patch };
    // The format follows the text until the user picks one.
    return patch.text !== undefined && !next.formatChosen ? { ...next, format: looksLikeMarkdown(next.text) ? 'markdown' : 'txt' } : next;
  });
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const name = draft.name.trim() || defaultName;
      await page.importText(name, draft.text, draft.format);
      opened.current = true;
      page.closeDialog();
    } catch (failure) {
      setError(t(ERROR_LABELS[errorCodeOf(failure)]));
    } finally {
      setSubmitting(false);
    }
  };
  const submitShortcut = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  // A new document takes focus into the reader; otherwise focus returns to where the dialog came from.
  const closed = () => {
    if (opened.current) { opened.current = false; page.focusReader(); }
    else page.restoreFocus();
  };
  const focusText = () => {
    const field = textarea.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
    return field;
  };

  return <DialogFrame open={!!request} width={560} testId="long-text-paste-dialog" icon={<ClipboardPaste />} title={t('paste.title')}
    busy={submitting} onSubmit={() => void submit()} initialFocus={focusText} onClosed={closed}
    footer={<>
      <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={page.closeDialog}>{t('paste.cancel')}</Button>
      <Button type="submit" size="sm" data-testid="long-text-paste-submit" disabled={!canSubmit}>
        {submitting && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}{t('paste.submit')}
      </Button>
    </>}>
    <div className="lt-paste-fields" onKeyDown={submitShortcut}>
      <div className="lt-paste-meta">
        <ToolField label={t('paste.name')} htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} className="h-8 text-xs" value={draft.name} maxLength={LONG_TEXT_LIMITS.nameChars}
            placeholder={defaultName} disabled={submitting} onChange={event => change({ name: event.target.value })} />
        </ToolField>
        <ToolField label={t('paste.format')} testId="long-text-paste-format">
          <ToolRadioButtonGroup<LongTextFormat> ariaLabel={t('paste.format')} value={draft.format} disabled={submitting}
            options={[{ value: 'txt', label: t('paste.plain') }, { value: 'markdown', label: t('paste.markdown') }]}
            onValueChange={format => change({ format, formatChosen: true })} />
        </ToolField>
      </div>
      <ToolField label={t('paste.text')} htmlFor={`${id}-text`}>
        <Textarea ref={textarea} id={`${id}-text`} data-testid="long-text-paste-text" className="lt-paste-text" value={draft.text}
          disabled={submitting} aria-invalid={tooLong || undefined} aria-describedby={`${id}-count`} onChange={event => change({ text: event.target.value })} />
        <p id={`${id}-count`} className="lt-paste-count" data-over={tooLong || undefined}>
          {t('paste.count', { count: groupedCount(length, i18n.language) })}
          {tooLong && <span> · {t('paste.too_long', { max: LONG_TEXT_LIMITS.pasteChars.toLocaleString(i18n.language) })}</span>}
        </p>
      </ToolField>
    </div>
    <DialogTransition transitionKey="error" stageClassName="pt-3">{error ? <DialogNote tone="error">{error}</DialogNote> : null}</DialogTransition>
  </DialogFrame>;
}
