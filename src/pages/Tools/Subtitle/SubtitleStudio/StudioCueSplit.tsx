import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { editedText, type CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { parseStudioTime } from '@/subtitle-studio/cue-structure';
import type { CueSplitSuggestion } from '@/subtitle-studio/cue-split';
import type { CueEditLabel } from '@/services/subtitle-studio/cue-history';
import { formatStudioTime } from './StudioControls';
import { CueAudioButton, useStopCueAudioOnClose } from './StudioCueAudio';
import type { CueTrack } from './StudioCueMenu';
import './StudioCueSplit.css';

export type CueSplitRequest = { cueId: string; serial: number };
const BREAK = /[\s。！？!?，,、；;：:…）)」』】]/u;

/** Where to split by default: after the break (punctuation or space) nearest the middle, else the middle. */
export function defaultSplitOffset(text: string, share = 0.5): number {
  const middle = text.length * share;
  let best = -1;
  for (let offset = 1; offset < text.length; offset++) {
    if (BREAK.test(text[offset - 1]) && !BREAK.test(text[offset]) && (best < 0 || Math.abs(offset - middle) < Math.abs(best - middle))) best = offset;
  }
  return best > 0 ? best : Math.min(text.length - 1, Math.max(1, Math.round(middle)));
}
/**
 * A text box whose caret marks where the text is split. It is not `readOnly`, where Chromium keeps
 * the caret from moving with the arrow keys; every edit is refused before it happens instead.
 */
function SplitText({ id, text, offset, onOffset, label, testId }: { id: string; text: string; offset: number; onOffset: (offset: number) => void; label: string; testId: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { box.current?.setSelectionRange(offset, offset); }, [offset, text]);
  useEffect(() => {
    const element = box.current;
    const refuse = (event: Event) => event.preventDefault();
    element?.addEventListener('beforeinput', refuse);
    return () => element?.removeEventListener('beforeinput', refuse);
  }, []);
  const read = () => { const value = box.current?.selectionStart; if (value !== undefined && value > 0 && value < text.length && value !== offset) onOffset(value); };
  return <textarea ref={box} id={id} value={text} aria-readonly="true" aria-label={label} data-testid={testId} className="studio-cue-split-text" spellCheck={false}
    rows={Math.min(4, Math.max(2, Math.ceil(text.length / 40)))} onChange={() => undefined} onSelect={read} onKeyUp={read} onClick={read} />;
}

/** Splits one cue in two at a place in its text, at a time suggested from the transcript's words or the text. */
export function StudioCueSplit({ page, request, track, mediaReady, busy, onClose, onApply }: {
  page: DocumentPage;
  request: CueSplitRequest | null;
  /** The translation track shown; its translation of the cue can be split too. */
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
  const cue = index >= 0 ? page.cues[index] : undefined;
  const text = cue?.source.plain ?? '';
  const entry = cue && track ? track.entries[cue.id] : undefined;
  const number = page.offset + index + 1;
  const [offset, setOffset] = useState(1);
  const [targetOffset, setTargetOffset] = useState(1);
  const [splitTarget, setSplitTarget] = useState(true);
  const [time, setTime] = useState('');
  const [edited, setEdited] = useState(false);
  const [suggestion, setSuggestion] = useState<CueSplitSuggestion | null>(null);
  const [saving, setSaving] = useState(false);
  useStopCueAudioOnClose(open);
  useEffect(() => {
    if (!request || !cue) return;
    const at = defaultSplitOffset(cue.source.plain);
    setOffset(at); setEdited(false); setSuggestion(null); setSaving(false); setSplitTarget(true); setTime('');
    if (entry) setTargetOffset(defaultSplitOffset(entry.text.plain, at / cue.source.plain.length));
    // Only a new request starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.serial]);
  // The main process suggests the time: it holds the transcript's word times.
  const documentId = page.summary.id, revision = page.summary.revision;
  useEffect(() => {
    if (!open || !cue) return;
    let live = true;
    const timer = setTimeout(() => {
      void window.subtitleStudio.suggestCueSplit({ documentId, revision, cueId: cue.id, offset }).then(result => {
        if (!live || !result.ok) return;
        setSuggestion(result.value);
        if (!edited) setTime(formatStudioTime(result.value.splitMs));
      }, () => undefined);
    }, 150);
    return () => { live = false; clearTimeout(timer); };
    // A typed time stays until the split place moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cue?.id, offset, documentId, revision]);
  const move = (value: number) => { setOffset(value); setEdited(false); };

  const splitMs = parseStudioTime(time);
  const halves = [text.slice(0, offset).trim(), text.slice(offset).trim()] as const;
  const targetText = entry?.text.plain ?? '';
  const targetHalves = [targetText.slice(0, targetOffset).trim(), targetText.slice(targetOffset).trim()] as const;
  const withTarget = !!entry && splitTarget;
  const endMs = cue?.timing.endMs ?? null;
  const problem = !cue ? null : !halves[0] || !halves[1] || (withTarget && (!targetHalves[0] || !targetHalves[1])) ? 'empty'
    : splitMs === null ? (time.trim() ? 'invalid' : 'pending')
    : splitMs <= cue.timing.startMs || (endMs !== null && splitMs >= endMs) ? 'out_of_range' : null;
  const apply = async () => {
    if (!cue || problem || splitMs === null || saving) return;
    setSaving(true);
    const ok = await onApply({ kind: 'split', cueId: cue.id, sources: [editedText(cue.source, halves[0]), editedText(cue.source, halves[1])], splitMs,
      ...(withTarget && track ? { trackId: track.id, targets: [editedText(entry!.text, targetHalves[0]), editedText(entry!.text, targetHalves[1])] } : {}) }, 'split', 1);
    setSaving(false);
    if (ok) onClose();
  };
  const parts = cue && splitMs !== null ? [
    { number, text: halves[0], startMs: cue.timing.startMs, endMs: splitMs },
    { number: number + 1, text: halves[1], startMs: splitMs, endMs: endMs ?? splitMs + 5000, unknownEnd: endMs === null },
  ] : [];

  return <ScrollableDialog open={open} onOpenChange={next => { if (!next && !saving) onClose(); }} maxWidth="sm:max-w-[520px]"
    onOpenAutoFocus={event => { event.preventDefault(); document.getElementById(`${id}-source`)?.focus(); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><Scissors className="size-4" />{t('studio:cue_split.title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{t('studio:cue_split.description', { number })}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-split p-3" fadeMaskHeight={12}>
      <label htmlFor={`${id}-source`} className="mb-1.5 block text-xs font-medium">{t('studio:cue_split.source')}</label>
      <SplitText id={`${id}-source`} text={text} offset={offset} onOffset={move} label={t('studio:cue_split.source')} testId="studio-cue-split-source" />
      {entry && <>
        <label className="studio-cue-split-check"><Checkbox checked={splitTarget} onCheckedChange={value => setSplitTarget(value === true)} data-testid="studio-cue-split-target-toggle" />{t('studio:cue_split.split_target')}</label>
        {splitTarget ? <SplitText id={`${id}-target`} text={targetText} offset={targetOffset} onOffset={setTargetOffset} label={t('studio:cue_split.target')} testId="studio-cue-split-target" />
          : <p className="text-xs text-muted-foreground">{t('studio:cue_split.target_kept')}</p>}
      </>}
      <div className="studio-cue-split-time">
        <label htmlFor={`${id}-time`} className="text-xs font-medium">{t('studio:cue_split.time')}</label>
        <Input id={`${id}-time`} data-testid="studio-cue-split-time" className="h-8 w-36 font-mono text-sm" value={time} aria-invalid={problem === 'invalid' || problem === 'out_of_range' || undefined}
          onChange={event => { setTime(event.target.value); setEdited(true); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} />
        {suggestion && <span className="text-xs text-muted-foreground" data-testid="studio-cue-split-basis">{t(`studio:cue_split.basis_${suggestion.basis}`)}</span>}
      </div>
      <ol className="studio-cue-split-parts" aria-label={t('studio:cue_split.preview')}>
        {parts.map((part, at) => <li key={at} data-testid="studio-cue-split-part">
          {mediaReady && <CueAudioButton playKey={`split:${cue!.id}:${at}`} data-testid="studio-cue-split-play" label={t('studio:cue_split.play', { number: part.number })}
            request={{ documentId, target: { range: { startMs: part.startMs, endMs: Math.max(part.startMs + 1, part.endMs) } } }} />}
          <span className="studio-cue-split-number">{part.number}</span>
          <span className="studio-cue-split-range">{formatStudioTime(part.startMs)} → {part.unknownEnd ? '—' : formatStudioTime(part.endMs)}</span>
          <span className="studio-cue-split-part-text">{part.text || '—'}{withTarget && <span className="text-muted-foreground"> · {targetHalves[at] || '—'}</span>}</span>
        </li>)}
      </ol>
      {problem && problem !== 'pending' && <p className="mt-2 text-xs text-destructive" role="alert" data-testid="studio-cue-split-problem">{t(`studio:cue_split.problem_${problem}`)}</p>}
      {busy && <p className="mt-2 text-xs text-muted-foreground">{busy}</p>}
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex justify-end gap-2 p-3">
      <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t('studio:cancel')}</Button>
      <Button size="sm" data-testid="studio-cue-split-apply" disabled={!!busy || saving || !!problem} onClick={() => void apply()}>
        {saving ? <LoaderCircle className="studio-spin" /> : <Scissors />}{t('studio:cue_split.apply')}
      </Button>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
