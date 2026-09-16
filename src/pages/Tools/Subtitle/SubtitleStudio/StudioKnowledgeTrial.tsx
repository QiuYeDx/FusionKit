import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { TranslationConfig } from '@/subtitle-studio/translation-contract';
import type { KnowledgeTrialPreview, KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import type { KnowledgeTranslationPreview } from '@/subtitle-studio/knowledge-translation-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeSelection, KnowledgeIssue, KnowledgeIssueCode } from '@/translation-knowledge/execution-contract';
import type { AutomaticKnowledgeRecheckRequest } from './automatic-knowledge-recheck';

const issueKeys = {
  selection_invalid: 'knowledge:trial.issue.selection_invalid', resource_limit: 'knowledge:trial.issue.resource_limit', resource_missing: 'knowledge:trial.issue.resource_missing', resource_archived: 'knowledge:trial.issue.resource_archived',
  style_unavailable: 'knowledge:trial.issue.style_unavailable', language_mismatch: 'knowledge:trial.issue.language_mismatch', untrusted: 'knowledge:trial.issue.untrusted', unsupported_kind: 'knowledge:trial.issue.unsupported_kind',
  subject_unbound: 'knowledge:trial.issue.subject_unbound', speaker_conflict: 'knowledge:trial.issue.speaker_conflict', condition_unconfirmed: 'knowledge:trial.issue.condition_unconfirmed', disabled: 'knowledge:trial.issue.disabled',
  no_match: 'knowledge:trial.issue.no_match', term_conflict: 'knowledge:trial.issue.term_conflict', rule_conflict: 'knowledge:trial.issue.rule_conflict', budget_excluded: 'knowledge:trial.issue.budget_excluded',
  budget_required: 'knowledge:trial.issue.budget_required', preferences_not_applied: 'knowledge:trial.issue.preferences_not_applied', required_term_suspect: 'knowledge:trial.issue.required_term_suspect',
} as const satisfies Record<KnowledgeIssueCode, string>;
const languages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
// A remounted form must finish the previous owner's late-plan cleanup first.
let ownerClosing: Promise<void> | null = null;
let ownerPlanning: Promise<unknown> | null = null;
function cancelOwnerKnowledgeSession() {
  if (!ownerClosing) {
    const pendingPlan = ownerPlanning;
    const operation = Promise.resolve().then(async () => {
      await Promise.allSettled([window.subtitleStudio.cancelKnowledgeTrial({}), window.subtitleStudio.cancelKnowledgeTranslationPlan({})]);
      if (pendingPlan) {
        await pendingPlan.catch(() => undefined);
        await Promise.allSettled([window.subtitleStudio.cancelKnowledgeTrial({}), window.subtitleStudio.cancelKnowledgeTranslationPlan({})]);
      }
    });
    ownerClosing = operation;
    void operation.then(() => { if (ownerClosing === operation) ownerClosing = null; });
  }
  return ownerClosing;
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

/** A file-scoped draft. Only explicit full-document admission creates a track. */
export function StudioKnowledgeTrial({ page, config, apiKey, disabled, onStarted, onAdmissionChange, recheckRequest, modelNeedsAttention }: { page: DocumentPage; config: TranslationConfig; apiKey: string; disabled: boolean; onStarted: (taskId: string) => void; onAdmissionChange: (pending: boolean) => void; recheckRequest?: AutomaticKnowledgeRecheckRequest; modelNeedsAttention?: boolean }) {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'trial' | 'document'>('trial');
  const [documentTopicIds, setDocumentTopicIds] = useState<string[]>([]);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [selection, setSelection] = useState<KnowledgeSelection>({ version: 1, languagePair: { source: 'ja', target: config.language === 'zh' ? 'zh-Hans' : languages.includes(config.language as typeof languages[number]) ? config.language : 'zh-Hans' }, collectionIds: [], bindings: [], confirmations: [], disabledEntryIds: [] });
  const [explicitCues, setExplicitCues] = useState<string[]>([]);
  const [scopeCues, setScopeCues] = useState<Array<{ id: string; text: string }>>([]);
  const [preview, setPreview] = useState<KnowledgeTrialPreview | null>(null);
  const [documentPreview, setDocumentPreview] = useState<KnowledgeTranslationPreview | null>(null);
  const [result, setResult] = useState<KnowledgeTrialResult | null>(null);
  const [pending, setPending] = useState<'load' | 'check' | 'run' | 'cancel' | 'start' | null>(null);
  const [error, setError] = useState(false);
  const [planExpired, setPlanExpired] = useState(false);
  const [materialsChanged, setMaterialsChanged] = useState(false);
  const [inputsChanged, setInputsChanged] = useState(false);
  const epoch = useRef(0), mounted = useRef(true), active = useRef(false);
  const pendingRef = useRef<typeof pending>(null);
  const consumedRecheck = useRef<string | null>(null);
  const libraryGeneration = useRef<number | null>(null);
  const identity = JSON.stringify([page.summary.id, page.summary.revision, config]);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const isBusy = pending !== null || disabled;
  const activity = (value: typeof pending) => { pendingRef.current = value; if (mounted.current) setPending(value); };
  const invalidate = () => { epoch.current++; setPreview(null); setDocumentPreview(null); setResult(null); setError(false); setPlanExpired(false); setMaterialsChanged(false); setInputsChanged(false); void cancelClosedSession(); };
  const acceptLibrary = (snapshot: LibrarySnapshot): boolean => {
    const changed = libraryGeneration.current !== null && libraryGeneration.current !== snapshot.generation;
    libraryGeneration.current = snapshot.generation;
    setLibrary(snapshot);
    const existingIds = new Set(snapshot.data.entries.map(entry => entry.id));
    if (changed) { setPreview(null); setDocumentPreview(null); setResult(null); setMaterialsChanged(true); void cancelClosedSession(); }
    setSelection(value => ({
      ...value,
      // Shared exclusions survive library changes; missing choices stay visible for repair.
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
  const cancelClosedSession = cancelOwnerKnowledgeSession;
  const close = () => {
    // Admission may already have persisted a real task. Its response owns the handoff.
    if (pendingRef.current === 'start') return;
    const wasActive = active.current;
    epoch.current++; active.current = false; setOpen(false); activity(null);
    if (wasActive) void cancelClosedSession();
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; if (active.current) void cancelClosedSession(); active.current = false; }; }, []);
  const previousInputs = useRef({ documentId: page.summary.id, revision: page.summary.revision, config: JSON.stringify(config) });
  useEffect(() => {
    const previous = previousInputs.current;
    previousInputs.current = { documentId: page.summary.id, revision: page.summary.revision, config: JSON.stringify(config) };
    if (pendingRef.current === 'start') return;
    if (previous.documentId === page.summary.id && previous.revision === page.summary.revision && previous.config === JSON.stringify(config)) return;
    if (previous.documentId !== page.summary.id) {
      if (active.current) close();
      setScopeCues([]); setExplicitCues([]); setDocumentTopicIds([]);
      setSelection(value => ({ ...value, bindings: [], confirmations: [], disabledEntryIds: [] }));
    } else {
      if (active.current) { invalidate(); activity(null); setInputsChanged(true); }
      // Source edits invalidate cue-specific authority, never shared choices or user text.
      if (previous.revision !== page.summary.revision) {
        setScopeCues([]); setExplicitCues([]);
        setSelection(value => ({ ...value, bindings: [], confirmations: [] }));
      }
    }
    setPreview(null); setDocumentPreview(null); setResult(null);
  }, [identity]);
  const currentPreview = mode === 'document' ? documentPreview : preview;
  useEffect(() => {
    if (!open || !currentPreview || pending === 'start' || pending === 'run' || pending === 'cancel') return;
    const timer = window.setTimeout(() => {
      if (pendingRef.current === 'start' || pendingRef.current === 'run' || pendingRef.current === 'cancel') return;
      setPreview(null); setDocumentPreview(null); setPlanExpired(true); void cancelClosedSession();
    }, Math.max(0, currentPreview.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [open, currentPreview, pending]);
  const begin = async (request?: AutomaticKnowledgeRecheckRequest) => {
    if (disabled || pendingRef.current || active.current) return;
    active.current = true; setOpen(true); setMode(recheckRequest ? 'document' : 'trial'); activity('load'); setLibrary(null); setError(false); setPlanExpired(false); setMaterialsChanged(false); setInputsChanged(false); setPreview(null); setDocumentPreview(null); setResult(null);
    if (request) {
      setSelection({ ...structuredClone(request.seed.selection), bindings: [], confirmations: [] });
      setDocumentTopicIds([...request.seed.documentTopicIds]); setExplicitCues([]); setScopeCues([]);
    }
    const revision = ++epoch.current;
    try {
      if (ownerClosing) await ownerClosing;
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
  useEffect(() => {
    if (!recheckRequest || consumedRecheck.current === recheckRequest.requestId || recheckRequest.documentId !== page.summary.id || disabled || pendingRef.current || active.current) return;
    consumedRecheck.current = recheckRequest.requestId;
    void begin(recheckRequest);
  }, [recheckRequest, disabled]);
  const refreshLibrary = async () => {
    if (pendingRef.current || !active.current) return;
    invalidate(); activity('load');
    const revision = epoch.current, requestIdentity = identity;
    try {
      await cancelClosedSession();
      if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
      const response = await window.translationKnowledge.read();
      if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
      if (response.ok) acceptLibrary(response.value); else setError(true);
    } catch { if (mounted.current && epoch.current === revision) setError(true); }
    finally { if (mounted.current && epoch.current === revision) activity(null); }
  };
  const check = async () => {
    if (disabled || pendingRef.current || !active.current || !library || unavailableSelections) return;
    activity('check'); setError(false); setPlanExpired(false); setMaterialsChanged(false); setResult(null); setPreview(null); setDocumentPreview(null);
    const revision = ++epoch.current, requestIdentity = identity;
    try {
      await cancelClosedSession();
      if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
      const request = { documentId: page.summary.id, revision: page.summary.revision, knowledgeGeneration: library.generation, config, knowledge: selection };
      const requestPromise = mode === 'document'
        ? window.subtitleStudio.planKnowledgeTranslation({ ...request, documentTopicIds })
        : window.subtitleStudio.planKnowledgeTrial({ ...request, ...(explicitCues.length ? { cueIds: explicitCues } : {}) });
      ownerPlanning = requestPromise;
      const response = await requestPromise.finally(() => { if (ownerPlanning === requestPromise) ownerPlanning = null; });
      if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
      if (response.ok) {
        if ('cues' in response.value) { setPreview(response.value); setScopeCues(response.value.cues); }
        else setDocumentPreview(response.value);
      }
      else if (response.error === 'revision_conflict') {
        const current = await window.translationKnowledge.read();
        if (!mounted.current || epoch.current !== revision || currentIdentity.current !== requestIdentity) return;
        if (!current.ok || !acceptLibrary(current.value)) setError(true);
      } else setError(true);
    } catch { if (mounted.current && epoch.current === revision) setError(true); }
    finally { if (mounted.current && epoch.current === revision) activity(null); }
  };
  const startDocument = async () => {
    if (disabled || pendingRef.current || !active.current || !documentPreview?.canRun || !apiKey.trim() || unavailableSelections) return;
    if (documentPreview.expiresAt <= Date.now()) { invalidate(); setPlanExpired(true); return; }
    activity('start'); onAdmissionChange(true); setError(false);
    const requestIdentity = identity;
    try {
      const current = await window.translationKnowledge.read();
      if (!current.ok) { if (mounted.current) setError(true); return; }
      if (current.value.generation !== libraryGeneration.current) {
        if (mounted.current) acceptLibrary(current.value);
        return;
      }
      if (!mounted.current || !active.current || currentIdentity.current !== requestIdentity) { void cancelClosedSession(); return; }
      const response = await window.subtitleStudio.createKnowledgeTranslation({ planId: documentPreview.planId, apiKey });
      // A document update or unmount must never discard an admitted task ID.
      if (response.ok) {
        active.current = false;
        if (mounted.current) { setOpen(false); setPreview(null); setDocumentPreview(null); setResult(null); }
        onStarted(response.value.taskId);
      } else if (mounted.current) {
        setDocumentPreview(null);
        if (response.error === 'revision_conflict') {
          const snapshot = await window.translationKnowledge.read();
          if (mounted.current && (!snapshot.ok || !acceptLibrary(snapshot.value))) setPlanExpired(true);
        } else setError(true);
      }
    } catch { if (mounted.current) { setDocumentPreview(null); setError(true); } }
    finally {
      onAdmissionChange(false); activity(null);
      if (mounted.current && currentIdentity.current !== requestIdentity && active.current) close();
    }
  };
  const run = async () => {
    if (disabled || pendingRef.current || !active.current || !preview?.canRun || !apiKey.trim() || unavailableSelections) return;
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
  const unavailableName = (name?: string) => t('knowledge:automatic.unavailable_item', { name: name ?? t('knowledge:automatic.removed_item') });
  const collectionChoices = availableCollections.map(item => ({ id: item.id, name: item.name }));
  for (const id of selectedCollections) if (!collectionChoices.some(item => item.id === id)) collectionChoices.push({ id, name: unavailableName(library?.data.collections.find(item => item.id === id)?.name) });
  const topicChoices = availableSubjects.map(item => ({ id: item.id, name: item.name }));
  for (const id of documentTopicIds) if (!topicChoices.some(item => item.id === id)) topicChoices.push({ id, name: unavailableName(library?.data.subjects.find(item => item.id === id)?.name) });
  const recipeChoices = (library?.data.recipes.filter(item => !item.archived) ?? []).map(item => ({ id: item.id, name: item.name }));
  if (selection.recipeId && !recipeChoices.some(item => item.id === selection.recipeId)) recipeChoices.push({ id: selection.recipeId, name: unavailableName(selectedRecipe?.name) });
  const entryChoices = scopedEntries.map(entry => ({ id: entry.id, name: entry.title }));
  for (const id of selection.disabledEntryIds) if (!entryChoices.some(item => item.id === id)) entryChoices.push({ id, name: unavailableName(names.get(id)) });
  const unavailableSelections = !!library && (
    !!selection.recipeId && (!selectedRecipe || selectedRecipe.archived)
    || [...selectedCollections].some(id => !availableCollections.some(item => item.id === id))
    || documentTopicIds.some(id => !availableSubjects.some(item => item.id === id))
    || selection.disabledEntryIds.some(id => !scopedEntries.some(item => item.id === id)));
  const previewItems = preview?.batches.flatMap(batch => batch.knowledge.items.map(item => ({ key: `${batch.id}:${item.entryId}`, item }))) ?? [];
  const issueCueDetails = new Map((preview?.cues ?? scopeCues).map((cue, index) => [cue.id, { text: cue.text, number: index + 1 }]));
  if (mode === 'document') for (const [index, cue] of page.cues.entries()) issueCueDetails.set(cue.id, { text: cue.source.plain, number: page.offset + index + 1 });
  for (const [index, item] of (result?.items ?? []).entries()) if (!issueCueDetails.has(item.cueId)) issueCueDetails.set(item.cueId, { text: item.source, number: index + 1 });
  const issues = (values: KnowledgeIssue[]) => <PagedItems items={values} size={20}>{(value, index) => {
    const summary = `${t(issueKeys[value.code])}${value.entryIds.length ? ` · ${value.entryIds.map(id => names.get(id) ?? t('knowledge:trial.related_entry')).join(' / ')}` : ''}${value.cueIds.length ? ` · ${t('knowledge:trial.cues_count', { count: value.cueIds.length })}` : ''}`;
    const className = `[overflow-wrap:anywhere] text-xs ${value.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`;
    return value.cueIds.length ? <details key={index} data-issue-code={value.code} className={className}>
      <summary className="cursor-pointer">{summary}</summary>
      <div className="mt-2 space-y-2 border-l pl-3">{value.cueIds.map(id => {
        const cue = issueCueDetails.get(id);
        return <p key={id} data-cue-id={id} className="whitespace-pre-wrap">{cue ? `${cue.number}. ${cue.text}` : t('knowledge:full.other_page_cue', { id })}</p>;
      })}</div>
    </details> : <p key={index} className={className}>{summary}</p>;
  }}</PagedItems>;
  return <>
    <Button data-testid="studio-knowledge-trial" size="sm" variant="outline" disabled={disabled || isBusy} onClick={() => void begin()}><BookOpen />{t(recheckRequest ? 'knowledge:recovery.recheck' : 'knowledge:trial.open')}</Button>
    <ScrollableDialog open={open} onOpenChange={next => { if (!next) close(); }} maxWidth="sm:max-w-3xl" contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden">
      <ScrollableDialogHeader className="p-3"><DialogTitle className="text-base">{t(mode === 'document' ? 'knowledge:full.title' : 'knowledge:trial.title')}</DialogTitle><DialogDescription className="text-xs">{t(mode === 'document' ? 'knowledge:full.description' : 'knowledge:trial.description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3" fadeMaskHeight={16}>
        <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]" data-testid="knowledge-trial-content" aria-busy={isBusy}>
          <p className="text-xs text-muted-foreground">{page.summary.origin.displayName} · {config.model.modelKey}</p>
          {recheckRequest && <p data-testid="knowledge-recheck-help" className="text-xs leading-5 text-muted-foreground">{t('knowledge:recovery.form_help')}</p>}
          {recheckRequest && modelNeedsAttention && <div className="space-y-2 rounded-md border p-3"><p className="text-xs leading-5 text-muted-foreground">{t('knowledge:recovery.model_changed')}</p><Button data-testid="knowledge-recheck-edit-model" size="sm" variant="outline" disabled={isBusy} onClick={close}>{t('knowledge:recovery.edit_model')}</Button></div>}
          {pending === 'load' && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 shrink-0 animate-spin" />{t('knowledge:loading')}</p>}
          <fieldset disabled={isBusy} className="min-w-0 space-y-4">
            {!recheckRequest && <RadioGroup data-testid="knowledge-translation-mode" value={mode} disabled={isBusy} aria-label={t('knowledge:full.mode')} className="flex flex-wrap gap-x-6 gap-y-2" onValueChange={next => {
              if (pendingRef.current || !active.current || next !== 'trial' && next !== 'document') return;
              invalidate(); setMode(next);
            }}>
              <label className="flex items-center gap-2 text-xs" htmlFor={`${formId}-trial`}><RadioGroupItem id={`${formId}-trial`} value="trial" />{t('knowledge:full.mode_trial')}</label>
              <label className="flex items-center gap-2 text-xs" htmlFor={`${formId}-document`}><RadioGroupItem data-testid="knowledge-full-mode" id={`${formId}-document`} value="document" />{t('knowledge:full.mode_document')}</label>
            </RadioGroup>}
            <div className="grid gap-4 sm:grid-cols-2">{(['source', 'target'] as const).map(side => <Choice key={side} testId={`knowledge-trial-${side}-language`} disabled={isBusy} label={t(side === 'source' ? 'knowledge:fields.source_language' : 'knowledge:fields.target_language')} value={selection.languagePair[side]} options={[...languages.map(id => ({ id, name: t(`knowledge:languages.${id}`) })), ...(!languages.includes(selection.languagePair[side] as typeof languages[number]) ? [{ id: selection.languagePair[side], name: selection.languagePair[side] }] : [])]} onChange={value => update(current => ({ languagePair: { ...current.languagePair, [side]: value } }))} />)}</div>
            <p className="text-xs text-muted-foreground">{t('knowledge:trial.language_help')}</p>
            <Choice testId="knowledge-trial-recipe" disabled={isBusy} label={t('knowledge:trial.recipe')} value={selection.recipeId ?? 'none'} options={[{ id: 'none', name: t('knowledge:trial.no_recipe') }, ...recipeChoices]} onChange={id => {
              const recipe = library?.data.recipes.find(item => item.id === id);
              update({ recipeId: recipe?.id, ...(recipe ? { languagePair: recipe.languagePair } : {}), bindings: [], confirmations: [] });
            }} />
            <details className="min-w-0 rounded-md border p-3" open={!selection.recipeId}>
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.collections')}</summary>
              <div className="mt-3"><PagedItems items={collectionChoices} disabled={isBusy}>{item => <Toggle key={item.id} testId={`knowledge-trial-collection-${item.id}`} label={item.name} checked={selectedCollections.has(item.id)} disabled={isBusy || selectedRecipe?.readCollectionIds.includes(item.id)} onChange={checked => update(current => ({ collectionIds: checked ? [...new Set([...current.collectionIds, item.id])] : current.collectionIds.filter(id => id !== item.id) }))} />}</PagedItems></div>
              {!collectionChoices.length && <p className="mt-2 text-xs text-muted-foreground">{t('knowledge:trial.empty')}</p>}
            </details>
            {mode === 'document' && <details data-testid="knowledge-document-topics" className="min-w-0 rounded-md border p-3" open>
              <summary className="cursor-pointer text-sm">{t('knowledge:full.topics', { count: documentTopicIds.length })}</summary>
              <p className="my-3 text-xs leading-5 text-muted-foreground">{t('knowledge:full.topics_help')}</p>
              <PagedItems items={topicChoices} disabled={isBusy}>{subject => <Toggle key={subject.id} testId={`knowledge-document-topic-${subject.id}`} label={subject.name} checked={documentTopicIds.includes(subject.id)} disabled={isBusy || documentTopicIds.length >= 20 && !documentTopicIds.includes(subject.id)} onChange={checked => {
                if (pendingRef.current || !active.current) return;
                invalidate(); setDocumentTopicIds(values => checked ? [...new Set([...values, subject.id])] : values.filter(id => id !== subject.id));
              }} />}</PagedItems>
              {!topicChoices.length && <p className="text-xs text-muted-foreground">{t('knowledge:full.no_topics')}</p>}
            </details>}
            {mode === 'document' && <p data-testid="knowledge-full-scope-help" className="text-xs leading-5 text-muted-foreground">{t(recheckRequest ? 'knowledge:recovery.scope_help' : 'knowledge:full.scope_help')}</p>}
            {mode === 'trial' && <details className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.choose_cues', { count: 20 })}</summary>
              <p className="my-2 text-xs text-muted-foreground">{t('knowledge:trial.cues_help')}</p>
              <PagedItems<DocumentPage['cues'][number]> items={page.cues} disabled={isBusy}>{(cue, index) => <Toggle key={cue.id} label={`${page.offset + index + 1}. ${cue.source.plain}`} checked={explicitCues.includes(cue.id)} disabled={isBusy || !/\S/u.test(cue.source.plain) || explicitCues.length >= 20 && !explicitCues.includes(cue.id)} onChange={checked => {
                if (pendingRef.current || !active.current) return;
                invalidate(); setExplicitCues(values => checked ? [...new Set([...values, cue.id])] : values.filter(id => id !== cue.id)); setScopeCues([]); setSelection(value => ({ ...value, bindings: [], confirmations: [] }));
              }} />}</PagedItems>
            </details>}
            <ToolField label={t('knowledge:trial.requirements')} htmlFor={`${formId}-requirements`}><Textarea id={`${formId}-requirements`} data-testid="knowledge-trial-instructions" disabled={isBusy} className="min-h-16 text-xs" value={selection.instructions ?? (config.instructions || selectedRecipe?.instructions || '')} maxLength={4000} onChange={event => update({ instructions: event.target.value })} /></ToolField>
            <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} data-testid="knowledge-trial-context" disabled={isBusy} className="min-h-16 text-xs" value={selection.context ?? selectedRecipe?.context ?? ''} maxLength={4000} onChange={event => update({ context: event.target.value })} /></ToolField>
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
            {entryChoices.length > 0 && <details data-testid="knowledge-trial-exclusions" className="min-w-0 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.disable')}</summary><div className="mt-3"><PagedItems key={[...selectedCollections].join(',')} items={entryChoices} disabled={isBusy}>{entry => <Toggle key={entry.id} testId={`knowledge-trial-exclude-${entry.id}`} label={entry.name} disabled={isBusy} checked={selection.disabledEntryIds.includes(entry.id)} onChange={checked => update(current => ({ disabledEntryIds: checked ? [...new Set([...current.disabledEntryIds, entry.id])] : current.disabledEntryIds.filter(id => id !== entry.id) }))} />}</PagedItems></div>
            </details>}
          </fieldset>
          {materialsChanged && <p role="status" data-testid="knowledge-trial-materials-changed" className="text-xs text-muted-foreground">{t('knowledge:trial.materials_changed')}</p>}
          {planExpired && <p role="status" className="text-xs text-muted-foreground">{t('knowledge:full.plan_expired')}</p>}
          {inputsChanged && <p data-testid="knowledge-recheck-inputs-changed" role="status" className="text-xs text-muted-foreground">{t('knowledge:recovery.inputs_changed')}</p>}
          {unavailableSelections && <p data-testid="knowledge-recheck-unavailable" role="status" className="text-xs text-destructive">{t('knowledge:recovery.selection_unavailable')}</p>}
          {error && <p role="alert" className="text-xs text-destructive">{t('knowledge:trial.error')}</p>}
          {documentPreview && <section data-testid="knowledge-full-preview" className="min-w-0 space-y-3 border-t pt-3">
            <ToolStatBar columns={3} title={t(documentPreview.canRun ? 'knowledge:full.ready' : 'knowledge:full.needs_attention')} className="studio-translation-estimate shadow-none" gridClassName="[&>div>div:first-child>span]:whitespace-normal [&>div>div:first-child>span]:[overflow-wrap:anywhere] [&>div>div:first-child]:normal-case [&>div>div:first-child]:tracking-normal" items={[
              { label: t('knowledge:full.cue_count'), value: documentPreview.cueCount.toLocaleString(i18n.language) },
              { label: t('studio:translation.batch_count'), value: documentPreview.batchCount.toLocaleString(i18n.language) },
              { label: t('studio:translation.estimated_input'), value: documentPreview.estimatedInputTokens.toLocaleString(i18n.language) },
              { label: t('studio:translation.output_reserve'), value: documentPreview.outputTokenReserve.toLocaleString(i18n.language) },
              { label: t('knowledge:full.resource_count'), value: documentPreview.resourceCount.toLocaleString(i18n.language) },
              { label: t('knowledge:full.entry_count'), value: documentPreview.includedEntryCount.toLocaleString(i18n.language) },
            ]} />
            {issues(documentPreview.issues)}
            <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:full.start_help')}</p>
          </section>}
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
          <p className="text-xs text-muted-foreground">{t(mode === 'document' ? 'knowledge:full.cost_help' : 'knowledge:trial.cost_help')}</p>
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button data-testid="knowledge-trial-close" size="sm" variant="ghost" disabled={pending === 'start'} onClick={close}>{t('knowledge:actions.close')}</Button>
        {pending === 'run' || pending === 'cancel' ? <Button size="sm" variant="outline" disabled={pending === 'cancel'} onClick={() => void cancel()}><LoaderCircle className="animate-spin" />{t('knowledge:trial.cancel')}</Button> : <>
          <Button data-testid="knowledge-trial-refresh" size="sm" variant="ghost" disabled={isBusy} onClick={() => void refreshLibrary()}><RefreshCw />{t('studio:refresh')}</Button>
          <Button data-testid={mode === 'document' ? 'knowledge-full-check' : 'knowledge-trial-check'} size="sm" variant="outline" disabled={isBusy || !library || unavailableSelections} onClick={() => void check()}>{pending === 'check' && <LoaderCircle className="animate-spin" />}{t(mode === 'document' ? 'knowledge:full.check' : 'knowledge:trial.check')}</Button>
          <Button data-testid={mode === 'document' ? 'knowledge-full-run' : 'knowledge-trial-run'} size="sm" disabled={isBusy || !currentPreview?.canRun || !apiKey.trim() || unavailableSelections} onClick={() => void (mode === 'document' ? startDocument() : run())}>{pending === 'start' && <LoaderCircle className="animate-spin" />}{t(mode === 'document' ? pending === 'start' ? 'knowledge:full.starting' : 'knowledge:full.run' : 'knowledge:trial.run')}</Button>
        </>}
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
