import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Regex, Replace, ReplaceAll, WholeWord, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import type { CueFindField, CueFindResult } from '@/subtitle-studio/cue-find';
import { validCueFindPattern } from '@/subtitle-studio/cue-find-query';
import type { ErrorCode } from '@/subtitle-studio/domain';
import type { CueEditLabel } from '@/services/subtitle-studio/cue-history';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import { StudioIconButton } from './StudioControls';
import type { CueTrack } from './StudioCueMenu';
import './StudioCueFind.css';

/** What the list highlights while the find bar is open. */
export type CueFindHighlight = { query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; field: CueFindField; currentCueId?: string };
export type CueFindTarget = { cueId: string; index: number };
type FindError = Extract<ErrorCode, 'invalid_pattern' | 'pattern_too_slow'>;
/** The match options stay as they were for the rest of the session, also after the bar closes. */
const sessionOptions = { matchCase: false, wholeWord: false, regex: false };

/**
 * The list's find bar: finds a text or a regular expression in every page, moves between matching
 * cues and replaces in the current one or in all of them. The list highlights and shows the matches.
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
  const [matchCase, setMatchCaseState] = useState(sessionOptions.matchCase);
  const [wholeWord, setWholeWordState] = useState(sessionOptions.wholeWord);
  const [regex, setRegexState] = useState(sessionOptions.regex);
  const setMatchCase = (value: boolean) => { sessionOptions.matchCase = value; setMatchCaseState(value); };
  const setWholeWord = (value: boolean) => { sessionOptions.wholeWord = value; setWholeWordState(value); };
  const setRegex = (value: boolean) => { sessionOptions.regex = value; setRegexState(value); };
  /** Why the query cannot be searched; shown where the count is. */
  const [error, setError] = useState<FindError | null>(null);
  /** The words and options the shown result belongs to: a regular expression is highlighted only once the search accepted it. */
  const [resultKey, setResultKey] = useState('');
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

  const searchKey = JSON.stringify([query, matchCase, wholeWord, regex]);
  // Search again whenever the words, the options, the scope or the document change.
  useEffect(() => {
    setError(null);
    if (!query.trim()) { setResult(null); setPosition(-1); return; }
    // An invalid expression is reported at once, without asking the main process.
    if (regex && !validCueFindPattern(query)) { setResult(null); setPosition(-1); setError('invalid_pattern'); return; }
    let live = true;
    const timer = setTimeout(() => {
      void window.subtitleStudio.searchCues({ documentId, revision, query, field: scope, matchCase, wholeWord, regex, ...(scope !== 'source' && trackId ? { trackId } : {}) }).then(found => {
        if (!live) return;
        if (!found.ok) {
          if (found.error === 'invalid_pattern' || found.error === 'pattern_too_slow') { setResult(null); setPosition(-1); setError(found.error); }
          return;
        }
        setResult(found.value);
        setResultKey(searchKey);
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
  }, [query, scope, matchCase, wholeWord, regex, documentId, revision, trackId]);
  const current = result && position >= 0 ? result.cues[position] : undefined;
  // A regular expression is run on the visible rows only after the main process ran it on the
  // whole document in time, so a pattern that backtracks badly never reaches the list.
  const highlightable = !!query.trim() && !error && (!regex || resultKey === searchKey);
  useEffect(() => {
    onHighlight(highlightable ? { query, matchCase, wholeWord, regex, field: scope, ...(current ? { currentCueId: current.cueId } : {}) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightable, query, matchCase, wholeWord, regex, scope, current?.cueId]);
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
    if (!result?.cues.length || applying || busy || error || (!all && !current)) return;
    if (current) anchor.current = current.index;
    setApplying(true);
    await onApply({ kind: 'replace', query, replacement, matchCase, wholeWord, regex, field: scope, ...(scope !== 'source' && trackId ? { trackId } : {}), ...(all ? {} : { cueIds: [current!.cueId] }) },
      'replace', all ? result.cues.length : 1);
    setApplying(false);
    input.current?.focus();
  };
  const count = !query.trim() ? '' : error ? t(`studio:cue_find.${error}`) : !result ? '…' : !result.cues.length ? t('studio:cue_find.none')
    : t(result.truncated ? 'studio:cue_find.count_truncated' : 'studio:cue_find.count', { position: position + 1, total: result.cues.length, occurrences: result.occurrences });
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // Alt+W and Alt+R toggle whole word and regular expression, as in code editors.
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyW' || event.code === 'KeyR')) {
      event.preventDefault(); event.stopPropagation();
      if (event.code === 'KeyW') setWholeWord(!wholeWord); else setRegex(!regex);
    }
  };

  return <div className="studio-cue-find" role="search" aria-label={t('studio:cue_find.label')} data-testid="studio-cue-find" onKeyDown={keys}>
    <div className="studio-cue-find-row">
      <StudioIconButton label={t(replacing ? 'studio:cue_find.hide_replace' : 'studio:cue_find.show_replace')} aria-expanded={replacing} data-testid="studio-cue-find-toggle-replace" onClick={() => setReplacing(value => !value)}>
        {replacing ? <ChevronDown /> : <ChevronRight />}
      </StudioIconButton>
      <Input ref={input} value={query} aria-label={t('studio:cue_find.query')} placeholder={t('studio:cue_find.query')} data-testid="studio-cue-find-query" className="h-8 text-xs"
        onChange={event => { setQuery(event.target.value); anchor.current = page.offset; }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
      <span className="studio-cue-find-count" aria-live="polite" data-testid="studio-cue-find-count" data-error={error ?? undefined}>{count}</span>
      <StudioIconButton label={t('studio:cue_find.match_case')} aria-pressed={matchCase} data-state={matchCase ? 'on' : 'off'} data-testid="studio-cue-find-case" onClick={() => setMatchCase(!matchCase)}><CaseSensitive /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.whole_word')} aria-pressed={wholeWord} data-state={wholeWord ? 'on' : 'off'} data-testid="studio-cue-find-whole-word" onClick={() => setWholeWord(!wholeWord)}><WholeWord /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.regex')} aria-pressed={regex} data-state={regex ? 'on' : 'off'} data-testid="studio-cue-find-regex" onClick={() => setRegex(!regex)}><Regex /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.previous')} disabled={!result?.cues.length} data-testid="studio-cue-find-previous" onClick={() => move(-1)}><ChevronUp /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.next')} disabled={!result?.cues.length} data-testid="studio-cue-find-next" onClick={() => move(1)}><ChevronDown /></StudioIconButton>
      <StudioIconButton label={t('studio:cue_find.close')} data-testid="studio-cue-find-close" onClick={onClose}><X /></StudioIconButton>
    </div>
    {track && <ToolRadioButtonGroup ariaLabel={t('studio:cue_find.scope')} value={field} onValueChange={setField} className="studio-cue-find-scope"
      options={(['source', 'target', 'both'] as const).map(value => ({ value, label: t(`studio:cue_find.scope_${value}`), testId: `studio-cue-find-scope-${value}` }))} />}
    {replacing && <div className="studio-cue-find-row studio-cue-find-replace">
      <Input value={replacement} aria-label={t('studio:cue_find.replacement')} placeholder={t('studio:cue_find.replacement')} data-testid="studio-cue-find-replacement" className="h-8 text-xs"
        onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void replace(false); } }} />
      <StudioIconButton label={busy ?? t('studio:cue_find.replace')} disabled={!!busy || applying || !!error || !current} data-testid="studio-cue-find-replace" onClick={() => void replace(false)}><Replace /></StudioIconButton>
      <StudioIconButton label={busy ?? t('studio:cue_find.replace_all', { count: result?.cues.length ?? 0 })} disabled={!!busy || applying || !!error || !result?.cues.length} data-testid="studio-cue-find-replace-all" onClick={() => void replace(true)}><ReplaceAll /></StudioIconButton>
    </div>}
  </div>;
}
