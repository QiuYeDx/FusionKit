import { useRef, useState } from 'react';
import { AlertCircle, FolderOpen, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StudioIconButton } from './StudioControls';

/** A local action must not toggle the workspace's reading or selection state. */
export function StudioRevealSource({ kind, id }: { kind: 'document' | 'transcription'; id: string }) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reveal = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    try { const result = await window.subtitleStudio.revealSource({ kind, id }); setFailed(!result.ok); }
    catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  };
  return <StudioIconButton data-testid="studio-reveal-source" label={t(failed ? 'studio:source_folder_failed' : 'studio:source_folder')} disabled={busy} onClick={() => void reveal()}>
    {busy ? <LoaderCircle className="studio-spin" /> : failed ? <AlertCircle className="text-destructive" /> : <FolderOpen />}
    {failed && <span role="alert" className="sr-only">{t('studio:source_folder_failed')}</span>}
  </StudioIconButton>;
}
