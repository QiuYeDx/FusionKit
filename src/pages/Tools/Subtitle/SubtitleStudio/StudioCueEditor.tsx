import { useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CUE_CONTROL_ATTR } from './useCueSelection';

export type CueEditorMove = 'stay' | 'next' | 'previous';

/**
 * Inline editor for one cue text. Enter saves, Shift+Enter breaks the line,
 * Tab / Shift+Tab save and continue on the next / previous cue, Escape cancels.
 * Leaving the editor saves as well, like a spreadsheet cell.
 */
export function StudioCueEditor({ initial, label, saving, error, note, onSave, onCancel }: {
  initial: string;
  label: string;
  saving: boolean;
  error?: string;
  note?: string;
  onSave: (value: string, move: CueEditorMove) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const settled = useRef(false);
  const fit = () => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    fit();
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollIntoView({ block: 'nearest' });
  }, []);
  // A failed save keeps the editor open for another attempt.
  useLayoutEffect(() => { if (!saving) settled.current = false; }, [saving, error]);
  const save = (move: CueEditorMove) => {
    if (settled.current || saving) return;
    settled.current = true;
    onSave(value, move);
  };
  return <div className="studio-cue-editor" {...{ [CUE_CONTROL_ATTR]: '' }} data-saving={saving || undefined}>
    <textarea
      ref={area}
      aria-label={label}
      aria-invalid={!!error || undefined}
      value={value}
      rows={1}
      spellCheck={false}
      readOnly={saving}
      onChange={event => { settled.current = false; setValue(event.target.value); fit(); }}
      onBlur={() => save('stay')}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); settled.current = true; onCancel(); }
        else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) { event.preventDefault(); save('stay'); }
        else if (event.key === 'Tab') { event.preventDefault(); save(event.shiftKey ? 'previous' : 'next'); }
      }}
    />
    <div className="studio-cue-editor-meta" aria-live="polite">
      {saving ? <span className="studio-cue-editor-saving"><LoaderCircle className="studio-spin" />{t('studio:cue_edit.saving')}</span>
        : error ? <span role="alert" className="studio-cue-editor-error">{error}</span>
          : <span>{note ?? t('studio:cue_edit.keys')}</span>}
    </div>
  </div>;
}
