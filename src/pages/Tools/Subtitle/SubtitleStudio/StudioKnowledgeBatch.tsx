import { useTranslation } from 'react-i18next';
import type { KnowledgeBatchTranslationPreview } from '@/subtitle-studio/knowledge-batch-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import { StudioFileName } from './StudioControls';
import { KnowledgeIssues } from './StudioKnowledgeTrial';

/** Bounded per-file results. The parent owns checks, selection and admission. */
export function StudioKnowledgeBatch({ preview, library }: { preview: KnowledgeBatchTranslationPreview; library: LibrarySnapshot | null }) {
  const { t } = useTranslation();
  return <section data-testid="knowledge-batch-preview" className="min-w-0 space-y-3 border-t pt-3">
    <ToolStatBar columns={3} title={t('knowledge:batch.ready_count', { count: preview.readyCount, total: preview.items.length })} className="studio-translation-estimate shadow-none" gridClassName="studio-translation-estimate-grid" items={[
      { label: t('studio:translation.estimated_input'), value: preview.totalEstimatedInputTokens },
      { label: t('studio:translation.output_reserve'), value: preview.totalOutputTokenReserve },
      { label: t('knowledge:full.entry_count'), value: preview.items.reduce((count, item) => count + (item.ok ? item.plan.includedEntryCount : 0), 0) },
    ]} />
    <div className="max-h-80 space-y-2 overflow-auto">{preview.items.map(item => <article key={item.documentId} data-testid={`knowledge-batch-file-${item.documentId}`} data-state={!item.ok ? 'failed' : item.plan.canRun ? 'ready' : 'blocked'} className="min-w-0 space-y-2 rounded-md border p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1 text-xs"><StudioFileName name={item.displayName} focusable /></div><span className="text-xs text-muted-foreground">{t(!item.ok ? 'knowledge:batch.file_failed' : item.plan.canRun ? 'knowledge:batch.file_ready' : 'knowledge:batch.file_blocked')}</span></div>
      {item.ok ? <><p className="text-xs text-muted-foreground">{t('knowledge:batch.file_summary', { cues: item.plan.cueCount, batches: item.plan.batchCount, entries: item.plan.includedEntryCount })}</p><KnowledgeIssues issues={item.plan.issues} library={library} />{item.plan.issueCount > item.plan.issues.length && <p className="text-xs text-muted-foreground">{t('knowledge:batch.issues_limited', { shown: item.plan.issues.length, count: item.plan.issueCount })}</p>}</> : <p className="text-xs text-destructive">{t(`studio:errors.${item.error}`)}</p>}
    </article>)}</div>
  </section>;
}
