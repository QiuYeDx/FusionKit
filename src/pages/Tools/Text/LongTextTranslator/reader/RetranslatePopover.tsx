import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { LONG_TEXT_LIMITS } from '@/long-text/contract';
import { isCjk } from '@/long-text/text-stats';
import { showToast } from '@/utils/toast';
import { MODEL_PROBLEM_LABELS, RETRANSLATE_CHIP_LABELS, RETRANSLATE_CHIP_TEXTS, RETRANSLATE_CHIPS } from '../labels';
import { useLongTextPage, type RowOverlay } from '../page-context';
import { focusWentWithOverlay, rowErrorText } from './RowMenu';

/**
 * The requirement box after a quick chip: the chip's sentence alone, or added after what is there,
 * with a space unless the text ends in CJK; nothing is added twice, and the box keeps its limit.
 */
export function appendRequirement(current: string, addition: string, limit = LONG_TEXT_LIMITS.instructionChars): string {
  const text = current.trimEnd();
  if (!text) return addition.slice(0, limit);
  if (text.includes(addition)) return current;
  const last = Array.from(text).pop() ?? '';
  return `${text}${isCjk(last) ? '' : ' '}${addition}`.slice(0, limit);
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Retranslates one row with an optional requirement (design §2 F8-4): four quick chips, Enter submits
 * unless an IME is composing, Shift+Enter is a new line. The row shows as translating at once and is
 * replaced by the result; focus goes back to the row.
 */
export function RetranslatePopover() {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const target = page.retranslateTarget;
  const last = useRef<RowOverlay | null>(target);
  if (target) last.current = target;
  const shown = target ?? last.current;
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const problem = 'problem' in page.runModel ? page.runModel.problem : null;

  useEffect(() => { if (target) setText(''); }, [target]);

  const close = () => page.setRetranslateTarget(null);
  const submit = () => {
    if (!target || problem) return;
    const { row } = target;
    const instruction = text.trim();
    close();
    page.reader?.apply({ ...row, status: 'translating' });
    page.retranslate(row, instruction || undefined).then(next => {
      page.reader?.apply(next);
    }, (error: unknown) => {
      page.reader?.apply(row);
      showToast(rowErrorText(t, error), 'error');
    });
  };

  return <Popover open={!!target} onOpenChange={open => { if (!open) close(); }}>
    {createPortal(<PopoverAnchor asChild>
      <span aria-hidden="true" style={{ position: 'fixed', left: shown?.point.x ?? 0, top: shown?.point.y ?? 0, width: 0, height: 0, pointerEvents: 'none' }} />
    </PopoverAnchor>, document.body)}
    <PopoverContent side="bottom" align="end" sideOffset={4} collisionPadding={8} className="lt-retranslate" data-testid="long-text-retranslate"
      onPointerDown={stop} onContextMenu={stop}
      onOpenAutoFocus={event => { event.preventDefault(); box.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={event => { event.preventDefault(); if (shown && focusWentWithOverlay()) page.reader?.focusRow(shown.row.index); }}>
      <h3>{t('retranslate.title')}</h3>
      <div className="lt-retranslate-chips">
        {RETRANSLATE_CHIPS.map(chip => <Button key={chip} type="button" size="xs" variant="outline" data-testid={`long-text-chip-${chip}`}
          onClick={() => { setText(value => appendRequirement(value, t(RETRANSLATE_CHIP_TEXTS[chip]))); box.current?.focus(); }}>
          {t(RETRANSLATE_CHIP_LABELS[chip])}
        </Button>)}
      </div>
      <Textarea ref={box} value={text} maxLength={LONG_TEXT_LIMITS.instructionChars} placeholder={t('retranslate.placeholder')} aria-label={t('retranslate.title')}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          submit();
        }} />
      <div className="lt-retranslate-footer">
        {problem && <p>{t(MODEL_PROBLEM_LABELS[problem])}</p>}
        <Button size="sm" data-testid="long-text-retranslate-submit" disabled={!!problem} onClick={submit}>{t('retranslate.submit')}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
