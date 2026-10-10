import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, BookOpen, Check, ChevronDown, LoaderCircle, RotateCcw, ScanText, Settings, Sparkles, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import useModelStore from '@/store/useModelStore';
import { inferMaxOutputTokens } from '@/constants/model';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { CONSISTENCY_CUE_LIMIT, CONSISTENCY_DOCUMENT_LIMIT, type ConsistencyGroup, type ConsistencyResult } from '@/subtitle-studio/consistency-contract';
import { translationModelSchema } from '@/subtitle-studio/translation-contract';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { hasMaterials, translationDraftMemory } from '@/services/subtitle-studio/translation-draft';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { cueKey, defaultChoice, groupChanges, hasSpellings, hasTranslations, planConsistencyEdits, unfixablePlaces, wordingsToKeep, type CueTexts, type GroupChoice } from './consistency-apply';
import { materialNames } from './knowledge-hints';
import './StudioCueRevision.css';
import './StudioConsistencyCheck.css';

/** A document to check, as the library lists it. */
export type ConsistencyTarget = { documentId: string; revision: number; name: string; cueCount: number; trackId?: string };
export type ConsistencyOutcome = { status: 'ready'; result: ConsistencyResult } | { status: 'failed'; error: ErrorCode } | { status: 'cancelled' };
export type ConsistencyRequestState = {
  serial: number;
  documents: ConsistencyTarget[];
  focus?: string;
  /** Start checking as soon as the window opens (the assistant asked for it). */
  autoStart?: boolean;
  onSettled?: (outcome: ConsistencyOutcome) => void;
};
type SkipReason = 'changed' | 'unavailable' | 'too_many' | 'busy';
type Receipt = { applied: { name: string; count: number }[]; skipped: { name: string; reason: SkipReason }[]; keep?: { source: string; target: string }[]; undo: { documentId: string; name: string; revision: number; operation: CueEditOperation; current: boolean }[] };
const memory: { profileId?: string } = {};
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text with one wording marked, so each place shows what differs. */
function Marked({ text, wording }: { text: string; wording: string }) {
  if (!wording) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(wording)})`, 'giu'));
  return <>{parts.map((part, index) => index % 2 ? <mark key={index} className="studio-consistency-mark">{part}</mark> : part)}</>;
}

/**
 * Finds names and terms written more than one way in one or several documents, then unifies the
 * ones the user confirms with a literal replacement (no model involved in fixing). The current
 * document's change joins its undo history; the receipt can undo every document.
 */
export function StudioConsistencyCheck({ request, currentDocumentId, editBlocked, onClose, onApplyCurrent, onUndoCurrent, onChangedOther, onKeep, onReviseLines }: {
  request: ConsistencyRequestState | null;
  currentDocumentId?: string;
  editBlocked?: string;
  onClose: () => void;
  /** Applies the current document's edit through its undo history; resolves whether it was applied. */
  onApplyCurrent: (operation: CueEditOperation, count: number) => Promise<boolean>;
  /** Undoes the current document's unification, if it is still the latest edit. */
  onUndoCurrent: () => Promise<boolean>;
  /** Another document changed; the library should refresh. */
  onChangedOther: () => void;
  /** Keep the chosen wordings in translation materials; `saved` runs once they are saved. */
  onKeep: (wordings: { source: string; target: string }[], saved: () => void) => void;
  /** Revise lines of the current document with AI (numbers from 1), for places no replacement can fix. */
  onReviseLines: (lines: number[], instructions: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const id = useId();
  const profiles = useModelStore(state => state.profiles);
  const assignment = useModelStore(state => state.assignment.taskExecution);
  const [focus, setFocus] = useState('');
  const [profileId, setProfileId] = useState('');
  const [pending, setPending] = useState<'check' | 'apply' | 'undo' | null>(null);
  const [result, setResult] = useState<ConsistencyResult | null>(null);
  const [choices, setChoices] = useState<Map<string, GroupChoice>>(new Map());
  const [custom, setCustom] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const running = useRef<string | null>(null);
  const generation = useRef(0);
  const settleRef = useRef<((outcome: ConsistencyOutcome) => void) | null>(null);
  const autoRun = useRef(false);
  const settle = (outcome: ConsistencyOutcome) => { const callback = settleRef.current; settleRef.current = null; callback?.(outcome); };
  const open = !!request;
  const shown = useRef(request);
  if (request) shown.current = request;
  const target = shown.current;
  const documents = target?.documents ?? [];
  const cueCount = documents.reduce((sum, item) => sum + item.cueCount, 0);
  const tooLarge = documents.length > CONSISTENCY_DOCUMENT_LIMIT || cueCount > CONSISTENCY_CUE_LIMIT;
  const current = documents.find(item => item.documentId === currentDocumentId);
  const draft = documents[0] ? translationDraftMemory.read(documents[0].documentId, documents[0].revision) ?? translationDraftMemory.last() : undefined;
  const materials = draft && hasMaterials(draft.selection) ? draft.selection : undefined;
  const profile = profiles.find(item => item.id === profileId);
  const model = translationModelSchema.safeParse(profile ? { profileId: profile.id, modelKey: profile.modelKey, endpoint: profile.baseUrl, apiFormat: profile.apiFormat, outputTokenParameter: profile.outputTokenParameter } : null);
  const configured = model.success && !!profile?.apiKey.trim();

  useEffect(() => {
    if (!request) return;
    settle({ status: 'cancelled' });
    settleRef.current = request.onSettled ?? null;
    setFocus(request.focus ?? ''); setResult(null); setChoices(new Map()); setCustom(new Set()); setExpanded(new Set()); setReceipt(null); setError(null); setPending(null);
    autoRun.current = !!request.autoStart;
    const remembered = [memory.profileId, draft?.profileId, assignment ?? undefined, profiles[0]?.id].find(value => value && profiles.some(item => item.id === value));
    setProfileId(remembered ?? '');
    if (materials && window.translationKnowledge) void window.translationKnowledge.read().then(response => { if (response.ok) setLibrary(response.value); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.serial]);
  const stop = () => {
    settle({ status: 'cancelled' });
    generation.current++;
    if (running.current) void window.subtitleStudio.cancelConsistency({ requestId: running.current });
    running.current = null;
    setPending(value => value === 'check' ? null : value);
  };
  const close = () => { stop(); onClose(); };
  useEffect(() => () => { generation.current++; if (running.current) void window.subtitleStudio.cancelConsistency({ requestId: running.current }); settle({ status: 'cancelled' }); }, []);

  const maxOutputTokens = () => {
    const configuredLimit = Number(draft?.maxOutputTokens);
    if (Number.isInteger(configuredLimit) && configuredLimit >= 256) return Math.min(configuredLimit, 32768);
    return Math.max(256, Math.min(profile?.maxOutputTokens ?? inferMaxOutputTokens(profile?.modelKey ?? ''), 8192));
  };
  const check = async () => {
    if (pending || tooLarge) return;
    if (!configured) { settle({ status: 'failed', error: 'needs_configuration' }); return; }
    const run = ++generation.current;
    const requestId = crypto.randomUUID();
    running.current = requestId;
    setPending('check'); setError(null); setResult(null); setReceipt(null);
    try {
      const value = await unwrapStudio(window.subtitleStudio.checkConsistency({ requestId, documents: documents.map(item => ({ documentId: item.documentId, revision: item.revision, ...(item.trackId ? { trackId: item.trackId } : {}) })),
        ...(focus.trim() ? { focus: focus.trim() } : {}), ...(materials ? { knowledge: materials } : {}), model: model.data!, maxOutputTokens: maxOutputTokens(), apiKey: profile!.apiKey }));
      if (generation.current !== run) return;
      setResult(value);
      setChoices(new Map(value.groups.map(group => [group.id, defaultChoice(group)])));
      settle({ status: 'ready', result: value });
    } catch (failure) {
      if (generation.current !== run) return;
      const code = failure instanceof StudioError ? failure.code : 'translation_failed';
      if (code !== 'interrupted') setError(code);
      settle(code === 'interrupted' ? { status: 'cancelled' } : { status: 'failed', error: code });
    } finally {
      if (running.current === requestId) running.current = null;
      if (generation.current === run) setPending(null);
    }
  };
  useEffect(() => {
    if (!autoRun.current || !open || (profiles.length > 0 && !profileId)) return;
    autoRun.current = false;
    void check();
  });

  const choose = (groupId: string, change: Partial<GroupChoice>) => setChoices(currentChoices => {
    const next = new Map(currentChoices);
    next.set(groupId, { ...next.get(groupId)!, ...change });
    return next;
  });
  const groups = result?.groups ?? [];
  const changes = useMemo(() => new Map(groups.map(group => [group.id, groupChanges(group, choices.get(group.id) ?? defaultChoice(group))])), [groups, choices]);
  const chosenGroups = groups.filter(group => (changes.get(group.id)?.size ?? 0) > 0);
  // Several groups can touch one line; it is changed once.
  const estimated = new Set(chosenGroups.flatMap(group => [...changes.get(group.id)!])).size;

  /** Reads the touched cues at the checked revisions; a document changed since is skipped. */
  const readTexts = async (skipped: Receipt['skipped']) => {
    const texts = new Map<string, CueTexts>();
    const needed = new Map<string, Set<number>>();
    for (const group of chosenGroups) for (const variant of [...group.variants, ...group.spellings]) for (const place of variant.occurrences)
      (needed.get(place.documentId) ?? needed.set(place.documentId, new Set()).get(place.documentId)!).add(Math.floor(place.index / 100) * 100);
    for (const document of result!.documents) {
      const offsets = needed.get(document.documentId);
      if (!offsets) continue;
      try {
        for (const offset of offsets) {
          const page = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: document.documentId, revision: document.revision, offset }));
          const track = page.translationTracks.find(item => item.id === document.trackId);
          for (const cue of page.cues) {
            const entry = track?.entries[cue.id];
            texts.set(cueKey(document.documentId, cue.id), { source: cue.source, ...(entry && entry.sourceRevision === cue.sourceRevision ? { target: entry.text } : {}) });
          }
        }
      } catch (failure) {
        skipped.push({ name: document.name, reason: failure instanceof StudioError && failure.code === 'revision_conflict' ? 'changed' : 'unavailable' });
        for (const key of [...texts.keys()]) if (key.startsWith(`${document.documentId}\u0000`)) texts.delete(key);
      }
    }
    return texts;
  };
  const apply = async () => {
    if (!result || pending || !chosenGroups.length) return;
    setPending('apply'); setError(null);
    const next: Receipt = { applied: [], skipped: [], undo: [] };
    try {
      const texts = await readTexts(next.skipped);
      const plan = planConsistencyEdits(result, choices, texts);
      for (const document of plan.tooMany) next.skipped.push({ name: document.name, reason: 'too_many' });
      let changedOther = false;
      for (const edit of plan.edits) {
        if (edit.document.documentId === currentDocumentId) {
          if (editBlocked) { next.skipped.push({ name: edit.document.name, reason: 'busy' }); continue; }
          if (await onApplyCurrent(edit.operation, edit.count)) { next.applied.push({ name: edit.document.name, count: edit.count }); next.undo.push({ documentId: edit.document.documentId, name: edit.document.name, revision: 0, operation: edit.operation, current: true }); }
          else next.skipped.push({ name: edit.document.name, reason: 'changed' });
          continue;
        }
        try {
          const value = await unwrapStudio(window.subtitleStudio.editCues({ documentId: edit.document.documentId, revision: edit.document.revision, operation: edit.operation }));
          next.applied.push({ name: edit.document.name, count: edit.count });
          next.undo.push({ documentId: edit.document.documentId, name: edit.document.name, revision: value.summary.revision, operation: value.undo, current: false });
          changedOther = true;
        } catch (failure) {
          next.skipped.push({ name: edit.document.name, reason: failure instanceof StudioError && (failure.code === 'revision_conflict' || failure.code === 'resource_busy') ? (failure.code === 'resource_busy' ? 'busy' : 'changed') : 'unavailable' });
        }
      }
      if (changedOther) onChangedOther();
      const keep = wordingsToKeep(result, choices);
      setReceipt(keep.length && next.applied.length ? { ...next, keep } : next);
    } finally { setPending(null); }
  };
  const undo = async () => {
    if (!receipt || pending) return;
    setPending('undo');
    const failed: Receipt['skipped'] = [];
    try {
      for (const item of receipt.undo) {
        if (item.current) { if (!await onUndoCurrent()) failed.push({ name: item.name, reason: 'changed' }); continue; }
        try { await unwrapStudio(window.subtitleStudio.editCues({ documentId: item.documentId, revision: item.revision, operation: item.operation })); }
        catch { failed.push({ name: item.name, reason: 'changed' }); }
      }
      onChangedOther();
      setReceipt({ applied: [], skipped: failed, undo: [] });
    } finally { setPending(null); }
  };

  const kindKey = (group: ConsistencyGroup) => `studio:consistency.kind_${group.kind}` as const;
  const name = (documentId: string) => result?.documents.find(item => item.documentId === documentId)?.name ?? '';
  const materialLabel = materials ? materialNames(materials, library).join(t('studio:cue_revision.materials_separator')) : '';
  const groupRow = (group: ConsistencyGroup) => {
    const choice = choices.get(group.id) ?? defaultChoice(group);
    const total = group.spellings.reduce((sum, item) => sum + item.count, 0);
    const unfixable = unfixablePlaces(group);
    const currentUnfixable = unfixable.filter(place => place.documentId === currentDocumentId);
    const isCustom = custom.has(group.id);
    const open = expanded.has(group.id);
    const translated = hasTranslations(group);
    const toggleOpen = () => setExpanded(value => { const next = new Set(value); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; });
    // Each line once, with the spelling its source uses and the translation it has marked.
    const places = new Map<string, { place: ConsistencyGroup['spellings'][number]['occurrences'][number]; spelling: string; rendering: string }>();
    for (const spelling of group.spellings) for (const place of spelling.occurrences) places.set(cueKey(place.documentId, place.cueId), { place, spelling: spelling.text, rendering: '' });
    for (const variant of group.variants) for (const place of variant.occurrences) {
      const key = cueKey(place.documentId, place.cueId);
      places.set(key, { place, spelling: places.get(key)?.spelling ?? group.source, rendering: variant.text });
    }
    const listed = [...places.values()].sort((a, b) => a.place.documentId.localeCompare(b.place.documentId) || a.place.index - b.place.index);
    return <li key={group.id} className="studio-consistency-group" data-testid="studio-consistency-group" data-kind={group.kind} data-chosen={choice.apply || undefined}>
      <div className="studio-consistency-head">
        <Checkbox checked={choice.apply} onCheckedChange={value => choose(group.id, { apply: value === true })} aria-label={t('studio:consistency.apply_group', { source: group.source })} data-testid="studio-consistency-apply-group" />
        <span className="studio-consistency-source">{group.source}</span>
        <span className="studio-consistency-kind" data-kind={group.kind}>{t(kindKey(group))}</span>
        <span className="studio-consistency-count">{t('studio:consistency.places', { count: total })}</span>
      </div>
      {translated && <div className="studio-consistency-variants" role="radiogroup" aria-label={t('studio:consistency.standard')}>
        {group.variants.filter(variant => variant.text).map(variant => {
          const selected = !isCustom && choice.standard === variant.text;
          return <button type="button" role="radio" aria-checked={selected} key={variant.text} className="studio-consistency-variant" data-testid="studio-consistency-variant"
            onClick={() => { setCustom(value => { const next = new Set(value); next.delete(group.id); return next; }); choose(group.id, { standard: variant.text, apply: true }); }}>
            {selected && <Check aria-hidden />}<span className="studio-consistency-variant-text">{variant.text}</span><span className="studio-consistency-variant-count">{variant.count}</span>
            {group.knowledgeTarget === variant.text ? <span className="studio-consistency-badge">{t('studio:consistency.from_materials')}</span>
              : group.recommended === variant.text && <span className="studio-consistency-badge">{t('studio:consistency.recommended')}</span>}
          </button>;
        })}
        <button type="button" role="radio" aria-checked={isCustom} className="studio-consistency-variant" data-testid="studio-consistency-custom"
          onClick={() => { setCustom(value => new Set(value).add(group.id)); choose(group.id, { standard: '', apply: true }); }}>{isCustom && <Check aria-hidden />}{t('studio:consistency.custom')}</button>
        {isCustom && <Input aria-label={t('studio:consistency.custom_label')} className="studio-consistency-custom-input h-7 text-xs" value={choice.standard} autoFocus
          onChange={event => choose(group.id, { standard: event.target.value })} />}
      </div>}
      {hasSpellings(group) && <div className="studio-consistency-spellings">
        {/* With translations to unify, fixing the source is optional; otherwise it is what the group does. */}
        {translated ? <label className="studio-consistency-option"><Checkbox checked={choice.fixSource} data-testid="studio-consistency-fix-source"
          onCheckedChange={value => choose(group.id, { fixSource: value === true, ...(value === true ? { apply: true } : {}) })} />{t('studio:consistency.fix_source')}</label>
          : <span className="studio-consistency-spellings-label">{t('studio:consistency.source_standard')}</span>}
        <div className="studio-consistency-variants" role="radiogroup" aria-label={t('studio:consistency.source_standard')}>
          {group.spellings.map((spelling, index) => {
            const selected = choice.fixSource && choice.sourceStandard === spelling.text;
            return <button type="button" role="radio" aria-checked={selected} key={spelling.text} className="studio-consistency-variant" data-testid="studio-consistency-spelling"
              onClick={() => choose(group.id, { sourceStandard: spelling.text, fixSource: true, apply: true })}>
              {selected && <Check aria-hidden />}<span className="studio-consistency-variant-text">{spelling.text}</span><span className="studio-consistency-variant-count">{spelling.count}</span>
              {index === 0 && <span className="studio-consistency-badge">{t('studio:consistency.most_common')}</span>}
            </button>;
          })}
        </div>
      </div>}
      {unfixable.length > 0 && <div className="studio-consistency-line studio-consistency-warning">
        <span>{t('studio:consistency.unfixable', { count: unfixable.length, target: group.knowledgeTarget ?? '' })}</span>
        {currentUnfixable.length > 0 && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" data-testid="studio-consistency-revise-lines"
          onClick={() => onReviseLines(currentUnfixable.map(place => place.index + 1).slice(0, 200), t('studio:consistency.revise_instructions', { source: group.source, target: group.knowledgeTarget ?? '' }))}><Sparkles />{t('studio:consistency.revise_lines', { count: currentUnfixable.length })}</Button>}
      </div>}
      <div className="studio-consistency-footer">
        {translated && (!group.knowledgeTarget || choice.standard !== group.knowledgeTarget) && <label className="studio-consistency-option"><Checkbox checked={choice.keep} onCheckedChange={value => choose(group.id, { keep: value === true })} data-testid="studio-consistency-keep" /><BookOpen aria-hidden />{t('studio:consistency.keep')}</label>}
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs text-muted-foreground" aria-expanded={open} onClick={toggleOpen} data-testid="studio-consistency-places-toggle">
          {t(open ? 'studio:consistency.hide_places' : 'studio:consistency.show_places')}<ChevronDown className={open ? 'rotate-180' : undefined} />
        </Button>
      </div>
      {open && <ul className="studio-consistency-places" data-testid="studio-consistency-places">
        {listed.slice(0, 100).map(({ place, spelling, rendering }) => <li key={`${place.documentId}:${place.cueId}`}>
          <span className="studio-consistency-place">{documents.length > 1 ? `${name(place.documentId)} · ` : ''}#{place.index + 1}</span>
          <span className="studio-consistency-place-text"><span><Marked text={place.source} wording={spelling} /></span>
            {place.target && <span className="text-muted-foreground"><Marked text={place.target} wording={rendering} /></span>}</span>
        </li>)}
      </ul>}
    </li>;
  };
  const description = documents.length > 1 ? t('studio:consistency.description_many', { documents: documents.length, count: cueCount }) : t('studio:consistency.description_one', { count: cueCount });

  return <ScrollableDialog animateSize open={open} maxWidth="sm:max-w-[680px]" contentClassName="studio-cue-revision-dialog"
    onOpenChange={value => { if (!value && pending !== 'apply' && pending !== 'undo') close(); }}
    onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>('[data-testid=studio-cue-list]')?.focus({ preventScroll: true }); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><ScanText className="size-4" />{t('studio:consistency.title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{description}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-revision-content" fadeMaskHeight={16}>
      <div className="studio-cue-revision-body">
        {!receipt && <div className="studio-cue-revision-form">
          <label htmlFor={`${id}-focus`} className="sr-only">{t('studio:consistency.focus')}</label>
          <div className="studio-cue-revision-options">
            <Input id={`${id}-focus`} data-testid="studio-consistency-focus" className="h-8 min-w-0 flex-[1_1_260px] text-xs" maxLength={500} value={focus} placeholder={t('studio:consistency.focus_placeholder')} disabled={!!pending}
              onChange={event => setFocus(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void check(); } }} />
            <Select value={profile?.id ?? ''} disabled={!!pending || !profiles.length} onValueChange={value => { setProfileId(value); memory.profileId = value; }}>
              <SelectTrigger aria-label={t('studio:cue_revision.model')} size="sm" className="studio-cue-revision-model min-w-0 text-xs"><SelectValue placeholder={t('studio:translation.select_model')} /></SelectTrigger>
              <SelectContent>{profiles.map(item => <SelectItem key={item.id} value={item.id}>{item.name || item.modelKey}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {materialLabel && <p className="studio-cue-revision-hint studio-cue-revision-materials" data-testid="studio-consistency-materials"><BookOpen />{t('studio:cue_revision.materials', { names: materialLabel })}</p>}
          {tooLarge && <p role="alert" className="studio-cue-revision-error"><AlertCircle />{t('studio:consistency.too_large', { documents: CONSISTENCY_DOCUMENT_LIMIT, count: CONSISTENCY_CUE_LIMIT })}</p>}
          {!configured && <div className="studio-translation-configuration"><p><AlertCircle className="size-4 shrink-0" />{t('studio:translation.model_required')}</p><Button variant="outline" size="sm" onClick={() => { close(); navigate('/setting?tab=model'); }}><Settings />{t('studio:translation.model_settings')}</Button></div>}
        </div>}
        {error && <p role="alert" className="studio-cue-revision-error"><AlertCircle />{t(`studio:cue_revision.errors.${error === 'translation_protocol_invalid' ? 'protocol_invalid' : error === 'translation_output_limit' ? 'output_limit' : 'failed'}`)}</p>}
        {pending === 'check' && <div className="studio-cue-revision-progress" role="status" data-testid="studio-consistency-progress"><span><LoaderCircle className="animate-spin" />{t('studio:consistency.checking', { count: cueCount })}</span></div>}
        {receipt && <section className="studio-cue-revision-result studio-consistency-receipt" data-testid="studio-consistency-receipt">
          {receipt.applied.length > 0 ? <p className="studio-cue-revision-summary"><span>{t('studio:consistency.applied', { groups: chosenGroups.length, count: receipt.applied.reduce((sum, item) => sum + item.count, 0), documents: receipt.applied.length })}</span></p>
            : !receipt.skipped.length && <p className="studio-cue-revision-summary"><span>{t('studio:consistency.undone')}</span></p>}
          {receipt.skipped.map(item => <p key={item.name} className="studio-cue-revision-hint" role="alert">{t(`studio:consistency.skipped_${item.reason}`, { name: item.name })}</p>)}
          {receipt.keep && <div className="studio-cue-revision-note studio-consistency-keep-note"><BookOpen /><span>{t('studio:consistency.keep_hint', { count: receipt.keep.length })}</span>
            <Button variant="outline" size="sm" className="ml-auto h-7 shrink-0 text-xs" data-testid="studio-consistency-keep-open" onClick={() => onKeep(receipt.keep!, () => setReceipt(value => value && { ...value, keep: undefined }))}>{t('studio:consistency.keep_open')}</Button></div>}
        </section>}
        {result && !receipt && <section className="studio-cue-revision-result" aria-label={t('studio:consistency.result')} data-testid="studio-consistency-result">
          <div className="studio-cue-revision-summary"><span aria-live="polite">{groups.length ? t('studio:consistency.summary', { count: groups.length, total: result.checkedLines }) : t('studio:consistency.none', { total: result.checkedLines })}</span></div>
          {groups.length > 0 && <ul className="studio-consistency-list">{groups.map(groupRow)}</ul>}
        </section>}
      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex flex-wrap items-center gap-2 p-3 sm:justify-between">
      <span className="studio-cue-revision-footnote">{editBlocked && current ? editBlocked : result && result.usage.totalTokens !== null ? t('studio:cue_revision.usage', { count: result.usage.totalTokens }) : t('studio:consistency.footnote')}</span>
      <div className="flex items-center gap-2">
        {pending === 'check' ? <Button variant="ghost" size="sm" data-testid="studio-consistency-stop" onClick={stop}>{t('studio:cue_revision.stop')}</Button>
          : <Button variant="ghost" size="sm" disabled={pending === 'apply' || pending === 'undo'} onClick={close}>{t(receipt ? 'studio:consistency.close' : 'studio:cancel')}</Button>}
        {receipt ? receipt.undo.length > 0 && <Button variant="outline" size="sm" data-testid="studio-consistency-undo" disabled={!!pending} onClick={() => void undo()}>{pending === 'undo' ? <LoaderCircle className="animate-spin" /> : <Undo2 />}{t('studio:consistency.undo')}</Button>
          : <Button variant={result ? 'outline' : 'default'} size="sm" data-testid="studio-consistency-check" disabled={!!pending || !configured || tooLarge || !documents.length} onClick={() => void check()}>
            {pending === 'check' ? <LoaderCircle className="animate-spin" /> : result ? <RotateCcw /> : <ScanText />}{t(result ? 'studio:consistency.recheck' : 'studio:consistency.check')}
          </Button>}
        {result && !receipt && groups.length > 0 && <Button size="sm" data-testid="studio-consistency-apply" disabled={!!pending || !chosenGroups.length} onClick={() => void apply()}>
          {pending === 'apply' ? <LoaderCircle className="animate-spin" /> : <Check />}{t('studio:consistency.apply', { groups: chosenGroups.length, count: estimated })}
        </Button>}
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
