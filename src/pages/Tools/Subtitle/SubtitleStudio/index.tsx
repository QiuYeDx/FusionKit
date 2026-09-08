import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronDown, Code2, Copy, FileText, FolderOpen, Library, List, LoaderCircle, RefreshCw, Settings, Subtitles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ClipPathTabs, ClipPathTabsContent } from '@/components/qiuye-ui/clip-path-tabs';
import ToolPageHeader from '../../_shared/ToolPageHeader';
import { TOOL_META } from '../../_shared/toolMeta';
import { ToolDetailLayout } from '../../_shared/ui/ToolDetailLayout';
import { ToolConfigPanel } from '../../_shared/ui/ToolConfigPanel';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { ToolFilePickerSurface } from '../../_shared/ui/ToolFilePickerSurface';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { encodingSchema, LIMITS, StudioError, type Diagnostic, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { formatStudioTime, StudioFileName, StudioIconButton, StudioPagination } from './StudioControls';
import './studio.css';

const errorKeys: Record<ErrorCode, string> = {
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature', encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded', revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied', document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
};
const diagnosticKeys: Record<Diagnostic['code'], string> = {
  empty_document: 'studio:diagnostics.empty_document', unsupported_markup: 'studio:diagnostics.unsupported_markup', enhanced_lrc: 'studio:diagnostics.enhanced_lrc', negative_time: 'studio:diagnostics.negative_time', zero_duration: 'studio:diagnostics.zero_duration', untimed_text: 'studio:diagnostics.untimed_text',
};
type Activity = 'load' | 'import' | 'select' | 'export';

export default function SubtitleStudio() {
  const { t } = useTranslation();
  const { encoding, setEncoding } = useStudioPreferences();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listOffset, setListOffset] = useState(0);
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [activity, setActivity] = useState<Activity | null>('load');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [exported, setExported] = useState('');
  const [view, setView] = useState('preview');
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const mounted = useRef(true);
  const operation = useRef(false);
  const retry = useRef<(() => void) | null>(null);
  const reader = useRef<HTMLDivElement>(null);
  const busy = activity !== null;
  const diagnostics = useMemo(() => {
    const counts = new Map<Diagnostic['code'], number>();
    for (const diagnostic of page?.summary.diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    return [...counts];
  }, [page?.summary]);
  const flaggedNodes = useMemo(() => new Set(page?.summary.diagnostics.map(item => item.nodeId).filter(Boolean)), [page?.summary]);

  const run = async (kind: Activity, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setActivity(kind); setError(null); setExported('');
    retry.current = () => void run(kind, action);
    try { await action(); }
    catch (failure) { if (mounted.current) setError(failure instanceof StudioError ? failure.code : 'document_unavailable'); }
    finally { operation.current = false; if (mounted.current) setActivity(null); }
  };
  const select = async (doc: DocumentSummary, offset = 0, nodeOffset = 0) => {
    const result = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset, nodeOffset }));
    if (mounted.current) { setPage(result); setCopied(null); setCopyFailed(false); reader.current?.scrollTo({ top: 0 }); }
  };
  const load = async (offset: number, openFirst = false) => {
    const result = await unwrapStudio(window.subtitleStudio.listDocuments({ offset }));
    if (!mounted.current) return;
    setDocuments(result.documents); setTotal(result.total); setListOffset(offset);
    if (openFirst && result.documents[0]) await select(result.documents[0]);
    else if (page) {
      const refreshed = result.documents.find(doc => doc.id === page.summary.id);
      if (refreshed) await select(refreshed, page.offset, page.nodeOffset);
    }
  };
  const importDocument = () => void run('import', async () => {
    const doc = await unwrapStudio(window.subtitleStudio.importSubtitle({ encoding }));
    if (doc && mounted.current) { await load(0); await select(doc); setView('preview'); }
  });
  const chooseDocument = (doc: DocumentSummary) => void run('select', async () => { await select(doc); if (mounted.current) setView('preview'); });
  const copyCue = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); if (mounted.current) { setCopied(id); setCopyFailed(false); } }
    catch { if (mounted.current) setCopyFailed(true); }
  };
  useEffect(() => {
    mounted.current = true;
    void run('load', () => load(0, true));
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timeout);
  }, [copied]);
  useEffect(() => { reader.current?.scrollTo({ top: 0 }); }, [view]);

  const encodingField = <Select value={encoding} onValueChange={value => setEncoding(encodingSchema.parse(value))} disabled={busy}>
    <SelectTrigger aria-label={t('studio:encoding')} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
    <SelectContent>{encodingSchema.options.map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
  </Select>;
  const documentPicker = <Select value={documents.some(doc => doc.id === page?.summary.id) ? page?.summary.id : ''} onValueChange={id => { const doc = documents.find(item => item.id === id); if (doc) chooseDocument(doc); }} disabled={busy || !documents.length}>
    <SelectTrigger aria-label={t('studio:select_document')} className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:select_document')}>{page && documents.some(doc => doc.id === page.summary.id) ? <StudioFileName name={page.summary.origin.displayName} /> : undefined}</SelectValue></SelectTrigger>
    <SelectContent className="max-w-[calc(100vw-2rem)]">{documents.map(doc => <SelectItem key={doc.id} value={doc.id} className="whitespace-normal break-all">{doc.origin.displayName}</SelectItem>)}</SelectContent>
  </Select>;
  const refresh = <StudioIconButton label={t('studio:refresh')} disabled={busy} onClick={() => void run('load', () => load(listOffset, !page))}><RefreshCw className={activity === 'load' ? 'studio-spin' : ''} /></StudioIconButton>;
  const libraryPagination = total > LIMITS.pageSize ? <StudioPagination compact offset={listOffset} total={total} busy={busy} onChange={offset => void run('load', () => load(offset))} /> : null;

  return <div data-testid="subtitle-studio" className={page ? 'studio studio-has-document' : 'studio'}>
    <ToolDetailLayout
      header={<ToolPageHeader meta={TOOL_META.subtitleStudio} title={t('studio:title')} right={<Badge variant="secondary" className="font-mono text-[11px] font-normal">SRT / LRC</Badge>} />}
      asideClassName="hidden lg:block"
      mainClassName="studio-main"
      aside={<div className="space-y-3 studio-library">
        <ToolConfigPanel icon={Settings} title={t('studio:import_settings')}>
          <ToolField label={t('studio:encoding')}>{encodingField}</ToolField>
        </ToolConfigPanel>
        <ToolPanel title={t('studio:documents')} icon={Library} badge={<Badge variant="secondary" className="font-mono text-[11px]">{total}</Badge>} actions={refresh} footer={libraryPagination}>
          {documents.length ? <ul className="studio-document-list p-2">{documents.map(doc => <li key={doc.id}>
            <button disabled={busy} aria-current={page?.summary.id === doc.id ? 'true' : undefined} className="studio-document" onClick={() => chooseDocument(doc)}>
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1"><StudioFileName name={doc.origin.displayName} /><span className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"><Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px] font-normal">{doc.origin.format.toUpperCase()}</Badge>{t('studio:cue_count', { count: doc.cueCount })}</span></span>
              {doc.diagnostics.length > 0 ? <AlertCircle className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label={t('studio:document_checks')} /> : page?.summary.id === doc.id ? <Check className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            </button>
          </li>)}</ul> : <p className="py-10 text-center text-sm text-muted-foreground">{t('studio:empty')}</p>}
        </ToolPanel>
      </div>}
    >
      <ToolFilePickerSurface title={t('studio:import')} description="SRT / LRC" actionLabel={t('studio:open_file')} disabled={busy} onSelect={importDocument} icon={activity === 'import' ? <LoaderCircle className="h-5 w-5 studio-spin" /> : undefined} className="studio-import" />
      <div className="studio-mobile-controls lg:hidden">
        <div className="min-w-0 flex-1 studio-mobile-picker">{documentPicker}</div>
        <div className="w-[116px] shrink-0">{encodingField}</div>
        {page && <StudioIconButton label={t('studio:open_file')} disabled={busy} onClick={importDocument}>{activity === 'import' ? <LoaderCircle className="studio-spin" /> : <FolderOpen />}</StudioIconButton>}
        {refresh}{libraryPagination}
      </div>
      {error && <div role="alert" className="studio-notice text-destructive border-destructive/20 bg-destructive/5"><AlertCircle /><span>{t(errorKeys[error])}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => retry.current?.()}>{t('studio:retry')}</Button><StudioIconButton label={t('studio:dismiss')} onClick={() => setError(null)}><X /></StudioIconButton></div>}
      {exported && <div role="status" className="studio-notice"><CheckCheck className="text-emerald-600 dark:text-emerald-400" /><span>{t('studio:exported', { name: exported })}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => setExported('')}><X /></StudioIconButton></div>}
      <span className="sr-only" role="status">{busy ? t('studio:loading') : copied ? t('studio:copied') : ''}</span>
      {copyFailed && <div role="alert" className="studio-notice text-destructive"><AlertCircle /><span>{t('studio:copy_failed')}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => setCopyFailed(false)}><X /></StudioIconButton></div>}
      <div aria-busy={busy} className="studio-preview-region">
        <ToolPanel
          title={t('studio:preview')}
          icon={Subtitles}
          badge={page ? <Badge variant="secondary" className="font-mono text-[11px]">{page.summary.cueCount}</Badge> : undefined}
          actions={page ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('export', async () => {
            const result = await unwrapStudio(window.subtitleStudio.exportSource({ documentId: page.summary.id, revision: page.summary.revision }));
            if (result && mounted.current) setExported(result.fileName);
          })}>{activity === 'export' ? <LoaderCircle className="studio-spin" /> : <ArrowDownToLine />}{t('studio:export_source')}</Button> : undefined}
          className="studio-preview-panel"
          footer={page ? <div className="studio-reader-footer"><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground studio-footer-status">{busy ? <LoaderCircle className="h-3.5 w-3.5 studio-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}{busy ? t('studio:loading') : t('studio:source_preserved')}</span><StudioPagination offset={view === 'raw' ? page.nodeOffset : page.offset} total={view === 'raw' ? page.nodeCount : page.summary.cueCount} busy={busy} onChange={offset => void run('select', () => select(page.summary, view === 'raw' ? page.offset : offset, view === 'raw' ? offset : page.nodeOffset))} /></div> : undefined}
        >
          {page ? <>
            <ClipPathTabs value={view} onValueChange={setView} ariaLabel={t('studio:document_view')} shape="rounded" smoothCorners size="sm" className="studio-tabs w-full gap-0" transitionDuration={200} transitionEasing="ease-out" items={[
              { value: 'preview', label: t('studio:preview'), icon: <List /> },
              { value: 'raw', label: t('studio:original_nodes'), icon: <Code2 /> },
            ]}>
              <div className="studio-document-heading">
                <h2 className="text-sm font-medium"><StudioFileName name={page.summary.origin.displayName} focusable /></h2>
                <div className="studio-document-meta text-[11px] text-muted-foreground">
                  <Badge variant="outline" className="font-mono text-[10px] font-normal">{page.summary.origin.format.toUpperCase()}</Badge>
                  <span>{page.summary.origin.encoding.toUpperCase()}</span>
                  <span>{t('studio:source_only')}</span>
                </div>
              </div>
              {diagnostics.length > 0 && <details className="studio-diagnostics border-t bg-muted/30" key={page.summary.id}><summary><AlertCircle className="text-amber-600 dark:text-amber-400" /><span>{t('studio:document_checks')}</span><Badge variant="secondary" className="font-mono text-[10px]">{page.summary.diagnostics.length}</Badge><ChevronDown className="studio-disclosure" /></summary><ul>{diagnostics.map(([code, count]) => <li key={code}><span>{t(diagnosticKeys[code])}</span><span className="shrink-0 font-mono text-[10px]">{count}</span></li>)}</ul></details>}
              <div className="studio-reader border-t" ref={reader}>
                <ClipPathTabsContent value="preview">
                  {page.cues.length ? <table aria-label={t('studio:preview')} className="studio-cue-table"><thead><tr><th scope="col">#</th><th scope="col">{t('studio:time')}</th><th scope="col">{t('studio:source')}</th><th scope="col"><span className="sr-only">{t('studio:copy')}</span></th></tr></thead><tbody>{page.cues.map((cue, index) => <tr key={cue.id} data-warning={flaggedNodes.has(cue.nodeId) || undefined}>
                    <td className="studio-cue-number">{page.offset + index + 1}</td>
                    <td className="studio-cue-time"><div className="studio-time-range"><span>{formatStudioTime(cue.timing.startMs)}</span><ArrowRight aria-hidden="true" /><span className="text-muted-foreground/70">{cue.timing.endMs === null ? t('studio:unknown_end') : formatStudioTime(cue.timing.endMs)}</span></div></td>
                    <td className="studio-cue-text">{cue.source.spans.map((span, i) => <span key={i} style={{ fontWeight: span.marks.includes('b') ? 650 : undefined, fontStyle: span.marks.includes('i') ? 'italic' : undefined, textDecoration: span.marks.includes('u') ? 'underline' : undefined }}>{span.text}</span>)}</td>
                    <td className="studio-cue-action"><StudioIconButton size="icon-xs" className={copied === cue.id ? 'studio-copy text-emerald-600 dark:text-emerald-400 is-copied' : 'studio-copy text-muted-foreground'} label={copied === cue.id ? t('studio:copied') : t('studio:copy')} onClick={() => void copyCue(cue.id, cue.source.plain)}>{copied === cue.id ? <Check /> : <Copy />}</StudioIconButton></td>
                  </tr>)}</tbody></table> : <div className="studio-content-empty"><Subtitles /><p>{t('studio:diagnostics.empty_document')}</p></div>}
                </ClipPathTabsContent>
                <ClipPathTabsContent value="raw" className="studio-raw"><ol start={page.nodeOffset + 1}>{page.rawNodes.map((node, index) => <li key={node.id}><span aria-hidden="true">{page.nodeOffset + index + 1}</span><pre>{node.text}</pre></li>)}</ol>{!page.rawNodes.length && <div className="studio-content-empty"><Code2 /><p>{t('studio:no_source_content')}</p></div>}</ClipPathTabsContent>
              </div>
            </ClipPathTabs>
          </> : <div className="studio-content-empty py-14">{busy ? <LoaderCircle className="studio-spin" /> : <Subtitles />}<p>{busy ? t('studio:loading') : t('studio:empty')}</p></div>}
        </ToolPanel>
      </div>
    </ToolDetailLayout>
  </div>;
}
