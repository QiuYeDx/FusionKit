import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, CheckCheck, CircleDashed, CircleHelp, Ellipsis, Languages, Redo2, Trash2, Undo2, UserPen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { SubtitleText } from '@/subtitle-studio/domain';
import { cueTextProblem, editedText, hasMixedStyle, normalizeCueText, type CueEditOperation, type CueTextProblem } from '@/subtitle-studio/cue-edit-contract';
import { buildCueCopyText } from '@/services/subtitle-studio/cue-copy';
import type { CueEditLabel, CueHistoryEntry } from '@/services/subtitle-studio/cue-history';
import { EMPTY_SELECTION, actionTargets } from '@/services/row-selection';
import { formatStudioTime, StudioIconButton } from './StudioControls';
import { StudioCueEditor, type CueEditorMove } from './StudioCueEditor';
import { StudioCueMenuContent, currentEntry, type CueField, type CueMenuActions, type CueTrack } from './StudioCueMenu';
import { CUE_CONTROL_ATTR, useCueSelection } from './useCueSelection';
import './StudioCueTable.css';

const control = { [CUE_CONTROL_ATTR]: '' };
const problemKeys: Record<CueTextProblem | 'empty_source', string> = {
  empty: 'studio:cue_edit.problem.empty',
  empty_source: 'studio:cue_edit.problem.empty_source',
  markup: 'studio:cue_edit.problem.markup',
  characters: 'studio:cue_edit.problem.characters',
  too_long: 'studio:cue_edit.problem.too_long',
};
const HELP_ITEMS = ['select', 'marquee', 'edit', 'editor', 'field', 'delete', 'copy', 'undo', 'menu'] as const;

function Spans({ text }: { text: SubtitleText }) {
  return <>{text.spans.map((span, i) => <span key={i} style={{ fontWeight: span.marks.includes('b') ? 650 : undefined, fontStyle: span.marks.includes('i') ? 'italic' : undefined, textDecoration: span.marks.includes('u') ? 'underline' : undefined }}>{span.text}</span>)}</>;
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
  onCopy: (cueId: string, text: string) => void;
  onRemember: (cue: DocumentPage['cues'][number]) => void;
};

/**
 * The subtitle preview list: select cues with the mouse or keyboard, edit
 * source and translation in place, and translate, review, copy or delete the
 * selection. Every edit can be undone.
 */
export function StudioCueTable({ page, track, flaggedNodes, busy, copied, scrollRef, history, onOperation, onUndo, onRedo, onTranslate, onCopy, onRemember }: StudioCueTableProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const order = page.cues.map(cue => cue.id);
  const [editing, setEditing] = useState<{ cueId: string; field: CueField } | null>(null);
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
    onClear: cueIds => { if (track) void run({ kind: 'clear', trackId: track.id, cueIds }, 'clear', cueIds.length); },
    onReview: (cueIds, reviewed) => { if (track) void run({ kind: 'review', trackId: track.id, cueIds, reviewed }, reviewed ? 'review' : 'unreview', cueIds.length); },
    onDelete: cueIds => void remove(cueIds),
    onCopy,
    onRemember: cueId => { const cue = page.cues.find(item => item.id === cueId); if (cue) onRemember(cue); },
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
  const { selection, marquee, keyboardNav } = selectionApi;
  const selected = order.filter(id => selection.keys.has(id));

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
      {selected.length ? t('studio:cue_toolbar.selected', { count: selected.length }) : activeTask ? editBlocked : ''}
    </span>
    <div className="studio-cue-toolbar" role="toolbar" aria-label={t('studio:cue_toolbar.label')} data-testid="studio-cue-toolbar">
    {selected.length > 0 && <>
      <StudioIconButton data-testid="studio-cue-toolbar-translate" label={t(translatedSelection ? 'studio:cue_menu.retranslate' : 'studio:cue_menu.translate')} disabled={!canTranslate || !selected.some(id => page.cues.find(cue => cue.id === id)?.source.plain.trim())} onClick={() => onTranslate(selected)}><Languages /></StudioIconButton>
      {track && <StudioIconButton data-testid="studio-cue-toolbar-review" label={t(reviewedAll ? 'studio:cue_menu.unreview' : 'studio:cue_menu.review')} disabled={!!editBlocked || !hasEntries} onClick={() => actions.onReview(selected, !reviewedAll)}>{reviewedAll ? <CircleDashed /> : <CheckCheck />}</StudioIconButton>}
      <StudioIconButton data-testid="studio-cue-toolbar-delete" label={t(selected.length > 1 ? 'studio:cue_menu.delete_many' : 'studio:cue_menu.delete')} disabled={!!editBlocked || selected.length >= page.summary.cueCount} onClick={() => void remove(selected)}><Trash2 /></StudioIconButton>
      <DropdownMenu>
        <Tooltip delayDuration={350}><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('studio:cue_toolbar.more')}><Ellipsis /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent sideOffset={6}>{t('studio:cue_toolbar.more')}</TooltipContent></Tooltip>
        <StudioCueMenuContent align="end" targets={() => selected} actions={actions} data-testid="studio-cue-toolbar-menu" />
      </DropdownMenu>
      <StudioIconButton label={t('studio:cue_toolbar.clear_selection')} onClick={() => { selectionApi.commit(EMPTY_SELECTION); focusList(); }}><X /></StudioIconButton>
      <span className="studio-cue-toolbar-divider" aria-hidden="true" />
    </>}
    <StudioIconButton data-testid="studio-cue-undo" label={history.undo ? t('studio:cue_history.undo', { action: historyLabel(history.undo) }) : t('studio:cue_history.nothing_to_undo')} disabled={!history.undo || !!editBlocked} onClick={onUndo}><Undo2 /></StudioIconButton>
    <StudioIconButton data-testid="studio-cue-redo" label={history.redo ? t('studio:cue_history.redo', { action: historyLabel(history.redo) }) : t('studio:cue_history.nothing_to_redo')} disabled={!history.redo || !!editBlocked} onClick={onRedo}><Redo2 /></StudioIconButton>
    <CueHelp />
    </div>
  </div>;

  return <>
    <div ref={listRef} className="studio-cue-list" tabIndex={0} data-testid="studio-cue-list" aria-label={t('studio:cue_toolbar.list_label')} {...selectionApi.listProps}>
      <table aria-label={t('studio:preview')} aria-multiselectable="true" role="grid" className={track ? 'studio-cue-table studio-translated-table' : 'studio-cue-table'}>
        <thead><tr><th scope="col">#</th><th scope="col">{t('studio:time')}</th><th scope="col">{track ? <div className="studio-parallel-text"><span>{t('studio:source')}</span><span>{t('studio:target')}</span></div> : t('studio:source')}</th><th scope="col" className="studio-cue-toolbar-cell"><span className="sr-only">{t('studio:copy')}</span>{toolbar}</th></tr></thead>
        <tbody>{page.cues.map((cue, index) => {
          const isSelected = selection.keys.has(cue.id);
          const entry = track?.entries[cue.id];
          const editingField = editing?.cueId === cue.id ? editing.field : undefined;
          const lead = keyboardNav && selection.lead === cue.id;
          const editor = (target: CueField) => {
            const text = target === 'source' ? cue.source : entry?.text;
            return <StudioCueEditor key={`${cue.id}:${target}`} initial={text?.plain ?? ''} label={t(target === 'source' ? 'studio:cue_menu.edit_source' : 'studio:cue_menu.edit_target')} saving={saving} error={editError}
              note={text && hasMixedStyle(text) ? t('studio:cue_edit.mixed_style') : undefined}
              onSave={(value, move) => void save(cue, target, value, move)} onCancel={() => { setEditing(null); setEditError(undefined); focusList(); }} />;
          };
          return <tr key={cue.id} data-cue-id={cue.id} aria-selected={isSelected} data-selected={isSelected || undefined}
            data-selected-last={isSelected && !selection.keys.has(order[index + 1]) || undefined}
            data-lead={lead || undefined} data-editing={editingField ? true : undefined} data-warning={flaggedNodes.has('nodeId' in cue ? cue.nodeId : undefined) || undefined}>
            <td className="studio-cue-number">{page.offset + index + 1}</td>
            <td className="studio-cue-time"><div className="studio-time-range"><span>{formatStudioTime(cue.timing.startMs)}</span><ArrowRight aria-hidden="true" /><span className="text-muted-foreground/70">{cue.timing.endMs === null ? t('studio:unknown_end') : formatStudioTime(cue.timing.endMs)}</span></div></td>
            <td className="studio-cue-text"><div className={track ? 'studio-parallel-text' : undefined}>
              <div className="studio-cue-field" data-field="source" data-active={lead && activeField === 'source' || undefined} onPointerDown={() => setField('source')} onDoubleClick={() => startEdit(cue.id, 'source')}>
                {editingField === 'source' ? editor('source') : <Spans text={cue.source} />}
              </div>
              {track && <div className="studio-target-text studio-cue-field" data-field="target" data-active={lead && activeField === 'target' || undefined} onPointerDown={() => setField('target')} onDoubleClick={() => startEdit(cue.id, 'target')}>
                {editingField === 'target' ? editor('target') : entry ? <>
                  {entry.sourceRevision !== cue.sourceRevision && <span className="block text-xs text-amber-600">{t('studio:translation_stale')}</span>}
                  <Spans text={entry.text} />
                  {(entry.reviewStatus === 'reviewed' || entry.origin === 'human') && <Tooltip delayDuration={350}>
                    <TooltipTrigger asChild><span className="studio-cue-mark" role="img" aria-label={t(entry.origin === 'human' ? 'studio:cue_edit.human' : 'studio:cue_edit.reviewed')} {...control}>{entry.origin === 'human' ? <UserPen /> : <Check />}</span></TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t(entry.origin === 'human' ? 'studio:cue_edit.human' : 'studio:cue_edit.reviewed')}</TooltipContent>
                  </Tooltip>}
                </> : <span className="text-xs text-muted-foreground">{cue.source.plain.trim() ? t('studio:translation_missing') : ''}</span>}
              </div>}
            </div></td>
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
    <DropdownMenu key={menu?.serial ?? lastMenu.current?.serial ?? 0} open={!!menu} modal={false} onOpenChange={open => { if (!open) setMenu(null); }}>
      {createPortal(<DropdownMenuTrigger tabIndex={-1} aria-hidden="true" style={{ position: 'fixed', left: (menu ?? lastMenu.current)?.x ?? 0, top: (menu ?? lastMenu.current)?.y ?? 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />, document.body)}
      <StudioCueMenuContent align="start" side="bottom" sideOffset={2} collisionPadding={8} data-testid="studio-cue-context-menu" timedTestId="studio-cue-context-timed-menu"
        targets={() => (menu ?? lastMenu.current)?.targets ?? []} actions={actions} restoreFocus={focusList} />
    </DropdownMenu>
  </>;
}
