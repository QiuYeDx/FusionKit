import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, BookOpen, Check, Combine, LoaderCircle, RotateCcw, ScanSearch, Settings, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import useModelStore from '@/store/useModelStore';
import { inferMaxOutputTokens } from '@/constants/model';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, StudioResult } from '@/subtitle-studio/ipc-contract';
import { CUE_BATCH_LIMIT, CUE_EDIT_LIMIT, editedText, type CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { findAdjacentDuplicates, revisionOperation, structureCueIds, structureKey, type CueStructureProposal } from '@/subtitle-studio/cue-structure';
import {
  CUE_REVISION_CHUNK, CUE_REVISION_CONFIRM_ABOVE, CUE_REVISION_DOCUMENT_LIMIT, CUE_REVISION_INSTRUCTIONS_LIMIT, CUE_REVISION_LIMIT, revisesSource, revisesTarget,
  type CueRevisionFields, type CueRevisionHint, type CueRevisionLocation, type CueRevisionProposal, type CueRevisionResult,
} from '@/subtitle-studio/cue-revision-contract';
import { translationModelSchema, type TranslationUsage } from '@/subtitle-studio/translation-contract';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { hasMaterials, translationDraftMemory } from '@/services/subtitle-studio/translation-draft';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { appliedHints, materialNames, mergeHints } from './knowledge-hints';
import { diffText } from '@/services/subtitle-studio/text-diff';
import { currentEntry, type CueTrack } from './StudioCueMenu';
import { formatStudioTime } from './StudioControls';
import './StudioCueRevision.css';

const errorKeys = {
  invalid_input: 'studio:errors.invalid_input',
  unsupported_feature: 'studio:errors.unsupported_feature',
  encoding_required: 'studio:errors.encoding_required',
  limit_exceeded: 'studio:cue_revision.errors.too_many',
  revision_conflict: 'studio:cue_revision.errors.revision_conflict',
  access_denied: 'studio:errors.access_denied',
  document_unavailable: 'studio:cue_revision.errors.apply_failed',
  output_write_failed: 'studio:errors.output_write_failed',
  knowledge_check_failed: 'studio:errors.knowledge_check_failed',
  needs_configuration: 'studio:errors.needs_configuration',
  translation_protocol_invalid: 'studio:cue_revision.errors.protocol_invalid',
  translation_record_unavailable: 'studio:errors.translation_record_unavailable',
  translation_output_limit: 'studio:cue_revision.errors.output_limit',
  translation_failed: 'studio:cue_revision.errors.failed',
  transcription_failed: 'studio:errors.transcription_failed',
  resource_busy: 'studio:cue_edit.blocked_translation',
  interrupted: 'studio:errors.interrupted',
} as const satisfies Record<ErrorCode, string>;
const fieldKeys = { source: 'studio:cue_revision.fields.source', target: 'studio:cue_revision.fields.target', both: 'studio:cue_revision.fields.both' } as const;
/** Kept for the session so that repeated revisions start where the last one ended. */
const memory: { fields?: CueRevisionFields; profileId?: string } = {};
const MAX_NOTES = 3;

type Scope = 'selection' | 'document';
/** Ways to find the lines without asking the model first, such as wording the agent already knows. */
export type CueRevisionSearch = { terms: string[] } | { lines: number[] };
/** A request prepared elsewhere (the assistant): the dialog fills it in and starts generating. */
export type CueRevisionPreset = { instructions: string; scope: Scope; fields?: CueRevisionFields; search?: CueRevisionSearch;
  /**
   * `duplicates` checks for repeated neighbours instead of asking the model; `prepared` shows the
   * given structure proposals (made by the assistant from the user's words) without asking the model.
   */
  mode?: 'duplicates' | 'prepared';
  structure?: CueStructureProposal[];
  /** Called after the user applies the previewed revision, with the wordings it settled and the structural changes. */
  onApplied?: (count: number, hints: CueRevisionHint[], changes: StructureCounts) => void };
/** Structural changes in a revision: cues merged away, deleted and retimed. */
export type StructureCounts = { merges: number; deletes: number; timings: number };
const countStructure = (structure: readonly CueStructureProposal[]): StructureCounts => ({
  merges: structure.filter(item => item.kind === 'merge').length, deletes: structure.filter(item => item.kind === 'delete').length, timings: structure.filter(item => item.kind === 'timing').length });
/** How a preset run ended; reported once. Applying stays with the user in the dialog. */
export type CueRevisionOutcome =
  | { status: 'ready'; checked: number; proposals: number; notes: string[]; plan?: CueRevisionLocation['plan']; knowledgeHints?: CueRevisionHint[]; structure?: StructureCounts }
  | { status: 'needs_confirmation'; count: number; plan: CueRevisionLocation['plan'] }
  | { status: 'failed'; error: ErrorCode }
  | { status: 'cancelled' };
export type CueRevisionRequestState = {
  /** The selected cues; empty when the revision was opened for the whole document. */
  cueIds: string[];
  serial: number;
  preset?: CueRevisionPreset;
  onSettled?: (outcome: CueRevisionOutcome) => void;
};
type RunProgress = { stage: 'locating' } | { stage: 'revising'; done: number; total: number };
type Outcome = Omit<CueRevisionResult, 'trackId'> & { checked: number; location?: CueRevisionLocation;
  /** How the proposals were made, for the summary: by the model, by the duplicate check, or by the assistant. */
  origin?: 'duplicates' | 'prepared' };
/** The texts a structure proposal shows for one cue. */
const structureText = (current: { source: { plain: string }; target?: { plain: string } }) => current.source.plain;

function addUsage(total: TranslationUsage, usage: TranslationUsage) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) total[key] = total[key] === null || usage[key] === null ? null : total[key]! + usage[key]!;
}

function Diff({ before, after }: { before: string; after: string }) {
  return <>{diffText(before, after).map((part, index) => part.kind === 'same' ? <span key={index}>{part.text}</span>
    : part.kind === 'added' ? <ins key={index}>{part.text}</ins> : <del key={index}>{part.text}</del>)}</>;
}

/** How a document-wide revision found its lines, shown above the proposals. */
function PlanSummary({ location }: { location: CueRevisionLocation }) {
  const { t } = useTranslation();
  const { plan } = location;
  return <div className="studio-cue-revision-plan" data-testid="studio-cue-revision-plan" title={plan.note}>
    <ScanSearch />
    {plan.strategy === 'terms' ? <span>
      {t('studio:cue_revision.plan.terms')}
      {plan.terms.map(term => <span key={term} className="studio-cue-revision-term">{term}</span>)}
      {t('studio:cue_revision.plan.found', { count: location.cueIds.length })}
    </span> : plan.strategy === 'lines' ? <span>{t('studio:cue_revision.plan.lines', { lines: plan.lines.join(', ') })}</span>
      : <span>{t('studio:cue_revision.plan.all', { count: location.cueIds.length })}</span>}
  </div>;
}

/**
 * Revises cues from a request in plain words, such as "line 3 should say …"
 * or "the recognizer wrote X for Y throughout". For the selection the model
 * reads those cues; for the whole document it first decides how to find the
 * lines (wording and likely mis-transcriptions, line numbers, or every line),
 * the app searches locally, and the found lines are revised in batches.
 * The user previews every change and applies the chosen ones as one undoable
 * edit. Uses the same model configuration as AI translation.
 */
export function StudioCueRevision({ page, track, request, editBlocked, onClose, onApply }: {
  page: DocumentPage;
  track?: CueTrack;
  request: CueRevisionRequestState | null;
  editBlocked?: string;
  onClose: () => void;
  /** Applies the accepted revision; resolves whether it was applied. The wordings are those of the applied proposals. */
  onApply: (operation: CueEditOperation, count: number, applied: { knowledgeHints: CueRevisionHint[]; instructions: string }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const id = useId();
  const profiles = useModelStore(state => state.profiles);
  const assignment = useModelStore(state => state.assignment.taskExecution);
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<Scope>('selection');
  const [fields, setFields] = useState<CueRevisionFields>('source');
  const [profileId, setProfileId] = useState('');
  const [pending, setPending] = useState<'generate' | 'duplicates' | 'apply' | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [confirm, setConfirm] = useState<CueRevisionLocation | null>(null);
  const [result, setResult] = useState<Outcome | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<ErrorCode | null>(null);
  /** The request in flight, and the run it belongs to; a new run or closing invalidates both. */
  const running = useRef<string | null>(null);
  const generation = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  /** The preset waiting to start once the form shows it, and the callback that reports its outcome. */
  const autoRun = useRef<CueRevisionPreset | null>(null);
  const settleRef = useRef<((outcome: CueRevisionOutcome) => void) | null>(null);
  const settle = (outcome: CueRevisionOutcome) => {
    const callback = settleRef.current;
    settleRef.current = null;
    callback?.(outcome);
  };
  const open = !!request;
  // The closing animation keeps showing the last request.
  const shown = useRef(request);
  if (request) shown.current = request;
  const target = shown.current;

  const selected = useMemo(() => {
    const ids = new Set(target?.cueIds ?? []);
    return page.cues.filter(cue => ids.has(cue.id)).map(cue => cue.id);
  }, [target, page.cues]);
  const draft = translationDraftMemory.read(page.summary.id, page.summary.revision) ?? translationDraftMemory.last();
  const profile = profiles.find(item => item.id === profileId);
  const model = translationModelSchema.safeParse(profile ? { profileId: profile.id, modelKey: profile.modelKey, endpoint: profile.baseUrl, apiFormat: profile.apiFormat, outputTokenParameter: profile.outputTokenParameter } : null);
  const configured = model.success && !!profile?.apiKey.trim();
  // The document's translation materials guide revised translations; only the translation dialog chooses them.
  const materials = draft && hasMaterials(draft.selection) && draft.selection.languagePair.source ? draft.selection : undefined;
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  useEffect(() => {
    if (!open || !materials || typeof window === 'undefined' || !window.translationKnowledge) return;
    let active = true;
    void window.translationKnowledge.read().then(response => { if (active && response.ok) setLibrary(response.value); }).catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.serial]);
  const materialLabel = (() => {
    const names = materials ? materialNames(materials, library) : [];
    return names.length > 2 ? t('studio:cue_revision.materials_more', { first: names[0], count: names.length }) : names.join(t('studio:cue_revision.materials_separator'));
  })();
  const translated = !!track && (scope === 'document' ? page.summary.translationStatus !== 'none' : selected.some(cueId => currentEntry(track, page.cues.find(cue => cue.id === cueId)!)));

  // A new request starts from a clean form with the remembered choices.
  useEffect(() => {
    if (!request) return;
    settle({ status: 'cancelled' });
    settleRef.current = request.onSettled ?? null;
    const ids = new Set(request.cueIds);
    const hasSelection = page.cues.some(cue => ids.has(cue.id));
    const preset = request.preset;
    setInstructions(preset?.instructions ?? ''); setResult(null); setConfirm(null); setProgress(null); setAccepted(new Set()); setError(null); setPending(null);
    setScope(preset?.scope ?? (hasSelection ? 'selection' : 'document'));
    const anyTranslation = !!track && (hasSelection ? page.cues.some(cue => ids.has(cue.id) && currentEntry(track, cue)) : page.summary.translationStatus !== 'none');
    setFields(track ? preset?.fields ?? memory.fields ?? (anyTranslation ? 'both' : 'source') : 'source');
    autoRun.current = preset ?? null;
    const remembered = [memory.profileId, draft?.profileId, assignment ?? undefined, profiles[0]?.id].find(value => value && profiles.some(item => item.id === value));
    setProfileId(remembered ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.serial]);

  const stop = () => {
    settle({ status: 'cancelled' });
    generation.current++;
    if (running.current) void window.subtitleStudio.cancelCueRevision({ requestId: running.current });
    running.current = null;
    setPending(current => current === 'generate' ? null : current);
    setProgress(null);
  };
  const close = () => { stop(); onClose(); };
  useEffect(() => () => {
    generation.current++;
    if (running.current) void window.subtitleStudio.cancelCueRevision({ requestId: running.current });
    settle({ status: 'cancelled' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Settings changed after a scan was located: its confirmation no longer applies. */
  const invalidate = () => setConfirm(null);

  const maxOutputTokens = () => {
    const configuredLimit = Number(draft?.maxOutputTokens);
    if (Number.isInteger(configuredLimit) && configuredLimit >= 256) return Math.min(configuredLimit, 32768);
    return Math.max(256, Math.min(profile?.maxOutputTokens ?? inferMaxOutputTokens(profile?.modelKey ?? ''), 8192));
  };
  const generate = async (confirmed?: CueRevisionLocation, search?: CueRevisionSearch) => {
    if (pending) return;
    if (!configured) { settle({ status: 'failed', error: 'needs_configuration' }); return; }
    if (!instructions.trim() || (scope === 'selection' && !selected.length)) { settle({ status: 'failed', error: 'invalid_input' }); return; }
    const run = ++generation.current;
    const current = () => generation.current === run;
    const base = {
      documentId: page.summary.id, revision: confirmed?.revision ?? page.summary.revision,
      ...(track ? { trackId: track.id } : {}), fields: track ? fields : 'source' as const,
      instructions: instructions.trim(), model: model.data!, maxOutputTokens: maxOutputTokens(), apiKey: profile!.apiKey,
    };
    const call = async <T,>(send: (requestId: string) => Promise<StudioResult<T>>) => {
      const requestId = crypto.randomUUID();
      running.current = requestId;
      try { return await unwrapStudio(send(requestId)); }
      finally { if (running.current === requestId) running.current = null; }
    };
    setPending('generate'); setError(null); setConfirm(null);
    try {
      let location = confirmed;
      if (scope === 'document' && !location) {
        setProgress({ stage: 'locating' });
        if (search) {
          // The lines are already known (for example from the assistant): search without a planning request.
          const found = await unwrapStudio(window.subtitleStudio.findCues({ documentId: base.documentId, revision: base.revision, ...(track ? { trackId: track.id } : {}), ...search, limit: 0 }));
          location = { documentId: found.documentId, revision: found.revision, total: page.summary.cueCount, cueIds: found.cueIds,
            plan: 'terms' in search ? { strategy: 'terms', terms: search.terms } : { strategy: 'lines', lines: search.lines }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        } else location = await call(requestId => window.subtitleStudio.locateCueRevision({ ...base, requestId }));
        if (!current()) return;
        // A large scan costs many requests: ask first.
        if (location.cueIds.length > CUE_REVISION_CONFIRM_ABOVE) {
          setConfirm(location); setResult(null);
          settle({ status: 'needs_confirmation', count: location.cueIds.length, plan: location.plan });
          return;
        }
      }
      const ids = location ? location.cueIds : selected;
      const outcome: Outcome = { documentId: page.summary.id, revision: location?.revision ?? page.summary.revision, proposals: [], notes: [], rejected: 0,
        usage: location ? { ...location.usage } : { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, checked: ids.length, ...(location ? { location } : {}) };
      for (let offset = 0; offset < ids.length; offset += CUE_REVISION_LIMIT) {
        setProgress({ stage: 'revising', done: offset, total: ids.length });
        const value = await call(requestId => window.subtitleStudio.reviseCues({ ...base, requestId, cueIds: ids.slice(offset, offset + CUE_REVISION_LIMIT),
          ...(materials && track && revisesTarget(base.fields) ? { knowledge: materials } : {}) }));
        if (!current()) return;
        outcome.revision = value.revision;
        outcome.proposals.push(...value.proposals);
        outcome.notes = [...new Set([...outcome.notes, ...value.notes])].slice(0, MAX_NOTES);
        outcome.rejected += value.rejected;
        if (value.knowledgeHints) outcome.knowledgeHints = mergeHints(outcome.knowledgeHints ?? [], value.knowledgeHints);
        if (value.knowledgeItems) outcome.knowledgeItems = (outcome.knowledgeItems ?? 0) + value.knowledgeItems;
        if (value.structure?.length) outcome.structure = [...(outcome.structure ?? []), ...value.structure];
        addUsage(outcome.usage, value.usage);
      }
      setResult(outcome); setAccepted(new Set([...outcome.proposals.slice(0, CUE_EDIT_LIMIT).map(item => item.cueId), ...(outcome.structure ?? []).slice(0, CUE_BATCH_LIMIT).map(structureKey)]));
      settle({ status: 'ready', checked: outcome.checked, proposals: outcome.proposals.length + (outcome.structure?.length ?? 0), notes: outcome.notes, ...(outcome.location ? { plan: outcome.location.plan } : {}),
        ...(outcome.knowledgeHints?.length ? { knowledgeHints: outcome.knowledgeHints } : {}), ...(outcome.structure?.length ? { structure: countStructure(outcome.structure) } : {}) });
    } catch (failure) {
      if (!current()) return;
      const code = failure instanceof StudioError ? failure.code : 'translation_failed';
      if (code !== 'interrupted') setError(code);
      settle(code === 'interrupted' ? { status: 'cancelled' } : { status: 'failed', error: code });
    } finally {
      if (current()) { setPending(null); setProgress(null); }
    }
  };
  /** Shows proposals made without the model and reports them like a generated revision. */
  const showStructure = (structure: CueStructureProposal[], checked: number, origin: 'duplicates' | 'prepared') => {
    const outcome: Outcome = { documentId: page.summary.id, revision: page.summary.revision, proposals: [], notes: [], rejected: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, checked, structure, origin };
    setResult(outcome); setAccepted(new Set(structure.slice(0, CUE_BATCH_LIMIT).map(structureKey)));
    settle({ status: 'ready', checked, proposals: structure.length, notes: [], structure: countStructure(structure) });
  };
  /**
   * Finds neighbouring cues that repeat each other, in the selection or the whole document, with no
   * model involved; each run becomes a merge proposal.
   */
  const checkDuplicates = async () => {
    if (pending) return;
    const run = ++generation.current;
    setPending('duplicates'); setError(null); setConfirm(null); setResult(null);
    try {
      const cues: (DocumentPage['cues'][number] & { index: number })[] = [];
      const entries: Record<string, NonNullable<CueTrack>['entries'][string]> = {};
      if (scope === 'selection') {
        const ids = new Set(selected);
        page.cues.forEach((cue, position) => { if (ids.has(cue.id)) cues.push({ ...cue, index: page.offset + position }); });
        if (track) Object.assign(entries, track.entries);
      } else {
        for (let offset = 0; offset < Math.min(page.summary.cueCount, CUE_REVISION_DOCUMENT_LIMIT * 4); offset += 100) {
          setProgress({ stage: 'revising', done: offset, total: page.summary.cueCount });
          const read = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: page.summary.id, revision: page.summary.revision, offset }));
          if (generation.current !== run) return;
          read.cues.forEach((cue, position) => cues.push({ ...cue, index: offset + position }));
          const pageTrack = track && read.translationTracks.find(item => item.id === track.id);
          if (pageTrack) Object.assign(entries, pageTrack.entries);
        }
      }
      // Only neighbours in the document: a gap in the selection separates runs.
      const runs: (typeof cues)[] = [];
      for (const cue of cues) { const last = runs.at(-1)?.at(-1); if (last && cue.index === last.index + 1) runs.at(-1)!.push(cue); else runs.push([cue]); }
      const found = runs.flatMap(group => findAdjacentDuplicates(group, track ? { id: track.id, entries } : undefined));
      if (generation.current !== run) return;
      showStructure(found, cues.length, 'duplicates');
    } catch (failure) {
      if (generation.current !== run) return;
      const code = failure instanceof StudioError ? failure.code : 'document_unavailable';
      setError(code);
      settle({ status: 'failed', error: code });
    } finally {
      if (generation.current === run) { setPending(null); setProgress(null); }
    }
  };
  // A preset starts once the form shows it and, when it asks the model, a model profile has been chosen.
  useEffect(() => {
    const preset = autoRun.current;
    if (!preset || !open || instructions !== preset.instructions) return;
    if (preset.mode === 'prepared') { autoRun.current = null; showStructure(preset.structure ?? [], preset.structure?.length ?? 0, 'prepared'); return; }
    if (preset.mode === 'duplicates') { autoRun.current = null; void checkDuplicates(); return; }
    if (profiles.length > 0 && !profileId) return;
    autoRun.current = null;
    void generate(undefined, preset.search);
  });

  const apply = async () => {
    if (!result || pending || editBlocked) return;
    if (result.revision !== page.summary.revision || result.documentId !== page.summary.id) { setError('revision_conflict'); return; }
    const sources: Record<string, ReturnType<typeof editedText>> = {}, targets: Record<string, ReturnType<typeof editedText>> = {};
    const structure = (result.structure ?? []).filter(item => accepted.has(structureKey(item)));
    // A cue merged or deleted takes no separate text change.
    const taken = new Set(structure.flatMap(structureCueIds));
    for (const proposal of result.proposals) {
      if (!accepted.has(proposal.cueId) || taken.has(proposal.cueId)) continue;
      if (proposal.source !== undefined) sources[proposal.cueId] = editedText(proposal.current.source, proposal.source);
      if (proposal.target !== undefined && track) targets[proposal.cueId] = proposal.keptTarget && proposal.current.target ? proposal.current.target : editedText(proposal.current.target, proposal.target);
    }
    const count = new Set([...Object.keys(sources), ...Object.keys(targets), ...taken]).size;
    if (!count || count > CUE_EDIT_LIMIT) return;
    const operation = revisionOperation({ kind: 'revise', sources, ...(track && Object.keys(targets).length ? { trackId: track.id, targets } : {}) }, structure, track?.id);
    if (!operation) return;
    setPending('apply'); setError(null);
    const hints = appliedHints(result.knowledgeHints, accepted);
    const onApplied = target?.preset?.onApplied;
    const applied = await onApply(operation, count, { knowledgeHints: hints, instructions: instructions.trim() });
    setPending(null);
    if (applied) { onApplied?.(count, hints, countStructure(structure)); onClose(); }
    else setError('document_unavailable');
  };
  const onInstructionsKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void generate(confirm ?? undefined); }
  };
  const toggle = (cueId: string, value: boolean) => setAccepted(current => {
    const next = new Set(current);
    if (value) next.add(cueId); else next.delete(cueId);
    return next;
  });

  const proposals = result?.proposals ?? [];
  const structure = result?.structure ?? [];
  const acceptedCount = proposals.filter(item => accepted.has(item.cueId)).length + structure.filter(item => accepted.has(structureKey(item))).length;
  const total = proposals.length + structure.length;
  const allKeys = () => new Set([...proposals.map(item => item.cueId), ...structure.map(structureKey)]);
  const usage = result?.usage.totalTokens ?? null;
  const fieldOptions = (['source', 'target', 'both'] as const).map(value => ({ value, label: t(fieldKeys[value]), testId: `studio-cue-revision-field-${value}`, disabled: value !== 'source' && !track }));
  const scopeOptions = [
    { value: 'selection' as const, label: selected.length ? t('studio:cue_revision.scope.selection', { count: selected.length }) : t('studio:cue_revision.scope.no_selection'), testId: 'studio-cue-revision-scope-selection', disabled: !selected.length },
    { value: 'document' as const, label: t('studio:cue_revision.scope.document', { count: page.summary.cueCount }), testId: 'studio-cue-revision-scope-document' },
  ];
  const row = (proposal: CueRevisionProposal) => {
    const { current } = proposal;
    const sourceChanged = proposal.source !== undefined;
    const targetChanged = proposal.target !== undefined && !proposal.keptTarget;
    const checked = accepted.has(proposal.cueId);
    return <li key={proposal.cueId} data-testid="studio-cue-revision-item" data-accepted={checked || undefined}>
      <label className="studio-cue-revision-item">
        <Checkbox checked={checked} onCheckedChange={value => toggle(proposal.cueId, value === true)} aria-label={t('studio:cue_revision.include', { number: proposal.index + 1 })} />
        <span className="studio-cue-revision-number">{proposal.index + 1}</span>
        <span className="studio-cue-revision-texts">
          <span className="studio-cue-revision-text" data-field="source">
            {sourceChanged ? <Diff before={current.source.plain} after={proposal.source!} /> : <span className="studio-cue-revision-unchanged">{current.source.plain}</span>}
          </span>
          {track && (targetChanged || proposal.keptTarget || (sourceChanged && current.target)) && <span className="studio-cue-revision-text" data-field="target">
            {targetChanged ? <Diff before={current.target?.plain ?? ''} after={proposal.target!} />
              : <span className="studio-cue-revision-unchanged">{current.target?.plain}</span>}
            {proposal.keptTarget && <span className="studio-cue-revision-tag"><Check />{t('studio:cue_revision.kept_target')}</span>}
            {sourceChanged && !proposal.keptTarget && !targetChanged && current.target && <span className="studio-cue-revision-tag" data-tone="warning">{t('studio:cue_revision.target_stale')}</span>}
          </span>}
        </span>
      </label>
    </li>;
  };
  const range = (timing: { startMs: number; endMs: number | null }) => `${formatStudioTime(timing.startMs)} → ${timing.endMs === null ? t('studio:unknown_end') : formatStudioTime(timing.endMs)}`;
  const structureRow = (proposal: CueStructureProposal) => {
    const key = structureKey(proposal);
    const checked = accepted.has(key);
    const numbers = proposal.kind === 'merge' ? `${proposal.indexes[0] + 1}–${proposal.indexes.at(-1)! + 1}` : String(proposal.index + 1);
    return <li key={key} data-testid="studio-cue-structure-item" data-kind={proposal.kind} data-accepted={checked || undefined}>
      <label className="studio-cue-revision-item">
        <Checkbox checked={checked} onCheckedChange={value => toggle(key, value === true)} aria-label={t('studio:cue_revision.include_structure', { numbers })} />
        <span className="studio-cue-revision-number">{numbers}</span>
        <span className="studio-cue-revision-texts">
          <span className="studio-cue-structure-head">
            <span className="studio-cue-revision-tag" data-tone={proposal.kind === 'delete' ? 'warning' : undefined}>
              {proposal.kind === 'merge' ? <><Combine />{t('studio:cue_revision.tag_merge', { count: proposal.cueIds.length })}</> : t(`studio:cue_revision.tag_${proposal.kind}`)}
            </span>
            <span className="studio-cue-structure-time">{proposal.kind === 'timing' ? `${range(proposal.before)}  ⇒  ${range(proposal.timing)}` : range(proposal.timing)}</span>
          </span>
          {proposal.kind === 'merge' ? <>
            <span className="studio-cue-revision-text" data-field="source">{proposal.source}</span>
            {proposal.target !== undefined && <span className="studio-cue-revision-text" data-field="target">{proposal.target}
              {proposal.targetStale && <span className="studio-cue-revision-tag" data-tone="warning">{t('studio:cue_revision.target_stale')}</span>}</span>}
            <span className="studio-cue-structure-old">{proposal.current.map((item, index) => <span key={index}><del>{structureText(item)}</del>{item.target && <del className="text-muted-foreground"> · {item.target.plain}</del>}</span>)}</span>
          </> : proposal.kind === 'delete' ? <span className="studio-cue-revision-text" data-field="source"><del>{proposal.current.source.plain}</del>{proposal.current.target && <del className="text-muted-foreground"> · {proposal.current.target.plain}</del>}</span>
            : <span className="studio-cue-revision-text studio-cue-revision-unchanged" data-field="source">{proposal.current.source.plain}</span>}
        </span>
      </label>
    </li>;
  };
  const summary = () => {
    if (!total) return t(result!.origin === 'duplicates' ? 'studio:cue_revision.duplicates_none' : result!.checked ? 'studio:cue_revision.no_changes' : 'studio:cue_revision.nothing_found', { total: result!.checked });
    if (!structure.length) return t('studio:cue_revision.summary', { count: proposals.length, total: result!.checked });
    const counts = countStructure(structure);
    const parts = [proposals.length && t('studio:cue_revision.part_texts', { count: proposals.length }), counts.merges && t('studio:cue_revision.part_merges', { count: counts.merges }),
      counts.deletes && t('studio:cue_revision.part_deletes', { count: counts.deletes }), counts.timings && t('studio:cue_revision.part_timings', { count: counts.timings })].filter(Boolean);
    const joined = parts.join(t('studio:cue_revision.materials_separator'));
    return result!.origin === 'prepared' ? t('studio:cue_revision.summary_prepared', { parts: joined }) : t('studio:cue_revision.summary_structure', { parts: joined, total: result!.checked });
  };
  const generateLabel = pending === 'generate' ? 'studio:cue_revision.generating' : confirm ? 'studio:cue_revision.continue' : result ? 'studio:cue_revision.regenerate' : 'studio:cue_revision.generate';

  return <ScrollableDialog animateSize open={open} maxWidth="sm:max-w-[640px]" contentClassName="studio-cue-revision-dialog"
    onOpenChange={value => { if (!value && pending !== 'apply') close(); }}
    onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}
    onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>('[data-testid=studio-cue-list]')?.focus({ preventScroll: true }); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4" />{t('studio:cue_revision.title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{t(scope === 'document' ? 'studio:cue_revision.description_document' : 'studio:cue_revision.description', { count: scope === 'document' ? page.summary.cueCount : selected.length })}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-revision-content" fadeMaskHeight={16}>
      <div className="studio-cue-revision-body">
      <div className="studio-cue-revision-form">
        <ToolRadioButtonGroup className="studio-cue-revision-scope" ariaLabel={t('studio:cue_revision.scope_label')} value={scope} options={scopeOptions} disabled={!!pending}
          onValueChange={value => { setScope(value); setResult(null); invalidate(); }} />
        <label htmlFor={`${id}-instructions`} className="sr-only">{t('studio:cue_revision.instructions')}</label>
        <Textarea ref={input} id={`${id}-instructions`} data-testid="studio-cue-revision-instructions" rows={result ? 2 : 3} maxLength={CUE_REVISION_INSTRUCTIONS_LIMIT}
          className="resize-none text-xs leading-5" value={instructions} placeholder={t(scope === 'document' ? 'studio:cue_revision.placeholder_document' : 'studio:cue_revision.placeholder')} disabled={pending === 'apply'}
          onChange={event => { setInstructions(event.target.value); invalidate(); }} onKeyDown={onInstructionsKey} />
        <div className="studio-cue-revision-options">
          {track && <ToolRadioButtonGroup className="studio-cue-revision-fields" ariaLabel={t('studio:cue_revision.fields_label')} value={fields} options={fieldOptions} disabled={!!pending}
            onValueChange={value => { setFields(value); memory.fields = value; invalidate(); }} />}
          <Select value={profile?.id ?? ''} disabled={!!pending || !profiles.length} onValueChange={value => { setProfileId(value); memory.profileId = value; }}>
            <SelectTrigger aria-label={t('studio:cue_revision.model')} data-testid="studio-cue-revision-model" size="sm" className="studio-cue-revision-model min-w-0 text-xs"><SelectValue placeholder={t('studio:translation.select_model')} /></SelectTrigger>
            <SelectContent>{profiles.map(item => <SelectItem key={item.id} value={item.id}>{item.name || item.modelKey}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {materials && track && revisesTarget(fields) && materialLabel && <p className="studio-cue-revision-hint studio-cue-revision-materials" data-testid="studio-cue-revision-materials">
          <BookOpen />{t('studio:cue_revision.materials', { names: materialLabel })}</p>}
        {!configured && <div className="studio-translation-configuration"><p><AlertCircle className="size-4 shrink-0" />{t('studio:translation.model_required')}</p><Button variant="outline" size="sm" onClick={() => { close(); navigate('/setting?tab=model'); }}><Settings />{t('studio:translation.model_settings')}</Button></div>}
      </div>
      {error && <p role="alert" className="studio-cue-revision-error"><AlertCircle />{t(errorKeys[error], { limit: CUE_REVISION_DOCUMENT_LIMIT })}</p>}
      {progress && <div className="studio-cue-revision-progress" role="status" data-testid="studio-cue-revision-progress">
        <span><LoaderCircle className="animate-spin" />{progress.stage === 'locating' ? t('studio:cue_revision.locating') : t(pending === 'duplicates' ? 'studio:cue_revision.reading' : 'studio:cue_revision.revising', { done: progress.done, total: progress.total })}</span>
        {progress.stage === 'revising' && progress.total > CUE_REVISION_LIMIT && <span className="studio-cue-revision-bar" aria-hidden="true"><span style={{ width: `${progress.done / progress.total * 100}%` }} /></span>}
      </div>}
      {confirm && <section className="studio-cue-revision-result" data-testid="studio-cue-revision-confirm">
        <PlanSummary location={confirm} />
        <p className="studio-cue-revision-hint">{t('studio:cue_revision.confirm', { count: confirm.cueIds.length, requests: Math.ceil(confirm.cueIds.length / CUE_REVISION_CHUNK) })}</p>
      </section>}
      {result && <section className="studio-cue-revision-result" aria-label={t('studio:cue_revision.result')} data-testid="studio-cue-revision-result">
        {result.location && <PlanSummary location={result.location} />}
        <div className="studio-cue-revision-summary">
          <span aria-live="polite" data-testid="studio-cue-revision-summary">{summary()}</span>
          {total > 1 && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAccepted(acceptedCount === total ? new Set() : allKeys())}>
            {t(acceptedCount === total ? 'studio:cue_revision.deselect_all' : 'studio:cue_revision.select_all')}
          </Button>}
        </div>
        {result.origin === 'prepared' && total > 0 && <p className="studio-cue-revision-note" data-testid="studio-cue-revision-prepared"><Sparkles />{t('studio:cue_revision.prepared_by_agent')}</p>}
        {result.notes.length > 0 && <p className="studio-cue-revision-note" data-testid="studio-cue-revision-note"><Sparkles />{result.notes.join(' ')}</p>}
        {!!result.knowledgeHints?.length && proposals.length > 0 && <p className="studio-cue-revision-hint studio-cue-revision-materials" data-testid="studio-cue-revision-knowledge-hint">
          <BookOpen />{t('studio:cue_revision.knowledge_hint', { count: result.knowledgeHints.length })}</p>}
        {total > 0 && <ul className="studio-cue-revision-list">{structure.map(structureRow)}{proposals.map(row)}</ul>}
        {result.rejected > 0 && <p className="studio-cue-revision-hint">{t('studio:cue_revision.rejected', { count: result.rejected })}</p>}
        {acceptedCount > CUE_EDIT_LIMIT && <p className="studio-cue-revision-hint" role="alert">{t('studio:cue_revision.apply_limit', { limit: CUE_EDIT_LIMIT })}</p>}
        {revisesSource(fields) && !revisesTarget(fields) && translated && proposals.some(item => item.source !== undefined) && <p className="studio-cue-revision-hint">{t('studio:cue_revision.source_only_hint')}</p>}
      </section>}
      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex flex-wrap items-center gap-2 p-3 sm:justify-between">
      {/* Proposals made without the model used nothing worth counting. */}
      <span className="studio-cue-revision-footnote">{editBlocked ?? (usage !== null && !result?.origin ? t('studio:cue_revision.usage', { count: usage }) : t('studio:cue_revision.shortcut'))}</span>
      <div className="flex items-center gap-2">
        {pending === 'generate'
          ? <Button variant="ghost" size="sm" data-testid="studio-cue-revision-stop" onClick={stop}>{t('studio:cue_revision.stop')}</Button>
          : <Button variant="ghost" size="sm" disabled={pending === 'apply'} onClick={close}>{t('studio:cancel')}</Button>}
        <Button variant="outline" size="sm" data-testid="studio-cue-revision-duplicates" disabled={!!pending || (scope === 'selection' && selected.length < 2)} onClick={() => void checkDuplicates()}>
          {pending === 'duplicates' ? <LoaderCircle className="animate-spin" /> : <Combine />}{t('studio:cue_revision.find_duplicates')}
        </Button>
        <Button variant={result ? 'outline' : 'default'} size="sm" data-testid="studio-cue-revision-generate" disabled={!!pending || !configured || !instructions.trim() || (scope === 'selection' && !selected.length)} onClick={() => void generate(confirm ?? undefined)}>
          {pending === 'generate' ? <LoaderCircle className="animate-spin" /> : result ? <RotateCcw /> : <Sparkles />}
          {t(generateLabel)}
        </Button>
        {result && total > 0 && <Button size="sm" data-testid="studio-cue-revision-apply" disabled={!!pending || !!editBlocked || !acceptedCount || acceptedCount > CUE_EDIT_LIMIT} onClick={() => void apply()}>
          {pending === 'apply' ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}{t('studio:cue_revision.apply', { count: acceptedCount })}
        </Button>}
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
