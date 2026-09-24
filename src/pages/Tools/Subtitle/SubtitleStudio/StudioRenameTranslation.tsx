import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, Pencil, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { StudioError, translationTrackNameSchema, type SubtitleDocument } from '@/subtitle-studio/domain';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { ToolField } from '../../_shared/ui/ToolField';
import { formatStudioTrackName, StudioIconButton } from './StudioControls';

export function StudioRenameTranslation({ page, track, busy, onChanged }: {
  page: DocumentPage; track: SubtitleDocument['translationTracks'][number]; busy: boolean;
  onChanged: (summary: DocumentSummary) => void;
}) {
  const { t } = useTranslation();
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<{ documentId: string; revision: number; trackId: string } | null>(null);
  const [name, setName] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const active = page.tasks.some(task => task.status === 'queued' || task.status === 'running');
  const valid = translationTrackNameSchema.safeParse(name).success;
  const automatic = formatStudioTrackName(track.language, page.translationTracks.findIndex(item => item.id === track.id), t('studio:language_unknown'));
  const save = async () => {
    if (!target || inFlight.current || busy || active || !valid) return;
    inFlight.current = true; setPending(true); setError('');
    try {
      const summary = await unwrapStudio(window.subtitleStudio.renameTranslationTrack({ ...target, name }));
      setTarget(null); onChanged(summary);
    } catch (failure) {
      const code = failure instanceof StudioError ? failure.code : 'document_unavailable';
      setError(t(`studio:errors.${code}`));
    } finally { inFlight.current = false; setPending(false); }
  };
  return <>
    <StudioIconButton ref={trigger} data-testid="studio-rename-translation" label={t('studio:track_naming.rename')} disabled={busy || active || pending}
      onClick={() => { setName(track.name ?? ''); setError(''); setTarget({ documentId: page.summary.id, revision: page.summary.revision, trackId: track.id }); }}><Pencil /></StudioIconButton>
    <ScrollableDialog animateSize open={!!target} onOpenChange={open => { if (!open && !inFlight.current) setTarget(null); }}
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}
      onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="p-3 pr-12"><DialogTitle className="text-base">{t('studio:track_naming.rename')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:track_naming.hint')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-bilingual-content" fadeMaskHeight={16}>
        <form id={`${id}-form`} className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
          <ToolField label={t('studio:track_naming.name')} htmlFor={`${id}-name`}><Input ref={input} id={`${id}-name`} data-testid="studio-rename-input" className="h-8 text-xs" value={name} maxLength={100} placeholder={automatic} disabled={pending} aria-invalid={!valid} onChange={event => { setName(event.target.value); setError(''); }} /></ToolField>
          {(!valid || error) && <p role="alert" className="text-xs leading-5 text-destructive">{!valid ? t('studio:track_naming.invalid') : error}</p>}
        </form>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap gap-2 p-3 sm:justify-between">
        <Button variant="ghost" size="sm" className="text-xs" disabled={pending || !name} onClick={() => { setName(''); setError(''); input.current?.focus(); }}><RotateCcw />{t('studio:track_naming.reset')}</Button>
        <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={pending} onClick={() => setTarget(null)}>{t('studio:cancel')}</Button><Button type="submit" form={`${id}-form`} size="sm" data-testid="studio-rename-save" disabled={pending || busy || active || !valid}>{pending && <LoaderCircle className="animate-spin" />}{t('studio:track_naming.save')}</Button></div>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
