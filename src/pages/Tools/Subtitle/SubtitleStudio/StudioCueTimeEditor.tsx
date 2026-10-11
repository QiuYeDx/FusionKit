import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseStudioTime } from '@/subtitle-studio/cue-structure';
import { formatStudioTime } from './StudioControls';
import { CUE_CONTROL_ATTR } from './useCueSelection';
import { StudioCueWaveform, type CueWaveformSource } from './StudioCueWaveform';

/** The waveform shows this much before the start and after the end. */
const WAVEFORM_MARGIN_MS = 1500;

export type CueTimeProblem = 'invalid' | 'end_before_start' | 'end_required' | 'before_previous' | 'after_next' | 'beyond_media';
export const timeProblemKeys: Record<CueTimeProblem, string> = {
  invalid: 'studio:cue_structure.time_invalid',
  end_before_start: 'studio:cue_structure.end_before_start',
  end_required: 'studio:cue_structure.end_required',
  before_previous: 'studio:cue_structure.before_previous',
  after_next: 'studio:cue_structure.after_next',
  beyond_media: 'studio:cue_structure.beyond_media',
};

/**
 * Inline editor for a cue's start and end time. Enter saves, Escape cancels, Tab moves between
 * the two fields; leaving the editor saves. An empty end means unknown where the format allows it.
 */
export function StudioCueTimeEditor({ startMs, endMs, allowUnknownEnd, saving, error, check, onSave, onCancel, waveform }: {
  startMs: number;
  endMs: number | null;
  allowUnknownEnd: boolean;
  saving: boolean;
  error?: string;
  /** Why the times cannot be saved, checked against the neighbouring cues. */
  check: (startMs: number, endMs: number | null) => CueTimeProblem | null;
  onSave: (startMs: number, endMs: number | null) => void;
  onCancel: () => void;
  /** Shows the cue's waveform with draggable start and end, when the document's media can be read. */
  waveform?: CueWaveformSource;
}) {
  const { t } = useTranslation();
  const [start, setStart] = useState(formatStudioTime(startMs));
  const [end, setEnd] = useState(endMs === null ? '' : formatStudioTime(endMs));
  const [problem, setProblem] = useState<CueTimeProblem | null>(null);
  // The stretch shown stays put while the markers move; an unknown end shows five seconds.
  const [view] = useState(() => ({ startMs: Math.max(0, startMs - WAVEFORM_MARGIN_MS), endMs: (endMs ?? startMs + 5000) + WAVEFORM_MARGIN_MS }));
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useLayoutEffect(() => { first.current?.focus({ preventScroll: true }); first.current?.select(); }, []);
  useLayoutEffect(() => { if (!saving) settled.current = false; }, [saving, error]);
  const save = () => {
    if (settled.current || saving) return;
    const nextStart = parseStudioTime(start);
    const nextEnd = end.trim() ? parseStudioTime(end) : null;
    const found: CueTimeProblem | null = nextStart === null || (end.trim() && nextEnd === null) ? 'invalid'
      : nextEnd === null && !allowUnknownEnd ? 'end_required' : check(nextStart, nextEnd);
    if (found) { setProblem(found); return; }
    settled.current = true;
    if (nextStart === startMs && nextEnd === endMs) { onCancel(); return; }
    onSave(nextStart!, nextEnd);
  };
  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); settled.current = true; onCancel(); }
    else if (event.key === 'Enter') { event.preventDefault(); save(); }
  };
  const message = problem ? t(timeProblemKeys[problem]) : error;
  return <div ref={root} className="studio-cue-time-editor" {...{ [CUE_CONTROL_ATTR]: '' }} data-saving={saving || undefined}
    onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) save(); }}>
    <div className="studio-cue-time-fields">
      <input ref={first} aria-label={t('studio:cue_structure.start')} aria-invalid={!!message || undefined} value={start} readOnly={saving} spellCheck={false}
        data-testid="studio-cue-time-start" onChange={event => { setStart(event.target.value); setProblem(null); settled.current = false; }} onKeyDown={keys} />
      <ArrowRight aria-hidden="true" />
      <input aria-label={t('studio:cue_structure.end')} aria-invalid={!!message || undefined} value={end} readOnly={saving} spellCheck={false}
        placeholder={allowUnknownEnd ? t('studio:cue_structure.unknown') : undefined} data-testid="studio-cue-time-end"
        onChange={event => { setEnd(event.target.value); setProblem(null); settled.current = false; }} onKeyDown={keys} />
    </div>
    {waveform && <StudioCueWaveform source={waveform} viewStartMs={view.startMs} viewEndMs={view.endMs}
      startMs={parseStudioTime(start)} endMs={end.trim() ? parseStudioTime(end) : null}
      onMove={(which, ms) => {
        (which === 'start' ? setStart : setEnd)(formatStudioTime(ms));
        setProblem(null); settled.current = false;
      }} />}
    <div className="studio-cue-editor-meta" aria-live="polite">
      {saving ? <span className="studio-cue-editor-saving"><LoaderCircle className="studio-spin" />{t('studio:cue_edit.saving')}</span>
        : message ? <span role="alert" className="studio-cue-editor-error">{message}</span>
          : <span>{t('studio:cue_structure.time_keys')}</span>}
    </div>
  </div>;
}
