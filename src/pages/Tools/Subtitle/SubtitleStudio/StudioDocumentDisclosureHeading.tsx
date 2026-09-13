import { ChevronDown, Files } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import './StudioSelectedDocuments.css';

/** Shared heading for selected documents and operation-result details. */
export function StudioDocumentDisclosureHeading({ title, count, collapsible = true }: { title: string; count: number; collapsible?: boolean }) {
  const { i18n } = useTranslation();
  return <>
    <span className="studio-selected-documents-icon" aria-hidden="true"><Files /></span>
    <span className="studio-selected-documents-heading"><span>{title}</span><Badge variant="secondary" className="studio-selected-documents-count" aria-hidden="true">{count.toLocaleString(i18n.language)}</Badge></span>
    {collapsible && <ChevronDown className="studio-selected-documents-chevron" aria-hidden="true" />}
  </>;
}
