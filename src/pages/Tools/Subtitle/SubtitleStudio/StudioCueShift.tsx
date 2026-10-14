import { useEffect, useId, useRef, useState } from 'react';
import { Clock3, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { consecutive } from '@/subtitle-studio/cue-structure';
import { CUE_SHIFT_MAX_MS, cueStretchRatioSchema, decimalRatio, FRAME_RATES, frameRateRatio, type CueShiftPreview, type CueStretchPreview, type CueStretchRatio, type FrameRateId } from '@/subtitle-studio/cue-shift';
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
/** Moving every cue by the same amount, or stretching times by a ratio (frame rate conversion). */
type AdjustMode = 'shift' | 'stretch';
type StretchSource = 'rates' | 'custom';
const STEPS = [-1000, -100, 100, 1000] as const;
const ratioText = (ratio: CueStretchRatio) => (ratio.num / ratio.den).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

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
 * Adjusts cue times as one edit. Shift moves cues earlier or later by the same amount: the selected
 * cues on this page, or, through the main process, every cue from one of them to the end or the
 * whole document. Stretch scales the times from one cue (or the whole document) by a ratio, for a
 * video at another frame rate. The reference cue can be heard at its new time before applying.
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
  const [mode, setMode] = useState<AdjustMode>('shift');
  const [source, setSource] = useState<StretchSource>('rates');
  const [subtitleFps, setSubtitleFps] = useState<FrameRateId>('25');
  const [videoFps, setVideoFps] = useState<FrameRateId>('23.976');
  const [custom, setCustom] = useState('1.0427');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ key: string; value?: CueShiftPreview; failed?: boolean } | null>(null);
  const [stretchPreview, setStretchPreview] = useState<{ key: string; value?: CueStretchPreview; failed?: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useStopCueAudioOnClose(open);
  useEffect(() => { if (request) { setValue('0'); setSaving(false); setScope(request.scope); setMode('shift'); setPreview(null); setStretchPreview(null); } }, [request]);

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
  // Stretching: from the reference cue to the end (it keeps its start), or the whole document from 0.
  const stretchScope: 'from' | 'all' = scope === 'all' || number <= 1 || !request?.cueIds.length ? 'all' : 'from';
  const stretchFrom = stretchScope === 'from' ? anchor?.id : undefined;
  const typedRatio = source === 'rates' ? (subtitleFps === videoFps ? null : frameRateRatio(subtitleFps, videoFps)) : decimalRatio(custom);
  const ratio = typedRatio && cueStretchRatioSchema.safeParse(typedRatio).success ? typedRatio : null;
  const stretchKey = `${documentId}:${revision}:${stretchFrom ?? ''}:${ratio ? `${ratio.num}/${ratio.den}` : ''}`;
  useEffect(() => {
    if (!open || mode !== 'stretch' || !ratio) return;
    let live = true;
    const timer = setTimeout(() => {
      void window.subtitleStudio.previewCueStretch({ documentId, revision, ratio, ...(stretchFrom ? { fromCueId: stretchFrom } : {}) }).then(
        result => { if (live) setStretchPreview(result.ok ? { key: stretchKey, value: result.value } : { key: stretchKey, failed: true }); },
        () => { if (live) setStretchPreview({ key: stretchKey, failed: true }); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
    // The ratio is in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, stretchKey, documentId, revision, stretchFrom]);
  const stretchRemote = stretchPreview?.key === stretchKey ? stretchPreview : undefined;
  const stretchProblem: 'stretch_invalid' | 'shift_failed' | 'shift_beyond_media' | null = !ratio ? 'stretch_invalid' : stretchRemote?.failed ? 'shift_failed'
    : stretchRemote?.value?.problem === 'beyond_media' ? 'shift_beyond_media' : null;
  const stretchChecking = !!ratio && !stretchRemote;
  const remote = scope !== 'selected' && preview?.key === key ? preview : undefined;
  const count = scope === 'selected' ? selected.length : remote?.value?.count ?? (scope === 'all' ? page.summary.cueCount : undefined);
  const problem = delta === null ? 'invalid'
    : local && 'problem' in local ? local.problem
    : remote?.failed ? 'failed' : remote?.value?.problem ?? null;
  const checking = scope !== 'selected' && !!delta && !remote;

  const apply = async () => {
    if (mode === 'stretch') {
      if (!ratio || stretchProblem || stretchChecking || saving) return;
      setSaving(true);
      const ok = await onApply({ kind: 'stretch', ratio, ...(stretchFrom ? { fromCueId: stretchFrom } : {}) }, 'stretch', stretchRemote?.value?.count ?? 0);
      setSaving(false);
      if (ok) onClose();
      return;
    }
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
  const stretchOptions = [
    // From a line only when one was chosen; without a selection the stretch is the whole document.
    ...number > 1 && anchor && request?.cueIds.length ? [{ value: 'from' as const, label: t('studio:cue_structure.shift_scope_from', { number }), testId: 'studio-cue-stretch-scope-from' }] : [],
    { value: 'all' as const, label: t('studio:cue_structure.shift_scope_all', { count: page.summary.cueCount }), testId: 'studio-cue-stretch-scope-all' },
  ];
  // The last line is heard where the stretch puts it: that is where the difference is largest.
  const lastValue = stretchRemote?.value;
  const stretchStart = lastValue?.lastAfterMs ?? -1;
  const stretchEnd = lastValue?.lastEndAfterMs ?? stretchStart + CUE_AUDIO_LIMITS.unknownEndMs;
  const description = mode === 'stretch'
    ? t(stretchScope === 'from' ? 'studio:cue_structure.stretch_description_from' : 'studio:cue_structure.stretch_description_all', { number, count: page.summary.cueCount })
    : scope === 'selected' ? t('studio:cue_structure.shift_description', { count: selected.length })
    : scope === 'from' ? t('studio:cue_structure.shift_description_from', { number })
    : t('studio:cue_structure.shift_description_all', { count: page.summary.cueCount });

  return <ScrollableDialog open={open} onOpenChange={next => { if (!next && !saving) onClose(); }} maxWidth="sm:max-w-[480px]"
    onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><Clock3 className="size-4" />{t('studio:cue_structure.adjust_title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{description}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-shift p-3" fadeMaskHeight={12}>
      <ToolRadioButtonGroup ariaLabel={t('studio:cue_structure.adjust_mode')} value={mode} onValueChange={setMode} className="studio-cue-shift-mode"
        options={[{ value: 'shift' as const, label: t('studio:cue_structure.mode_shift'), testId: 'studio-cue-adjust-shift' }, { value: 'stretch' as const, label: t('studio:cue_structure.mode_stretch'), testId: 'studio-cue-adjust-stretch' }]} />
      {mode === 'stretch' ? <div className="studio-cue-stretch" data-testid="studio-cue-stretch">
        {stretchOptions.length > 1 && <ToolRadioButtonGroup ariaLabel={t('studio:cue_structure.shift_scope')} value={stretchScope} options={stretchOptions}
          onValueChange={value => setScope(value)} className="studio-cue-shift-scope" />}
        <ToolRadioButtonGroup ariaLabel={t('studio:cue_structure.stretch_source')} value={source} onValueChange={setSource} className="studio-cue-shift-scope"
          options={[{ value: 'rates' as const, label: t('studio:cue_structure.stretch_source_rates'), testId: 'studio-cue-stretch-rates' }, { value: 'custom' as const, label: t('studio:cue_structure.stretch_source_custom'), testId: 'studio-cue-stretch-custom' }]} />
        {source === 'rates' ? <div className="studio-cue-stretch-rates">
          <label className="studio-cue-stretch-field"><span>{t('studio:cue_structure.stretch_subtitle_fps')}</span>
            <Select value={subtitleFps} onValueChange={value => setSubtitleFps(value as FrameRateId)}>
              <SelectTrigger data-testid="studio-cue-stretch-subtitle-fps" aria-label={t('studio:cue_structure.stretch_subtitle_fps')}><SelectValue /></SelectTrigger>
              <SelectContent>{FRAME_RATES.map(rate => <SelectItem key={rate.id} value={rate.id}>{rate.id} fps</SelectItem>)}</SelectContent>
            </Select></label>
          <span className="studio-cue-stretch-arrow" aria-hidden="true">→</span>
          <label className="studio-cue-stretch-field"><span>{t('studio:cue_structure.stretch_video_fps')}</span>
            <Select value={videoFps} onValueChange={value => setVideoFps(value as FrameRateId)}>
              <SelectTrigger data-testid="studio-cue-stretch-video-fps" aria-label={t('studio:cue_structure.stretch_video_fps')}><SelectValue /></SelectTrigger>
              <SelectContent>{FRAME_RATES.map(rate => <SelectItem key={rate.id} value={rate.id}>{rate.id} fps</SelectItem>)}</SelectContent>
            </Select></label>
          <span className="studio-cue-stretch-ratio" data-testid="studio-cue-stretch-ratio">{ratio ? t('studio:cue_structure.stretch_ratio', { ratio: ratioText(ratio) }) : ''}</span>
        </div> : <div>
          <label htmlFor={`${id}-ratio`} className="mb-1.5 block text-xs font-medium">{t('studio:cue_structure.stretch_custom_label')}</label>
          <Input id={`${id}-ratio`} data-testid="studio-cue-stretch-custom-ratio" inputMode="decimal" className="h-8 font-mono text-sm" value={custom} aria-invalid={!ratio || undefined}
            onChange={event => setCustom(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} />
        </div>}
        <div className="studio-cue-shift-result">
          {mediaReady && <CueAudioButton playKey={`stretch:${documentId}`} data-testid="studio-cue-stretch-listen" disabled={!!stretchProblem || stretchChecking || stretchStart < 0}
            label={t('studio:cue_structure.stretch_listen', { number: page.summary.cueCount })}
            request={{ documentId, target: { range: { startMs: Math.max(0, stretchStart), endMs: Math.max(stretchStart + 1, stretchEnd) } } }} />}
          <p className={stretchProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} role={stretchProblem ? 'alert' : undefined} data-testid="studio-cue-stretch-preview">
            {stretchProblem ? t(`studio:cue_structure.${stretchProblem}`)
              : stretchChecking ? t('studio:cue_structure.shift_checking')
              : stretchRemote?.value && stretchRemote.value.lastBeforeMs !== undefined ? t('studio:cue_structure.stretch_preview', { count: stretchRemote.value.count,
                from: formatStudioTime(stretchRemote.value.lastBeforeMs), to: formatStudioTime(stretchRemote.value.lastAfterMs!) }) : ''}
          </p>
        </div>
      </div> : <>
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
      </>}
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex justify-end gap-2 p-3">
      <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t('studio:cancel')}</Button>
      {mode === 'stretch'
        ? <Button size="sm" data-testid="studio-cue-stretch-apply" disabled={busy || saving || !!stretchProblem || stretchChecking} onClick={() => void apply()}>
          {saving ? <LoaderCircle className="studio-spin" /> : <Clock3 />}{t('studio:cue_structure.stretch_apply')}
        </Button>
        : <Button size="sm" data-testid="studio-cue-shift-apply" disabled={busy || saving || !!problem || checking || !delta} onClick={() => void apply()}>
          {saving ? <LoaderCircle className="studio-spin" /> : <Clock3 />}{t('studio:cue_structure.shift_apply')}
        </Button>}
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
