import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeSelection, KnowledgeIssue } from '@/translation-knowledge/execution-contract';
import type { KnowledgeTranslationPreview } from '@/subtitle-studio/knowledge-translation-contract';
import type { KnowledgeTrialPreview, KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import { MaterialToggle } from './StudioMaterialsFields';
import { KnowledgeDisclosure } from '../../../TranslationKnowledge/KnowledgeDisclosure';
import { StudioScrollFade } from './StudioScrollFade';
import './StudioKnowledgeTrial.css';

export function KnowledgeIssues({ issues, library, cues = [] }: { issues: KnowledgeIssue[]; library: LibrarySnapshot | null; cues?: Array<{ id: string; number: number; text: string }> }) {
  const { t } = useTranslation();
  const groups = [issues.filter(issue => issue.severity === 'error'), issues.filter(issue => issue.severity !== 'error')];
  return <div className="min-w-0 space-y-2">{groups.map((items, group) => items.length > 0 && <KnowledgeDisclosure key={group} variant="inline" defaultOpen={group === 0} data-testid={group === 0 ? 'studio-materials-issues-errors' : 'studio-materials-issues-excluded'}
    title={<span className={group === 0 ? 'text-destructive' : 'text-muted-foreground'}>{t(group === 0 ? 'studio:materials.blocking' : 'studio:materials.excluded', { count: items.length })}</span>}>
    <StudioScrollFade maxHeight={224} contentClassName="studio-knowledge-issue-list">{items.map((issue, index) => <div key={index} data-issue-code={issue.code} className="text-xs leading-5 [overflow-wrap:anywhere]">
      <KnowledgeDisclosure variant="inline" title={<>{t(`knowledge:trial.issue.${issue.code}`)}{issue.entryIds.length > 0 && ` · ${issue.entryIds.map(id => library?.data.entries.find(entry => entry.id === id)?.title ?? t('knowledge:trial.related_entry')).join(' / ')}`}{issue.cueIds.length > 0 && ` · ${t('knowledge:trial.cues_count', { count: issue.cueIds.length })}`}</>}>
        <div className="space-y-1 border-l pl-2">{issue.cueIds.map((id, cueIndex) => { const cue = cues.find(item => item.id === id); const number = 'cueNumbers' in issue ? (issue.cueNumbers as number[])[cueIndex] : undefined; return <p key={id} data-cue-id={id} className="whitespace-pre-wrap">{cue ? `${cue.number}. ${cue.text}` : number ? t('knowledge:batch.cue_references', { ids: String(number) }) : t('knowledge:full.other_page_cue', { id })}</p>; })}</div>
      </KnowledgeDisclosure>
    </div>)}</StudioScrollFade>
  </KnowledgeDisclosure>)}</div>;
}

/** Scope editing uses the displayed source page, independently of a trial plan. */
export function StudioKnowledgeScope({ page, selection, library, cueIds, disabled, onChange, onCueIdsChange, onCheck, canCheck }: {
  page: DocumentPage; selection: KnowledgeSelection; library: LibrarySnapshot | null; cueIds: string[]; disabled: boolean;
  onChange: (value: KnowledgeSelection) => void; onCueIdsChange: (ids: string[]) => void; onCheck: () => void; canCheck: boolean;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const recipe = library?.data.recipes.find(item => item.id === selection.recipeId);
  const collections = new Set([...selection.collectionIds, ...recipe?.readCollectionIds ?? []]);
  const entries = library?.data.entries.filter(entry => collections.has(entry.collectionId)) ?? [];
  const conditions = entries.filter(entry => entry.scope.condition.mode === 'requires_confirmation');
  const needsRoles = entries.some(entry => entry.scope.requiredSubjects.length > 0);
  const subjects = library?.data.subjects.filter(subject => !subject.archived) ?? [];
  const setRole = (cueId: string, role: KnowledgeSelection['bindings'][number]['role'], subjectId: string) => {
    const bindings = selection.bindings.flatMap(binding => {
      const cueIds = binding.role === role ? binding.cueIds.filter(id => id !== cueId) : binding.cueIds;
      return cueIds.length ? [{ ...binding, cueIds }] : [];
    });
    if (subjectId !== 'none') bindings.push({ subjectId, role, cueIds: [cueId] });
    onChange({ ...selection, bindings });
  };
  return <KnowledgeDisclosure data-testid="knowledge-trial-scopes" title={t('studio:materials.cues')}>
    <div className="studio-knowledge-scope">
      <p className="studio-knowledge-scope-help">{t('studio:materials.cues_help')}</p>
      <StudioScrollFade className="studio-knowledge-scope-scroll" maxHeight={288}>
        <ol className="studio-knowledge-cue-list">
          {page.cues.map((cue, index) => /\S/u.test(cue.source.plain) && <li key={cue.id} className="studio-knowledge-cue" data-cue-id={cue.id} data-selected={cueIds.includes(cue.id)}>
            <label htmlFor={`${formId}-${cue.id}-selected`} className="studio-knowledge-cue-label">
              <Checkbox id={`${formId}-${cue.id}-selected`} data-testid={`studio-materials-cue-${cue.id}`} checked={cueIds.includes(cue.id)} disabled={disabled || cueIds.length >= 20 && !cueIds.includes(cue.id)} onCheckedChange={checked => onCueIdsChange(checked === true ? [...cueIds, cue.id] : cueIds.filter(id => id !== cue.id))} />
              <span className="studio-knowledge-cue-number">{page.offset + index + 1}.</span>
              <span id={`${formId}-${cue.id}-text`} className="studio-knowledge-cue-text">{cue.source.plain}</span>
            </label>
            {needsRoles && <div className="studio-knowledge-cue-roles">{(['topic', 'speaker', 'mentioned'] as const).map(role => <div key={role} className="studio-knowledge-cue-role">
              <label htmlFor={`${formId}-${cue.id}-${role}`}>{t(`knowledge:role.${role}`)}</label>
              <Select value={selection.bindings.find(binding => binding.role === role && binding.cueIds.includes(cue.id))?.subjectId ?? 'none'} disabled={disabled || selection.bindings.length >= 100} onValueChange={id => setRole(cue.id, role, id)}>
                <SelectTrigger id={`${formId}-${cue.id}-${role}`} aria-describedby={`${formId}-${cue.id}-text`} data-testid={`studio-materials-role-${cue.id}-${role}`} className="studio-knowledge-cue-role-trigger"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">{t('knowledge:filters.no_subject')}</SelectItem>{subjects.filter(subject => role !== 'speaker' || subject.kind === 'person').map(subject => <SelectItem key={subject.id} value={subject.id}>{subject.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>)}</div>}
            {conditions.length > 0 && <div className="studio-knowledge-cue-conditions">{conditions.map(entry => <MaterialToggle key={entry.id} testId={`studio-materials-confirm-${cue.id}-${entry.id}`} label={`${entry.title} · ${entry.scope.condition.mode === 'requires_confirmation' ? entry.scope.condition.text : ''}`} checked={selection.confirmations.some(item => item.entryId === entry.id && item.cueIds.includes(cue.id))} disabled={disabled} onChange={checked => {
              const confirmations = selection.confirmations.flatMap(item => { const ids = item.entryId === entry.id ? item.cueIds.filter(id => id !== cue.id) : item.cueIds; return ids.length ? [{ ...item, cueIds: ids }] : []; });
              if (checked) confirmations.push({ entryId: entry.id, cueIds: [cue.id] });
              onChange({ ...selection, confirmations });
            }} />)}</div>}
          </li>)}
        </ol>
      </StudioScrollFade>
      <div className="studio-knowledge-scope-actions"><Button data-testid="studio-translation-check-trial" variant="outline" size="sm" disabled={!canCheck} onClick={onCheck}>{t('studio:materials.check_trial')}</Button></div>
    </div>
  </KnowledgeDisclosure>;
}

export function StudioKnowledgeTrial({ preview, documentPreview, result, library, page }: { page?: DocumentPage; preview?: KnowledgeTrialPreview | null; documentPreview?: KnowledgeTranslationPreview | null; result?: KnowledgeTrialResult | null; library: LibrarySnapshot | null }) {
  const { t } = useTranslation();
  const checked = preview ?? documentPreview;
  const cues = preview?.cues.map((cue, index) => ({ ...cue, number: (page?.cues.findIndex(item => item.id === cue.id) ?? -1) >= 0 ? page!.offset + page!.cues.findIndex(item => item.id === cue.id) + 1 : index + 1 })) ?? page?.cues.map((cue, index) => ({ id: cue.id, number: page.offset + index + 1, text: cue.source.plain })) ?? [];
  return <>
    {checked && <section data-testid={preview ? 'knowledge-trial-preview' : 'knowledge-full-preview'} className="min-w-0 space-y-3 border-t pt-3">
      <ToolStatBar columns={3} title={t(checked.canRun ? 'knowledge:full.ready' : 'knowledge:full.needs_attention')} className="studio-translation-estimate shadow-none" gridClassName="studio-translation-estimate-grid" items={[
        { label: t('knowledge:full.cue_count'), value: checked.cueCount },
        { label: t('studio:translation.estimated_input'), value: checked.estimatedInputTokens },
        { label: t('knowledge:full.entry_count'), value: documentPreview?.includedEntryCount ?? new Set(preview?.batches.flatMap(batch => batch.knowledge.items.map(item => item.entryId))).size },
      ]} />
      <KnowledgeIssues issues={checked.issues} library={library} cues={cues} />
      {preview && <KnowledgeDisclosure variant="inline" data-testid="studio-materials-included" title={t('studio:materials.included')}><StudioScrollFade maxHeight={256} contentClassName="studio-knowledge-issue-list">{preview.batches.flatMap(batch => batch.knowledge.items.map(item => <p key={`${batch.id}:${item.entryId}`} className="whitespace-pre-wrap text-xs leading-5 [overflow-wrap:anywhere]">{item.title} · {'target' in item.payload ? item.payload.target : 'text' in item.payload ? item.payload.text : ''} · {t('knowledge:trial.cues_count', { count: item.applicableCueIds.length })}</p>))}</StudioScrollFade></KnowledgeDisclosure>}
      {documentPreview && <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.full_details')}</p>}
    </section>}
    {result && <section data-testid="knowledge-trial-result" className="min-w-0 space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">{t(result.status === 'completed' ? 'knowledge:trial.result' : 'knowledge:trial.partial_result')}</h3>
      <p className="text-xs text-muted-foreground">{t('knowledge:trial.usage', { requests: result.requestCount, input: result.usage.inputTokens ?? t('knowledge:trial.unknown_usage'), output: result.usage.outputTokens ?? t('knowledge:trial.unknown_usage') })}</p>
      {result.error && <p role="alert" className="text-xs text-destructive">{t(`studio:errors.${result.error}`)}</p>}
      <StudioScrollFade maxHeight={320}><div className="studio-knowledge-trial-results">{result.items.map(item => <div key={item.cueId} className="studio-knowledge-trial-result-row"><p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{item.source}</p><p className="whitespace-pre-wrap text-sm leading-5">{item.target}</p>{item.issues.length > 0 && <KnowledgeIssues issues={item.issues} library={library} />}</div>)}</div></StudioScrollFade>
    </section>}
  </>;
}
