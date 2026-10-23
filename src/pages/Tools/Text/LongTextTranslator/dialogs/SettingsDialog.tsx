import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, LoaderCircle, Settings2 } from 'lucide-react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  LONG_TEXT_LANGUAGES,
  LONG_TEXT_LIMITS,
  STYLES,
  TXT_SPLITS,
  settingsSchema,
  type DocumentDetail,
  type LanguageTag,
  type LongTextSettings,
  type Pace,
  type SourceLanguage,
  type Style,
  type TxtSplit,
} from '@/long-text/contract';
import { isLanguageTag, labelKey } from '@/long-text/languages';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { emptyMaterials, resolveRunModel } from '@/services/long-text/model';
import useModelStore from '@/store/useModelStore';
import { useLongTextStore, type LongTextDefaults } from '@/store/tools/text/useLongTextStore';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { KNOWLEDGE_CHANGED_EVENT, newerSnapshot } from '@/translation-knowledge/library-events';
import { StudioMaterialsFields, materialProblem } from '../../../Subtitle/SubtitleStudio/StudioMaterialsFields';
import { InfoHint } from '../../../_shared/ui/InfoHint';
import { ToolField } from '../../../_shared/ui/ToolField';
import { ToolRadioButtonGroup } from '../../../_shared/ui/ToolRadioButtonGroup';
import { isTranslating } from '../hooks/useDocuments';
import { ERROR_LABELS, MODEL_PROBLEM_LABELS, PACE_LABELS, STYLE_LABELS, TXT_SPLIT_LABELS } from '../labels';
import { MODEL_SETTINGS_ROUTE, groupedCount, useLongTextPage, type PageDialog, type StartIntent } from '../page-context';
import { clearedCount } from './ConfirmDialog';
import { DialogFrame, DialogNote, useDialogRequest } from './DialogFrame';
import { costRangeText, tokenRange } from './estimate-text';

/** The settings form; numbers stay as typed until they are saved. */
export interface SettingsDraft {
  sourceLanguage: SourceLanguage;
  targetLanguage: LanguageTag;
  style: Style;
  instructions: string;
  profileId: string | null;
  pace: Pace;
  batchSourceTokens: string;
  /** Empty: automatic. */
  maxOutputTokens: string;
  /** TXT only; null for Markdown. */
  txtSplit: TxtSplit | null;
  /** The materials picker's draft; its language pair is always the page's (design §5.7). */
  materials: KnowledgeSelection;
}

const BATCH_TOKENS = settingsSchema.shape.batchSourceTokens;
const OUTPUT_TOKENS = settingsSchema.shape.maxOutputTokens.unwrap();
/** The model Select's value for "跟随任务模型" (`profileId: null`). */
const FOLLOW_TASK_MODEL = 'task-model';
const PACES = [1, 2, 4] as const satisfies readonly Pace[];

export function effectiveSource(sourceLanguage: SourceLanguage, detected: LanguageTag): LanguageTag {
  return sourceLanguage === 'auto' ? detected : sourceLanguage;
}

const withPair = (materials: KnowledgeSelection, source: LanguageTag, target: LanguageTag): KnowledgeSelection =>
  ({ ...materials, languagePair: { source, target } });

export function draftFromDetail(detail: Pick<DocumentDetail, 'settings' | 'detected' | 'structure'>): SettingsDraft {
  const { settings, detected, structure } = detail;
  return {
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    style: settings.style,
    instructions: settings.instructions,
    profileId: settings.profileId,
    pace: settings.pace,
    batchSourceTokens: String(settings.batchSourceTokens),
    maxOutputTokens: settings.maxOutputTokens === null ? '' : String(settings.maxOutputTokens),
    txtSplit: structure?.txtSplit ?? null,
    materials: withPair(settings.knowledge ?? emptyMaterials(settings.targetLanguage),
      effectiveSource(settings.sourceLanguage, detected.sourceLanguage), settings.targetLanguage),
  };
}

/** New page languages; the materials keep their collections and follow (a mismatch shows in the picker). */
export function changeLanguages(draft: SettingsDraft, patch: Partial<Pick<SettingsDraft, 'sourceLanguage' | 'targetLanguage'>>, detected: LanguageTag): SettingsDraft {
  const next = { ...draft, ...patch };
  return { ...next, materials: withPair(next.materials, effectiveSource(next.sourceLanguage, detected), next.targetLanguage) };
}

/**
 * The picker's new selection. A different source language it brings (a preset, the first collection
 * chosen) becomes the page's explicit source language, unless the languages are locked by a run.
 */
export function changeMaterials(draft: SettingsDraft, selection: KnowledgeSelection, detected: LanguageTag, languagesLocked: boolean): SettingsDraft {
  const picked = selection.languagePair.source;
  const adopt = !languagesLocked && isLanguageTag(picked) && picked !== effectiveSource(draft.sourceLanguage, detected);
  const sourceLanguage = adopt ? picked : draft.sourceLanguage;
  return { ...draft, sourceLanguage, materials: withPair(selection, effectiveSource(sourceLanguage, detected), draft.targetLanguage) };
}

/** A typed token count, or null when it is not a whole number accepted by `schema`. */
export function parseTokens(text: string, schema: typeof BATCH_TOKENS | typeof OUTPUT_TOKENS): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const parsed = schema.safeParse(Number(trimmed));
  return parsed.success ? parsed.data : null;
}

/**
 * The settings to save, or null while a field is invalid. Materials without collections are saved as
 * `null`; otherwise they take the page's languages and must pass `knowledgeSelectionSchema` (E11).
 */
export function settingsFromDraft(draft: SettingsDraft, detected: LanguageTag): LongTextSettings | null {
  const batchSourceTokens = parseTokens(draft.batchSourceTokens, BATCH_TOKENS);
  const automatic = !draft.maxOutputTokens.trim();
  const maxOutputTokens = automatic ? null : parseTokens(draft.maxOutputTokens, OUTPUT_TOKENS);
  if (batchSourceTokens === null || (!automatic && maxOutputTokens === null)) return null;
  const knowledge = draft.materials.collectionIds.length
    ? withPair(draft.materials, effectiveSource(draft.sourceLanguage, detected), draft.targetLanguage)
    : null;
  const parsed = settingsSchema.safeParse({
    sourceLanguage: draft.sourceLanguage, targetLanguage: draft.targetLanguage, style: draft.style, instructions: draft.instructions,
    knowledge, profileId: draft.profileId, pace: draft.pace, batchSourceTokens, maxOutputTokens,
  });
  return parsed.success ? parsed.data : null;
}

/** What new documents inherit (design §2 F4-3); a style matching the content's suggestion keeps suggesting. */
export function defaultsFromSettings(settings: LongTextSettings, suggestedStyle: Style): Partial<LongTextDefaults> {
  return {
    targetLanguage: settings.targetLanguage,
    style: settings.style === suggestedStyle ? null : settings.style,
    instructions: settings.instructions,
    profileId: settings.profileId,
    pace: settings.pace,
    batchSourceTokens: settings.batchSourceTokens,
    maxOutputTokens: settings.maxOutputTokens,
    knowledgeCollectionIds: settings.knowledge?.collectionIds ?? [],
  };
}

/** A field label with its "?" explanation; the control names itself with `aria-label` so the button stays out of its name. */
function HintedLabel({ text, hint }: { text: string; hint: string }) {
  const { t } = useTranslation('text');
  return <>{text}<InfoHint label={t('settings.info')}>{hint}</InfoHint></>;
}

/** A run queued behind a save, started once the saved settings are on screen (the run uses the page's model). */
interface QueuedRun { run: StartIntent; revision: number; dialog: PageDialog }

/**
 * Translation settings (720, design §3.3-F) for `page.dialog` of kind `settings`. One source language
 * control: the materials picker's own is hidden and its language pair follows this page (U1). With
 * `intent: 'run'` saving starts `dialog.run` ("保存并翻译"). While a run goes on the languages and the
 * paragraph detection are locked; changing them with translations present clears every translation.
 */
export function SettingsDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const navigate = useNavigate();
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const targetTrigger = useRef<HTMLButtonElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const ledgerButton = useRef<HTMLButtonElement>(null);
  /** The glossary was opened from here; returning focuses "管理…". */
  const toLedger = useRef(false);
  const profiles = useModelStore(state => state.profiles);
  const taskProfileId = useModelStore(state => state.assignment.taskExecution);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState('');
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<QueuedRun | null>(null);
  const libraryRead = useRef(0);
  const { request, shown, detail } = useDialogRequest('settings', (_request, current) => {
    setDraft(current ? draftFromDetail(current) : null);
    setDirty(false);
    setAdvanced('');
    setError('');
    setPending(false);
    setQueued(null);
    toLedger.current = false;
  });
  const open = !!request && !!detail && !!draft;

  const loadLibrary = useCallback(async () => {
    const read = ++libraryRead.current;
    setLibraryLoading(true);
    try {
      const result = await window.translationKnowledge.read();
      if (read === libraryRead.current) setLibrary(result.ok ? result.value : null);
    } catch {
      if (read === libraryRead.current) setLibrary(null);
    } finally {
      if (read === libraryRead.current) setLibraryLoading(false);
    }
  }, []);
  useEffect(() => {
    if (request) void loadLibrary();
  }, [request, loadLibrary]);
  useEffect(() => {
    if (!request) return;
    const changed = (event: Event) => setLibrary(current => newerSnapshot(current, (event as CustomEvent<LibrarySnapshot>).detail));
    window.addEventListener(KNOWLEDGE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(KNOWLEDGE_CHANGED_EVENT, changed);
  }, [request]);

  // "保存并翻译": start once the page shows the saved settings, so the run takes the model chosen here.
  const { start, isDialogOpen, closeDialog } = page;
  useEffect(() => {
    if (!queued || !detail || detail.revision < queued.revision) return;
    setQueued(null);
    void start(queued.run).finally(() => {
      setPending(false);
      // A run that could not start may have opened another dialog in this one's place.
      if (isDialogOpen(queued.dialog)) closeDialog();
    });
  }, [queued, detail, start, isDialogOpen, closeDialog]);

  if (!shown || !detail || !draft) return null;

  const detected = detail.detected.sourceLanguage;
  const { structure } = detail;
  const source = effectiveSource(draft.sourceLanguage, detected);
  const running = isTranslating(detail);
  const translations = clearedCount(detail.counts, false);
  const languagesChanged = source !== detail.languages.source || draft.targetLanguage !== detail.languages.target;
  const structureChanged = draft.txtSplit !== null && structure !== null && draft.txtSplit !== structure.txtSplit;
  const clearing = translations > 0 && (languagesChanged || structureChanged);
  const sameLanguage = source === draft.targetLanguage;
  const settings = settingsFromDraft(draft, detected);
  const materialsIssue = materialProblem(draft.materials, library);
  const taskProfile = profiles.find(profile => profile.id === taskProfileId) ?? null;
  const runModel = resolveRunModel({ profileId: draft.profileId, maxOutputTokens: settings?.maxOutputTokens ?? null }, profiles, taskProfile);
  const automaticModel = resolveRunModel({ profileId: draft.profileId, maxOutputTokens: null }, profiles, taskProfile);
  const runIntent = shown.intent === 'run';
  const batchInvalid = parseTokens(draft.batchSourceTokens, BATCH_TOKENS) === null;
  const outputInvalid = !!draft.maxOutputTokens.trim() && parseTokens(draft.maxOutputTokens, OUTPUT_TOKENS) === null;
  const canSave = !!settings && !sameLanguage && !materialsIssue && !pending
    && !(running && (languagesChanged || structureChanged)) && !(runIntent && 'problem' in runModel);

  const edit = (patch: Partial<SettingsDraft>) => {
    setDraft(current => current && { ...current, ...patch });
    setDirty(true);
  };
  const editLanguages = (patch: Partial<Pick<SettingsDraft, 'sourceLanguage' | 'targetLanguage'>>) => {
    setDraft(current => current && changeLanguages(current, patch, detected));
    setDirty(true);
  };
  const editMaterials = (selection: KnowledgeSelection) => {
    setDraft(current => current && changeMaterials(current, selection, detected, running));
    setDirty(true);
  };

  const save = async () => {
    if (!canSave || !settings || !request) return;
    setPending(true);
    setError('');
    let saved: DocumentDetail | null = null;
    try {
      if (dirty) {
        saved = await unwrap(window.longText.updateSettings({
          documentId: detail.id, expectedRevision: detail.revision, settings, clearTranslations: translations > 0 && languagesChanged,
        }));
        useLongTextStore.getState().setDefaults(defaultsFromSettings(settings, detail.detected.style));
      }
      if (structureChanged && draft.txtSplit) {
        saved = await unwrap(window.longText.resegment({ documentId: detail.id, txtSplit: draft.txtSplit, discardTranslations: translations > 0 }));
      }
    } catch (failure) {
      const code = errorCodeOf(failure);
      if (code === 'conflict') page.refreshDetail();
      // Settings saved before a failed resegmentation stay saved; the form keeps the rest.
      if (saved) page.applyDetail(saved);
      setDirty(dirty && !saved);
      setError(t(ERROR_LABELS[code]));
      setPending(false);
      return;
    }
    if (saved) page.applyDetail(saved);
    if (runIntent) {
      setQueued({ run: shown.run ?? { kind: 'full' }, revision: saved?.revision ?? detail.revision, dialog: request });
      return;
    }
    setPending(false);
    page.closeDialog();
  };
  const manageLedger = () => {
    if (!request) return;
    toLedger.current = true;
    page.openDialog({ kind: 'ledger', back: request });
  };

  const languageName = (tag: LanguageTag) => t(labelKey(tag));
  const languageItems = LONG_TEXT_LANGUAGES.map(tag => <SelectItem key={tag} value={tag}>{languageName(tag)}</SelectItem>);
  const modelValue = draft.profileId !== null && profiles.some(profile => profile.id === draft.profileId) ? draft.profileId : FOLLOW_TASK_MODEL;
  const estimate = page.estimate;
  const footerText = error ? null : estimate && t('settings.estimate', {
    count: groupedCount(estimate.value.segments, i18n.language), tokens: tokenRange(estimate.value),
  }) + (estimate.cost ? t('status.idle_cost', { cost: costRangeText(estimate.cost) }) : '');
  const saveLabel = clearing ? t('settings.save_and_clear') : runIntent ? t('settings.save_and_run') : t('settings.save');
  const saveIcon = pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" />;

  return <DialogFrame open={open} width={720} testId="long-text-settings" icon={<Settings2 />} title={t('settings.title')} name={detail.name}
    busy={pending}
    initialFocus={() => {
      if (toLedger.current) {
        toLedger.current = false;
        return ledgerButton.current;
      }
      if (shown.focus === 'model') return modelTrigger.current;
      if (shown.focus === 'materials') return body.current?.querySelector<HTMLElement>('[data-testid=studio-materials-choose]');
      return targetTrigger.current;
    }}
    footer={<>
      <p className="lt-dialog-footer-text" data-testid="long-text-settings-estimate">
        {error ? <span role="alert" className="text-destructive">{error}</span> : footerText}
      </p>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={page.closeDialog}>{t('settings.cancel')}</Button>
      {/* Clearing translations is the destructive variant of the same button (design §2 F4-5). */}
      {clearing
        ? <Button type="button" variant="destructive" size="sm" data-testid="long-text-settings-save" disabled={!canSave} onClick={() => void save()}>{saveIcon}{saveLabel}</Button>
        : <Button type="button" size="sm" data-testid="long-text-settings-save" disabled={!canSave} onClick={() => void save()}>{saveIcon}{saveLabel}</Button>}
    </>}>
    <div ref={body}>
      <DialogTransition transitionKey="running" stageClassName="pb-4">
        {running ? <DialogNote tone="info" testId="long-text-settings-running">{t('settings.running_note')}</DialogNote> : null}
      </DialogTransition>
      <div className="lt-settings">
        <div className="lt-settings-full">
          <div className="lt-settings-pair">
            <ToolField label={t('settings.source')} htmlFor={`${id}-source`}>
              <Select value={draft.sourceLanguage} disabled={running || pending}
                onValueChange={value => editLanguages({ sourceLanguage: value as SourceLanguage })}>
                <SelectTrigger id={`${id}-source`} data-testid="long-text-settings-source" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('settings.auto', { language: languageName(detected) })}</SelectItem>
                  {languageItems}
                </SelectContent>
              </Select>
            </ToolField>
            <ArrowRight className="lt-settings-arrow" aria-hidden="true" />
            <ToolField label={t('settings.target')} htmlFor={`${id}-target`}>
              <Select value={draft.targetLanguage} disabled={running || pending}
                onValueChange={value => editLanguages({ targetLanguage: value as LanguageTag })}>
                <SelectTrigger ref={targetTrigger} id={`${id}-target`} data-testid="long-text-settings-target" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{languageItems}</SelectContent>
              </Select>
            </ToolField>
          </div>
          <DialogTransition transitionKey={sameLanguage ? 'same' : 'clear'} stageClassName="pt-3">
            {sameLanguage ? <DialogNote tone="error">{t('settings.same_language')}</DialogNote>
              : translations > 0 && languagesChanged ? <DialogNote tone="warning" testId="long-text-settings-clear-warning">
                {t('settings.language_change_warning', { count: groupedCount(translations, i18n.language), language: languageName(detail.languages.target) })}
              </DialogNote> : null}
          </DialogTransition>
        </div>

        <div className="lt-settings-pair">
          <ToolField label={t('settings.model')} htmlFor={`${id}-model`}>
            <div>
              <Select value={modelValue} disabled={pending} onValueChange={value => edit({ profileId: value === FOLLOW_TASK_MODEL ? null : value })}>
                <SelectTrigger ref={modelTrigger} id={`${id}-model`} data-testid="long-text-settings-model" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_TASK_MODEL}>{t('settings.model_follow', { name: taskProfile?.name ?? '—' })}</SelectItem>
                  {profiles.map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <DialogTransition transitionKey="model" stageClassName="pt-2">
                {'problem' in runModel ? <div className="lt-settings-model-problem" data-testid="long-text-settings-model-problem">
                  <DialogNote tone="warning">{t(MODEL_PROBLEM_LABELS[runModel.problem])}</DialogNote>
                  <Button type="button" variant="outline" size="xs" onClick={() => navigate(MODEL_SETTINGS_ROUTE)}>{t('notices.model_settings')}</Button>
                </div> : null}
              </DialogTransition>
            </div>
          </ToolField>
          <ToolField className="lt-settings-second" label={<HintedLabel text={t('settings.pace')} hint={t('settings.pace_help')} />} testId="long-text-settings-pace">
            <ToolRadioButtonGroup<`${Pace}`> ariaLabel={t('settings.pace')} value={`${draft.pace}`} disabled={pending}
              options={PACES.map(pace => ({ value: `${pace}` as const, label: t(PACE_LABELS[pace]) }))}
              onValueChange={value => edit({ pace: Number(value) as Pace })} />
          </ToolField>
        </div>

        <ToolField label={t('settings.style')} testId="long-text-settings-style">
          <div className="lt-settings-pair lt-settings-style">
            <ToolRadioButtonGroup<Style> ariaLabel={t('settings.style')} value={draft.style} disabled={pending}
              options={STYLES.map(style => ({ value: style, label: t(STYLE_LABELS[style]) }))} onValueChange={style => edit({ style })} />
            <p className="lt-settings-second lt-dialog-hint">{t('settings.style_suggested', { style: t(STYLE_LABELS[detail.detected.style]) })}</p>
          </div>
        </ToolField>

        <ToolField label={t('settings.instructions')} htmlFor={`${id}-instructions`}
          action={<span className="lt-settings-count">{draft.instructions.length.toLocaleString(i18n.language)} / {LONG_TEXT_LIMITS.settingsInstructionChars.toLocaleString(i18n.language)}</span>}>
          <Textarea id={`${id}-instructions`} data-testid="long-text-settings-instructions" className="lt-settings-instructions" value={draft.instructions}
            maxLength={LONG_TEXT_LIMITS.settingsInstructionChars} placeholder={t('settings.instructions_placeholder')} disabled={pending}
            onChange={event => edit({ instructions: event.target.value })} />
        </ToolField>

        <div className="lt-materials" data-testid="long-text-settings-materials">
          <StudioMaterialsFields value={draft.materials} library={library} disabled={pending} loading={libraryLoading}
            onChange={editMaterials} onLibraryChange={setLibrary} onRefresh={() => void loadLibrary()} />
        </div>

        <div className="lt-settings-ledger">
          <span className="lt-settings-label">{t('settings.ledger')}</span>
          <span className="lt-settings-ledger-summary">
            {t('settings.ledger_summary', { total: groupedCount(detail.ledger.total, i18n.language), confirmed: groupedCount(detail.ledger.confirmed, i18n.language) })}
          </span>
          <Button ref={ledgerButton} type="button" variant="ghost" size="sm" data-testid="long-text-settings-ledger" disabled={pending} onClick={manageLedger}>
            {t('settings.ledger_manage')}
          </Button>
        </div>

        <Accordion type="single" collapsible value={advanced} onValueChange={setAdvanced} className="lt-settings-advanced" data-testid="long-text-settings-advanced">
          <AccordionItem value="advanced" className="border-0">
            <AccordionTrigger className="min-h-11 w-full cursor-pointer rounded-smooth-[11px] px-3 py-2 text-[13px] data-[state=open]:rounded-b-none">
              {t('settings.advanced')}
            </AccordionTrigger>
            <AccordionContent forceMount motionOpen={advanced === 'advanced'} aria-hidden={advanced !== 'advanced'} inert={advanced !== 'advanced'}
              className="px-3 pb-3 pt-1">
              <div className="lt-settings-advanced-fields">
                <ToolField label={<HintedLabel text={t('settings.batch_tokens')} hint={t('settings.batch_tokens_help')} />} htmlFor={`${id}-batch`}>
                  <div className="lt-settings-unit">
                    <Input id={`${id}-batch`} type="number" inputMode="numeric" data-testid="long-text-settings-batch" aria-label={t('settings.batch_tokens')}
                      className="h-8 text-xs" min={BATCH_TOKENS.minValue ?? undefined} max={BATCH_TOKENS.maxValue ?? undefined} step={100}
                      value={draft.batchSourceTokens} aria-invalid={batchInvalid || undefined} disabled={pending}
                      onChange={event => edit({ batchSourceTokens: event.target.value })} />
                    <span>{t('settings.tokens_unit')}</span>
                  </div>
                </ToolField>
                <ToolField label={<HintedLabel text={t('settings.max_output')} hint={t('settings.max_output_help')} />} htmlFor={`${id}-output`}>
                  <Input id={`${id}-output`} type="number" inputMode="numeric" data-testid="long-text-settings-output" aria-label={t('settings.max_output')}
                    className="h-8 text-xs" min={OUTPUT_TOKENS.minValue ?? undefined} max={OUTPUT_TOKENS.maxValue ?? undefined}
                    placeholder={t('settings.max_output_auto', { value: 'problem' in automaticModel ? '—' : automaticModel.model.maxOutputTokens.toLocaleString(i18n.language) })}
                    value={draft.maxOutputTokens} aria-invalid={outputInvalid || undefined} disabled={pending}
                    onChange={event => edit({ maxOutputTokens: event.target.value })} />
                </ToolField>
                {draft.txtSplit !== null && structure && <ToolField label={t('settings.txt_split')} htmlFor={`${id}-split`}>
                  <Select value={draft.txtSplit} disabled={running || pending} onValueChange={value => setDraft(current => current && { ...current, txtSplit: value as TxtSplit })}>
                    <SelectTrigger id={`${id}-split`} data-testid="long-text-settings-split" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{TXT_SPLITS.map(split => <SelectItem key={split} value={split}>
                      {split === 'auto' ? t(TXT_SPLIT_LABELS.auto, { mode: t(TXT_SPLIT_LABELS[structure.resolved]) }) : t(TXT_SPLIT_LABELS[split])}
                    </SelectItem>)}</SelectContent>
                  </Select>
                </ToolField>}
              </div>
              <DialogTransition transitionKey="structure" stageClassName="pt-3">
                {structureChanged && translations > 0 ? <DialogNote tone="warning" testId="long-text-settings-structure-warning">
                  {t('settings.structure_change_warning', { count: groupedCount(translations, i18n.language) })}
                </DialogNote> : null}
              </DialogTransition>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  </DialogFrame>;
}
