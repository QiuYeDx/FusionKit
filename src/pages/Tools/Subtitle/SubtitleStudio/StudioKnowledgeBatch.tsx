import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import { AlertCircle, BookOpen, CheckCheck, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import { StudioSelectedDocuments } from './StudioSelectedDocuments';
import { StudioFileName } from './StudioControls';
import type { DocumentSummary } from '@/subtitle-studio/ipc-contract';
import type { ErrorCode } from '@/subtitle-studio/domain';
import type { TranslationConfig } from '@/subtitle-studio/translation-contract';
import type { TranslationBatchResult } from '@/subtitle-studio/batch-contract';
import { KNOWLEDGE_BATCH_DOCUMENT_LIMIT, type BatchKnowledgeSelection, type KnowledgeBatchTranslationPreview, type KnowledgeBatchIssue } from '@/subtitle-studio/knowledge-batch-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';

const languages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
const targetLanguage = (language: string) => language === 'zh' ? 'zh-Hans' : language;

// These fences belong to the renderer owner, so a remounted form waits for an
// earlier form's late plan to be disposed before asking for another plan.
let ownerCleanup: Promise<void> | null = null;
let ownerPlanning: Promise<unknown> | null = null;
function cancelOwnerPlan() {
  if (!ownerCleanup) {
    const pendingPlan = ownerPlanning;
    const operation = Promise.resolve().then(async () => {
      await window.subtitleStudio.cancelKnowledgeTranslationBatchPlan({}).catch(() => undefined);
      if (pendingPlan) {
        await pendingPlan.catch(() => undefined);
        await window.subtitleStudio.cancelKnowledgeTranslationBatchPlan({}).catch(() => undefined);
      }
    });
    ownerCleanup = operation;
    void operation.then(() => { if (ownerCleanup === operation) ownerCleanup = null; });
  }
  return ownerCleanup;
}

function Toggle({ label, checked, onChange, disabled, testId }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; testId?: string }) {
  const id = useId();
  return <label htmlFor={id} className="flex min-w-0 items-start gap-2 text-xs leading-5"><Checkbox id={id} data-testid={testId} className="mt-0.5 shrink-0" checked={checked} disabled={disabled} onCheckedChange={value => { if (!disabled) onChange(value === true); }} /><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span></label>;
}
function Choice({ label, value, options, onChange, disabled, testId }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (id: string) => void; disabled?: boolean; testId?: string }) {
  const id = useId();
  return <ToolField label={label} htmlFor={id}><Select value={value} disabled={disabled} onValueChange={next => { if (!disabled) onChange(next); }}><SelectTrigger id={id} data-testid={testId} className="h-auto min-h-8 w-full min-w-0 text-left text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:whitespace-normal [&_[data-slot=select-value]]:[overflow-wrap:anywhere]"><SelectValue /></SelectTrigger><SelectContent className="max-w-[calc(100vw-2rem)]">{options.map(option => <SelectItem key={option.id} value={option.id} className="max-w-[min(36rem,80vw)] whitespace-normal [overflow-wrap:anywhere]">{option.name}</SelectItem>)}</SelectContent></Select></ToolField>;
}
function PagedItems<T>({ items, children, size = 10, disabled = false }: { items: readonly T[]; children: (item: T, index: number) => ReactNode; size?: number; disabled?: boolean }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size)), current = Math.min(page, pages - 1);
  useEffect(() => { setPage(value => Math.min(value, pages - 1)); }, [pages]);
  return <div className="min-w-0 space-y-3">{items.slice(current * size, (current + 1) * size).map((item, index) => children(item, current * size + index))}{pages > 1 && <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground"><span>{t('knowledge:pagination', { count: items.length, page: current + 1, pages })}</span><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={disabled || current === 0} onClick={() => setPage(current - 1)}>{t('knowledge:actions.previous')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled || current + 1 >= pages} onClick={() => setPage(current + 1)}>{t('knowledge:actions.next')}</Button></div></div>}</div>;
}

function BatchIssues({ issues, issueCount, names }: { issues: KnowledgeBatchIssue[]; issueCount: number; names: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  return <div className="min-w-0 space-y-3">
    <p className="text-xs text-muted-foreground">{t('knowledge:batch.issues', { count: issueCount })}</p>
    {issueCount > issues.length && <p className="text-xs text-muted-foreground">{t('knowledge:batch.issues_limited', { shown: issues.length, count: issueCount })}</p>}
    <PagedItems items={[...issues].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))} size={10}>{(issue, index) => {
      const summary = <span>{t(issue.severity === 'error' ? 'knowledge:batch.issue_error' : 'knowledge:batch.issue_warning')} · {t(`knowledge:trial.issue.${issue.code}`)}</span>;
      const className = `min-w-0 text-xs leading-5 [overflow-wrap:anywhere] ${issue.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`;
      return issue.entryIds.length || issue.cueIds.length ? <details key={index} data-issue-code={issue.code} className={className}>
        <summary className="cursor-pointer">{summary}</summary>
        <div className="mt-2 space-y-2 border-l pl-3">
          {issue.entryIds.length > 0 && <p>{issue.entryIds.map(id => names.get(id) ?? t('knowledge:trial.related_entry')).join(' / ')}</p>}
          {issue.cueNumbers.length > 0 && <p>{t('knowledge:batch.cue_references', { ids: issue.cueNumbers.join(' / ') })}</p>}
        </div>
      </details> : <p key={index} data-issue-code={issue.code} className={className}>{summary}</p>;
    }}</PagedItems>
  </div>;
}

type Props = {
  documents: readonly DocumentSummary[];
  config: TranslationConfig;
  apiKey: string;
  disabled: boolean;
  openRequest?: number;
  onStarted: (result: TranslationBatchResult) => void;
  onAdmissionChange: (pending: boolean) => void;
};

/** Shared choices are cue-free. Each checked file owns its frozen execution. */
export function StudioKnowledgeBatch({ documents, config, apiKey, disabled, onStarted, onAdmissionChange, openRequest = 0 }: Props) {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [selection, setSelection] = useState<BatchKnowledgeSelection>({ version: 1, languagePair: { source: '', target: targetLanguage(config.language) }, collectionIds: [], disabledEntryIds: [] });
  const [documentTopicIds, setDocumentTopicIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<KnowledgeBatchTranslationPreview | null>(null);
  const [pending, setPending] = useState<'load' | 'check' | 'start' | null>(null);
  const [error, setError] = useState<ErrorCode | 'library' | null>(null);
  const [notice, setNotice] = useState<'expired' | 'inputs_changed' | 'materials_changed' | null>(null);
  const mounted = useRef(true), active = useRef(false), epoch = useRef(0);
  const pendingRef = useRef<typeof pending>(null), generationRef = useRef<number | null>(null);
  const identity = JSON.stringify([documents.map(item => [item.id, item.revision]), config]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const overLimit = documents.length > KNOWLEDGE_BATCH_DOCUMENT_LIMIT;
  const busy = pending !== null || disabled;
  const activity = (value: typeof pending) => { pendingRef.current = value; if (mounted.current) setPending(value); };
  const isCurrent = (requestEpoch: number, requestIdentity: string) => mounted.current && active.current && epoch.current === requestEpoch && identityRef.current === requestIdentity;
  const invalidate = () => { epoch.current++; setPreview(null); setError(null); setNotice(null); void cancelOwnerPlan(); };
  const update = (patch: Partial<BatchKnowledgeSelection> | ((value: BatchKnowledgeSelection) => Partial<BatchKnowledgeSelection>)) => {
    if (disabled || pendingRef.current || !active.current) return;
    invalidate(); setSelection(value => ({ ...value, ...(typeof patch === 'function' ? patch(value) : patch) }));
  };
  const acceptLibrary = (snapshot: LibrarySnapshot) => {
    const changed = generationRef.current !== null && generationRef.current !== snapshot.generation;
    generationRef.current = snapshot.generation; setLibrary(snapshot);
    if (changed) {
      setPreview(null); setNotice('materials_changed');
      setSelection(value => ({ ...value, disabledEntryIds: [] }));
      void cancelOwnerPlan();
    }
    return changed;
  };
  const close = () => {
    if (pendingRef.current === 'start') return;
    const wasActive = active.current;
    epoch.current++; active.current = false; setOpen(false); setPreview(null); activity(null);
    if (wasActive) void cancelOwnerPlan();
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; if (active.current) void cancelOwnerPlan(); active.current = false; };
  }, []);
  useEffect(() => {
    if (pendingRef.current === 'start') return;
    epoch.current++; setPreview(null); setError(null);
    if (active.current) { setNotice('inputs_changed'); activity(null); void cancelOwnerPlan(); }
    // Undefined instructions inherit the current parent/recipe; an explicit
    // override (including an empty string) belongs to this materials draft.
    setSelection(value => ({ ...value, languagePair: { ...value.languagePair, target: targetLanguage(config.language) } }));
  }, [identity]);
  useEffect(() => {
    if (!open || !preview || pending === 'start') return;
    const timer = window.setTimeout(() => {
      if (pendingRef.current === 'start') return;
      setPreview(null); setNotice('expired'); void cancelOwnerPlan();
    }, Math.max(0, preview.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [open, preview, pending]);

  const begin = async () => {
    if (disabled || overLimit || !documents.length || pendingRef.current || active.current) return;
    active.current = true; setOpen(true); setLibrary(null); setPreview(null); setError(null); setNotice(null); activity('load');
    const requestEpoch = ++epoch.current, requestIdentity = identity;
    try {
      if (ownerCleanup) await ownerCleanup;
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      const result = await window.translationKnowledge.read();
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      if (result.ok) acceptLibrary(result.value); else setError('library');
    } catch { if (isCurrent(requestEpoch, requestIdentity)) setError('library'); }
    finally { if (isCurrent(requestEpoch, requestIdentity)) activity(null); }
  };
  const refreshLibrary = async () => {
    if (disabled || pendingRef.current || !active.current) return;
    invalidate(); activity('load');
    const requestEpoch = epoch.current, requestIdentity = identity;
    try {
      await cancelOwnerPlan();
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      const result = await window.translationKnowledge.read();
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      if (result.ok) acceptLibrary(result.value); else setError('library');
    } catch { if (isCurrent(requestEpoch, requestIdentity)) setError('library'); }
    finally { if (isCurrent(requestEpoch, requestIdentity)) activity(null); }
  };
  const consumedOpenRequest = useRef(0);
  useEffect(() => {
    if (!openRequest || consumedOpenRequest.current === openRequest || disabled || overLimit || !documents.length || pendingRef.current || active.current) return;
    consumedOpenRequest.current = openRequest; void begin();
  }, [openRequest, disabled]);
  const check = async () => {
    if (disabled || pendingRef.current || !active.current || overLimit || !documents.length || !selectionReady) return;
    activity('check'); setPreview(null); setError(null); setNotice(null);
    const requestEpoch = ++epoch.current, requestIdentity = identity;
    try {
      await cancelOwnerPlan();
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      const read = await window.translationKnowledge.read();
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      if (!read.ok) { setError('library'); return; }
      if (acceptLibrary(read.value)) return;
      const promise = window.subtitleStudio.planKnowledgeTranslationBatch({ documents: documents.map(item => ({ documentId: item.id, revision: item.revision })), config, knowledgeGeneration: read.value.generation, knowledge: selection, documentTopicIds });
      ownerPlanning = promise;
      const response = await promise.finally(() => { if (ownerPlanning === promise) ownerPlanning = null; });
      if (!isCurrent(requestEpoch, requestIdentity)) return;
      if (response.ok) setPreview(response.value);
      else if (response.error === 'revision_conflict') {
        const read = await window.translationKnowledge.read();
        if (!isCurrent(requestEpoch, requestIdentity)) return;
        if (!read.ok) setError('library'); else if (!acceptLibrary(read.value)) setNotice('inputs_changed');
      } else setError(response.error);
    } catch { if (isCurrent(requestEpoch, requestIdentity)) setError('translation_failed'); }
    finally { if (isCurrent(requestEpoch, requestIdentity)) activity(null); }
  };
  const start = async () => {
    if (disabled || pendingRef.current || !active.current || !preview?.readyCount || !apiKey.trim() || overLimit) return;
    if (preview.expiresAt <= Date.now()) { invalidate(); setNotice('expired'); return; }
    activity('start'); onAdmissionChange(true); setError(null);
    const requestIdentity = identity;
    try {
      const read = await window.translationKnowledge.read();
      if (!read.ok) { if (mounted.current) setError('library'); return; }
      if (read.value.generation !== preview.knowledgeGeneration) {
        if (mounted.current) acceptLibrary(read.value);
        return;
      }
      if (!mounted.current || !active.current || identityRef.current !== requestIdentity) { void cancelOwnerPlan(); return; }
      const response = await window.subtitleStudio.createKnowledgeTranslationBatch({ planId: preview.planId, apiKey });
      // After submission, every admitted task belongs in the parent result even
      // when document revisions, model settings, or component identity changed.
      if (response.ok) {
        active.current = false;
        if (mounted.current) { setOpen(false); setPreview(null); }
        onStarted(response.value);
      } else if (mounted.current) {
        setPreview(null);
        if (response.error === 'revision_conflict') {
          const read = await window.translationKnowledge.read();
          if (mounted.current) { if (!read.ok) setError('library'); else if (!acceptLibrary(read.value)) setNotice('inputs_changed'); }
        } else setError(response.error);
      }
    } catch { if (mounted.current) { setPreview(null); setError('translation_failed'); } }
    finally {
      onAdmissionChange(false); activity(null);
      if (mounted.current && active.current && identityRef.current !== requestIdentity) { setPreview(null); setNotice('inputs_changed'); void cancelOwnerPlan(); }
    }
  };

  const recipe = library?.data.recipes.find(item => item.id === selection.recipeId);
  const collections = new Set([...selection.collectionIds, ...recipe?.readCollectionIds ?? []]);
  const target = targetLanguage(config.language);
  const recipeLanguageMismatch = !!recipe && recipe.languagePair.target !== target;
  const sourceValid = knowledgeSelectionSchema.shape.languagePair.shape.source.safeParse(selection.languagePair.source).success;
  const targetValid = knowledgeSelectionSchema.shape.languagePair.shape.target.safeParse(target).success;
  const selectionReady = sourceValid && targetValid && !recipeLanguageMismatch && (collections.size > 0 || !!recipe);
  const selectedNames = [...collections].map(id => library?.data.collections.find(item => item.id === id)?.name ?? t('knowledge:automatic.removed_item'));
  const scopedEntries = library?.data.entries.filter(entry => collections.has(entry.collectionId)) ?? [];
  const availableRecipes = library?.data.recipes.filter(item => !item.archived) ?? [];
  const availableCollections = library?.data.collections.filter(item => !item.archived) ?? [];
  const availableSubjects = library?.data.subjects.filter(item => !item.archived) ?? [];
  const entryNames = new Map(library?.data.entries.map(entry => [entry.id, entry.title]) ?? []);
  const readyBatches = preview?.items.reduce((sum, item) => sum + (item.ok && item.plan.canRun ? item.plan.batchCount : 0), 0) ?? 0;
  const formatNumber = (number: number) => number.toLocaleString(i18n.language);

  return <>
    <div className="min-w-0 space-y-2">
      <p data-testid="studio-knowledge-selection-summary" className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{selectedNames.length || recipe ? t('knowledge:selection.summary', { names: [recipe?.name, ...selectedNames].filter(Boolean).join(' · ') }) : t('knowledge:selection.none')}</p>
      <Button ref={trigger} data-testid="studio-knowledge-batch" size="sm" variant="outline" disabled={disabled || busy || overLimit || !documents.length} onClick={() => void begin()}><BookOpen />{t('knowledge:selection.choose')}</Button>
      {overLimit && <p data-testid="knowledge-batch-limit" className="text-xs leading-5 text-muted-foreground">{t('knowledge:batch.limit', { count: documents.length, max: KNOWLEDGE_BATCH_DOCUMENT_LIMIT })}</p>}
    </div>
    <ScrollableDialog open={open} onOpenChange={next => { if (!next) close(); }} maxWidth="sm:max-w-3xl" contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden" onCloseAutoFocus={event => { event.preventDefault(); if (active.current === false && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="p-3">
        <DialogTitle className="text-base">{t('knowledge:batch.title')}</DialogTitle>
        <DialogDescription className="text-xs">{t('knowledge:batch.description', { count: documents.length, max: KNOWLEDGE_BATCH_DOCUMENT_LIMIT })}</DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3" fadeMaskHeight={16}>
        <div data-testid="knowledge-batch-content" aria-busy={busy} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
          <StudioSelectedDocuments documents={documents} />
          <p className="text-xs text-muted-foreground">{t('studio:translation.model')} · {config.model.modelKey}</p>
          {pending === 'load' && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('knowledge:loading')}</p>}
          <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.help')}</p>
          {!sourceValid && <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.source_required')}</p>}
          {!targetValid && <p role="alert" className="text-xs leading-5 text-destructive">{t('knowledge:selection.target_required')}</p>}
          <fieldset disabled={busy || !library} className="min-w-0 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Choice testId="knowledge-batch-source-language" disabled={busy || !library} label={t('knowledge:fields.source_language')} value={selection.languagePair.source || 'unselected'} options={[{ id: 'unselected', name: t('knowledge:automatic.choose_source') }, ...languages.map(id => ({ id, name: t(`knowledge:languages.${id}`) })), ...(selection.languagePair.source && !languages.includes(selection.languagePair.source as typeof languages[number]) ? [{ id: selection.languagePair.source, name: selection.languagePair.source }] : [])]} onChange={value => update(current => ({ languagePair: { ...current.languagePair, source: value === 'unselected' ? '' : value } }))} />
              <ToolField label={t('knowledge:fields.target_language')}><p data-testid="knowledge-batch-target-language" className="flex min-h-8 items-center text-xs">{languages.includes(target as typeof languages[number]) ? t(`knowledge:languages.${target as typeof languages[number]}`) : target}</p><p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.target_help')}</p></ToolField>
            </div>
            <p className="text-xs text-muted-foreground">{t('knowledge:trial.language_help')}</p>
            {(availableRecipes.length > 0 || !!selection.recipeId) && <Choice testId="knowledge-batch-recipe" disabled={busy || !library} label={t('knowledge:trial.recipe')} value={selection.recipeId ?? 'none'} options={[{ id: 'none', name: t('knowledge:trial.no_recipe') }, ...availableRecipes, ...(selection.recipeId && !availableRecipes.some(item => item.id === selection.recipeId) ? [{ id: selection.recipeId, name: t('knowledge:batch.unavailable_recipe') }] : [])]} onChange={id => {
              const chosen = library?.data.recipes.find(item => item.id === id);
              update({ recipeId: chosen?.id, ...(chosen ? { languagePair: { source: chosen.languagePair.source, target } } : {}) });
            }} />}
            {recipeLanguageMismatch && <p role="alert" className="text-xs leading-5 text-destructive">{t('knowledge:selection.recipe_language')}</p>}
            <details data-testid="knowledge-batch-collections" className="min-w-0 rounded-md border p-3" open={!selection.recipeId}>
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.collections')}</summary>
              <div className="mt-3"><PagedItems items={availableCollections} disabled={busy}>{item => <Toggle key={item.id} testId={`knowledge-batch-collection-${item.id}`} label={item.name} checked={collections.has(item.id)} disabled={busy || recipe?.readCollectionIds.includes(item.id)} onChange={checked => update(current => ({ collectionIds: checked ? [...new Set([...current.collectionIds, item.id])] : current.collectionIds.filter(id => id !== item.id) }))} />}</PagedItems></div>
              {library && !availableCollections.length && <div className="mt-2 space-y-2"><p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.empty')}</p><Button asChild variant="outline" size="sm"><Link to="/tools/translation-knowledge">{t('knowledge:selection.manage')}</Link></Button></div>}
            </details>
            {(availableSubjects.length > 0 || documentTopicIds.length > 0) && <details data-testid="knowledge-batch-topics" className="min-w-0 rounded-md border p-3" open>
              <summary className="cursor-pointer text-sm">{t('knowledge:batch.topics', { count: documentTopicIds.length })}</summary>
              <p className="my-3 text-xs leading-5 text-muted-foreground">{t('knowledge:batch.topics_help')}</p>
              <PagedItems items={availableSubjects} disabled={busy}>{subject => <Toggle key={subject.id} testId={`knowledge-batch-topic-${subject.id}`} label={subject.name} checked={documentTopicIds.includes(subject.id)} disabled={busy || documentTopicIds.length >= 20 && !documentTopicIds.includes(subject.id)} onChange={checked => {
                if (pendingRef.current || !active.current) return;
                invalidate(); setDocumentTopicIds(values => checked ? [...new Set([...values, subject.id])] : values.filter(id => id !== subject.id));
              }} />}</PagedItems>
              {!availableSubjects.length && <p className="text-xs text-muted-foreground">{t('knowledge:full.no_topics')}</p>}
            </details>}
            {(availableSubjects.length > 0 || documentTopicIds.length > 0) && <p data-testid="knowledge-batch-scope-help" className="text-xs leading-5 text-muted-foreground">{t('knowledge:batch.scope_help')}</p>}
            <ToolField label={t('knowledge:trial.requirements')} htmlFor={`${formId}-requirements`}><Textarea id={`${formId}-requirements`} data-testid="knowledge-batch-instructions" disabled={busy || !library} className="min-h-16 text-xs" value={selection.instructions ?? (config.instructions || recipe?.instructions || '')} maxLength={4000} onChange={event => update({ instructions: event.target.value })} /></ToolField>
            <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} data-testid="knowledge-batch-context" disabled={busy || !library} className="min-h-16 text-xs" value={selection.context ?? recipe?.context ?? ''} maxLength={4000} onChange={event => update({ context: event.target.value })} /></ToolField>
            {scopedEntries.length > 0 && <details data-testid="knowledge-batch-exclusions" className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.disable')}</summary>
              <div className="mt-3"><PagedItems key={[...collections].join(',')} items={scopedEntries} disabled={busy}>{entry => <Toggle key={entry.id} testId={`knowledge-batch-exclude-${entry.id}`} label={entry.title} checked={selection.disabledEntryIds.includes(entry.id)} disabled={busy} onChange={checked => update(current => ({ disabledEntryIds: checked ? [...new Set([...current.disabledEntryIds, entry.id])] : current.disabledEntryIds.filter(id => id !== entry.id) }))} />}</PagedItems></div>
            </details>}
          </fieldset>
          {notice && <p role="status" data-testid="knowledge-batch-notice" className="text-xs leading-5 text-muted-foreground">{t(notice === 'expired' ? 'knowledge:full.plan_expired' : notice === 'materials_changed' ? 'knowledge:batch.materials_changed' : 'knowledge:batch.inputs_changed')}</p>}
          {error && <p role="alert" className="text-xs leading-5 text-destructive">{error === 'library' ? t('knowledge:batch.library_error') : t(`studio:errors.${error}`)}</p>}
          {preview && <section data-testid="knowledge-batch-preview" className="min-w-0 space-y-3 border-t pt-3">
            <ToolStatBar columns={3} className="studio-translation-estimate shadow-none" gridClassName="studio-translation-estimate-grid" title={t('knowledge:batch.ready_count', { count: preview.readyCount, total: preview.items.length })} icon={preview.readyCount === preview.items.length ? <CheckCheck /> : <AlertCircle />} items={[
              { label: t('studio:translation.estimated_input'), value: formatNumber(preview.totalEstimatedInputTokens) },
              { label: t('studio:translation.batch_count'), value: formatNumber(readyBatches) },
              { label: t('studio:translation.output_reserve'), value: formatNumber(preview.totalOutputTokenReserve) },
            ]} />
            <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:batch.estimate_help')}</p>
            <PagedItems key={preview.planId} items={preview.items} size={5} disabled={busy}>{item => <article key={item.documentId} data-testid={`knowledge-batch-file-${item.documentId}`} data-state={!item.ok ? 'failed' : item.plan.canRun ? 'ready' : 'blocked'} className="min-w-0 rounded-md border p-3">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1 text-sm"><StudioFileName name={item.displayName} focusable /></div><span className={`text-xs ${item.ok && item.plan.canRun ? 'text-muted-foreground' : 'text-destructive'}`}>{t(!item.ok ? 'knowledge:batch.file_failed' : item.plan.canRun ? 'knowledge:batch.file_ready' : 'knowledge:batch.file_blocked')}</span></div>
              {item.ok ? <>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('knowledge:batch.file_summary', { cues: item.plan.cueCount, batches: item.plan.batchCount, entries: item.plan.includedEntryCount })}</p>
                <details className="mt-2" open={!item.plan.canRun}>
                  <summary className="cursor-pointer text-xs">{t('knowledge:batch.file_details', { count: item.plan.issueCount })}</summary>
                  <div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">{t('knowledge:batch.file_usage', { input: formatNumber(item.plan.estimatedInputTokens), output: formatNumber(item.plan.outputTokenReserve), resources: item.plan.resourceCount })}</p><BatchIssues issues={item.plan.issues} issueCount={item.plan.issueCount} names={entryNames} /></div>
                </details>
              </> : <p className="mt-2 text-xs leading-5 text-destructive">{t(`studio:errors.${item.error}`)}</p>}
            </article>}</PagedItems>
            <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:batch.start_help')}</p>
          </section>}
          <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:full.cost_help')}</p>
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button data-testid="knowledge-batch-close" size="sm" variant="ghost" disabled={pending === 'start'} onClick={close}>{t('knowledge:actions.close')}</Button>
        <Button data-testid="knowledge-batch-refresh" size="sm" variant="ghost" disabled={busy} onClick={() => void refreshLibrary()}><RefreshCw />{t('studio:refresh')}</Button>
        <Button data-testid="knowledge-batch-check" size="sm" variant="outline" disabled={busy || !library || overLimit || !documents.length || !selectionReady} onClick={() => void check()}>{pending === 'check' && <LoaderCircle className="animate-spin" />}{t('knowledge:batch.check')}</Button>
        <Button data-testid="knowledge-batch-run" size="sm" disabled={busy || !preview?.readyCount || !apiKey.trim() || overLimit} onClick={() => void start()}>{pending === 'start' && <LoaderCircle className="animate-spin" />}{t(pending === 'start' ? 'knowledge:batch.starting' : 'knowledge:batch.run', { count: preview?.readyCount ?? 0 })}</Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
