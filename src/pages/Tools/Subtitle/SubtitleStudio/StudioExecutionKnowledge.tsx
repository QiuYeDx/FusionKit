import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutionRecordPage } from '@/subtitle-studio/execution-view-contract';
import { entrySummary } from '@/translation-knowledge/ipc-contract';
import { KnowledgeDisclosure } from '@/pages/TranslationKnowledge/KnowledgeDisclosure';
import { StudioPagination } from './StudioControls';

type Knowledge = NonNullable<Extract<ExecutionRecordPage, { state: 'available' }>['knowledge']>;
const pageSize = 20;

/** Frozen materials of one batch: what was included, why others were left out, and the shared background. */
export function StudioExecutionKnowledge({ knowledge }: { knowledge: Knowledge }) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0), [issueOffset, setIssueOffset] = useState(0);
  const titleId = useId();
  const entries = new Map(knowledge.entries.map(entry => [entry.id, entry]));
  const { items, issues, context } = knowledge.compiled;
  return <section data-testid="studio-execution-knowledge" className="studio-execution-knowledge" aria-labelledby={titleId}>
    <div className="studio-execution-section-head">
      <h4 id={titleId}>{t('studio:execution.knowledge_title')}</h4>
      <span>{t('studio:execution.knowledge_resources', { count: knowledge.resourceCount })}</span>
    </div>
    <p className="studio-execution-help">{t('studio:execution.knowledge_help')}</p>
    {(!!knowledge.recipeName || !!knowledge.documentTopics.length) && <dl className="studio-execution-facts">
      {!!knowledge.recipeName && <div><dt>{t('knowledge:trial.recipe')}</dt><dd>{knowledge.recipeName}</dd></div>}
      {!!knowledge.documentTopics.length && <div><dt>{t('studio:execution.knowledge_topics')}</dt><dd>{knowledge.documentTopics.join(' / ')}</dd></div>}
    </dl>}
    <div className="studio-execution-entries">
      <div className="studio-execution-group-label">
        <span>{t('studio:execution.knowledge_included')}</span>
        <span className="studio-execution-count">{items.length}</span>
      </div>
      {items.length ? items.slice(offset, offset + pageSize).map(item => <KnowledgeDisclosure key={item.entryId} variant="section"
        title={item.title} description={t(item.required ? 'studio:execution.knowledge_required' : 'studio:execution.knowledge_reference')}
        contentClassName="studio-execution-entry">
        <p className="whitespace-pre-wrap">{entrySummary(entries.get(item.entryId)!)}</p>
        <p className="studio-execution-muted">{t('studio:execution.knowledge_scope', { count: item.applicableCueIds.length, revision: item.revision })}</p>
        {!!item.condition && <p>{item.condition}</p>}
        <ol className="studio-execution-entry-cues">
          {knowledge.cues.filter(cue => item.applicableCueIds.includes(cue.cueId)).map(cue => <li key={cue.cueId}>
            <span>{cue.number}</span><span>{cue.text}</span>
          </li>)}
        </ol>
        {item.evidence.map(source => <blockquote key={source.id}>
          <p className="font-medium">{source.title}</p>
          <p className="whitespace-pre-wrap studio-execution-muted">{source.excerpt}</p>
          {!!source.attribution && <p className="studio-execution-muted">{source.attribution}</p>}
          {!!source.url && <p className="studio-execution-muted">{source.url}</p>}
        </blockquote>)}
      </KnowledgeDisclosure>) : <p className="studio-execution-empty">{t('studio:execution.knowledge_none')}</p>}
      {items.length > pageSize && <div className="studio-execution-entries-footer"><StudioPagination compact offset={offset} total={items.length} pageSize={pageSize} busy={false} onChange={setOffset} /></div>}
      {!!issues.length && <>
        <div className="studio-execution-group-label">
          <span>{t('studio:execution.knowledge_issues')}</span>
          <span className="studio-execution-count">{issues.length}</span>
        </div>
        <ul className="studio-execution-issues">
          {issues.slice(issueOffset, issueOffset + pageSize).map((issue, index) => <li key={issueOffset + index}>
            <p>{t(`knowledge:trial.issue.${issue.code}`)}</p>
            {(!!issue.entryIds.length || !!issue.cueIds.length) && <p className="studio-execution-muted">
              {[issue.entryIds.map(id => entries.get(id)?.title ?? id).join(' / '),
                issue.cueIds.length ? t('studio:execution.knowledge_cue_count', { count: issue.cueIds.length }) : ''].filter(Boolean).join(' · ')}
            </p>}
          </li>)}
        </ul>
        {issues.length > pageSize && <div className="studio-execution-entries-footer"><StudioPagination compact offset={issueOffset} total={issues.length} pageSize={pageSize} busy={false} onChange={setIssueOffset} /></div>}
      </>}
    </div>
    {!!context && <KnowledgeDisclosure title={t('studio:execution.knowledge_context')} contentClassName="studio-execution-entry">
      <p className="whitespace-pre-wrap">{context}</p>
    </KnowledgeDisclosure>}
  </section>;
}
