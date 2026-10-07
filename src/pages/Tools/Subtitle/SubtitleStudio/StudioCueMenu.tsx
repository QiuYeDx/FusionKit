import { useRef, type ComponentProps } from 'react';
import { BookmarkPlus, CheckCheck, CircleDashed, Clock3, Copy, Eraser, Languages, PencilLine, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { buildCueCopyText, type CueCopyMode } from '@/services/subtitle-studio/cue-copy';
import './StudioCueCopy.css';

export type CueField = 'source' | 'target';
export type CueTrack = DocumentPage['translationTracks'][number];
export type CueMenuActions = {
  page: DocumentPage;
  track?: CueTrack;
  /** Why edits are unavailable (busy, translation running); undefined when editing is possible. */
  editBlocked?: string;
  canTranslate: boolean;
  onEdit: (cueId: string, field: CueField) => void;
  onTranslate: (cueIds: string[]) => void;
  onClear: (cueIds: string[]) => void;
  onReview: (cueIds: string[], reviewed: boolean) => void;
  onDelete: (cueIds: string[]) => void;
  onCopy: (cueId: string, text: string) => void;
  onRemember: (cueId: string) => void;
};

const copyLabels = {
  source: 'studio:copy_options.source',
  target: 'studio:copy_options.target',
  bilingual: 'studio:copy_options.bilingual',
} as const;

export const currentEntry = (track: CueTrack | undefined, cue: DocumentPage['cues'][number]) => {
  const entry = track?.entries[cue.id];
  return entry && entry.text.plain.trim() ? entry : undefined;
};

/** Clipboard text for several cues: one block per cue, blank line between them. */
export function copyCues(page: DocumentPage, track: CueTrack | undefined, cueIds: readonly string[], mode: CueCopyMode, timing: boolean): string | null {
  const ids = new Set(cueIds);
  const blocks = page.cues.filter(cue => ids.has(cue.id)).flatMap(cue => {
    const text = buildCueCopyText({ source: cue.source.plain, target: currentEntry(track, cue)?.text.plain, ...cue.timing }, mode, timing);
    return text === null ? [] : [text];
  });
  return blocks.length ? blocks.join('\n\n') : null;
}

function CueMenuItems({ targets, actions, timedTestId, onEditing }: { targets: readonly string[]; actions: CueMenuActions; timedTestId?: string; onEditing: () => void }) {
  const { t } = useTranslation();
  const { page, track, editBlocked } = actions;
  const ids = new Set(targets);
  const cues = page.cues.filter(cue => ids.has(cue.id));
  if (!cues.length) return null;
  const single = cues.length === 1 ? cues[0] : undefined;
  const cueIds = cues.map(cue => cue.id);
  const entries = cues.flatMap(cue => track?.entries[cue.id] ? [track.entries[cue.id]] : []);
  const translated = cues.some(cue => currentEntry(track, cue));
  const allReviewed = entries.length > 0 && entries.every(entry => entry.reviewStatus === 'reviewed');
  const stale = !!single && !!currentEntry(track, single) && track?.entries[single.id].sourceRevision !== single.sourceRevision;
  const translatable = cues.some(cue => cue.source.plain.trim());
  const deletesAll = cues.length >= page.summary.cueCount;
  const copy = (mode: CueCopyMode, timing: boolean) => {
    const text = copyCues(page, track, cueIds, mode, timing);
    if (text !== null) actions.onCopy(cueIds[0], text);
  };
  const choices = (timing: boolean) => (Object.keys(copyLabels) as CueCopyMode[]).map(mode =>
    <DropdownMenuItem key={mode} disabled={mode !== 'source' && !translated} onSelect={() => copy(mode, timing)}>
      {timing ? <Clock3 /> : <Copy />}{t(copyLabels[mode])}
    </DropdownMenuItem>);
  const edit = (field: CueField) => { onEditing(); actions.onEdit(single!.id, field); };
  return <>
    {cues.length > 1 && <><DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('studio:cue_menu.selected', { count: cues.length })}</DropdownMenuLabel><DropdownMenuSeparator /></>}
    {single && <>
      <DropdownMenuItem data-testid="studio-cue-edit-source" disabled={!!editBlocked} onSelect={() => edit('source')}><PencilLine />{t('studio:cue_menu.edit_source')}</DropdownMenuItem>
      {track && <DropdownMenuItem data-testid="studio-cue-edit-target" disabled={!!editBlocked} onSelect={() => edit('target')}><PencilLine />{t('studio:cue_menu.edit_target')}</DropdownMenuItem>}
      <DropdownMenuSeparator />
    </>}
    <DropdownMenuItem data-testid="studio-cue-translate" disabled={!!editBlocked || !actions.canTranslate || !translatable} onSelect={() => actions.onTranslate(cueIds)}>
      <Languages />{t(track && translated ? 'studio:cue_menu.retranslate' : 'studio:cue_menu.translate')}
    </DropdownMenuItem>
    {track && <>
      <DropdownMenuItem data-testid="studio-cue-review" disabled={!!editBlocked || !entries.length} onSelect={() => actions.onReview(cueIds, !allReviewed)}>
        {allReviewed ? <CircleDashed /> : <CheckCheck />}{t(allReviewed ? 'studio:cue_menu.unreview' : 'studio:cue_menu.review')}
      </DropdownMenuItem>
      <DropdownMenuItem data-testid="studio-cue-clear" disabled={!!editBlocked || !entries.length} onSelect={() => actions.onClear(cueIds)}><Eraser />{t('studio:cue_menu.clear_translation')}</DropdownMenuItem>
    </>}
    <DropdownMenuSeparator />
    {choices(false)}
    <DropdownMenuSub>
      <DropdownMenuSubTrigger><Clock3 />{t('studio:copy_options.with_time')}</DropdownMenuSubTrigger>
      <DropdownMenuPortal><DropdownMenuSubContent className="studio-copy-menu" data-testid={timedTestId}>
        {choices(true)}
        {cues.some(cue => cue.timing.endMs === null) && <p className="studio-copy-hint">{t('studio:copy_options.start_only')}</p>}
      </DropdownMenuSubContent></DropdownMenuPortal>
    </DropdownMenuSub>
    {single && <DropdownMenuItem data-testid="studio-remember-term" onSelect={() => actions.onRemember(single.id)}><BookmarkPlus />{t('materials:remember')}</DropdownMenuItem>}
    <DropdownMenuSeparator />
    <DropdownMenuItem data-testid="studio-cue-delete" variant="destructive" disabled={!!editBlocked || deletesAll} onSelect={() => actions.onDelete(cueIds)}>
      <Trash2 />{t(cues.length > 1 ? 'studio:cue_menu.delete_many' : 'studio:cue_menu.delete')}<DropdownMenuShortcut>Del</DropdownMenuShortcut>
    </DropdownMenuItem>
    {(editBlocked || deletesAll || (single && (!translated || stale))) && <DropdownMenuSeparator />}
    {editBlocked && <p className="studio-copy-hint" role="note">{editBlocked}</p>}
    {!editBlocked && deletesAll && <p className="studio-copy-hint" role="note">{t('studio:cue_menu.keep_one')}</p>}
    {single && (!translated || stale) && <p className="studio-copy-hint" role="note">{t(stale ? 'studio:copy_options.stale' : 'studio:copy_options.no_translation')}</p>}
  </>;
}

/**
 * Actions for one cue or the selected cues, shared by the row button and the
 * right-click menu. Starting an inline edit keeps focus in the editor instead
 * of returning it to the trigger, which would blur and save the editor at once.
 */
export function StudioCueMenuContent({ targets, actions, timedTestId, restoreFocus, ...props }: Omit<ComponentProps<typeof DropdownMenuContent>, 'children' | 'onCloseAutoFocus'> & {
  targets: () => readonly string[];
  actions: CueMenuActions;
  timedTestId?: string;
  restoreFocus?: () => void;
}) {
  const editing = useRef(false);
  return <DropdownMenuContent {...props} className={['studio-copy-menu studio-cue-menu', props.className].filter(Boolean).join(' ')} onCloseAutoFocus={event => {
    if (editing.current) { editing.current = false; event.preventDefault(); }
    else if (restoreFocus) { event.preventDefault(); restoreFocus(); }
  }}>
    <CueMenuItems targets={targets()} actions={actions} timedTestId={timedTestId} onEditing={() => { editing.current = true; }} />
  </DropdownMenuContent>;
}
