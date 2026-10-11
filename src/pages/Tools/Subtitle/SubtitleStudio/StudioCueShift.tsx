import { useEffect, useId, useRef, useState } from 'react';
import { Clock3, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { consecutive } from '@/subtitle-studio/cue-structure';
import { CUE_SHIFT_MAX_MS, type CueShiftPreview } from '@/subtitle-studio/cue-shift';
import { CUE_AUDIO_LIMITS } from '@/subtitle-studio/cue-audio';
import type { CueEditLabel } from '@/services/subtitle-studio/cue-history';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import { formatStudioTime } from './StudioControls';
import { CueAudioButton, useStopCueAudioOnClose } from './StudioCueAudio';
import './StudioCueShift.css';

type Cue = DocumentPage['cues'][number];
/** The selected cues, every cue from the first selected one to the end, or the whole document. */
export type CueShiftScope = 'selected' | 'from' | 'all';
export type CueShiftRequest = { cueIds: string[]; scope: CueShiftScope };
const STEPS = [-1000, -100, 100, 1000] as const;

/** Times of the cues moved by `deltaMs`, or why they cannot move. */
export function shiftedTimes(cues: readonly Cue[], deltaMs: number, previousStart?: number, nextStart?: number) {
  const changes: Record<string, { startMs: number; endMs: number | null }> = {};
  for (const cue of cues) {
    const startMs = cue.timing.startMs + deltaMs;
    const endMs = cue.timing.endMs === null ? null : cue.timing.endMs + deltaMs;
    if (startMs < 0) return { problem: 'negative' as const };
    changes[cue.id] = { startMs, endMs };
  }
  const first = changes[cues[0].id].startMs, last = changes[cues.at(-1)!.id].startMs;
  if (previousStart !== undefined && first < previousStart && cues[0].timing.startMs >= previousStart) return { problem: 'before_previous' as const };
  if (nextStart !== undefined && last > nextStart && cues.at(-1)!.timing.startMs <= nextStart) return { problem: 'after_next' as const };
  return { changes };
}

/**
 * Moves cues earlier or later by the same amount, as one edit: the selected cues on this page, or,
 * through the main process, every cue from one of them to the end or the whole document. The
 * reference cue can be heard at its shifted time before applying.
 */
export function StudioCueShift({ page, request, mediaReady, busy, onClose, onApply }: {
  page: DocumentPage;
  request: CueShiftRequest | null;
  /** The document's original audio can be played. */
  mediaReady: boolean;
  busy: boolean;
  onClose: () => void;
  onApply: (operation: CueEditOperation, label: CueEditLabel, count: number) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const open = !!request;
  const [value, setValue] = useState('0');
  const [scope, setScope] = useState<CueShiftScope>('selected');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ key: string; value?: CueShiftPreview; failed?: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useStopCueAudioOnClose(open);
  useEffect(() => { if (request) { setValue('0'); setSaving(false); setScope(request.scope); setPreview(null); } }, [request]);

  const order = page.cues.map(cue => cue.id);
  const selected = page.cues.filter(cue => request?.cueIds.includes(cue.id));
  const anchor = selected[0] ?? page.cues[0];
  const anchorIndex = anchor ? order.indexOf(anchor.id) : -1;
  const number = page.offset + anchorIndex + 1;
  const delta = /^\s*[+-]?\d{1,9}\s*$/.test(value) && Math.abs(Number(value)) <= CUE_SHIFT_MAX_MS ? Number(value) : null;
  const documentId = page.summary.id, revision = page.summary.revision;
  const fromCueId = scope === 'from' ? anchor?.id : undefined;

  // The selected cues are on this page: their new times are worked out here.
  const together = selected.length > 0 && consecutive(selected.map(cue => cue.id), order);
  const first = order.indexOf(selected[0]?.id), last = order.indexOf(selected.at(-1)?.id ?? '');
  const local = scope === 'selected' && delta !== null && selected.length
    ? shiftedTimes(selected, delta, together ? page.cues[first - 1]?.timing.startMs : undefined, together ? page.cues[last + 1]?.timing.startMs : undefined) : null;
  // A shift to the end of the document is checked by the main process, which holds every cue.
  const key = `${documentId}:${revision}:${scope}:${fromCueId ?? ''}:${delta}`;
  useEffect(() => {
    if (!open || scope === 'selected' || !delta) return;
    let live = true;
    const timer = setTimeout(() => {
      void window.subtitleStudio.previewCueShift({ documentId, revision, deltaMs: delta, ...(fromCueId ? { fromCueId } : {}) }).then(
        result => { if (live) setPreview(result.ok ? { key, value: result.value } : { key, failed: true }); },
        () => { if (live) setPreview({ key, failed: true }); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [open, key, scope, delta, documentId, revision, fromCueId]);
  const remote = scope !== 'selected' && preview?.key === key ? preview : undefined;
  const count = scope === 'selected' ? selected.length : remote?.value?.count ?? (scope === 'all' ? page.summary.cueCount : undefined);
  const problem = delta === null ? 'invalid'
    : local && 'problem' in local ? local.problem
    : remote?.failed ? 'failed' : remote?.value?.problem ?? null;
  const checking = scope !== 'selected' && !!delta && !remote;

  const apply = async () => {
    if (!delta || problem || checking || saving || !anchor) return;
    let ok: boolean;
    setSaving(true);
    if (scope === 'selected') {
      if (!local || !('changes' in local)) { setSaving(false); return; }
      ok = await onApply({ kind: 'timing', changes: local.changes! }, 'timing', selected.length);
    } else ok = await onApply({ kind: 'shift', deltaMs: delta, ...(fromCueId ? { fromCueId } : {}) }, 'shift', count ?? 0);
    setSaving(false);
    if (ok) onClose();
  };
  const nudge = (step: number) => {
    const next = Math.max(-CUE_SHIFT_MAX_MS, Math.min(CUE_SHIFT_MAX_MS, (delta ?? 0) + step));
    setValue(String(next));
  };

  // The reference cue heard where it will be after the shift.
  const anchorEnd = anchor ? anchor.timing.endMs ?? page.cues[anchorIndex + 1]?.timing.startMs ?? anchor.timing.startMs + CUE_AUDIO_LIMITS.unknownEndMs : 0;
  const listenStart = anchor ? anchor.timing.startMs + (delta ?? 0) : -1;
  const listenEnd = anchorEnd + (delta ?? 0);
  const options = request?.cueIds.length ? [
    { value: 'selected' as const, label: t('studio:cue_structure.shift_scope_selected', { count: selected.length }), testId: 'studio-cue-shift-scope-selected' },
    // From the first line of the document is the whole document.
    ...number > 1 ? [{ value: 'from' as const, label: t('studio:cue_structure.shift_scope_from', { number }), testId: 'studio-cue-shift-scope-from' }] : [],
    { value: 'all' as const, label: t('studio:cue_structure.shift_scope_all', { count: page.summary.cueCount }), testId: 'studio-cue-shift-scope-all' },
  ] : [];
  const description = scope === 'selected' ? t('studio:cue_structure.shift_description', { count: selected.length })
    : scope === 'from' ? t('studio:cue_structure.shift_description_from', { number })
    : t('studio:cue_structure.shift_description_all', { count: page.summary.cueCount });

  return <ScrollableDialog open={open} onOpenChange={next => { if (!next && !saving) onClose(); }} maxWidth="sm:max-w-[480px]"
    onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><Clock3 className="size-4" />{t('studio:cue_structure.shift_title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{description}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-shift p-3" fadeMaskHeight={12}>
      {options.length > 0 && <ToolRadioButtonGroup ariaLabel={t('studio:cue_structure.shift_scope')} value={scope} options={options} onValueChange={setScope} className="studio-cue-shift-scope" />}
      <label htmlFor={`${id}-delta`} className="mb-1.5 block text-xs font-medium">{t('studio:cue_structure.shift_label')}</label>
      <div className="studio-cue-shift-amount">
        <Input ref={input} id={`${id}-delta`} data-testid="studio-cue-shift-delta" inputMode="numeric" className="h-8 font-mono text-sm" value={value} aria-invalid={!!problem && value.trim() !== '' || undefined}
          onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} />
        <div className="studio-cue-shift-steps" role="group" aria-label={t('studio:cue_structure.shift_steps')}>
          {STEPS.map(step => <Button key={step} type="button" variant="outline" size="sm" className="font-mono" data-testid={`studio-cue-shift-step-${step}`}
            aria-label={t(step < 0 ? 'studio:cue_structure.shift_earlier' : 'studio:cue_structure.shift_later', { seconds: Math.abs(step) / 1000 })}
            onClick={() => nudge(step)}>{`${step < 0 ? '−' : '+'}${Math.abs(step) / 1000}s`}</Button>)}
        </div>
      </div>
      <div className="studio-cue-shift-result">
        {mediaReady && anchor && <CueAudioButton playKey={`shift:${anchor.id}`} data-testid="studio-cue-shift-listen" disabled={delta === null || listenStart < 0}
          label={t('studio:cue_structure.shift_listen', { number })}
          request={{ documentId, target: { range: { startMs: Math.max(0, listenStart), endMs: Math.max(listenStart + 1, listenEnd) } } }} />}
        <p className={problem && value.trim() ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} role={problem ? 'alert' : undefined} data-testid="studio-cue-shift-preview">
          {problem ? t(`studio:cue_structure.shift_${problem}`)
            : checking ? t('studio:cue_structure.shift_checking')
            : anchor && delta !== null ? t('studio:cue_structure.shift_preview', { number, from: formatStudioTime(anchor.timing.startMs), to: formatStudioTime(anchor.timing.startMs + delta), count }) : ''}
        </p>
      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex justify-end gap-2 p-3">
      <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t('studio:cancel')}</Button>
      <Button size="sm" data-testid="studio-cue-shift-apply" disabled={busy || saving || !!problem || checking || !delta} onClick={() => void apply()}>
        {saving ? <LoaderCircle className="studio-spin" /> : <Clock3 />}{t('studio:cue_structure.shift_apply')}
      </Button>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
