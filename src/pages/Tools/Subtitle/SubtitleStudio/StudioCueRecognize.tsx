import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRight, AudioWaveform, Check, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { LIMITS, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { editedText, type CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { CUE_RECOGNIZE_LIMITS } from '@/subtitle-studio/cue-recognize-contract';
import type { CueReviewReason } from '@/subtitle-studio/transcription-review';
import { transcriptionModelProfile, transcriptionModelSpeaks } from '@/subtitle-studio/transcription-model-profiles';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import { getStudioTranscriptionController } from '@/services/subtitle-studio/transcription-controller';
import { CueAudioButton, useStopCueAudioOnClose } from './StudioCueAudio';
import { CueReviewReasons } from './StudioCueReview';
import { Diff } from './StudioCueRevision';
import { TRANSCRIPTION_LANGUAGES } from './StudioTranscription';
import { resourceDisplayName } from './resource-names';
import './StudioCueRevision.css';
import './StudioCueRecognize.css';

const errorKeys = {
  resource_busy: 'studio:cue_recognize.errors.resource_busy',
  needs_configuration: 'studio:cue_recognize.errors.needs_configuration',
  limit_exceeded: 'studio:cue_recognize.errors.limit_exceeded',
  document_unavailable: 'studio:cue_recognize.errors.document_unavailable',
  interrupted: 'studio:cue_recognize.errors.interrupted',
  failed: 'studio:cue_recognize.errors.failed',
} as const;
const errorKey = (code: ErrorCode) => code in errorKeys ? errorKeys[code as keyof typeof errorKeys] : errorKeys.failed;

type Cue = DocumentPage['cues'][number];
type Item = { cueId: string; number: number; before: string; source: Cue['source']; state: 'waiting' | 'running' | 'done' | 'error'; text?: string; error?: ErrorCode;
  /** The review rules the result trips as the cue's new text, and its confidence. */
  reasons?: CueReviewReason[]; confidence?: number };
type Model = { id: string; resource: Parameters<typeof resourceDisplayName>[1] };
/** Kept for the session, so recognizing more cues starts with the last choices; `modelId` is also the model last loaded for it. */
const memory: { modelId?: string; language?: string; prompt?: string } = {};
/** Pages read at a time for cues listed off the page shown: the review bar may list one on each of a hundred pages. */
const PAGE_READS = 4;

export type CueRecognizeRequestState = { cueIds: string[]; serial: number;
  /** Where cues off the page shown are in the document (the review bar lists them across pages). */
  positions?: Record<string, number> };

/**
 * Recognizes the selected cues' original audio again with a local transcription
 * model, one after another, and shows each result against the current source.
 * Chosen results replace the source in one edit that undoes as a whole. A result
 * the review rules flag is shown with why and left unchosen.
 */
export function StudioCueRecognize({ page, request, editBlocked, onClose, onApply, onOpenTranscription }: {
  page: DocumentPage;
  request: CueRecognizeRequestState | null;
  editBlocked?: string;
  onClose: () => void;
  onApply: (operation: CueEditOperation, count: number) => Promise<boolean>;
  /** Goes to the transcription view, where models are installed. */
  onOpenTranscription: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const transcription = useStudioPreferences(state => state.transcription.config);
  const open = !!request;
  const [models, setModels] = useState<Model[] | undefined>();
  const [modelId, setModelId] = useState('');
  const [language, setLanguage] = useState('auto');
  const [prompt, setPrompt] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [reading, setReading] = useState(false);
  /** Cues asked for that could not be read, so are not listed. */
  const [unread, setUnread] = useState(0);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  /** The first cue of a run with another model waits for the server to load it. */
  const [loadingModel, setLoadingModel] = useState(false);
  const [applying, setApplying] = useState(false);
  const stopped = useRef(false);
  const documentId = page.summary.id;
  useStopCueAudioOnClose(open);

  // A new request starts over with the selected cues and the installed models.
  useEffect(() => {
    if (!request) return;
    const ids = request.cueIds.slice(0, CUE_RECOGNIZE_LIMITS.batch);
    const known = new Map<string, Pick<Item, 'number' | 'before' | 'source'>>();
    const take = (cues: readonly Cue[], offset: number) => cues.forEach((cue, index) => known.set(cue.id, { number: offset + index + 1, before: cue.source.plain, source: cue.source }));
    const list = () => ids.flatMap(cueId => { const cue = known.get(cueId); return cue ? [{ cueId, ...cue, state: 'waiting' as const }] : []; }).sort((a, b) => a.number - b.number);
    take(page.cues, page.offset);
    // Cues the review bar listed on other pages are read from those pages.
    const offsets = [...new Set(ids.flatMap(cueId => known.has(cueId) || request.positions?.[cueId] === undefined ? []
      : [Math.floor(request.positions[cueId] / LIMITS.pageSize) * LIMITS.pageSize]))];
    const listed = list();
    setItems(listed); setReading(offsets.length > 0); setUnread(offsets.length ? 0 : ids.length - listed.length);
    setAccepted(new Set()); setRunning(false); setLoadingModel(false); setApplying(false); stopped.current = false;
    setLanguage(memory.language ?? transcription.language); setPrompt(memory.prompt ?? '');
    setModels(undefined);
    let live = true;
    if (offsets.length) void (async () => {
      for (let next = 0; live && next < offsets.length; next += PAGE_READS)
        await Promise.all(offsets.slice(next, next + PAGE_READS).map(offset => window.subtitleStudio.readDocumentPage({ documentId, revision: page.summary.revision, offset })
          .then(read => { if (read.ok) take(read.value.cues, offset); }, () => undefined)));
      if (!live) return;
      // A page that changed or failed leaves its cues out, which the dialog says.
      const read = list();
      setItems(read); setUnread(ids.length - read.length); setReading(false);
    })();
    void window.subtitleStudio.listTranscriptionResources({}).then(result => {
      if (!live) return;
      const ready = result.ok ? result.value.resources.filter(item => item.resourceType === 'model' && item.status === 'ready')
        .map(item => ({ id: item.resourceId, resource: item })) : [];
      setModels(ready);
      // The last choice, else the model this document was transcribed with (its preserved transcript, or its task
      // when this session listed one), else the transcription setting.
      const transcribedWith = page.summary.transcriptionModelId
        ?? getStudioTranscriptionController().getState().tasks.find(task => task.documentId === documentId)?.modelId;
      const preferred = [memory.modelId, transcribedWith, transcription.modelId].find(value => value && ready.some(model => model.id === value));
      setModelId(preferred ?? ready[0]?.id ?? '');
    }, () => { if (live) setModels([]); });
    return () => { live = false; };
    // Only a new request resets the dialog; page reloads while it is open keep its results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.serial]);

  // What the chosen model can do: a locked language is used whatever was chosen, a forbidden prompt is not sent.
  const profile = transcriptionModelProfile(modelId);
  const usedLanguage = transcriptionModelSpeaks(profile, language) ? language : (profile.languages as readonly string[])[0]!;
  const promptForbidden = profile.prompt === 'forbid';
  const lockedLanguages = profile.languages === 'any' ? undefined : new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, { type: 'conjunction' })
    .format(profile.languages.map(value => { const known = TRANSCRIPTION_LANGUAGES.find(([code]) => code === value); return known ? t(known[1]) : value; }));
  // Sentences follow each other without a space in Chinese and Japanese.
  const modelHint = [profile.role === 'recognize' ? t('studio:cue_recognize.recognize_only_hint') : '',
    lockedLanguages ? t('studio:transcription.model_language_locked', { languages: lockedLanguages }) : '',
    promptForbidden ? t('studio:transcription.model_prompt_forbidden') : ''].filter(Boolean).join(/^(zh|ja)/.test(i18n.resolvedLanguage ?? i18n.language) ? '' : ' ');
  const nameOf = (model: Model) => resourceDisplayName(key => t(key), model.resource);
  const chosenModel = models?.find(model => model.id === modelId);

  const stop = () => {
    stopped.current = true;
    void window.subtitleStudio.cancelCueRecognition({});
  };
  const close = () => { if (running) stop(); onClose(); };
  const update = (cueId: string, patch: Partial<Item>) => setItems(current => current.map(item => item.cueId === cueId ? { ...item, ...patch } : item));
  const recognize = async () => {
    if (!modelId || running) return;
    // Another model than the one used last reloads the server before the first cue.
    setLoadingModel(memory.modelId !== modelId);
    memory.modelId = modelId; memory.language = language; memory.prompt = prompt;
    stopped.current = false; setRunning(true); setAccepted(new Set());
    setItems(current => current.map(({ cueId, number, before, source }) => ({ cueId, number, before, source, state: 'waiting' })));
    const chosen = new Set<string>();
    for (const item of items) {
      if (stopped.current) break;
      update(item.cueId, { state: 'running' });
      let result: Awaited<ReturnType<typeof window.subtitleStudio.recognizeCue>>;
      try {
        result = await window.subtitleStudio.recognizeCue({ documentId, cueId: item.cueId, modelId, language: usedLanguage,
          devicePreference: transcription.devicePreference, ...(prompt.trim() && !promptForbidden ? { initialPrompt: prompt.trim() } : {}) });
      } catch { result = { ok: false, error: 'transcription_failed' }; }
      setLoadingModel(false);
      if (!result.ok) {
        update(item.cueId, { state: stopped.current ? 'waiting' : 'error', error: result.error });
        // The model or server will not do better for the next cue.
        if (result.error === 'resource_busy' || result.error === 'needs_configuration') break;
        continue;
      }
      const { text, reasons, confidence } = result.value;
      update(item.cueId, { state: 'done', text, reasons, ...(confidence === undefined ? {} : { confidence }) });
      // A flagged result is never chosen for the user: it is worth hearing first.
      if (text && text !== item.before.trim() && !reasons.length) { chosen.add(item.cueId); setAccepted(new Set(chosen)); }
    }
    setRunning(false); setLoadingModel(false);
  };
  const changed = items.filter(item => item.state === 'done' && item.text && item.text !== item.before.trim());
  const flagged = items.filter(item => item.state === 'done' && item.text && item.reasons?.length).length;
  const apply = async () => {
    const operations: Extract<CueEditOperation, { kind: 'source' }>[] = changed.filter(item => accepted.has(item.cueId)).map(item => {
      // The page shown has the cue's latest text; a cue on another page keeps the text it was read with.
      const source = page.cues.find(cue => cue.id === item.cueId)?.source ?? item.source;
      return { kind: 'source' as const, cueId: item.cueId, text: editedText(source, item.text!) };
    });
    if (!operations.length) return;
    setApplying(true);
    const ok = await onApply(operations.length === 1 ? operations[0] : { kind: 'batch', operations }, operations.length);
    setApplying(false);
    if (ok) onClose();
  };

  const done = items.filter(item => item.state === 'done' || item.state === 'error').length;
  const selectedCount = changed.filter(item => accepted.has(item.cueId)).length;
  const row = (item: Item) => {
    const differs = item.state === 'done' && !!item.text && item.text !== item.before.trim();
    const checked = differs && accepted.has(item.cueId);
    const reasons = item.state === 'done' && item.text ? item.reasons ?? [] : [];
    return <li key={item.cueId} data-testid="studio-cue-recognize-item" data-state={item.state} data-accepted={checked || undefined} data-flagged={reasons.length ? '' : undefined}>
      <label className="studio-cue-revision-item">
        <Checkbox checked={checked} disabled={!differs || applying} aria-label={t('studio:cue_recognize.include', { number: item.number })}
          onCheckedChange={value => setAccepted(current => { const next = new Set(current); if (value === true) next.add(item.cueId); else next.delete(item.cueId); return next; })} />
        <span className="studio-cue-revision-number">
          <CueAudioButton playKey={`cue:${documentId}:${item.cueId}`} request={{ documentId, revision: page.summary.revision, target: { cueIds: [item.cueId] }, rows: [item.cueId] }}
            label={t('studio:cue_audio.play_cue', { number: item.number })} className="studio-cue-revision-audio" data-testid="studio-cue-recognize-play" />
          {item.number}
        </span>
        <span className="studio-cue-revision-texts">
          <span className="studio-cue-revision-text" data-field="source">
            {differs ? <Diff before={item.before} after={item.text!} /> : <span className={item.state === 'done' ? undefined : 'studio-cue-revision-unchanged'}>{item.before}</span>}
          </span>
          {item.state === 'running' && <span className="studio-cue-revision-tag"><LoaderCircle className="animate-spin" />{t('studio:cue_recognize.listening')}</span>}
          {item.state === 'done' && !item.text && <span className="studio-cue-revision-tag" data-tone="warning">{t('studio:cue_recognize.empty')}</span>}
          {item.state === 'done' && item.text && !differs && <span className="studio-cue-revision-tag"><Check />{t('studio:cue_recognize.same')}</span>}
          {reasons.length > 0 && <Tooltip delayDuration={250}>
            <TooltipTrigger asChild><span className="studio-cue-revision-tag" data-tone="warning" tabIndex={0} data-testid="studio-cue-recognize-flag">
              <TriangleAlert />{reasons.map(reason => t(`studio:cue_review.reasons.${reason}`)).join(t('studio:cue_review.separator'))}</span></TooltipTrigger>
            {/* Below the tag, clear of the text it is about. */}
            <TooltipContent side="bottom" align="start" sideOffset={6} className="studio-cue-review-tip"><CueReviewReasons entry={{ reasons, confidence: item.confidence }} /></TooltipContent>
          </Tooltip>}
          {item.state === 'error' && <span className="studio-cue-revision-tag" data-tone="warning" data-testid="studio-cue-recognize-error"><AlertCircle />{t(errorKey(item.error!))}</span>}
        </span>
      </label>
    </li>;
  };

  const noModels = models !== undefined && !models.length;
  const started = items.some(item => item.state !== 'waiting');
  return <ScrollableDialog animateSize open={open} maxWidth="sm:max-w-[640px]" contentClassName="studio-cue-revision-dialog studio-cue-recognize-dialog"
    onOpenChange={value => { if (!value && !applying) close(); }}
    onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>('[data-testid=studio-cue-list]')?.focus({ preventScroll: true }); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><AudioWaveform className="size-4" />{t('studio:cue_recognize.title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{t('studio:cue_recognize.description', { count: items.length })}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-cue-revision-content" fadeMaskHeight={16}>
      <div className="studio-cue-revision-body">
        <div className="studio-cue-revision-form">
          <div className="studio-cue-recognize-options">
            <Select value={modelId} disabled={running || !models?.length} onValueChange={setModelId}>
              <SelectTrigger aria-label={t('studio:cue_recognize.model')} data-testid="studio-cue-recognize-model" size="sm" className="w-full min-w-0 text-xs">
                {/* As in the transcription settings: the trigger names the model, the list adds what it suits. */}
                <SelectValue placeholder={models ? t('studio:cue_recognize.no_model') : t('studio:loading')}>{chosenModel && nameOf(chosenModel)}</SelectValue>
              </SelectTrigger>
              <SelectContent className="studio-cue-recognize-models" data-testid="studio-cue-recognize-models">{(models ?? []).map(model => {
                const option = transcriptionModelProfile(model.id);
                return <SelectItem key={model.id} value={model.id} textValue={nameOf(model)}>
                  <span className="studio-transcription-model-option"><span>{nameOf(model)}
                    {option.role === 'recognize' && <Badge variant="outline">{t('studio:transcription.model_recognize_only')}</Badge>}
                    {option.experimental && <Badge variant="outline">{t('studio:transcription.model_experimental')}</Badge>}</span>
                    {option.scenarioKey && <small>{t(option.scenarioKey)}</small>}</span>
                </SelectItem>;
              })}</SelectContent>
            </Select>
            <Select value={usedLanguage} disabled={running} onValueChange={setLanguage}>
              <SelectTrigger aria-label={t('studio:cue_recognize.language')} data-testid="studio-cue-recognize-language" size="sm" className="w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{TRANSCRIPTION_LANGUAGES.map(([value, key]) => <SelectItem key={value} value={value} disabled={!transcriptionModelSpeaks(profile, value)}>{t(key)}</SelectItem>)}
                {!TRANSCRIPTION_LANGUAGES.some(([value]) => value === usedLanguage) && <SelectItem value={usedLanguage}>{usedLanguage}</SelectItem>}</SelectContent>
            </Select>
          </div>
          <label htmlFor={`${id}-prompt`} className="sr-only">{t('studio:cue_recognize.prompt')}</label>
          <Input id={`${id}-prompt`} data-testid="studio-cue-recognize-prompt" className="h-8 text-xs" maxLength={CUE_RECOGNIZE_LIMITS.promptChars} value={promptForbidden ? '' : prompt}
            disabled={running || promptForbidden} placeholder={t('studio:cue_recognize.prompt_placeholder')} onChange={event => setPrompt(event.target.value)} />
          {modelHint && <p className="studio-cue-revision-hint" data-testid="studio-cue-recognize-model-hint">{modelHint}</p>}
          {noModels && <div className="studio-translation-configuration" data-testid="studio-cue-recognize-no-model">
            <p><AlertCircle className="size-4 shrink-0" />{t('studio:cue_recognize.no_model_hint')}</p>
            <Button variant="outline" size="sm" onClick={() => { close(); onOpenTranscription(); }}>{t('studio:cue_recognize.open_transcription')}</Button>
          </div>}
          {request && request.cueIds.length > CUE_RECOGNIZE_LIMITS.batch && <p className="studio-cue-revision-hint">{t('studio:cue_recognize.limited', { limit: CUE_RECOGNIZE_LIMITS.batch })}</p>}
          {unread > 0 && <p className="studio-cue-revision-hint" data-testid="studio-cue-recognize-unread">{t('studio:cue_recognize.unread', { count: unread })}</p>}
        </div>
        {running && <div className="studio-cue-revision-progress" role="status" data-testid="studio-cue-recognize-progress">
          <span><LoaderCircle className="animate-spin" />{t(loadingModel ? 'studio:cue_recognize.loading_model' : 'studio:cue_recognize.progress', { done: Math.min(done + 1, items.length), total: items.length })}</span>
          <span className="studio-cue-revision-bar" aria-hidden="true"><span style={{ width: `${done / Math.max(1, items.length) * 100}%` }} /></span>
        </div>}
        <section className="studio-cue-revision-result" aria-label={t('studio:cue_recognize.title')} data-testid="studio-cue-recognize-result">
          {started && !running && <div className="studio-cue-revision-summary"><span aria-live="polite" data-testid="studio-cue-recognize-summary">
            {t('studio:cue_recognize.summary', { done, changed: changed.length })}</span></div>}
          {flagged > 0 && <p className="studio-cue-revision-note studio-cue-recognize-flagged" role="note" data-testid="studio-cue-recognize-flagged">
            <TriangleAlert />{t('studio:cue_recognize.flagged', { count: flagged })}</p>}
          <ul className="studio-cue-revision-list">{items.map(row)}</ul>
        </section>
      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex flex-wrap items-center gap-2 p-3 sm:justify-between">
      <span className="studio-cue-revision-footnote">{editBlocked ?? t('studio:cue_recognize.footnote')}</span>
      <div className="flex items-center gap-2">
        {running
          ? <Button variant="ghost" size="sm" data-testid="studio-cue-recognize-stop" onClick={stop}>{t('studio:cue_recognize.stop')}</Button>
          : <Button variant="ghost" size="sm" disabled={applying} onClick={close}>{t('studio:cancel')}</Button>}
        <Button variant={started ? 'outline' : 'default'} size="sm" data-testid="studio-cue-recognize-start" disabled={running || applying || reading || !modelId || !items.length} onClick={() => void recognize()}>
          {running ? <LoaderCircle className="animate-spin" /> : started ? <RotateCcw /> : <AudioWaveform />}{t(started ? 'studio:cue_recognize.restart' : 'studio:cue_recognize.start')}
        </Button>
        {changed.length > 0 && <Button size="sm" data-testid="studio-cue-recognize-apply" disabled={running || applying || !!editBlocked || !selectedCount} onClick={() => void apply()}>
          {applying ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}{t('studio:cue_recognize.apply', { count: selectedCount })}
        </Button>}
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
