import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LONG_TEXT_LIMITS } from '@/long-text/contract';

/** What follows a save from the keyboard: the next or previous row's editor, or the next attention. */
export type EditorNext = { kind: 'move'; step: 1 | -1 } | { kind: 'attention'; direction: 'next' | 'previous' };

/** The editor's own keys (design §4.1): Ctrl/Cmd+Enter, Alt+↓/↑, F8 / Shift+F8 and Esc; Enter is a new line. */
export function editorKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): 'save' | 'cancel' | EditorNext | null {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (key === 'Enter' && (ctrlKey || metaKey) && !altKey && !shiftKey) return 'save';
  if (key === 'Escape' && !ctrlKey && !metaKey && !altKey && !shiftKey) return 'cancel';
  if (altKey && !ctrlKey && !metaKey && !shiftKey && (key === 'ArrowDown' || key === 'ArrowUp')) return { kind: 'move', step: key === 'ArrowDown' ? 1 : -1 };
  if (key === 'F8' && !ctrlKey && !metaKey && !altKey) return { kind: 'attention', direction: shiftKey ? 'previous' : 'next' };
  return null;
}

/**
 * The target edited in place (design §2 F8-3): an auto-growing text box with the raw inline Markdown,
 * where Enter starts a new line. Saving an empty box clears the translation; the parent saves.
 */
export function RowEditor({ initial, onSave, onCancel, onDraft }: {
  initial: string;
  /** Saves `text`, then goes on with `next`. */
  onSave: (text: string, next?: EditorNext) => void;
  onCancel: () => void;
  /** The text as typed, so a switch to another row can save it. */
  onDraft: (text: string) => void;
}) {
  const { t, i18n } = useTranslation('text');
  const [text, setText] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  const over = text.length > LONG_TEXT_LIMITS.editChars;

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollIntoView({ block: 'nearest' });
  }, []);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const action = editorKey(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'cancel') onCancel();
    else if (!over) onSave(text, action === 'save' ? undefined : action);
  };

  return <div className="lt-editor" data-testid="long-text-editor">
    <Textarea ref={box} value={text} aria-label={t('row.edit')} aria-invalid={over || undefined} spellCheck={false}
      onChange={event => { setText(event.target.value); onDraft(event.target.value); }} onKeyDown={keyDown} />
    <div className="lt-editor-bar">
      <span className="lt-editor-hint" data-over={over || undefined}>
        {over ? t('editor.too_long', { max: LONG_TEXT_LIMITS.editChars.toLocaleString(i18n.language) }) : t('editor.hint')}
      </span>
      <span className="lt-editor-actions">
        <Button size="xs" variant="ghost" onClick={onCancel}>{t('editor.cancel')}</Button>
        <Button size="xs" data-testid="long-text-editor-save" disabled={over} onClick={() => onSave(text)}>{t('editor.save')}</Button>
      </span>
    </div>
  </div>;
}
