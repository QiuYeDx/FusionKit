import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, CheckCheck, CircleDashed, CircleHelp, Combine, Ellipsis, Languages, MoveHorizontal, Redo2, Search, Sparkles, Trash2, Undo2, UserPen, X, ScanText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { LIMITS, type SubtitleText } from '@/subtitle-studio/domain';
import { findRanges } from '@/subtitle-studio/cue-find';
import { cueTextProblem, editedText, hasMixedStyle, normalizeCueText, type CueEditOperation, type CueTextProblem } from '@/subtitle-studio/cue-edit-contract';
import { buildCueCopyText } from '@/services/subtitle-studio/cue-copy';
import type { CueEditLabel, CueHistoryEntry } from '@/services/subtitle-studio/cue-history';
import { EMPTY_SELECTION, actionTargets } from '@/services/row-selection';
import { formatStudioTime, StudioIconButton } from './StudioControls';
import { StudioCueEditor, type CueEditorMove } from './StudioCueEditor';
import { StudioCueMenuContent, currentEntry, type CueField, type CueMenuActions, type CueTrack } from './StudioCueMenu';
import { CUE_CONTROL_ATTR, useCueSelection } from './useCueSelection';
import { consecutive, mergeOperation, MERGE_LIMIT } from '@/subtitle-studio/cue-structure';
import { StudioCueTimeEditor, timeProblemKeys, type CueTimeProblem } from './StudioCueTimeEditor';
import { StudioCueShift, type CueShiftRequest } from './StudioCueShift';
import { StudioCueSplit, type CueSplitRequest } from './StudioCueSplit';
import { StudioCueInsert, type CueInsertRequest } from './StudioCueInsert';
import { StudioCueFind, type CueFindHighlight, type CueFindTarget } from './StudioCueFind';
import { isolateListEvents } from './StudioListLayer';
import { CueAudioButton, StudioCueMediaControl, useCueMedia } from './StudioCueAudio';
import { cueAudioPlayer, useCueAudioFollow, useCueAudioRows } from '@/services/subtitle-studio/cue-audio-player';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import './StudioCueTable.css';

const control = { [CUE_CONTROL_ATTR]: '' };
const problemKeys: Record<CueTextProblem | 'empty_source', string> = {
  empty: 'studio:cue_edit.problem.empty',
  empty_source: 'studio:cue_edit.problem.empty_source',
  markup: 'studio:cue_edit.problem.markup',
  characters: 'studio:cue_edit.problem.characters',
  too_long: 'studio:cue_edit.problem.too_long',
};
const HELP_ITEMS = ['select', 'marquee', 'edit', 'editor', 'field', 'timing', 'play', 'follow', 'mark', 'merge', 'delete', 'copy', 'undo', 'menu'] as const;
/** The player key of a cue row; a stretch of several cues plays under its first row's key. */
export const cueAudioKey = (documentId: string, cueId: string) => `cue:${documentId}:${cueId}`;

/** A cue's styled text; matches of the find bar's words are marked. */
function Spans({ text, find }: { text: SubtitleText; find?: { query: string; matchCase: boolean } }) {
  const ranges = find ? findRanges(text.plain, find.query, find.matchCase) : [];
  let offset = 0;
  return <>{text.spans.map((span, i) => {
    const start = offset;
    offset += span.text.length;
    const style = { fontWeight: span.marks.includes('b') ? 650 : undefined, fontStyle: span.marks.includes('i') ? 'italic' : undefined, textDecoration: span.marks.includes('u') ? 'underline' : undefined };
    if (!ranges.some(([from, to]) => from < offset && to > start)) return <span key={i} style={style}>{span.text}</span>;
    // Cut the span at the matches that fall in it.
    const parts: ReactElement[] = [];
    let at = 0;
    for (const [from, to] of ranges) {
      const a = Math.max(0, from - start), b = Math.min(span.text.length, to - start);
      if (b <= 0 || a >= span.text.length) continue;
      if (a > at) parts.push(<span key={`t${at}`}>{span.text.slice(at, a)}</span>);
      parts.push(<mark key={`m${a}`} className="studio-cue-find-mark">{span.text.slice(a, b)}</mark>);
      at = b;
    }
    if (at < span.text.length) parts.push(<span key={`t${at}`}>{span.text.slice(at)}</span>);
    return <span key={i} style={style}>{parts}</span>;
  })}</>;
}

function CueHelp() {
  const { t } = useTranslation();
  return <Tooltip delayDuration={200}>
    <TooltipTrigger asChild>
      <button type="button" className="studio-cue-help" aria-label={t('studio:cue_help.label')} data-testid="studio-cue-help"><CircleHelp /></button>
    </TooltipTrigger>
    <TooltipContent side="bottom" align="end" className="studio-cue-help-content">
      <div className="mb-1.5 text-[12px] font-medium">{t('studio:cue_help.label')}</div>
      <dl>{HELP_ITEMS.map(item => <div key={item}><dt>{t(`studio:cue_help.${item}.keys`)}</dt><dd>{t(`studio:cue_help.${item}.desc`)}</dd></div>)}</dl>
    </TooltipContent>
  </Tooltip>;
}

export type StudioCueTableProps = {
  page: DocumentPage;
  track?: CueTrack;
  flaggedNodes: ReadonlySet<string | undefined>;
  busy: boolean;
  copied: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  history: { undo?: CueHistoryEntry; redo?: CueHistoryEntry };
  /** Applies an edit and reloads the page; resolves false when it failed. */
  onOperation: (operation: CueEditOperation, label: CueEditLabel, count: number) => Promise<boolean>;
  onUndo: () => void;
  onRedo: () => void;
  onTranslate: (cueIds: string[]) => void;
  /** Opens the AI revision dialog for the cues, or for the whole document when none are given. */
  onRevise: (cueIds: string[]) => void;
  /** Opens the terminology consistency check for this document. */
  onCheckConsistency?: () => void;
  /** Reports the selected cues in list order whenever the selection changes. */
  onSelectionChange?: (cueIds: string[]) => void;
  onCopy: (cueId: string, text: string) => void;
  onRemember: (cue: DocumentPage['cues'][number]) => void;
  /** Shows the page at this offset, as continuous playback moves past the last cue shown. */
  onFollowPage?: (offset: number) => void;
  /** Opens “recognize the original audio again” for the cues. */
  onRecognize?: (cueIds: string[]) => void;
};

/**
 * The subtitle preview list: select cues with the mouse or keyboard, edit
 * source and translation in place, and translate, review, copy or delete the
 * selection. Every edit can be undone.
 */
export function StudioCueTable({ page, track, flaggedNodes, busy, copied, scrollRef, history, onOperation, onUndo, onRedo, onTranslate, onRevise, onCheckConsistency, onSelectionChange, onCopy, onRemember, onFollowPage, onRecognize }: StudioCueTableProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const order = page.cues.map(cue => cue.id);
  const [editing, setEditing] = useState<{ cueId: string; field: CueField | 'timing' } | null>(null);
  // The retimed row's text cell, where the time editor puts its waveform.
  const [waveformSlot, setWaveformSlot] = useState<HTMLDivElement | null>(null);
  const [shifting, setShifting] = useState<CueShiftRequest | null>(null);
  const [splitting, setSplitting] = useState<CueSplitRequest | null>(null);
  const [finding, setFinding] = useState<{ initialQuery: string; serial: number } | null>(null);
  const [highlight, setHighlight] = useState<CueFindHighlight | null>(null);
  /** A match on another page, selected once that page shows. */
  const pendingFind = useRef<string | null>(null);
  const [inserting, setInserting] = useState<CueInsertRequest | null>(null);
  const structureSerial = useRef(0);
  /** The cue to select once the page shows an added one: the one beside `cueId`. */
  const selectAdded = useRef<{ cueId: string; step: 1 | -1 } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | undefined>();
  const [field, setField] = useState<CueField>('source');
  const [menu, setMenu] = useState<{ targets: string[]; x: number; y: number; serial: number } | null>(null);
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const activeTask = page.tasks.some(task => task.status === 'queued' || task.status === 'running');
  const editBlocked = activeTask ? t('studio:cue_edit.blocked_translation') : busy ? t('studio:cue_edit.blocked_busy') : undefined;
  const canTranslate = page.summary.capabilities.translate && !activeTask && !busy;
  const activeField: CueField = track ? field : 'source';
  const documentId = page.summary.id;
  const media = useCueMedia(documentId);
  const playingKey = useCueAudioRows(documentId);
  const playing = new Set(playingKey ? playingKey.split(',') : []);
  const [mediaRequest, setMediaRequest] = useState(0);
  useEffect(() => () => cueAudioPlayer.stopFor(documentId), [documentId]);
  /** A short message in the list header, such as why a mark was not set. */
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const followKey = `follow:${documentId}`;
  const hasNextPage = page.offset + page.cues.length < page.summary.cueCount;
  /** The cue being heard: the last one starting at or before the position; 'next' past this page's last cue. */
  const following = useCueAudioFollow(documentId, positionMs => {
    let found: string | null = null;
    for (const cue of page.cues) { if (cue.timing.startMs <= positionMs) found = cue.id; else break; }
    const last = page.cues.at(-1);
    if (last && hasNextPage && positionMs >= (last.timing.endMs ?? last.timing.startMs + 5000)) return 'next';
    return found;
  });
  const lastFollowed = useRef<string | null>(null);
  const requestedPage = useRef(-1);
  useEffect(() => {
    if (following === 'next') {
      // Turn the page only when playback ran off this page's last cue, not after the user paged elsewhere.
      if (lastFollowed.current === page.cues.at(-1)?.id && requestedPage.current !== page.offset) {
        requestedPage.current = page.offset;
        onFollowPage?.(page.offset + page.cues.length);
      }
      return;
    }
    lastFollowed.current = following;
    if (!following) return;
    const row = listRef.current?.querySelector<HTMLElement>(`tr[data-cue-id="${following}"]`), view = scrollRef.current;
    if (!row || !view) return;
    const box = row.getBoundingClientRect(), frame = view.getBoundingClientRect();
    // The sticky header covers the top 36px of the reader.
    if (box.top < frame.top + 36 || box.bottom > frame.bottom) row.scrollIntoView({ block: 'nearest' });
  }, [following, page.offset, page.cues, onFollowPage, scrollRef]);
  /** Plays from a cue to the end of the document; the list follows along. */
  const follow = (cueId: string) => {
    if (!media.ready) { setMediaRequest(value => value + 1); return; }
    const cue = page.cues.find(item => item.id === cueId);
    if (!cue) return;
    const padMs = useStudioPreferences.getState().cueAudioPadMs;
    cueAudioPlayer.follow(followKey, { documentId, fromMs: Math.max(0, cue.timing.startMs - padMs),
      ...(page.summary.origin.format === 'media' && 'durationMs' in page.summary.origin ? { endMs: page.summary.origin.durationMs } : {}) });
  };
  const cueAudioRequest = (cueIds: readonly string[]) => ({ documentId, revision: page.summary.revision, rows: [...cueIds],
    target: { cueIds: cueIds.length > 1 ? [cueIds[0], cueIds.at(-1)!] as [string, string] : [cueIds[0]] as [string] } });
  /** Plays one cue, consecutive cues as one stretch, otherwise the keyboard row. */
  const playCues = (targets: string[]) => {
    // Without media the original-audio panel explains why and offers to choose a file.
    if (!media.ready) { setMediaRequest(value => value + 1); return; }
    const ordered = order.filter(id => targets.includes(id));
    const cueIds = ordered.length > 1 && consecutive(ordered, order) ? ordered : [selectionApi.selectionRef.current.lead ?? ordered[0]].filter(Boolean);
    if (cueIds.length) cueAudioPlayer.toggle(cueAudioKey(documentId, cueIds[0]), cueAudioRequest(cueIds));
  };

  const focusList = () => listRef.current?.focus({ preventScroll: true });
  const startEdit = (cueId: string, next: CueField) => {
    if (editBlocked || (next === 'target' && !track)) return;
    setField(next); setEditError(undefined);
    selectionApi.commit({ keys: new Set([cueId]), anchor: cueId, lead: cueId });
    setEditing({ cueId, field: next });
  };
  const run = async (operation: CueEditOperation, label: CueEditLabel, count: number) => {
    if (editBlocked) return false;
    return onOperation(operation, label, count);
  };
  const startTiming = (cueId: string) => {
    if (editBlocked) return;
    setEditError(undefined);
    selectionApi.commit({ keys: new Set([cueId]), anchor: cueId, lead: cueId });
    setEditing({ cueId, field: 'timing' });
  };
  const mergeable = (cueIds: readonly string[]) => cueIds.length >= 2 && cueIds.length <= MERGE_LIMIT && consecutive(cueIds, order);
  const merge = async (cueIds: string[]) => {
    if (editBlocked || !mergeable(cueIds)) return;
    const ids = new Set(cueIds);
    const cues = page.cues.filter(cue => ids.has(cue.id));
    if (await run(mergeOperation(cues, track), 'merge', cues.length)) {
      selectionApi.commit({ keys: new Set([cues[0].id]), anchor: cues[0].id, lead: cues[0].id });
      focusList();
    }
  };
  /** Checks typed times against the neighbouring cues on this page; the main process checks again. */
  const timingProblem = (cue: DocumentPage['cues'][number], startMs: number, endMs: number | null): CueTimeProblem | null => {
    const index = order.indexOf(cue.id);
    const previous = page.cues[index - 1]?.timing.startMs, next = page.cues[index + 1]?.timing.startMs;
    if (endMs !== null && endMs < startMs) return 'end_before_start';
    if (previous !== undefined && startMs < previous && cue.timing.startMs >= previous) return 'before_previous';
    if (next !== undefined && startMs > next && cue.timing.startMs <= next) return 'after_next';
    if (page.summary.origin.format === 'media' && endMs !== null && 'durationMs' in page.summary.origin && endMs > page.summary.origin.durationMs) return 'beyond_media';
    return null;
  };
  const saveTiming = async (cue: DocumentPage['cues'][number], startMs: number, endMs: number | null) => {
    setSaving(true);
    const ok = await run({ kind: 'timing', changes: { [cue.id]: { startMs, endMs } } }, 'timing', 1);
    setSaving(false);
    if (ok) { setEditing(null); setEditError(undefined); focusList(); }
    else setEditError(t('studio:cue_structure.time_rejected'));
  };
  const remove = async (cueIds: string[]) => {
    if (editBlocked || !cueIds.length || cueIds.length >= page.summary.cueCount) return;
    const gone = new Set(cueIds);
    const last = Math.max(...cueIds.map(id => order.indexOf(id)));
    const next = order.slice(last + 1).find(id => !gone.has(id)) ?? [...order].reverse().find(id => !gone.has(id));
    if (await run({ kind: 'delete', cueIds }, 'delete', cueIds.length) && next) {
      selectionApi.commit({ keys: new Set([next]), anchor: next, lead: next });
      focusList();
    }
  };
  const actions: CueMenuActions = {
    page, track, editBlocked, canTranslate,
    onEdit: startEdit,
    onTranslate,
    onRevise: cueIds => { if (!editBlocked) onRevise(cueIds); },
    onClear: cueIds => { if (track) void run({ kind: 'clear', trackId: track.id, cueIds }, 'clear', cueIds.length); },
    onReview: (cueIds, reviewed) => { if (track) void run({ kind: 'review', trackId: track.id, cueIds, reviewed }, reviewed ? 'review' : 'unreview', cueIds.length); },
    onDelete: cueIds => void remove(cueIds),
    onMerge: cueIds => void merge(cueIds),
    onEditTiming: startTiming,
    onSplit: cueId => { if (!editBlocked) setSplitting({ cueId, serial: ++structureSerial.current }); },
    onInsert: (cueId, position) => { if (!editBlocked) setInserting({ cueId, position, serial: ++structureSerial.current }); },
    // Ctrl+A selects this page only: when that is every cue shown and the document is longer, the whole document is meant.
    onShift: cueIds => { if (!editBlocked) setShifting({ cueIds, scope: cueIds.length === page.cues.length && page.summary.cueCount > page.cues.length ? 'all' : 'selected' }); },
    onCopy,
    onRemember: cueId => { const cue = page.cues.find(item => item.id === cueId); if (cue) onRemember(cue); },
    audio: { ready: media.ready, onPlay: playCues, onFollow: follow, onRecognize: cueIds => onRecognize?.(cueIds) },
  };

  const copySelection = (cueIds: string[]) => {
    const ids = new Set(cueIds);
    const blocks = page.cues.filter(cue => ids.has(cue.id)).map(cue => buildCueCopyText({ source: cue.source.plain, target: currentEntry(track, cue)?.text.plain, ...cue.timing }, currentEntry(track, cue) ? 'bilingual' : 'source')!);
    if (blocks.length) onCopy(cueIds[0], blocks.join('\n\n'));
  };
  const onKey = (event: KeyboardEvent<HTMLElement>, _selection: unknown, targets: string[]) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') { if (event.shiftKey) onRedo(); else onUndo(); return true; }
    if (mod && key === 'y') { onRedo(); return true; }
    if (mod && key === 'c') { copySelection(targets); return true; }
    if (mod && key === 'm' && !event.shiftKey) { void merge(targets); return true; }
    if (mod && key === 'f' && !event.shiftKey) { openFind(); return true; }
    if (key === 't' && !mod && !event.altKey && targets.length) { startTiming(selectionApi.selectionRef.current.lead ?? targets[0]); return true; }
    // Shift+P plays on from the keyboard row and the list follows; again it stops.
    if (key === 'p' && event.shiftKey && !mod && !event.altKey) {
      const current = cueAudioPlayer.snapshot();
      if (current?.documentId === documentId && current.phase !== 'error') cueAudioPlayer.stop();
      else { const from = selectionApi.selectionRef.current.lead ?? targets[0] ?? order[0]; if (from) follow(from); }
      return true;
    }
    // [ and ] set the keyboard row's start and end to what is heard now; ] then moves to the next cue.
    if ((event.key === '[' || event.key === ']') && !mod && !event.altKey) {
      const positionMs = cueAudioPlayer.positionFor(documentId);
      if (positionMs === null) { setNotice(t('studio:cue_listen.mark_needs_playback')); return true; }
      if (editBlocked) { setNotice(editBlocked); return true; }
      const id = selectionApi.selectionRef.current.lead ?? targets[0];
      const cue = page.cues.find(item => item.id === id);
      if (!cue) return true;
      const ending = event.key === ']';
      const startMs = ending ? cue.timing.startMs : positionMs, endMs = ending ? positionMs : cue.timing.endMs;
      const problem = timingProblem(cue, startMs, endMs);
      if (problem) { setNotice(t(timeProblemKeys[problem])); return true; }
      void run({ kind: 'timing', changes: { [cue.id]: { startMs, endMs } } }, 'timing', 1).then(ok => {
        if (!ok || !ending) return;
        const next = order[order.indexOf(cue.id) + 1];
        if (next) { selectionApi.commit({ keys: new Set([next]), anchor: next, lead: next }); selectionApi.scrollToRow(next); }
      });
      return true;
    }
    // P plays the selection, or stops whatever this document is playing.
    if (key === 'p' && !mod && !event.altKey) {
      const current = cueAudioPlayer.snapshot();
      if (current?.documentId === documentId && current.phase !== 'error') cueAudioPlayer.stop();
      else if (targets.length) playCues(targets);
      else return false;
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'F2') && !mod && targets.length) { startEdit(selectionApi.selectionRef.current.lead ?? targets[0], activeField); return true; }
    if (track && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !mod && !event.shiftKey) {
      setField(event.key === 'ArrowLeft' ? 'source' : 'target'); selectionApi.setKeyboardNav(true); return true;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && targets.length) { void remove(targets); return true; }
    return false;
  };
  const selectionApi = useCueSelection({
    order, listRef, scrollRef,
    openMenu: (targets, point) => setMenu(current => ({ targets, ...point, serial: (current?.serial ?? lastMenu.current?.serial ?? 0) + 1 })),
    onKey,
  });
  /** Opens the find bar, with the text selected in the list as its words. */
  const openFind = () => {
    const selected = window.getSelection()?.toString().trim() ?? '';
    setFinding(current => ({ initialQuery: current?.initialQuery ?? (selected.length <= 200 && !selected.includes('\n') ? selected : ''), serial: (current?.serial ?? 0) + 1 }));
  };
  /** Shows a match: on this page it is selected at once, on another the page turns first. */
  const goToMatch = (target: CueFindTarget) => {
    if (page.cues.some(cue => cue.id === target.cueId)) {
      selectionApi.commit({ keys: new Set([target.cueId]), anchor: target.cueId, lead: target.cueId });
      selectionApi.scrollToRow(target.cueId);
      return;
    }
    pendingFind.current = target.cueId;
    onFollowPage?.(Math.floor(target.index / LIMITS.pageSize) * LIMITS.pageSize);
  };
  useEffect(() => {
    const cueId = pendingFind.current;
    if (!cueId || !page.cues.some(cue => cue.id === cueId)) return;
    pendingFind.current = null;
    selectionApi.commit({ keys: new Set([cueId]), anchor: cueId, lead: cueId });
    selectionApi.scrollToRow(cueId);
  }, [page.cues, selectionApi]);
  // Rows scrolled into view stop below the sticky header, whose height grows with the find bar.
  useEffect(() => {
    const head = listRef.current?.querySelector('thead');
    if (!head) return;
    const update = () => listRef.current?.style.setProperty('--studio-cue-head', `${head.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(head);
    return () => observer.disconnect();
  }, [finding]);
  // Select a split's second half or an inserted cue once the page shows it.
  useEffect(() => {
    const added = selectAdded.current;
    if (!added) return;
    const index = page.cues.findIndex(cue => cue.id === added.cueId);
    const target = index < 0 ? undefined : page.cues[index + added.step]?.id;
    if (!target) return;
    selectAdded.current = null;
    selectionApi.commit({ keys: new Set([target]), anchor: target, lead: target });
    selectionApi.scrollToRow(target);
  }, [page.cues, selectionApi]);
  const { selection, marquee, keyboardNav } = selectionApi;
  const selected = order.filter(id => selection.keys.has(id));
  const selectedKey = selected.join(',');
  const reportSelection = useRef(onSelectionChange);
  reportSelection.current = onSelectionChange;
  useEffect(() => { reportSelection.current?.(selectedKey ? selectedKey.split(',') : []); }, [selectedKey]);

  const finish = (cueId: string, current: CueField, move: CueEditorMove) => {
    setEditing(null); setEditError(undefined);
    const index = order.indexOf(cueId) + (move === 'next' ? 1 : move === 'previous' ? -1 : 0);
    if (move !== 'stay' && order[index]) { startEdit(order[index], current); return; }
    focusList();
  };
  const save = async (cue: DocumentPage['cues'][number], target: CueField, draft: string, move: CueEditorMove) => {
    const text = normalizeCueText(draft);
    const entry = track?.entries[cue.id];
    let operation: CueEditOperation | null = null;
    if (target === 'target' && !text) {
      if (entry) operation = { kind: 'target', trackId: track!.id, cueId: cue.id, text: null };
    } else {
      const problem = cueTextProblem(text);
      if (problem) { setEditError(t(problemKeys[problem === 'empty' && target === 'source' ? 'empty_source' : problem])); return; }
      if (target === 'source') {
        if (text !== cue.source.plain) operation = { kind: 'source', cueId: cue.id, text: editedText(cue.source, text) };
      } else if (text !== entry?.text.plain || entry.sourceRevision !== cue.sourceRevision) {
        // Saving an unchanged stale translation confirms it for the current source.
        operation = { kind: 'target', trackId: track!.id, cueId: cue.id, text: editedText(entry?.text, text) };
      }
    }
    if (!operation) { finish(cue.id, target, move); return; }
    setSaving(true);
    const ok = await run(operation, target, 1);
    setSaving(false);
    if (ok) finish(cue.id, target, move);
  };

  const rowTargets = (cueId: string) => actionTargets(selectionApi.selectionRef.current, order, cueId);
  const reviewedAll = !!track && selected.length > 0 && selected.every(id => track.entries[id]?.reviewStatus === 'reviewed');
  const hasEntries = !!track && selected.some(id => track.entries[id]);
  const translatedSelection = !!track && selected.some(id => { const cue = page.cues.find(item => item.id === id); return cue && currentEntry(track, cue); });
  const historyLabel = (entry: CueHistoryEntry) => t(`studio:cue_history.labels.${entry.label}`, { count: entry.count });

  // Lives in the sticky table header, so it costs no reader height. With a
  // selection it widens over the column labels, like a mail list header.
  const toolbar = <div className="studio-cue-bar" data-selecting={selected.length > 0 || undefined} {...control}>
    <span className="studio-cue-bar-status" data-testid="studio-cue-selected-count" aria-live="polite">
      {notice || (selected.length ? t('studio:cue_toolbar.selected', { count: selected.length }) : activeTask ? editBlocked : '')}
    </span>
    <div className="studio-cue-toolbar" role="toolbar" aria-label={t('studio:cue_toolbar.label')} data-testid="studio-cue-toolbar">
    {selected.length > 0 && <>
      <StudioIconButton data-testid="studio-cue-toolbar-translate" label={t(translatedSelection ? 'studio:cue_menu.retranslate' : 'studio:cue_menu.translate')} disabled={!canTranslate || !selected.some(id => page.cues.find(cue => cue.id === id)?.source.plain.trim())} onClick={() => onTranslate(selected)}><Languages /></StudioIconButton>
      {track && <StudioIconButton data-testid="studio-cue-toolbar-review" label={t(reviewedAll ? 'studio:cue_menu.unreview' : 'studio:cue_menu.review')} disabled={!!editBlocked || !hasEntries} onClick={() => actions.onReview(selected, !reviewedAll)}>{reviewedAll ? <CircleDashed /> : <CheckCheck />}</StudioIconButton>}
      {selected.length > 1 && <StudioIconButton data-testid="studio-cue-toolbar-merge" label={t(mergeable(selected) ? 'studio:cue_structure.merge' : selected.length > MERGE_LIMIT ? 'studio:cue_structure.merge_too_many' : 'studio:cue_structure.merge_not_adjacent', { count: MERGE_LIMIT })} disabled={!!editBlocked || !mergeable(selected)} onClick={() => void merge(selected)}><Combine /></StudioIconButton>}
      <StudioIconButton data-testid="studio-cue-toolbar-delete" label={t(selected.length > 1 ? 'studio:cue_menu.delete_many' : 'studio:cue_menu.delete')} disabled={!!editBlocked || selected.length >= page.summary.cueCount} onClick={() => void remove(selected)}><Trash2 /></StudioIconButton>
      <DropdownMenu>
        <Tooltip delayDuration={350}><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('studio:cue_toolbar.more')}><Ellipsis /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent sideOffset={6}>{t('studio:cue_toolbar.more')}</TooltipContent></Tooltip>
        <StudioCueMenuContent align="end" targets={() => selected} actions={actions} data-testid="studio-cue-toolbar-menu" />
      </DropdownMenu>
      <StudioIconButton label={t('studio:cue_toolbar.clear_selection')} onClick={() => { selectionApi.commit(EMPTY_SELECTION); focusList(); }}><X /></StudioIconButton>
      <span className="studio-cue-toolbar-divider" aria-hidden="true" />
    </>}
    <StudioCueMediaControl media={media} openRequest={mediaRequest} />
    {!selected.length && <StudioIconButton data-testid="studio-cue-toolbar-shift" label={t('studio:cue_structure.shift_document')} disabled={!!editBlocked} onClick={() => setShifting({ cueIds: [], scope: 'all' })}><MoveHorizontal /></StudioIconButton>}
    <StudioIconButton data-testid="studio-cue-toolbar-find" label={t('studio:cue_find.open')} onClick={() => openFind()}><Search /></StudioIconButton>
    <StudioIconButton data-testid="studio-cue-toolbar-revise" label={t(selected.length ? 'studio:cue_menu.revise' : 'studio:cue_revision.revise_document')} disabled={!!editBlocked} onClick={() => actions.onRevise(selected)}><Sparkles /></StudioIconButton>
    {onCheckConsistency && <StudioIconButton data-testid="studio-cue-toolbar-consistency" label={t('studio:consistency.open')} onClick={onCheckConsistency}><ScanText /></StudioIconButton>}
    <StudioIconButton data-testid="studio-cue-undo" label={history.undo ? t('studio:cue_history.undo', { action: historyLabel(history.undo) }) : t('studio:cue_history.nothing_to_undo')} disabled={!history.undo || !!editBlocked} onClick={onUndo}><Undo2 /></StudioIconButton>
    <StudioIconButton data-testid="studio-cue-redo" label={history.redo ? t('studio:cue_history.redo', { action: historyLabel(history.redo) }) : t('studio:cue_history.nothing_to_redo')} disabled={!history.redo || !!editBlocked} onClick={onRedo}><Redo2 /></StudioIconButton>
    <CueHelp />
    </div>
  </div>;

  return <>
    <div ref={listRef} className="studio-cue-list" tabIndex={0} data-testid="studio-cue-list" aria-label={t('studio:cue_toolbar.list_label')} {...selectionApi.listProps}>
      <table aria-label={t('studio:preview')} aria-multiselectable="true" role="grid" className={track ? 'studio-cue-table studio-translated-table' : 'studio-cue-table'}>
        <thead><tr><th scope="col">#</th><th scope="col">{t('studio:time')}</th><th scope="col">{track ? <div className="studio-parallel-text"><span>{t('studio:source')}</span><span>{t('studio:target')}</span></div> : t('studio:source')}</th><th scope="col" className="studio-cue-toolbar-cell"><span className="sr-only">{t('studio:copy')}</span>{toolbar}</th></tr>
          {/* The find bar is a header row: it stays in view and never covers a row. */}
          {finding && <tr className="studio-cue-find-head"><th colSpan={4} {...control} {...isolateListEvents}>
            <StudioCueFind key={documentId} page={page} track={track} initialQuery={finding.initialQuery} focusSerial={finding.serial} busy={editBlocked}
              onClose={() => { setFinding(null); setHighlight(null); focusList(); }} onHighlight={setHighlight} onGo={goToMatch} onApply={run} />
          </th></tr>}
        </thead>
        <tbody>{page.cues.map((cue, index) => {
          const isSelected = selection.keys.has(cue.id);
          const findCurrent = highlight?.currentCueId === cue.id;
          const entry = track?.entries[cue.id];
          const editingField = editing?.cueId === cue.id ? editing.field : undefined;
          const lead = keyboardNav && selection.lead === cue.id;
          const editor = (target: CueField) => {
            const text = target === 'source' ? cue.source : entry?.text;
            return <StudioCueEditor key={`${cue.id}:${target}`} initial={text?.plain ?? ''} label={t(target === 'source' ? 'studio:cue_menu.edit_source' : 'studio:cue_menu.edit_target')} saving={saving} error={editError}
              note={text && hasMixedStyle(text) ? t('studio:cue_edit.mixed_style') : undefined}
              onSave={(value, move) => void save(cue, target, value, move)} onCancel={() => { setEditing(null); setEditError(undefined); focusList(); }} />;
          };
          return <tr key={cue.id} data-cue-id={cue.id} aria-selected={isSelected} data-selected={isSelected || undefined} data-find-current={findCurrent || undefined}
            data-selected-last={isSelected && !selection.keys.has(order[index + 1]) || undefined}
            data-lead={lead || undefined} data-editing={editingField ? true : undefined} data-warning={flaggedNodes.has('nodeId' in cue ? cue.nodeId : undefined) || undefined}
            data-playing={playing.has(cue.id) || following === cue.id || undefined} data-following={following === cue.id || undefined}>
            <td className="studio-cue-number" data-audio={media.ready || undefined}><span className="studio-cue-number-text">{page.offset + index + 1}</span>
              {media.ready && <CueAudioButton playKey={following === cue.id ? followKey : cueAudioKey(documentId, cue.id)} request={cueAudioRequest([cue.id])} tabbable={false} {...control}
                label={t('studio:cue_audio.play_cue', { number: page.offset + index + 1 })} data-testid="studio-cue-play" />}</td>
            <td className="studio-cue-time" onDoubleClick={() => startTiming(cue.id)}>{editingField === 'timing'
              ? <StudioCueTimeEditor startMs={cue.timing.startMs} endMs={cue.timing.endMs} saving={saving} error={editError}
                nextStartMs={page.cues.slice(index + 1).find(next => next.timing.startMs > cue.timing.startMs)?.timing.startMs}
                // Only text subtitles may leave the end unknown; LRC never has one.
                allowUnknownEnd={page.summary.origin.format !== 'media' && (cue.timing.endMs === null || page.summary.origin.format === 'lrc')}
                check={(startMs, endMs) => timingProblem(cue, startMs, endMs)}
                onSave={(startMs, endMs) => void saveTiming(cue, startMs, endMs)} onCancel={() => { setEditing(null); setEditError(undefined); focusList(); }}
                waveform={media.ready ? { playKey: `edit:${documentId}:${cue.id}`,
                  load: (startMs, endMs, buckets) => cueAudioPlayer.peaks({ documentId, revision: page.summary.revision, startMs, endMs }, buckets),
                  request: (startMs, endMs) => ({ documentId, target: { range: { startMs, endMs } } }) } : undefined} waveformSlot={waveformSlot} />
              : <div className="studio-time-range"><span>{formatStudioTime(cue.timing.startMs)}</span><ArrowRight aria-hidden="true" /><span className="text-muted-foreground/70">{cue.timing.endMs === null ? t('studio:unknown_end') : formatStudioTime(cue.timing.endMs)}</span></div>}</td>
            <td className="studio-cue-text"><div className={track ? 'studio-parallel-text' : undefined}>
              <div className="studio-cue-field" data-field="source" data-active={lead && activeField === 'source' || undefined} onPointerDown={() => setField('source')} onDoubleClick={() => startEdit(cue.id, 'source')}>
                {editingField === 'source' ? editor('source') : <Spans text={cue.source} find={highlight && highlight.field !== 'target' ? highlight : undefined} />}
              </div>
              {track && <div className="studio-target-text studio-cue-field" data-field="target" data-active={lead && activeField === 'target' || undefined} onPointerDown={() => setField('target')} onDoubleClick={() => startEdit(cue.id, 'target')}>
                {editingField === 'target' ? editor('target') : entry ? <>
                  {entry.sourceRevision !== cue.sourceRevision && <span className="block text-xs text-amber-600">{t('studio:translation_stale')}</span>}
                  <Spans text={entry.text} find={highlight && highlight.field !== 'source' ? highlight : undefined} />
                  {(entry.reviewStatus === 'reviewed' || entry.origin === 'human') && <Tooltip delayDuration={350}>
                    <TooltipTrigger asChild><span className="studio-cue-mark" role="img" aria-label={t(entry.origin === 'human' ? 'studio:cue_edit.human' : 'studio:cue_edit.reviewed')} {...control}>{entry.origin === 'human' ? <UserPen /> : <Check />}</span></TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t(entry.origin === 'human' ? 'studio:cue_edit.human' : 'studio:cue_edit.reviewed')}</TooltipContent>
                  </Tooltip>}
                </> : <span className="text-xs text-muted-foreground">{cue.source.plain.trim() ? t('studio:translation_missing') : ''}</span>}
              </div>}
            </div>
            {editingField === 'timing' && media.ready && <div ref={setWaveformSlot} className="studio-cue-wave-slot" {...control} />}</td>
            <td className="studio-cue-action" {...control}>
              <DropdownMenu>
                <Tooltip delayDuration={350}>
                  <TooltipTrigger asChild><DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" className={copied === cue.id ? 'studio-copy is-copied text-emerald-600 dark:text-emerald-400' : 'studio-copy text-muted-foreground'} aria-label={t('materials:cue_actions')}>
                      {copied === cue.id ? <Check /> : <Ellipsis />}
                    </Button>
                  </DropdownMenuTrigger></TooltipTrigger>
                  <TooltipContent sideOffset={6}>{t(copied === cue.id ? 'studio:copied' : 'materials:cue_actions')}</TooltipContent>
                </Tooltip>
                <StudioCueMenuContent align="end" targets={() => rowTargets(cue.id)} actions={actions} data-testid="studio-copy-menu" timedTestId="studio-copy-timed-menu" />
              </DropdownMenu>
            </td>
          </tr>;
        })}</tbody>
      </table>
      {marquee && <div aria-hidden="true" className="studio-cue-marquee" data-testid="studio-cue-marquee" style={marquee} />}
    </div>
    <StudioCueSplit page={page} request={splitting} track={track} mediaReady={media.ready} busy={editBlocked}
      onClose={() => { setSplitting(null); focusList(); }}
      onApply={async (operation, label, count) => {
        const ok = await run(operation, label, count);
        // The second half follows the cue.
        if (ok && operation.kind === 'split') selectAdded.current = { cueId: operation.cueId, step: 1 };
        return ok;
      }} />
    <StudioCueInsert page={page} request={inserting} track={track} mediaReady={media.ready} busy={editBlocked}
      onClose={() => { setInserting(null); focusList(); }}
      onApply={async (operation, label, count) => {
        const ok = await run(operation, label, count);
        if (ok && operation.kind === 'insert') selectAdded.current = { cueId: operation.cueId, step: operation.position === 'after' ? 1 : -1 };
        return ok;
      }} />
    <StudioCueShift page={page} request={shifting} mediaReady={media.ready} busy={!!editBlocked}
      onClose={() => { setShifting(null); focusList(); }} onApply={run} />
    <DropdownMenu key={menu?.serial ?? lastMenu.current?.serial ?? 0} open={!!menu} modal={false} onOpenChange={open => { if (!open) setMenu(null); }}>
      {createPortal(<DropdownMenuTrigger tabIndex={-1} aria-hidden="true" style={{ position: 'fixed', left: (menu ?? lastMenu.current)?.x ?? 0, top: (menu ?? lastMenu.current)?.y ?? 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />, document.body)}
      <StudioCueMenuContent align="start" side="bottom" sideOffset={2} collisionPadding={8} data-testid="studio-cue-context-menu" timedTestId="studio-cue-context-timed-menu"
        targets={() => (menu ?? lastMenu.current)?.targets ?? []} actions={actions} restoreFocus={focusList} />
    </DropdownMenu>
  </>;
}
