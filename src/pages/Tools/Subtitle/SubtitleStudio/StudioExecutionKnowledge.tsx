import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutionRecordPage } from '@/subtitle-studio/execution-view-contract';
import { entrySummary } from '@/translation-knowledge/ipc-contract';
import { StudioPagination } from './StudioControls';

type Knowledge = NonNullable<Extract<ExecutionRecordPage, { state: 'available' }>['knowledge']>;
export function StudioExecutionKnowledge({ knowledge }: { knowledge: Knowledge }) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0), [issueOffset, setIssueOffset] = useState(0);
  const entries = new Map(knowledge.entries.map(entry => [entry.id, entry]));
  return <section data-testid="studio-execution-knowledge" className="min-w-0 space-y-3 border-t pt-3">
    <h3 className="text-sm font-semibold">{t('studio:execution.knowledge_title')}</h3>
    <p className="text-xs leading-5 text-muted-foreground">{t('studio:execution.knowledge_help', { count: knowledge.resourceCount })}</p>
    {!!knowledge.recipeName && <p className="text-xs">{t('knowledge:trial.recipe')} · {knowledge.recipeName}</p>}
    {!!knowledge.documentTopics.length && <p className="text-xs">{t('studio:execution.knowledge_topics')} · {knowledge.documentTopics.join(' / ')}</p>}
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-xs font-medium">{t('studio:execution.knowledge_guidance')}</summary>
      <div className="mt-2 space-y-2 whitespace-pre-wrap text-xs leading-5">
        <p>{knowledge.compiled.instructions || t('studio:execution.no_instructions')}</p>
        {!!knowledge.compiled.context && <p>{knowledge.compiled.context}</p>}
        <p className="text-muted-foreground">{t('studio:execution.knowledge_digest')} · {knowledge.digest}</p>
      </div>
    </details>
    <h4 className="text-xs font-medium">{t('studio:execution.knowledge_included', { count: knowledge.compiled.items.length })}</h4>
    {knowledge.compiled.items.slice(offset, offset + 20).map(item => <details key={item.entryId} className="rounded-md border p-3">
      <summary className="cursor-pointer text-xs leading-5">{item.title} · {t(item.required ? 'studio:execution.knowledge_required' : 'studio:execution.knowledge_reference')}</summary>
      <div className="mt-2 space-y-3 text-xs leading-5">
        <p className="whitespace-pre-wrap">{entrySummary(entries.get(item.entryId)!)}</p>
        <p className="text-muted-foreground">{t('studio:execution.knowledge_scope', { count: item.applicableCueIds.length, revision: item.revision })}</p>
        <ol className="space-y-1 rounded-md bg-muted/35 p-2">
          {knowledge.cues.filter(cue => item.applicableCueIds.includes(cue.cueId)).map(cue => <li key={cue.cueId} className="whitespace-pre-wrap">{cue.number}. {cue.text}</li>)}
        </ol>
        {!!item.condition && <p>{item.condition}</p>}
        {item.evidence.map(source => <blockquote key={source.id} className="space-y-1 border-l-2 pl-3">
          <p className="font-medium">{source.title}</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{source.excerpt}</p>
          {!!source.attribution && <p className="text-muted-foreground">{source.attribution}</p>}
          {!!source.url && <p className="text-muted-foreground">{source.url}</p>}
        </blockquote>)}
      </div>
    </details>)}
    {knowledge.compiled.items.length > 20 && <StudioPagination compact offset={offset} total={knowledge.compiled.items.length} pageSize={20} busy={false} onChange={setOffset} />}
    <h4 className="text-xs font-medium">{t('studio:execution.knowledge_issues', { count: knowledge.compiled.issues.length })}</h4>
    {knowledge.compiled.issues.slice(issueOffset, issueOffset + 20).map((issue, index) => <div key={issueOffset + index} className="space-y-1 rounded-md bg-muted/35 p-2 text-xs leading-5">
      <p>{t(`knowledge:trial.issue.${issue.code}`)}</p>
      {!!issue.entryIds.length && <p className="text-muted-foreground">{issue.entryIds.map(id => entries.get(id)?.title ?? id).join(' / ')}</p>}
      {!!issue.cueIds.length && <p className="text-muted-foreground">{t('studio:execution.knowledge_cue_count', { count: issue.cueIds.length })}</p>}
    </div>)}
    {knowledge.compiled.issues.length > 20 && <StudioPagination compact offset={issueOffset} total={knowledge.compiled.issues.length} pageSize={20} busy={false} onChange={setIssueOffset} />}
  </section>;
}
