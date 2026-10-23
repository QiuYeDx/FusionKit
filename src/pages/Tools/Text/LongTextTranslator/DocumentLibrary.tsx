import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ClipboardList, ClipboardPaste, FilePlus2, FileText, Library, LoaderCircle, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import type { DocumentSummary } from '@/long-text/contract';
import { labelKey } from '@/long-text/languages';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { StudioFileName, StudioIconButton } from '../../Subtitle/SubtitleStudio/StudioControls';
import { StudioScrollFade } from '../../Subtitle/SubtitleStudio/StudioScrollFade';
import { isTranslating, type ImportProgress } from './hooks/useDocuments';
import { LIBRARY_STATUS_LABELS } from './labels';
import { useLongTextPage } from './page-context';

/** The library offers a search box once it holds more documents than this. */
export const LIBRARY_SEARCH_FROM = 6;

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** "18.6 MB": one decimal from KB on, whole bytes below. */
export function formatBytes(bytes: number, language: string): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${UNITS[unit]}`;
}

/** Share of the translatable segments that are done, in whole percent. */
export function percentDone(summary: Pick<DocumentSummary, 'counts'>): number {
  const { done, translatable } = summary.counts;
  return translatable ? Math.floor((done / translatable) * 100) : 0;
}

/** Names that contain the query, ignoring case and full-width forms. */
export function matchesName(summary: Pick<DocumentSummary, 'name'>, query: string): boolean {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase();
  return !needle || summary.name.normalize('NFKC').toLocaleLowerCase().includes(needle);
}

/** The status phrase of a list row: the run's state, otherwise how far the translation got. */
export function useDocumentStatus() {
  const { t } = useTranslation('text');
  return (summary: DocumentSummary): string => {
    const percent = percentDone(summary);
    const run = summary.run;
    if (run && run.status !== 'completed') return t(LIBRARY_STATUS_LABELS[run.status], { percent });
    if (summary.counts.translatable > 0 && summary.counts.done >= summary.counts.translatable) return t('library.status_done');
    return summary.counts.done ? t('run.running_percent', { percent }) : t('library.status_new');
  };
}

function ImportingRow({ importing }: { importing: ImportProgress }) {
  const { t } = useTranslation('text');
  const { names, done } = importing;
  const total = names?.length ?? 0;
  return <li className="lt-document-importing" role="status">
    <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <span>{names && total ? t('library.importing', { name: names[Math.min(done, total - 1)], current: Math.min(done + 1, total), total }) : t('import.reading')}</span>
  </li>;
}

function DocumentRow({ summary, current, onChoose }: { summary: DocumentSummary; current: boolean; onChoose: (id: string) => void }) {
  const { t } = useTranslation('text');
  const status = useDocumentStatus();
  const Icon = summary.source.kind === 'paste' ? ClipboardList : FileText;
  const running = isTranslating(summary);
  const meta = summary.unavailable
    ? [t(summary.unavailable === 'newer_version' ? 'library.unavailable_newer' : 'library.unavailable_damaged')]
    : [
      summary.format === 'markdown' ? 'MD' : 'TXT',
      t('meta.direction', { source: t(labelKey(summary.languages.source)), target: t(labelKey(summary.languages.target)) }),
      status(summary),
    ];
  return <li>
    <button type="button" className="lt-document" data-testid="long-text-library-row" data-document-id={summary.id}
      data-unavailable={summary.unavailable ? true : undefined} aria-current={current ? 'true' : undefined} onClick={() => onChoose(summary.id)}>
      <Icon className="lt-document-icon" aria-hidden="true" />
      <span className="lt-document-body">
        <StudioFileName name={summary.name} />
        <span className="lt-document-meta">
          {meta.map((part, index) => <span key={index}>{part}</span>)}
          {!summary.unavailable && summary.counts.attention > 0 && <span className="lt-document-attention">
            <AlertCircle aria-hidden="true" />{t('library.attention', { count: summary.counts.attention })}
          </span>}
        </span>
        {running && <Progress className="lt-document-progress" value={percentDone(summary)} aria-label={status(summary)} />}
      </span>
      {/* Hover and current surfaces can share a colour; the check tells the open document apart. */}
      {current && <Check className="lt-document-current" aria-hidden="true" />}
    </button>
  </li>;
}

/**
 * The document rows with their search box; shared by the left column and the narrow library dialog.
 * `fill` scrolls the rows inside the column; the dialog scrolls them itself.
 */
export function DocumentRows({ fill, onChosen }: { fill: boolean; onChosen?: () => void }) {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const [query, setQuery] = useState('');
  const { documents, importing } = page;
  const searchable = documents.length > LIBRARY_SEARCH_FROM;
  const visible = searchable ? documents.filter(summary => matchesName(summary, query)) : documents;
  const choose = (id: string) => {
    page.selectDocument(id);
    onChosen?.();
  };
  const message = page.listState === 'failed' && !documents.length
    ? <div className="lt-library-message" role="alert">
      <span>{t('library.load_failed')}</span>
      <Button size="sm" variant="ghost" onClick={page.reloadList}>{t('library.retry')}</Button>
    </div>
    : importing || visible.length ? null
      : <p className="lt-library-message">{t(documents.length ? 'library.no_match' : 'library.empty')}</p>;
  const list = <ul className="lt-document-list">
    {importing && <ImportingRow importing={importing} />}
    {visible.map(summary => <DocumentRow key={summary.id} summary={summary} current={summary.id === page.activeId} onChoose={choose} />)}
  </ul>;
  return <>
    {searchable && <div className="lt-library-search">
      <Search aria-hidden="true" />
      <Input data-testid="long-text-library-search" aria-label={t('library.search')} placeholder={t('library.search')} value={query}
        maxLength={200} onChange={event => setQuery(event.target.value)} />
      {query && <StudioIconButton size="icon-xs" label={t('library.search_clear')} onClick={() => setQuery('')}><X /></StudioIconButton>}
    </div>}
    {message ?? (fill ? <StudioScrollFade fill className="lt-library-fade">{list}</StudioScrollFade> : list)}
  </>;
}

/** The left column: documents, import actions and the local storage footer (design §3.1). */
export function DocumentLibrary() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  return <ToolPanel className="lt-library" title={t('library.title')} icon={Library}
    badge={<Badge variant="secondary" className="font-mono text-[11px]">{page.documents.length}</Badge>}
    actions={<>
      <StudioIconButton data-testid="long-text-paste" label={t('import.paste')} onClick={() => page.openDialog({ kind: 'paste', text: '' })}><ClipboardPaste /></StudioIconButton>
      <StudioIconButton data-testid="long-text-import" label={t('import.files')} disabled={page.importBusy} onClick={page.pickFiles}>
        {page.importBusy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <FilePlus2 />}
      </StudioIconButton>
    </>}>
    <div className="lt-library-content" data-testid="long-text-library"><DocumentRows fill /></div>
    <div className="lt-library-footer">{t('library.storage', { size: formatBytes(page.storageBytes, i18n.language) })}</div>
  </ToolPanel>;
}
