import { ChevronDown, Files } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { StudioFileName } from './StudioControls';
import './StudioSelectedDocuments.css';

/** Read-only scope preview; confirmations keep the affected documents visible. */
export function StudioSelectedDocuments({ documents, collapsible = true }: { documents: readonly DocumentSummary[]; collapsible?: boolean }) {
  const { t, i18n } = useTranslation();
  const heading = <>
      <span className="studio-selected-documents-icon" aria-hidden="true"><Files /></span>
      <span className="studio-selected-documents-heading">
        <span>{t('studio:batch.selected_title')}</span>
        <Badge variant="secondary" className="studio-selected-documents-count" aria-hidden="true">{documents.length.toLocaleString(i18n.language)}</Badge>
      </span>
  </>;
  const list = <ol className="studio-selected-documents-list" aria-label={t('studio:library.selected', { count: documents.length })}>
      {documents.map((document, index) => <li key={document.id}>
        <span className="studio-selected-documents-number" aria-hidden="true">{index + 1}</span>
        <StudioFileName name={document.origin.displayName} focusable />
        <Badge variant="outline" className="studio-selected-documents-format">{document.origin.format.toUpperCase()}</Badge>
      </li>)}
    </ol>;
  if (!collapsible) return <section className="studio-selected-documents" data-testid="studio-selected-documents" aria-label={t('studio:library.selected', { count: documents.length })}>
    <div className="studio-selected-documents-header">{heading}</div>
    {list}
  </section>;
  return <details className="studio-selected-documents" data-testid="studio-selected-documents">
    <summary className="studio-selected-documents-header" aria-label={t('studio:batch.selected_documents', { count: documents.length })}>
      {heading}
      <ChevronDown className="studio-selected-documents-chevron" aria-hidden="true" />
    </summary>
    {list}
  </details>;
}
