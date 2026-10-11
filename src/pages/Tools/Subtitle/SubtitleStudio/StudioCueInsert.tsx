import { useEffect, useId, useRef, useState } from 'react';
import { ListPlus, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { cueTextProblem, normalizeCueText, type CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { parseStudioTime } from '@/subtitle-studio/cue-structure';
import type { CueEditLabel } from '@/services/subtitle-studio/cue-history';
import { formatStudioTime } from './StudioControls';
import { CueAudioButton, useStopCueAudioOnClose } from './StudioCueAudio';
import type { CueTrack } from './StudioCueMenu';
import { timeProblemKeys, type CueTimeProblem } from './StudioCueTimeEditor';
import './StudioCueSplit.css';

export type CueInsertRequest = { cueId: string; position: 'before' | 'after'; serial: number };
/** Longest default for a new cue, filling the gap between its neighbours. */
const DEFAULT_MS = 2000;

/** The gap beside the anchor: after it, from its end (or start) to the next start; before it, from the previous end. */
export function defaultInsertTiming(cues: readonly DocumentPage['cues'][number][], index: number, position: 'before' | 'after') {
  const anchor = cues[index];
  if (position === 'after') {
    const startMs = anchor.timing.endMs ?? anchor.timing.startMs;
    const next = cues[index + 1]?.timing.startMs;
    const endMs = next !== undefined && next > startMs ? Math.min(next, startMs + DEFAULT_MS) : startMs + 1000;
    return { startMs, endMs };
  }
  const previous = cues[index - 1];
  const endMs = anchor.timing.startMs;
  const startMs = Math.max(0, previous ? Math.max(previous.timing.endMs ?? previous.timing.startMs, endMs - DEFAULT_MS) : endMs - DEFAULT_MS);
  return { startMs: Math.min(startMs, endMs), endMs };
}
const plain = (text: string) => ({ plain: text, spans: [{ text, marks: [] as never[] }] });

/** Inserts a new cue before or after one, with its time, text and an optional translation. */
export function StudioCueInsert({ page, request, track, mediaReady, busy, onClose, onApply }: {
  page: DocumentPage;
  request: CueInsertRequest | null;
  track?: CueTrack;
  mediaReady: boolean;
  busy?: string;
  onClose: () => void;
  onApply: (operation: CueEditOperation, label: CueEditLabel, count: number) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const open = !!request;
  const index = request ? page.cues.findIndex(cue => cue.id === request.cueId) : -1;
  const anchor = index >= 0 ? page.cues[index] : undefined;
  const number = page.offset + index + 1 + (request?.position === 'after' ? 1 : 0);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const textBox = useRef<HTMLTextAreaElement>(null);
  useStopCueAudioOnClose(open);
  useEffect(() => {
    if (!request || index < 0) return;
    const timing = defaultInsertTiming(page.cues, index, request.position);
    setStart(formatStudioTime(timing.startMs)); setEnd(formatStudioTime(timing.endMs));
    setSource(''); setTarget(''); setSaving(false);
    // Only a new request starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.serial]);

  const media = page.summary.origin.format === 'media';
  // As in the time editor: an unknown end only where the format has one (LRC) or the neighbour has none.
  const allowUnknownEnd = !media && (page.summary.origin.format === 'lrc' || anchor?.timing.endMs === null);
  const startMs = parseStudioTime(start);
  const endMs = end.trim() ? parseStudioTime(end) : null;
  const at = index + (request?.position === 'after' ? 1 : 0);
  const previous = page.cues[at - 1]?.timing.startMs, next = page.cues[at]?.timing.startMs;
  const timeProblem: CueTimeProblem | null = startMs === null || (end.trim() && endMs === null) ? 'invalid'
    : endMs === null && !allowUnknownEnd ? 'end_required'
    : endMs !== null && endMs < startMs ? 'end_before_start'
    : previous !== undefined && startMs < previous ? 'before_previous'
    : next !== undefined && startMs > next ? 'after_next'
    : media && endMs !== null && 'durationMs' in page.summary.origin && endMs > page.summary.origin.durationMs ? 'beyond_media' : null;
  const text = normalizeCueText(source), translation = normalizeCueText(target);
  const textProblem = text ? cueTextProblem(text) : null;
  const targetProblem = translation ? cueTextProblem(translation) : null;
  const ready = !!anchor && !timeProblem && !!text && !textProblem && !targetProblem;
  const apply = async () => {
    if (!ready || saving || startMs === null || !request) return;
    setSaving(true);
    const ok = await onApply({ kind: 'insert', cueId: request.cueId, position: request.position, timing: { startMs, endMs }, source: plain(text),
      ...(translation && track ? { trackId: track.id, target: plain(translation) } : {}) }, 'insert', 1);
    setSaving(false);
    if (ok) onClose();
  };

  return <ScrollableDialog open={open} onOpenChange={next => { if (!next && !saving) onClose(); }} maxWidth="sm:max-w-[480px]"
    onOpenAutoFocus={event => { event.preventDefault(); textBox.current?.focus(); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><ListPlus className="size-4" />{t('studio:cue_insert.title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{t(request?.position === 'before' ? 'studio:cue_insert.description_before' : 'studio:cue_insert.description_after', { number })}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-split p-3" fadeMaskHeight={12}>
      <div className="studio-cue-insert-times">
        <label htmlFor={`${id}-start`} className="text-xs font-medium">{t('studio:cue_insert.start')}</label>
        <Input id={`${id}-start`} data-testid="studio-cue-insert-start" className="h-8 font-mono text-sm" value={start} onChange={event => setStart(event.target.value)} />
        <label htmlFor={`${id}-end`} className="text-xs font-medium">{t('studio:cue_insert.end')}</label>
        <Input id={`${id}-end`} data-testid="studio-cue-insert-end" className="h-8 font-mono text-sm" value={end} placeholder={allowUnknownEnd ? t('studio:cue_insert.unknown_end') : undefined} onChange={event => setEnd(event.target.value)} />
        {mediaReady && startMs !== null && !timeProblem && <CueAudioButton playKey={`insert:${request?.cueId}`} data-testid="studio-cue-insert-play" label={t('studio:cue_insert.play')}
          request={{ documentId: page.summary.id, target: { range: { startMs, endMs: Math.max(startMs + 1, endMs ?? startMs + 5000) } } }} />}
      </div>
      {timeProblem && <p className="mt-1.5 text-xs text-destructive" role="alert" data-testid="studio-cue-insert-problem">{t(timeProblemKeys[timeProblem])}</p>}
      <label htmlFor={`${id}-source`} className="mb-1.5 mt-3 block text-xs font-medium">{t('studio:cue_insert.source')}</label>
      <textarea ref={textBox} id={`${id}-source`} data-testid="studio-cue-insert-source" className="studio-cue-split-text" rows={2} value={source}
        onChange={event => setSource(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void apply(); } }} />
      {textProblem && <p className="mt-1.5 text-xs text-destructive" role="alert">{t(`studio:cue_edit.problem.${textProblem}`)}</p>}
      {track && <>
        <label htmlFor={`${id}-target`} className="mb-1.5 mt-3 block text-xs font-medium">{t('studio:cue_insert.target')}</label>
        <textarea id={`${id}-target`} data-testid="studio-cue-insert-target" className="studio-cue-split-text" rows={2} value={target} placeholder={t('studio:cue_insert.target_optional')}
          onChange={event => setTarget(event.target.value)} />
        {targetProblem && <p className="mt-1.5 text-xs text-destructive" role="alert">{t(`studio:cue_edit.problem.${targetProblem}`)}</p>}
      </>}
      {busy && <p className="mt-2 text-xs text-muted-foreground">{busy}</p>}
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex justify-end gap-2 p-3">
      <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t('studio:cancel')}</Button>
      <Button size="sm" data-testid="studio-cue-insert-apply" disabled={!!busy || saving || !ready} onClick={() => void apply()}>
        {saving ? <LoaderCircle className="studio-spin" /> : <ListPlus />}{t('studio:cue_insert.apply')}
      </Button>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
