import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeSelection, KnowledgeIssue } from '@/translation-knowledge/execution-contract';
import type { KnowledgeTranslationPreview } from '@/subtitle-studio/knowledge-translation-contract';
import type { KnowledgeTrialPreview, KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import { MaterialToggle } from './StudioMaterialsFields';

export function KnowledgeIssues({ issues, library, cues = [] }: { issues: KnowledgeIssue[]; library: LibrarySnapshot | null; cues?: Array<{ id: string; number: number; text: string }> }) {
  const { t } = useTranslation();
  const groups = [issues.filter(issue => issue.severity === 'error'), issues.filter(issue => issue.severity !== 'error')];
  return <div className="min-w-0 space-y-2">{groups.map((items, group) => items.length > 0 && <details key={group} open={group === 0}>
    <summary className={`cursor-pointer text-xs ${group === 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{t(group === 0 ? 'studio:materials.blocking' : 'studio:materials.excluded', { count: items.length })}</summary>
    <div className="mt-2 max-h-56 space-y-2 overflow-auto">{items.map((issue, index) => <details key={index} data-issue-code={issue.code} className="text-xs leading-5 [overflow-wrap:anywhere]">
      <summary className="cursor-pointer">{t(`knowledge:trial.issue.${issue.code}`)}{issue.entryIds.length > 0 && ` · ${issue.entryIds.map(id => library?.data.entries.find(entry => entry.id === id)?.title ?? t('knowledge:trial.related_entry')).join(' / ')}`}{issue.cueIds.length > 0 && ` · ${t('knowledge:trial.cues_count', { count: issue.cueIds.length })}`}</summary>
      <div className="mt-2 space-y-1 border-l pl-2">{issue.cueIds.map((id, cueIndex) => { const cue = cues.find(item => item.id === id); const number = 'cueNumbers' in issue ? (issue.cueNumbers as number[])[cueIndex] : undefined; return <p key={id} data-cue-id={id} className="whitespace-pre-wrap">{cue ? `${cue.number}. ${cue.text}` : number ? t('knowledge:batch.cue_references', { ids: String(number) }) : t('knowledge:full.other_page_cue', { id })}</p>; })}</div>
    </details>)}</div>
  </details>)}</div>;
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
  return <details data-testid="knowledge-trial-scopes" className="min-w-0 rounded-lg border p-3">
    <summary className="cursor-pointer text-xs">{t('studio:materials.cues')}</summary>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('studio:materials.cues_help')}</p>
    <div className="mt-3 max-h-72 space-y-3 overflow-auto">{page.cues.filter(cue => /\S/u.test(cue.source.plain)).map((cue, index) => <div key={cue.id} className="min-w-0 space-y-2 rounded-md border p-3">
      <MaterialToggle testId={`studio-materials-cue-${cue.id}`} label={`${page.offset + index + 1}. ${cue.source.plain}`} checked={cueIds.includes(cue.id)} disabled={disabled || cueIds.length >= 20 && !cueIds.includes(cue.id)} onChange={checked => onCueIdsChange(checked ? [...cueIds, cue.id] : cueIds.filter(id => id !== cue.id))} />
      {needsRoles && <div className="grid gap-2 sm:grid-cols-3">{(['topic', 'speaker', 'mentioned'] as const).map(role => <div key={role} className="min-w-0 space-y-1"><label htmlFor={`${formId}-${cue.id}-${role}`} className="text-xs text-muted-foreground">{t(`knowledge:role.${role}`)}</label><Select value={selection.bindings.find(binding => binding.role === role && binding.cueIds.includes(cue.id))?.subjectId ?? 'none'} disabled={disabled || selection.bindings.length >= 100} onValueChange={id => setRole(cue.id, role, id)}><SelectTrigger id={`${formId}-${cue.id}-${role}`} data-testid={`studio-materials-role-${cue.id}-${role}`} className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('knowledge:filters.no_subject')}</SelectItem>{subjects.filter(subject => role !== 'speaker' || subject.kind === 'person').map(subject => <SelectItem key={subject.id} value={subject.id}>{subject.name}</SelectItem>)}</SelectContent></Select></div>)}</div>}
      {conditions.map(entry => <MaterialToggle key={entry.id} testId={`studio-materials-confirm-${cue.id}-${entry.id}`} label={`${entry.title} · ${entry.scope.condition.mode === 'requires_confirmation' ? entry.scope.condition.text : ''}`} checked={selection.confirmations.some(item => item.entryId === entry.id && item.cueIds.includes(cue.id))} disabled={disabled} onChange={checked => {
        const confirmations = selection.confirmations.flatMap(item => { const ids = item.entryId === entry.id ? item.cueIds.filter(id => id !== cue.id) : item.cueIds; return ids.length ? [{ ...item, cueIds: ids }] : []; });
        if (checked) confirmations.push({ entryId: entry.id, cueIds: [cue.id] });
        onChange({ ...selection, confirmations });
      }} />)}
    </div>)}</div>
    <Button data-testid="studio-translation-check-trial" className="mt-3" variant="outline" size="sm" disabled={!canCheck} onClick={onCheck}>{t('studio:materials.check_trial')}</Button>
  </details>;
}

export function StudioKnowledgeTrial({ preview, documentPreview, result, library, page }: { page?: DocumentPage; preview?: KnowledgeTrialPreview | null; documentPreview?: KnowledgeTranslationPreview | null; result?: KnowledgeTrialResult | null; library: LibrarySnapshot | null }) {
  const { t } = useTranslation();
  const checked = preview ?? documentPreview;
  const cues = preview?.cues.map((cue, index) => ({ ...cue, number: (page?.cues.findIndex(item => item.id === cue.id) ?? -1) >= 0 ? page!.offset + page!.cues.findIndex(item => item.id === cue.id) + 1 : index + 1 })) ?? page?.cues.map((cue, index) => ({ id: cue.id, number: page.offset + index + 1, text: cue.source.plain })) ?? [];
  return <>
    {checked && <section data-testid={preview ? 'knowledge-trial-preview' : 'knowledge-full-preview'} className="min-w-0 space-y-3 border-t pt-3">
      <ToolStatBar columns={3} title={t(checked.canRun ? 'knowledge:full.ready' : 'knowledge:full.needs_attention')} className="studio-translation-estimate shadow-none" items={[
        { label: t('knowledge:full.cue_count'), value: checked.cueCount },
        { label: t('studio:translation.estimated_input'), value: checked.estimatedInputTokens },
        { label: t('knowledge:full.entry_count'), value: documentPreview?.includedEntryCount ?? new Set(preview?.batches.flatMap(batch => batch.knowledge.items.map(item => item.entryId))).size },
      ]} />
      <KnowledgeIssues issues={checked.issues} library={library} cues={cues} />
      {preview && <details><summary className="cursor-pointer text-xs">{t('studio:materials.included')}</summary><div className="mt-2 max-h-64 space-y-2 overflow-auto">{preview.batches.flatMap(batch => batch.knowledge.items.map(item => <p key={`${batch.id}:${item.entryId}`} className="whitespace-pre-wrap text-xs leading-5 [overflow-wrap:anywhere]">{item.title} · {'target' in item.payload ? item.payload.target : 'text' in item.payload ? item.payload.text : ''} · {t('knowledge:trial.cues_count', { count: item.applicableCueIds.length })}</p>))}</div></details>}
      {documentPreview && <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.full_details')}</p>}
    </section>}
    {result && <section data-testid="knowledge-trial-result" className="min-w-0 space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">{t(result.status === 'completed' ? 'knowledge:trial.result' : 'knowledge:trial.partial_result')}</h3>
      <p className="text-xs text-muted-foreground">{t('knowledge:trial.usage', { requests: result.requestCount, input: result.usage.inputTokens ?? t('knowledge:trial.unknown_usage'), output: result.usage.outputTokens ?? t('knowledge:trial.unknown_usage') })}</p>
      {result.error && <p role="alert" className="text-xs text-destructive">{t(`studio:errors.${result.error}`)}</p>}
      <div className="max-h-80 space-y-3 overflow-auto">{result.items.map(item => <div key={item.cueId} className="min-w-0 space-y-1 rounded-md border p-3"><p className="whitespace-pre-wrap text-xs text-muted-foreground">{item.source}</p><p className="whitespace-pre-wrap text-sm">{item.target}</p><KnowledgeIssues issues={item.issues} library={library} /></div>)}</div>
    </section>}
  </>;
}
