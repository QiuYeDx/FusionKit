import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { TranslationConfig } from '@/subtitle-studio/translation-contract';
import type { KnowledgeTrialPreview, KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeSelection, KnowledgeIssue, KnowledgeIssueCode } from '@/translation-knowledge/execution-contract';

const issueKeys = {
  selection_invalid: 'knowledge:trial.issue.selection_invalid', resource_limit: 'knowledge:trial.issue.resource_limit', resource_missing: 'knowledge:trial.issue.resource_missing', resource_archived: 'knowledge:trial.issue.resource_archived',
  style_unavailable: 'knowledge:trial.issue.style_unavailable', language_mismatch: 'knowledge:trial.issue.language_mismatch', untrusted: 'knowledge:trial.issue.untrusted', unsupported_kind: 'knowledge:trial.issue.unsupported_kind',
  subject_unbound: 'knowledge:trial.issue.subject_unbound', speaker_conflict: 'knowledge:trial.issue.speaker_conflict', condition_unconfirmed: 'knowledge:trial.issue.condition_unconfirmed', disabled: 'knowledge:trial.issue.disabled',
  no_match: 'knowledge:trial.issue.no_match', term_conflict: 'knowledge:trial.issue.term_conflict', rule_conflict: 'knowledge:trial.issue.rule_conflict', budget_excluded: 'knowledge:trial.issue.budget_excluded',
  budget_required: 'knowledge:trial.issue.budget_required', preferences_not_applied: 'knowledge:trial.issue.preferences_not_applied', required_term_suspect: 'knowledge:trial.issue.required_term_suspect',
} as const satisfies Record<KnowledgeIssueCode, string>;
const languages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return <label htmlFor={id} className="flex min-w-0 items-start gap-2 text-xs leading-5"><Checkbox id={id} className="mt-0.5 shrink-0" checked={checked} disabled={disabled} onCheckedChange={value => { if (!disabled) onChange(value === true); }} /><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span></label>;
}
function Choice({ label, value, options, onChange, disabled }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (id: string) => void; disabled?: boolean }) {
  const id = useId();
  return <ToolField label={label} htmlFor={id}><Select value={value} disabled={disabled} onValueChange={next => { if (!disabled) onChange(next); }}><SelectTrigger id={id} className="h-auto min-h-8 w-full min-w-0 text-left text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:whitespace-normal [&_[data-slot=select-value]]:[overflow-wrap:anywhere]"><SelectValue /></SelectTrigger><SelectContent className="max-w-[calc(100vw-2rem)]">{options.map(option => <SelectItem key={option.id} value={option.id} className="max-w-[min(36rem,80vw)] whitespace-normal [overflow-wrap:anywhere]">{option.name}</SelectItem>)}</SelectContent></Select></ToolField>;
}
function PagedItems<T>({ items, children, size = 10, disabled = false }: { items: readonly T[]; children: (item: T, index: number) => ReactNode; size?: number; disabled?: boolean }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size)), current = Math.min(page, pages - 1);
  useEffect(() => { setPage(value => Math.min(value, pages - 1)); }, [pages]);
  return <div className="min-w-0 space-y-3">{items.slice(current * size, (current + 1) * size).map((item, index) => children(item, current * size + index))}{pages > 1 && <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground"><span>{t('knowledge:pagination', { count: items.length, page: current + 1, pages })}</span><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={disabled || current === 0} onClick={() => setPage(current - 1)}>{t('knowledge:actions.previous')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled || current + 1 >= pages} onClick={() => setPage(current + 1)}>{t('knowledge:actions.next')}</Button></div></div>}</div>;
}
function setCueBinding(bindings: KnowledgeSelection['bindings'], cueId: string, role: KnowledgeSelection['bindings'][number]['role'], subjectId: string): KnowledgeSelection['bindings'] {
  const grouped = new Map<string, KnowledgeSelection['bindings'][number]>();
  for (const binding of [...bindings, ...(subjectId !== 'none' ? [{ subjectId, role, cueIds: [cueId] }] : [])]) {
    const ids = binding.role === role && binding.subjectId !== subjectId ? binding.cueIds.filter(id => id !== cueId) : binding.cueIds;
    if (!ids.length) continue;
    const key = `${binding.subjectId}:${binding.role}`, previous = grouped.get(key);
    grouped.set(key, { ...binding, cueIds: [...new Set([...(previous?.cueIds ?? []), ...ids])] });
  }
  return [...grouped.values()];
}
function setCueConfirmation(confirmations: KnowledgeSelection['confirmations'], entryId: string, cueId: string, checked: boolean): KnowledgeSelection['confirmations'] {
  const grouped = new Map<string, Set<string>>();
  for (const item of confirmations) grouped.set(item.entryId, new Set([...(grouped.get(item.entryId) ?? []), ...item.cueIds]));
  const ids = grouped.get(entryId) ?? new Set<string>();
  if (checked) ids.add(cueId); else ids.delete(cueId);
  grouped.set(entryId, ids);
  return [...grouped].filter(([, values]) => values.size).map(([id, values]) => ({ entryId: id, cueIds: [...values] }));
}

/** A file-scoped draft: nothing here changes saved defaults or official translations. */
export function StudioKnowledgeTrial({ page, config, apiKey, disabled }: { page: DocumentPage; config: TranslationConfig; apiKey: string; disabled: boolean }) {
  const { t } = useTranslation();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [selection, setSelection] = useState<KnowledgeSelection>({ version: 1, languagePair: { source: 'ja', target: config.language === 'zh' ? 'zh-Hans' : languages.includes(config.language as typeof languages[number]) ? config.language : 'zh-Hans' }, collectionIds: [], bindings: [], confirmations: [], disabledEntryIds: [], instructions: config.instructions || undefined });
  const [explicitCues, setExplicitCues] = useState<string[]>([]);
  const [scopeCues, setScopeCues] = useState<Array<{ id: string; text: string }>>([]);
  const [preview, setPreview] = useState<KnowledgeTrialPreview | null>(null);
  const [result, setResult] = useState<KnowledgeTrialResult | null>(null);
  const [pending, setPending] = useState<'load' | 'check' | 'run' | 'cancel' | null>(null);
  const [error, setError] = useState(false);
  const [materialsChanged, setMaterialsChanged] = useState(false);
  const epoch = useRef(0), mounted = useRef(true), active = useRef(false);
  const pendingRef = useRef<typeof pending>(null);
  const closing = useRef<Promise<void> | null>(null);
  const libraryGeneration = useRef<number | null>(null);
  const identity = JSON.stringify([page.summary.id, page.summary.revision, config]);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const isBusy = pending !== null;
  const activity = (value: typeof pending) => { pendingRef.current = value; if (mounted.current) setPending(value); };
  const invalidate = () => { epoch.current++; setPreview(null); setResult(null); setError(false); setMaterialsChanged(false); };
  const acceptLibrary = (snapshot: LibrarySnapshot): boolean => {
    const changed = libraryGeneration.current !== null && libraryGeneration.current !== snapshot.generation;
    libraryGeneration.current = snapshot.generation;
    setLibrary(snapshot);
    const existingIds = new Set(snapshot.data.entries.map(entry => entry.id));
    if (changed) { setPreview(null); setResult(null); setMaterialsChanged(true); }
    setSelection(value => ({
      ...value,
      disabledEntryIds: changed ? [] : value.disabledEntryIds.filter(id => existingIds.has(id)),
      confirmations: changed ? [] : value.confirmations.filter(item => existingIds.has(item.entryId)),
      // Undefined requirements/context continue to display the newly read
      // recipe. Only explicit task overrides are carried across reopening.
    }));
    return changed;
  };
  const update = (patch: Partial<KnowledgeSelection> | ((value: KnowledgeSelection) => Partial<KnowledgeSelection>)) => {
    if (pendingRef.current || !active.current) return;
    invalidate(); setSelection(value => ({ ...value, ...(typeof patch === 'function' ? patch(value) : patch) }));
  };
  const cancelClosedSession = () => {
    if (!closing.current) {
      const operation = Promise.resolve().then(() => window.subtitleStudio.cancelKnowledgeTrial({})).then(() => undefined, () => undefined);
      closing.current = operation;
      void operation.then(() => { if (closing.current === operation) closing.current = null; });
    }
    return closing.current;
  };
  const close = () => {
    const wasActive = active.current;
    epoch.current++; active.current = false; setOpen(false); activity(null);
    if (wasActive) void cancelClosedSession();
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; if (active.current) void cancelClosedSession(); active.current = false; }; }, []);
  useEffect(() => { if (active.current) close(); setPreview(null); setResult(null); setScopeCues([]); setExplicitCues([]); setSelection(value => ({ ...value, bindings: [], confirmations: [], disabledEntryIds: [], instructions: config.instructions || undefined })); }, [identity]);
  const begin = async () => {
    if (disabled || pendingRef.current || active.current) return;
    active.current = true; setOpen(true); activity('load'); setLibrary(null); setError(false); setMaterialsChanged(false); setPreview(null); setResult(null);
    const revision = ++epoch.current;
    try {
      if (closing.current) await closing.current;
      if (!mounted.current || revision !== epoch.current) return;
      const response = await window.translationKnowledge.read();
      if (!mounted.current || revision !== epoch.current) return;
      if (response.ok) {
        acceptLibrary(response.value);
      } else setError(true);
    }
    catch { if (mounted.current && revision === epoch.current) setError(true); }
    finally { if (mounted.current && revision === epoch.current) activity(null); }
  };
  const check = async () => {
    if (pendingRef.current || !active.current || !library) return;
    activity('check'); setError(false); setMaterialsChanged(false); setResult(null); setPreview(null);
    const revision = ++epoch.current, requestIdentity = identity;
    try {
      const response = await window.subtitleStudio.planKnowledgeTrial({ documentId: page.summary.id, revision: page.summary.revision, knowledgeGeneration: library.generation, config, knowledge: selection, ...(explicitCues.length ? { cueIds: explicitCues } : {}) });
      if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
      if (response.ok) { setPreview(response.value); setScopeCues(response.value.cues); }
      else if (response.error === 'revision_conflict') {
        const current = await window.translationKnowledge.read();
        if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
        if (!current.ok || !acceptLibrary(current.value)) setError(true);
      } else setError(true);
    } catch { if (mounted.current && epoch.current === revision) setError(true); }
    finally { if (mounted.current && epoch.current === revision) activity(null); }
  };
  const run = async () => {
    if (pendingRef.current || !active.current || !preview?.canRun || !apiKey.trim()) return;
    activity('run'); setError(false); setResult(null);
    const revision = ++epoch.current;
    try { const response = await window.subtitleStudio.runKnowledgeTrial({ planId: preview.planId, apiKey }); if (!mounted.current || epoch.current !== revision) return; if (response.ok) setResult(response.value); else setError(true); }
    catch { if (mounted.current && epoch.current === revision) setError(true); }
    finally { if (mounted.current && epoch.current === revision) { setPreview(value => value ? { ...value, canRun: false } : value); activity(null); } }
  };
  const cancel = async () => {
    const isCancelling = () => pendingRef.current === 'cancel';
    if (pendingRef.current !== 'run' || !active.current) return;
    const revision = epoch.current;
    activity('cancel');
    let failed = false;
    try { const response = await window.subtitleStudio.cancelKnowledgeTrial({}); failed = !response.ok; }
    catch { failed = true; }
    if (mounted.current && revision === epoch.current && failed) {
      setError(true);
      if (isCancelling()) activity('run');
    }
    // The original run response owns the usage and releases the busy state. A
    // cancel acknowledgement can arrive first and must not discard that response.
  };
  const names = new Map(library?.data.entries.map(entry => [entry.id, entry.title]) ?? []);
  const selectedRecipe = library?.data.recipes.find(recipe => recipe.id === selection.recipeId);
  const selectedCollections = new Set([...selection.collectionIds, ...(selectedRecipe?.readCollectionIds ?? [])]);
  const scopedEntries = library?.data.entries.filter(entry => selectedCollections.has(entry.collectionId)) ?? [];
  const conditions = scopedEntries.filter(entry => entry.scope.condition.mode === 'requires_confirmation');
  const availableCollections = library?.data.collections.filter(item => !item.archived) ?? [];
  const availableSubjects = library?.data.subjects.filter(item => !item.archived) ?? [];
  const previewItems = preview?.batches.flatMap(batch => batch.knowledge.items.map(item => ({ key: `${batch.id}:${item.entryId}`, item }))) ?? [];
  const issueCueDetails = new Map((preview?.cues ?? scopeCues).map((cue, index) => [cue.id, { text: cue.text, number: index + 1 }]));
  for (const [index, item] of (result?.items ?? []).entries()) if (!issueCueDetails.has(item.cueId)) issueCueDetails.set(item.cueId, { text: item.source, number: index + 1 });
  const issues = (values: KnowledgeIssue[]) => <PagedItems items={values} size={20}>{(value, index) => {
    const summary = `${t(issueKeys[value.code])}${value.entryIds.length ? ` · ${value.entryIds.map(id => names.get(id) ?? t('knowledge:trial.related_entry')).join(' / ')}` : ''}${value.cueIds.length ? ` · ${t('knowledge:trial.cues_count', { count: value.cueIds.length })}` : ''}`;
    const className = `[overflow-wrap:anywhere] text-xs ${value.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`;
    return value.cueIds.length ? <details key={index} data-issue-code={value.code} className={className}>
      <summary className="cursor-pointer">{summary}</summary>
      <div className="mt-2 space-y-2 border-l pl-3">{value.cueIds.map(id => {
        const cue = issueCueDetails.get(id);
        return cue ? <p key={id} data-cue-id={id} className="whitespace-pre-wrap">{cue.number}. {cue.text}</p> : null;
      })}</div>
    </details> : <p key={index} className={className}>{summary}</p>;
  }}</PagedItems>;
  return <>
    <Button data-testid="studio-knowledge-trial" size="sm" variant="outline" disabled={disabled || isBusy} onClick={() => void begin()}><BookOpen />{t('knowledge:trial.open')}</Button>
    <ScrollableDialog open={open} onOpenChange={next => { if (!next) close(); }} maxWidth="sm:max-w-3xl" contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden">
      <ScrollableDialogHeader className="p-3"><DialogTitle className="text-base">{t('knowledge:trial.title')}</DialogTitle><DialogDescription className="text-xs">{t('knowledge:trial.description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3" fadeMaskHeight={16}>
        <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]" data-testid="knowledge-trial-content" aria-busy={isBusy}>
          <p className="text-xs text-muted-foreground">{page.summary.origin.displayName} · {config.model.modelKey}</p>
          {pending === 'load' && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 shrink-0 animate-spin" />{t('knowledge:loading')}</p>}
          <fieldset disabled={isBusy} className="min-w-0 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">{(['source', 'target'] as const).map(side => <Choice key={side} disabled={isBusy} label={t(side === 'source' ? 'knowledge:fields.source_language' : 'knowledge:fields.target_language')} value={selection.languagePair[side]} options={languages.map(id => ({ id, name: t(`knowledge:languages.${id}`) }))} onChange={value => update(current => ({ languagePair: { ...current.languagePair, [side]: value } }))} />)}</div>
            <p className="text-xs text-muted-foreground">{t('knowledge:trial.language_help')}</p>
            <Choice disabled={isBusy} label={t('knowledge:trial.recipe')} value={selection.recipeId ?? 'none'} options={[{ id: 'none', name: t('knowledge:trial.no_recipe') }, ...(library?.data.recipes.filter(item => !item.archived) ?? [])]} onChange={id => {
              const recipe = library?.data.recipes.find(item => item.id === id);
              update({ recipeId: recipe?.id, ...(recipe ? { languagePair: recipe.languagePair } : {}), bindings: [], confirmations: [] });
            }} />
            <details className="min-w-0 rounded-md border p-3" open={!selection.recipeId}>
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.collections')}</summary>
              <div className="mt-3"><PagedItems items={availableCollections} disabled={isBusy}>{item => <Toggle key={item.id} label={item.name} checked={selectedCollections.has(item.id)} disabled={isBusy || selectedRecipe?.readCollectionIds.includes(item.id)} onChange={checked => update(current => ({ collectionIds: checked ? [...new Set([...current.collectionIds, item.id])] : current.collectionIds.filter(id => id !== item.id) }))} />}</PagedItems></div>
              {!availableCollections.length && <p className="mt-2 text-xs text-muted-foreground">{t('knowledge:trial.empty')}</p>}
            </details>
            <details className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.choose_cues', { count: 20 })}</summary>
              <p className="my-2 text-xs text-muted-foreground">{t('knowledge:trial.cues_help')}</p>
              <PagedItems<DocumentPage['cues'][number]> items={page.cues} disabled={isBusy}>{(cue, index) => <Toggle key={cue.id} label={`${page.offset + index + 1}. ${cue.source.plain}`} checked={explicitCues.includes(cue.id)} disabled={isBusy || !/\S/u.test(cue.source.plain) || explicitCues.length >= 20 && !explicitCues.includes(cue.id)} onChange={checked => {
                if (pendingRef.current || !active.current) return;
                invalidate(); setExplicitCues(values => checked ? [...new Set([...values, cue.id])] : values.filter(id => id !== cue.id)); setScopeCues([]); setSelection(value => ({ ...value, bindings: [], confirmations: [] }));
              }} />}</PagedItems>
            </details>
            <ToolField label={t('knowledge:trial.requirements')} htmlFor={`${formId}-requirements`}><Textarea id={`${formId}-requirements`} disabled={isBusy} className="min-h-16 text-xs" value={selection.instructions ?? (config.instructions || selectedRecipe?.instructions || '')} maxLength={4000} onChange={event => update({ instructions: event.target.value })} /></ToolField>
            <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} disabled={isBusy} className="min-h-16 text-xs" value={selection.context ?? selectedRecipe?.context ?? ''} maxLength={4000} onChange={event => update({ context: event.target.value })} /></ToolField>
            {scopeCues.length > 0 && <details data-testid="knowledge-trial-scopes" className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.scope')}</summary><p className="my-3 text-xs text-muted-foreground">{t('knowledge:trial.scope_help')}</p>
              <PagedItems items={scopeCues} size={5} disabled={isBusy}>{(cue, index) => <div key={cue.id} className="min-w-0 space-y-3 rounded-md border p-3">
                <p className="whitespace-pre-wrap text-xs">{index + 1}. {cue.text}</p>
                {(['topic', 'speaker', 'mentioned'] as const).map(role => <Choice key={role} disabled={isBusy} label={t(role === 'speaker' ? 'knowledge:trial.speaker' : role === 'topic' ? 'knowledge:trial.topic' : 'knowledge:trial.mentioned')} value={selection.bindings.find(binding => binding.role === role && binding.cueIds.includes(cue.id))?.subjectId ?? 'none'} options={[{ id: 'none', name: t('knowledge:trial.unknown') }, ...availableSubjects.filter(item => role !== 'speaker' || item.kind === 'person')]} onChange={subjectId => update(current => ({ bindings: setCueBinding(current.bindings, cue.id, role, subjectId) }))} />)}
              </div>}</PagedItems>
            </details>}
            {scopeCues.length > 0 && conditions.length > 0 && <details data-testid="knowledge-trial-conditions" className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.conditions')}</summary><div className="mt-3"><PagedItems key={[...selectedCollections].join(',')} items={conditions} size={5} disabled={isBusy}>{entry => <div key={entry.id} className="min-w-0 space-y-2">
                <p className="text-xs font-medium">{entry.title} · {'text' in entry.scope.condition ? entry.scope.condition.text : ''}</p>
                <PagedItems items={scopeCues} disabled={isBusy}>{(cue, index) => <Toggle key={cue.id} disabled={isBusy} label={`${index + 1}. ${cue.text}`} checked={selection.confirmations.some(value => value.entryId === entry.id && value.cueIds.includes(cue.id))} onChange={checked => update(current => ({ confirmations: setCueConfirmation(current.confirmations, entry.id, cue.id, checked) }))} />}</PagedItems>
              </div>}</PagedItems></div>
            </details>}
            {scopedEntries.length > 0 && <details data-testid="knowledge-trial-exclusions" className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.disable')}</summary><div className="mt-3"><PagedItems key={[...selectedCollections].join(',')} items={scopedEntries} disabled={isBusy}>{entry => <Toggle key={entry.id} label={entry.title} disabled={isBusy} checked={selection.disabledEntryIds.includes(entry.id)} onChange={checked => update(current => ({ disabledEntryIds: checked ? [...new Set([...current.disabledEntryIds, entry.id])] : current.disabledEntryIds.filter(id => id !== entry.id) }))} />}</PagedItems></div>
            </details>}
          </fieldset>
          {materialsChanged && <p role="status" data-testid="knowledge-trial-materials-changed" className="text-xs text-muted-foreground">{t('knowledge:trial.materials_changed')}</p>}
          {error && <p role="alert" className="text-xs text-destructive">{t('knowledge:trial.error')}</p>}
          {preview && <section data-testid="knowledge-trial-preview" className="min-w-0 space-y-3 border-t pt-3">
            <h3 className="text-sm font-medium">{t('knowledge:trial.estimate', { cues: preview.cueCount, batches: preview.batchCount, tokens: preview.estimatedInputTokens })}</h3>{issues(preview.issues)}
            <PagedItems key={preview.planId} items={previewItems}>{({ key, item }) => <details key={key} className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-xs">{item.title} · {t('knowledge:trial.cues_count', { count: item.applicableCueIds.length })}</summary>
              <div className="mt-2 space-y-2 text-xs"><p className="whitespace-pre-wrap">{'target' in item.payload ? item.payload.target : 'text' in item.payload ? item.payload.text : ''}</p>{item.applicableCueIds.map(id => <p key={id} className="text-muted-foreground">{preview.cues.find(cue => cue.id === id)?.text}</p>)}<PagedItems items={item.evidence}>{source => <p key={source.id} className="whitespace-pre-wrap text-muted-foreground">{source.title} · {source.excerpt}</p>}</PagedItems></div>
            </details>}</PagedItems>
          </section>}
          {result && <section data-testid="knowledge-trial-result" className="min-w-0 space-y-3 border-t pt-3">
            <h3 className="text-sm font-medium">{t(result.status === 'completed' ? 'knowledge:trial.result' : 'knowledge:trial.partial_result')}</h3>
            <p className="text-xs text-muted-foreground">{t('knowledge:trial.usage', { requests: result.requestCount, input: result.usage.inputTokens ?? t('knowledge:trial.unknown_usage'), output: result.usage.outputTokens ?? t('knowledge:trial.unknown_usage') })}</p>
            {result.error && <p role="alert" className="text-xs text-destructive">{t(`studio:errors.${result.error}`)}</p>}
            <PagedItems key={result.planId} items={result.items}>{item => <div key={item.cueId} className="min-w-0 space-y-2 rounded-md border p-3"><p className="whitespace-pre-wrap text-xs text-muted-foreground">{item.source}</p><p className="whitespace-pre-wrap text-sm">{item.target}</p>{issues(item.issues)}</div>}</PagedItems>
          </section>}
          <p className="text-xs text-muted-foreground">{t('knowledge:trial.cost_help')}</p>
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button size="sm" variant="ghost" onClick={close}>{t('knowledge:actions.close')}</Button>
        {pending === 'run' || pending === 'cancel' ? <Button size="sm" variant="outline" disabled={pending === 'cancel'} onClick={() => void cancel()}><LoaderCircle className="animate-spin" />{t('knowledge:trial.cancel')}</Button> : <>
          <Button data-testid="knowledge-trial-check" size="sm" variant="outline" disabled={isBusy || !library} onClick={() => void check()}>{pending === 'check' && <LoaderCircle className="animate-spin" />}{t('knowledge:trial.check')}</Button>
          <Button data-testid="knowledge-trial-run" size="sm" disabled={isBusy || !preview?.canRun || !apiKey.trim()} onClick={() => void run()}>{t('knowledge:trial.run')}</Button>
        </>}
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
