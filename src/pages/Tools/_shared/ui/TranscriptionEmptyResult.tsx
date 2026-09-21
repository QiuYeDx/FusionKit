import { useTranslation } from 'react-i18next';

/** A completed analysis without subtitle content, distinct from a runtime failure. */
export function TranscriptionEmptyResult() {
  const { t } = useTranslation();
  return <div data-testid="transcription-empty-result" role="status" className="mt-2 min-w-0 space-y-1 rounded-lg bg-muted/40 p-3 text-xs leading-5 [overflow-wrap:anywhere]">
    <p>{t('common:transcription_empty.message')}</p>
    <p className="text-muted-foreground">{t('common:transcription_empty.help')}</p>
  </div>;
}
