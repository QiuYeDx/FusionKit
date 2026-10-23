import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A completed analysis without subtitle content, distinct from a runtime failure. A caller that can submit the
 * file again passes its own `help` and the buttons as children.
 */
export function TranscriptionEmptyResult({ help, children }: { help?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return <div data-testid="transcription-empty-result" role="status" className="mt-2 min-w-0 space-y-1 rounded-smooth-lg bg-muted/40 p-3 text-xs leading-5 [overflow-wrap:anywhere]">
    <p>{t('common:transcription_empty.message')}</p>
    <p className="text-muted-foreground">{help ?? t('common:transcription_empty.help')}</p>
    {children}
  </div>;
}
