import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Replace, ReplaceAll, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import type { CueFindField, CueFindResult } from '@/subtitle-studio/cue-find';
import type { CueEditLabel } from '@/services/subtitle-studio/cue-history';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import { StudioIconButton } from './StudioControls';
import type { CueTrack } from './StudioCueMenu';
import './StudioCueFind.css';

/** What the list highlights while the find bar is open. */
export type CueFindHighlight = { query: string; matchCase: boolean; field: CueFindField; currentCueId?: string };
export type CueFindTarget = { cueId: string; index: number };

/**
 * The list's find bar: finds a literal text in every page, moves between matching cues and
 * replaces in the current one or in all of them. The list highlights and shows the matches.
 */
export function StudioCueFind({ page, track, initialQuery, focusSerial, busy, onClose, onHighlight, onGo, onApply }: {
  page: DocumentPage;
  track?: CueTrack;
  initialQuery: string;
  /** Changes when Ctrl+F is pressed again: the query is selected for typing over. */
  focusSerial: number;
  /** Why replacing is unavailable (a translation runs). */
  busy?: string;
  onClose: () => void;
  onHighlight: (highlight: CueFindHighlight | null) => void;
  onGo: (target: CueFindTarget) => void;
  onApply: (operation: CueEditOperation, label: CueEditLabel, count: number) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState('');
  const [field, setField] = useState<CueFindField>(track ? 'both' : 'source');
  const [matchCase, setMatchCase] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [result, setResult] = useState<CueFindResult | null>(null);
  const [position, setPosition] = useState(-1);
  const [applying, setApplying] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** The cue index found last, kept so that a new search continues from there. */
  const anchor = useRef<number>(page.offset);
  const scope: CueFindField = track ? field : 'source';
  const documentId = page.summary.id, revision = page.summary.revision, trackId = track?.id;
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, [focusSerial]);

  // Search again whenever the words, the scope or the document change.
  useEffect(() => {
    if (!query.trim()) { setResult(null); setPosition(-1); return; }
    let live = true;
    const timer = setTimeout(() => {
      void window.subtitleStudio.searchCues({ documentId, revision, query, field: scope, matchCase, ...(scope !== 'source' && trackId ? { trackId } : {}) }).then(found => {
        if (!live || !found.ok) return;
        setResult(found.value);
        // Continue from where the last match was: after a replacement, that is the next one.
        const next = found.value.cues.findIndex(cue => cue.index >= anchor.current);
        const at = found.value.cues.length ? (next < 0 ? 0 : next) : -1;
        setPosition(at);
        if (at >= 0) onGo(found.value.cues[at]);
      }, () => undefined);
    }, 150);
    return () => { live = false; clearTimeout(timer); };
    // onGo is a fresh closure each render; searching again for it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, matchCase, documentId, revision, trackId]);
  const current = result && position >= 0 ? result.cues[position] : undefined;
  useEffect(() => {
    onHighlight(query.trim() ? { query, matchCase, field: scope, ...(current ? { currentCueId: current.cueId } : {}) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, scope, current?.cueId]);
  // Closing clears the highlight; the latest callback is used, whatever its identity.
  const highlight = useRef(onHighlight);
  highlight.current = onHighlight;
  useEffect(() => () => highlight.current(null), []);

  const move = (step: 1 | -1) => {
    if (!result?.cues.length) return;
    const at = ((position < 0 ? 0 : position + step) + result.cues.length) % result.cues.length;
    setPosition(at);
    anchor.current = result.cues[at].index;
    onGo(result.cues[at]);
  };
  const replace = async (all: boolean) => {
    if (!result?.cues.length || applying || busy || (!all && !current)) return;
    if (current) anchor.current = current.index;
    setApplying(true);
    await onApply({ kind: 'replace', query, replacement, matchCase, field: scope, ...(scope !== 'source' && trackId ? { trackId } : {}), ...(all ? {} : { cueIds: [current!.cueId] }) },
      'replace', all ? result.cues.length : 1);
    setApplying(false);
    input.current?.focus();
  };
  const count = !query.trim() ? '' : !result ? '…' : !result.cues.length ? t('studio:cue_find.none')
    : t(result.truncated ? 'studio:cue_find.count_truncated' : 'studio:cue_find.count', { position: position + 1, total: result.cues.length, occurrences: result.occurrences });
  const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };

  return <div className="studio-cue-find" role="search" aria-label={t('studio:cue_find.label')} data-testid="studio-cue-find" onKeyDown={keys}>
    <div className="studio-cue-find-row">
      <StudioIconButton label={t(replacing ? 'studio:cue_find.hide_replace' : 'studio:cue_find.show_replace')} aria-expanded={replacing} data-testid="studio-cue-find-toggle-replace" onClick={() => setReplacing(value => !value)}>
        {replacing ? <ChevronDown /> : <ChevronRight />}
      </StudioIconButton>
      <Input ref={input} value={query} aria-label={t('studio:cue_find.query')} placeholder={t('studio:cue_find.query')} data-testid="studio-cue-find-query" className="h-8 text-xs"
        onChange={event => { setQuery(event.target.value); anchor.current = page.offset; }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
      <span className="studio-cue-find-count" aria-live="polite" data-testid="studio-cue-find-count">{count}</span>
      <StudioIconButton label={t('studio:cue_find.match_case')} aria-pressed={matchCase} data-state={matchCase ? 'on' : 'off'} data-testid="studio-cue-find-case" onClick={() => setMatchCase(value => !value)}><CaseSensitive /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.previous')} disabled={!result?.cues.length} data-testid="studio-cue-find-previous" onClick={() => move(-1)}><ChevronUp /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.next')} disabled={!result?.cues.length} data-testid="studio-cue-find-next" onClick={() => move(1)}><ChevronDown /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.close')} data-testid="studio-cue-find-close" onClick={onClose}><X /></StudioIconButton>
    </div>
    {track && <ToolRadioButtonGroup ariaLabel={t('studio:cue_find.scope')} value={field} onValueChange={setField} className="studio-cue-find-scope"
      options={(['source', 'target', 'both'] as const).map(value => ({ value, label: t(`studio:cue_find.scope_${value}`), testId: `studio-cue-find-scope-${value}` }))} />}
    {replacing && <div className="studio-cue-find-row studio-cue-find-replace">
      <Input value={replacement} aria-label={t('studio:cue_find.replacement')} placeholder={t('studio:cue_find.replacement')} data-testid="studio-cue-find-replacement" className="h-8 text-xs"
        onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void replace(false); } }} />
      <StudioIconButton label={busy ?? t('studio:cue_find.replace')} disabled={!!busy || applying || !current} data-testid="studio-cue-find-replace" onClick={() => void replace(false)}><Replace /></StudioIconButton>
      <StudioIconButton label={busy ?? t('studio:cue_find.replace_all', { count: result?.cues.length ?? 0 })} disabled={!!busy || applying || !result?.cues.length} data-testid="studio-cue-find-replace-all" onClick={() => void replace(true)}><ReplaceAll /></StudioIconButton>
    </div>}
  </div>;
}
