import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, FolderOpen, LoaderCircle } from 'lucide-react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Button } from '@/components/ui/button';
import type { DocumentDetail, LongTextRequest } from '@/long-text/contract';
import { exportName, numberedName } from '@/long-text/export-name';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { useLongTextStore, type ExportMode } from '@/store/tools/text/useLongTextStore';
import { showToast } from '@/utils/toast';
import { StudioFileName } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { ToolField } from '../../../_shared/ui/ToolField';
import { ToolRadioButtonGroup } from '../../../_shared/ui/ToolRadioButtonGroup';
import { isTranslating } from '../hooks/useDocuments';
import { ERROR_LABELS, EXPORT_MODE_LABELS } from '../labels';
import { groupedCount, useLongTextPage } from '../page-context';
import { DialogFrame, DialogNote, useDialogRequest } from './DialogFrame';
import { compactCount } from './estimate-text';

type Destination = LongTextRequest<'export'>['destination'];
type Pending = 'export' | 'copy' | 'choose';

/** The file an export writes first; an existing file of that name makes it `name (2).ext` (design §6.12). */
export function exportFileName(detail: Pick<DocumentDetail, 'source' | 'name' | 'format' | 'languages'>, mode: ExportMode): string {
  const fileName = detail.source.kind === 'file' ? detail.source.fileName : null;
  return numberedName(exportName({ fileName, name: detail.name, format: detail.format }, detail.languages.target, mode), 1);
}

/**
 * Where an export goes by default: next to an imported file, unless a folder was chosen for the
 * document before; pasted text has only the folder (the Documents folder until one is chosen).
 */
export function defaultDestination(detail: Pick<DocumentDetail, 'source' | 'exportFolder'>): Destination {
  return detail.source.kind === 'file' && detail.exportFolder === null ? 'source' : 'folder';
}

/**
 * Export and copy (520, design §3.3-E). The folder of "其他文件夹" is chosen only in the main process's
 * native dialog and remembered per document; a finished export closes the dialog and is reported by
 * the "已导出" notice.
 */
export function ExportDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const submit = useRef<HTMLButtonElement>(null);
  const mode = useLongTextStore(state => state.exportMode);
  const setMode = useLongTextStore(state => state.setExportMode);
  const [destination, setDestination] = useState<Destination>('source');
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const { request, detail } = useDialogRequest('export', (_request, current) => {
    if (current) setDestination(defaultDestination(current));
    setChosenFolder(null);
    setError('');
  });
  if (!detail) return null;

  const fromFile = detail.source.kind === 'file';
  const folder = chosenFolder ?? detail.exportFolder;
  const location = destination === 'source' && detail.source.kind === 'file' ? detail.source.directory : folder;
  const untranslated = detail.counts.translatable - detail.counts.done;
  const translating = isTranslating(detail);
  const fail = (kind: Pending, failure: unknown) => {
    const code = errorCodeOf(failure);
    // The main process reports a clipboard it could not write as `internal`.
    setError(t(kind === 'copy' && code === 'internal' ? 'errors.copy_failed' : ERROR_LABELS[code]));
  };
  const run = async (kind: Pending, action: () => Promise<void>) => {
    setPending(kind);
    setError('');
    try {
      await action();
    } catch (failure) {
      fail(kind, failure);
    } finally {
      setPending(null);
    }
  };
  const chooseFolder = () => run('choose', async () => {
    const chosen = await unwrap(window.longText.chooseExportFolder({ documentId: detail.id }));
    if (chosen) setChosenFolder(chosen.path);
  });
  const exportFile = () => run('export', async () => {
    const exported = await unwrap(window.longText.export({ documentId: detail.id, mode, destination }));
    page.pushNotice({ kind: 'exported', documentId: detail.id, name: exported.name });
    page.closeDialog();
  });
  const copy = () => run('copy', async () => {
    const { characters } = await unwrap(window.longText.copy({ documentId: detail.id, mode }));
    showToast(t('notices.copied_all', { count: compactCount(characters, i18n.language) }), 'success');
  });
  const spinner = (kind: Pending) => pending === kind && <LoaderCircle className="animate-spin motion-reduce:animate-none" />;

  return <DialogFrame open={!!request} width={520} testId="long-text-export-dialog" icon={<Download />} title={t('export.title')} name={detail.name}
    busy={pending !== null} initialFocus={() => submit.current}
    footer={<>
      <Button type="button" variant="outline" size="sm" className="mr-auto" data-testid="long-text-export-copy" disabled={pending !== null} onClick={() => void copy()}>
        {spinner('copy') || <Copy />}{t('export.copy')}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={page.closeDialog}>{t('export.cancel')}</Button>
      <Button ref={submit} type="button" size="sm" data-testid="long-text-export-submit" disabled={pending !== null} onClick={() => void exportFile()}>
        {spinner('export') || <Download />}{t('export.submit')}
      </Button>
    </>}>
    <div className="lt-dialog-body">
      <ToolField label={t('export.content')} testId="long-text-export-mode">
        <div>
          <ToolRadioButtonGroup<ExportMode> ariaLabel={t('export.content')} value={mode} disabled={pending !== null}
            options={(['target', 'bilingual'] as const).map(value => ({ value, label: t(EXPORT_MODE_LABELS[value]) }))} onValueChange={setMode} />
          <DialogTransition transitionKey="bilingual" stageClassName="pt-2">
            {mode === 'bilingual' ? <p className="lt-dialog-hint">{t('export.bilingual_note')}</p> : null}
          </DialogTransition>
        </div>
      </ToolField>
      <ToolField label={t('export.destination')} testId="long-text-export-destination">
        <div className="lt-export-destination">
          {fromFile && <ToolRadioButtonGroup<Destination> ariaLabel={t('export.destination')} value={destination} disabled={pending !== null}
            options={[{ value: 'source', label: t('export.beside_source') }, { value: 'folder', label: t('export.folder') }]} onValueChange={setDestination} />}
          <div className="lt-export-location">
            <span className="lt-export-path" data-testid="long-text-export-path">
              {location ? <StudioFileName name={location} focusable /> : t('export.documents_folder')}
            </span>
            <Button type="button" variant="outline" size="xs" data-testid="long-text-export-choose" disabled={destination !== 'folder' || pending !== null}
              onClick={() => void chooseFolder()}>{spinner('choose') || <FolderOpen />}{t('export.choose')}</Button>
          </div>
        </div>
      </ToolField>
      <ToolField label={t('export.file_name')}>
        <div>
          <p className="lt-export-name" data-testid="long-text-export-name">{exportFileName(detail, mode)}</p>
          <p className="lt-dialog-hint">{t('export.no_overwrite')}</p>
        </div>
      </ToolField>
    </div>
    <DialogTransition transitionKey="incomplete" stageClassName="pt-4">
      {untranslated > 0 || translating ? <DialogNote tone="info" testId="long-text-export-incomplete">
        {untranslated > 0 && <span className="block">{t('export.incomplete', { count: groupedCount(untranslated, i18n.language) })}</span>}
        {translating && <span className="block">{t('export.running')}</span>}
      </DialogNote> : null}
    </DialogTransition>
    <DialogTransition transitionKey="error" stageClassName="pt-3">{error ? <DialogNote tone="error">{error}</DialogNote> : null}</DialogTransition>
  </DialogFrame>;
}
