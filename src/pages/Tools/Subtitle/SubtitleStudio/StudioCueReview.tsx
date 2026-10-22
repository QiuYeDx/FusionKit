import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AudioWaveform, ChevronDown, ChevronUp, Copy, EyeOff, FoldHorizontal, Gauge, Ghost, ListChecks, ListFilter, ListRestart, Music, Play, Repeat2, Timer, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { CUE_REVIEW_REASONS, collapseRepetition, cueReviewIgnoreKey, reviewPosition, reviewStep, visibleReview,
  type CueReviewEntry, type CueReviewReason, type CueReviewResult } from '@/subtitle-studio/transcription-review';
import { cueReviewIgnores } from '@/services/subtitle-studio/cue-review-ignores';
import type { CueAudioRequest } from '@/services/subtitle-studio/cue-audio-player';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import { StudioIconButton } from './StudioControls';
import { CueAudioButton } from './StudioCueAudio';
import type { CueFindTarget } from './StudioCueFind';
import './StudioCueReview.css';

export const CUE_REVIEW_ICONS: Record<CueReviewReason, LucideIcon> = {
  low_confidence: Gauge, phantom_phrase: Ghost, repetition_loop: Repeat2, non_speech_only: Music, abnormal_rate: Timer, duplicate_neighbor: Copy,
};
type Filter = CueReviewReason | 'all';
/** The toolbar's count stops growing here, as a badge would. */
export const reviewCountText = (count: number) => count > 999 ? '999+' : String(count);

/**
 * The quality review of a transcribed document's cues: asked of the main process for every
 * revision, without the flags ignored on this computer. Only transcribed (media) documents
 * are reviewed; `result` is null for others and until the first answer arrives. The reason
 * filter belongs to the document shown; `shown` are the flagged cues it lets through, which
 * the list alone shows while `only` is on.
 */
export function useCueReview(page: DocumentPage) {
  const documentId = page.summary.id, revision = page.summary.revision;
  const enabled = page.summary.origin.format === 'media';
  const [answer, setAnswer] = useState<{ documentId: string; revision: number; value: CueReviewResult } | null>(null);
  const [ignored, setIgnored] = useState(() => cueReviewIgnores.read(documentId));
  const [choice, setChoice] = useState<{ documentId: string; filter: Filter } | null>(null);
  const [only, setOnly] = useState(true);
  useEffect(() => setIgnored(cueReviewIgnores.read(documentId)), [documentId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void window.subtitleStudio.reviewCues({ documentId, revision }).then(found => {
      if (live && found.ok) setAnswer({ documentId, revision, value: found.value });
    }, () => undefined);
    return () => { live = false; };
  }, [enabled, documentId, revision]);
  // While a newer revision is reviewed the last answer for this document stays, so marks do not flicker.
  const current = enabled && answer?.documentId === documentId ? answer.value : null;
  const result = useMemo(() => current && visibleReview(current, ignored), [current, ignored]);
  const byCue = useMemo(() => new Map(result?.cues.map(entry => [entry.cueId, entry])), [result]);
  const filter = choice?.documentId === documentId ? choice.filter : 'all';
  // A reason that no longer flags anything (after edits or ignores) leaves the filter at all reasons.
  const active: Filter = filter !== 'all' && !result?.counts[filter] ? 'all' : filter;
  const shown = useMemo(() => !result ? [] : active === 'all' ? result.cues : result.cues.filter(entry => entry.reasons.includes(active)), [result, active]);
  return { enabled, result, byCue, active, shown, only, setOnly,
    setFilter: (value: Filter) => setChoice({ documentId, filter: value }),
    /** Flags of this document hidden by an ignore; `restore` shows them all again. */
    ignoredCount: current && result ? current.total - result.total : 0,
    restore: () => setIgnored(cueReviewIgnores.clear(documentId)),
    ignore: (entry: CueReviewEntry) => setIgnored(cueReviewIgnores.add(documentId, cueReviewIgnoreKey(entry))) };
}
export type CueReview = ReturnType<typeof useCueReview>;

/** Each reason of a flagged cue with what it means, for the tooltips of the row mark, the bar and a recognized result. */
export function CueReviewReasons({ entry }: { entry: Pick<CueReviewEntry, 'reasons' | 'confidence'> }) {
  const { t } = useTranslation();
  return <ul>{entry.reasons.map(reason => <li key={reason}><strong>{t(`studio:cue_review.reasons.${reason}`)}</strong>
    <span>{t(`studio:cue_review.details.${reason}`, { confidence: entry.confidence?.toFixed(2) })}</span></li>)}</ul>;
}

/** A flagged row's mark beside its number: the first reason's icon, every reason on hover. */
export function CueReviewBadge({ entry, current }: { entry: CueReviewEntry; current: boolean }) {
  const { t } = useTranslation();
  const Icon = CUE_REVIEW_ICONS[entry.reasons[0]];
  const label = t('studio:cue_review.badge', { reasons: entry.reasons.map(reason => t(`studio:cue_review.reasons.${reason}`)).join(t('studio:cue_review.separator')) });
  return <Tooltip delayDuration={250}>
    <TooltipTrigger asChild><span className="studio-cue-review-badge" role="img" aria-label={label} data-current={current || undefined} data-testid="studio-cue-review-badge"><Icon /></span></TooltipTrigger>
    <TooltipContent side="right" sideOffset={6} className="studio-cue-review-tip"><CueReviewReasons entry={entry} /></TooltipContent>
  </Tooltip>;
}

/** Whether the reason filter's segments fit the bar at their natural width; measured, so it holds in every language. */
function useSegmentsFit(labels: string[]) {
  const row = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const key = labels.join('\n');
  useLayoutEffect(() => {
    const measure = () => {
      if (!row.current || !ruler.current) return;
      // The segments share the width equally: the widest label decides, plus the item and track padding.
      const widest = Math.max(0, ...Array.from(ruler.current.children, item => item.getBoundingClientRect().width));
      setFits((widest + 12) * labels.length + 4 <= row.current.clientWidth);
    };
    measure();
    if (!row.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(row.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { row, ruler, fits };
}

/**
 * The list's review bar, in the find bar's place: counts the cues worth hearing again by reason,
 * moves between them across pages and offers the current one's quick actions. While it is open
 * the list shows only those cues, unless `only` is turned off to read them among the rest. It
 * only marks; collapsing a repetition is an ordinary text edit, so it undoes like any other.
 */
export function StudioCueReview({ page, review, focusSerial, mediaReady, editBlocked, audio, onClose, onGo, onCurrent, onNeedsMedia, onRecognize, onCollapse }: {
  page: DocumentPage;
  review: CueReview;
  /** Changes when the toolbar button is pressed again: the bar takes focus. */
  focusSerial: number;
  mediaReady: boolean;
  editBlocked?: string;
  audio: { key: (cueId: string) => string; request: (cueId: string) => CueAudioRequest };
  onClose: () => void;
  onGo: (target: CueFindTarget) => void;
  onCurrent: (cueId: string | undefined) => void;
  onNeedsMedia: () => void;
  /** Recognizes cues again: the current one, or all those listed, with where each is in the document. */
  onRecognize: (cueIds: string[], positions?: Record<string, number>) => void;
  onCollapse: (cueId: string, text: string) => void;
}) {
  const { t } = useTranslation();
  const [position, setPosition] = useState(-1);
  const bar = useRef<HTMLDivElement>(null);
  /** The cue index shown last, kept so that a new answer continues from there. */
  const anchor = useRef(page.offset);
  const shownId = useRef<string | undefined>(undefined);
  const { result, active, shown: cues } = review;
  const reasons = CUE_REVIEW_REASONS.filter(reason => result?.counts[reason]);
  useLayoutEffect(() => { bar.current?.focus({ preventScroll: true }); }, [focusSerial]);

  const go = (entry: CueReviewEntry) => {
    anchor.current = entry.index;
    if (shownId.current === entry.cueId) return;
    shownId.current = entry.cueId;
    onGo(entry);
  };
  // A new answer (after an edit or an ignore) or another reason continues from the cue shown last.
  useEffect(() => {
    const at = reviewPosition(cues, anchor.current);
    setPosition(at);
    if (at >= 0) go(cues[at]);
    // go and onGo are fresh closures each render; following them would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cues]);
  const current = position >= 0 ? cues[position] : undefined;
  useEffect(() => { onCurrent(current?.cueId); }, [current?.cueId, onCurrent]);
  // Closing clears the current mark; the latest callback is used, whatever its identity.
  const clear = useRef(onCurrent);
  clear.current = onCurrent;
  useEffect(() => () => clear.current(undefined), []);

  const move = (step: 1 | -1) => {
    if (!cues.length) return;
    const at = reviewStep(cues.length, position, step);
    setPosition(at);
    go(cues[at]);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    // An Escape the filter's select or a dialog opened from here already took closes only that.
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // Enter and Shift+Enter move, as in the find bar, unless a control of the bar has focus.
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && (target === bar.current || target.dataset.reviewStep)) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
  };

  const options = (['all', ...reasons] as Filter[]).map(value => ({ value, name: value === 'all' ? t('studio:cue_review.all') : t(`studio:cue_review.reasons.${value}`),
    count: value === 'all' ? result?.total ?? 0 : result?.counts[value] ?? 0 }));
  const labels = options.map(option => `${option.name} ${option.count}`);
  const optionLabel = (option: (typeof options)[number]) => <>{option.name} <span className="studio-cue-review-option-count">{option.count}</span></>;
  const { row, ruler, fits } = useSegmentsFit(labels);
  const cue = current && page.cues.find(item => item.id === current.cueId);
  const collapsed = cue && current?.reasons.includes('repetition_loop') ? collapseRepetition(cue.source.plain) : null;
  /** Whether the list shows only flagged cues: with nothing flagged it shows every row, whatever `only` says. */
  const listing = review.only && !!result?.total;
  const count = !result ? t('studio:cue_review.loading') : !result.total ? t('studio:cue_review.none')
    : t(result.truncated && active === 'all' ? 'studio:cue_review.count_truncated' : 'studio:cue_review.count', { position: position + 1, total: cues.length });

  return <div ref={bar} className="studio-cue-find studio-cue-review" role="region" tabIndex={-1} aria-label={t('studio:cue_review.open')} data-testid="studio-cue-review" onKeyDown={keys}>
    <div className="studio-cue-find-row">
      <span className="studio-cue-review-title"><ListChecks aria-hidden="true" />{t('studio:cue_review.label')}</span>
      <span className="studio-cue-find-count" aria-live="polite" data-testid="studio-cue-review-count">{count}</span>
      <StudioIconButton label={t('studio:cue_review.only')} aria-pressed={listing} data-state={listing ? 'on' : 'off'} disabled={!result?.total} data-testid="studio-cue-review-only"
        onClick={() => review.setOnly(!review.only)}><ListFilter /></StudioIconButton>
      {/* The two-pass use: every cue the filter lists, with another model; the dialog takes the first ones up to its limit. */}
      <StudioIconButton label={t('studio:cue_review.recognize_filtered', { count: cues.length })} disabled={!cues.length || !!editBlocked || !mediaReady} data-testid="studio-cue-review-recognize-filtered"
        onClick={() => onRecognize(cues.map(entry => entry.cueId), Object.fromEntries(cues.map(entry => [entry.cueId, entry.index])))}><ListRestart /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_review.previous')} disabled={!cues.length} data-review-step="" data-testid="studio-cue-review-previous" onClick={() => move(-1)}><ChevronUp /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_review.next')} disabled={!cues.length} data-review-step="" data-testid="studio-cue-review-next" onClick={() => move(1)}><ChevronDown /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_review.close')} data-testid="studio-cue-review-close" onClick={onClose}><X /></StudioIconButton>
    </div>
    {!!result?.total && <div ref={row} className="studio-cue-review-filter" data-mode={fits ? 'segments' : 'select'}>
      <div ref={ruler} className="studio-cue-review-ruler" aria-hidden="true">{labels.map(label => <span key={label}>{label}</span>)}</div>
      {fits ? <ToolRadioButtonGroup ariaLabel={t('studio:cue_review.filter')} value={active} onValueChange={review.setFilter}
        options={options.map((option, index) => ({ value: option.value, label: optionLabel(option), ariaLabel: labels[index], testId: `studio-cue-review-filter-${option.value}` }))} />
        : <Select value={active} onValueChange={value => review.setFilter(value as Filter)}>
          <SelectTrigger size="sm" aria-label={t('studio:cue_review.filter')} data-testid="studio-cue-review-filter" className="w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{optionLabel(option)}</SelectItem>)}</SelectContent>
        </Select>}
    </div>}
    {current && <div className="studio-cue-review-current" data-testid="studio-cue-review-current">
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild><span className="studio-cue-review-reasons" tabIndex={0}>
          <span className="studio-cue-review-number">{t('studio:cue_review.current', { number: current.index + 1 })}</span>
          {current.reasons.map(reason => t(`studio:cue_review.reasons.${reason}`)).join(t('studio:cue_review.separator'))}
        </span></TooltipTrigger>
        <TooltipContent sideOffset={6} className="studio-cue-review-tip"><CueReviewReasons entry={current} /></TooltipContent>
      </Tooltip>
      {mediaReady ? <CueAudioButton playKey={audio.key(current.cueId)} request={audio.request(current.cueId)} label={t('studio:cue_review.play')} className="studio-cue-review-play" data-testid="studio-cue-review-play" />
        : <StudioIconButton label={t('studio:cue_review.play')} className="studio-cue-review-needs-media" data-testid="studio-cue-review-play" onClick={onNeedsMedia}><Play /></StudioIconButton>}
      <StudioIconButton label={t('studio:cue_review.recognize')} disabled={!cue || !!editBlocked || !mediaReady} data-testid="studio-cue-review-recognize" onClick={() => onRecognize([current.cueId])}><AudioWaveform /></StudioIconButton>
      {current.reasons.includes('repetition_loop') && <StudioIconButton label={editBlocked ?? (collapsed ? t('studio:cue_review.collapse', { text: collapsed.length > 40 ? `${collapsed.slice(0, 40)}…` : collapsed }) : t('studio:cue_review.collapse_none'))}
        disabled={!collapsed || !!editBlocked} data-testid="studio-cue-review-collapse" onClick={() => collapsed && onCollapse(current.cueId, collapsed)}><FoldHorizontal /></StudioIconButton>}
      <StudioIconButton label={t('studio:cue_review.ignore')} data-testid="studio-cue-review-ignore" onClick={() => review.ignore(current)}><EyeOff /></StudioIconButton>
    </div>}
    {result && !result.confidence && <p className="studio-cue-review-note" data-testid="studio-cue-review-no-confidence">{t('studio:cue_review.no_confidence')}</p>}
    {review.ignoredCount > 0 && <p className="studio-cue-review-note" data-testid="studio-cue-review-ignored">{t('studio:cue_review.ignored', { count: review.ignoredCount })}
      <button type="button" className="studio-cue-review-restore" data-testid="studio-cue-review-restore" onClick={review.restore}>{t('studio:cue_review.restore')}</button></p>}
  </div>;
}
