import type { ReactNode } from 'react';
import { ChevronDown, Files } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';
import './StudioSelectedDocuments.css';
import './StudioPlanDocuments.css';

export function StudioPlanDocuments({ documents, collapsible = true, tracks, renderDetails, renderStatus, rowState, renderActions }: {
  documents: readonly DocumentSummary[]; collapsible?: boolean;
  tracks?: { selected: Readonly<Record<string, string>>; onChange: (documentId: string, trackId: string) => void; disabled?: boolean; emptyNote?: ReactNode };
  renderDetails?: (document: DocumentSummary) => ReactNode;
  renderStatus?: (document: DocumentSummary) => ReactNode;
  rowState?: (document: DocumentSummary) => string | undefined;
  renderActions?: (document: DocumentSummary) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const heading = <>
    <span className="studio-selected-documents-icon" aria-hidden="true"><Files /></span>
    <span className="studio-selected-documents-heading"><span>{t('studio:batch.selected_title')}</span>
      <Badge variant="secondary" className="studio-selected-documents-count" aria-hidden="true">{documents.length.toLocaleString(i18n.language)}</Badge>
    </span>
  </>;
  const list = <div className="studio-plan-documents-body"><StudioDocumentList label={t('studio:library.selected', { count: documents.length })} maxHeight="min(240px, 32vh)">
    {documents.map((document, index) => <StudioDocumentRow key={document.id} data-document-id={document.id} data-state={rowState?.(document)} name={document.origin.displayName} index={index + 1}
      status={<span className="studio-plan-document-status"><Badge variant="outline" className="studio-selected-documents-format">{document.origin.format.toUpperCase()}</Badge>{renderStatus?.(document)}</span>}
      actions={renderActions || tracks && (document.translationTracks?.length ?? 0) > 1 ? <>{tracks && (document.translationTracks?.length ?? 0) > 1 && <Select value={tracks.selected[document.id] ?? ''} onValueChange={value => tracks.onChange(document.id, value)} disabled={tracks.disabled}>
        <SelectTrigger aria-label={t('studio:batch.track_for', { name: document.origin.displayName })} className="studio-plan-document-track h-8 text-xs"><SelectValue placeholder={t('studio:export.no_track')} /></SelectTrigger>
        <SelectContent>{document.translationTracks?.map((track, trackIndex) => <SelectItem key={track.id} value={track.id}>{track.language === 'und' ? t('studio:language_unknown') : track.language} · {trackIndex + 1}</SelectItem>)}</SelectContent>
      </Select>}{renderActions?.(document)}</> : undefined}>
      {tracks && !document.translationTracks?.length && tracks.emptyNote && <p className="studio-plan-documents-note">{tracks.emptyNote}</p>}
      {renderDetails?.(document)}
    </StudioDocumentRow>)}
  </StudioDocumentList></div>;
  if (!collapsible) return <section className="studio-selected-documents" data-testid="studio-selected-documents" aria-label={t('studio:library.selected', { count: documents.length })}>
    <div className="studio-selected-documents-header">{heading}</div>{list}
  </section>;
  return <details className="studio-selected-documents" data-testid="studio-selected-documents">
    <summary className="studio-selected-documents-header" aria-label={t('studio:batch.selected_documents', { count: documents.length })}>
      {heading}<ChevronDown className="studio-selected-documents-chevron" aria-hidden="true" />
    </summary>{list}
  </details>;
}
