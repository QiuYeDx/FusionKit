import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRight, AudioWaveform, Check, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { editedText, type CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { CUE_RECOGNIZE_LIMITS } from '@/subtitle-studio/cue-recognize-contract';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import { CueAudioButton, useStopCueAudioOnClose } from './StudioCueAudio';
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

type Item = { cueId: string; number: number; before: string; state: 'waiting' | 'running' | 'done' | 'error'; text?: string; error?: ErrorCode };
type Model = { id: string; resource: Parameters<typeof resourceDisplayName>[1] };
/** Kept for the session, so recognizing more cues starts with the last choices. */
const memory: { modelId?: string; language?: string; prompt?: string } = {};

export type CueRecognizeRequestState = { cueIds: string[]; serial: number };

/**
 * Recognizes the selected cues' original audio again with a local transcription
 * model, one after another, and shows each result against the current source.
 * Chosen results replace the source in one edit that undoes as a whole.
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
  const { t } = useTranslation();
  const id = useId();
  const transcription = useStudioPreferences(state => state.transcription.config);
  const open = !!request;
  const [models, setModels] = useState<Model[] | undefined>();
  const [modelId, setModelId] = useState('');
  const [language, setLanguage] = useState('auto');
  const [prompt, setPrompt] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const stopped = useRef(false);
  const documentId = page.summary.id;
  useStopCueAudioOnClose(open);

  // A new request starts over with the selected cues and the installed models.
  useEffect(() => {
    if (!request) return;
    const ids = new Set(request.cueIds.slice(0, CUE_RECOGNIZE_LIMITS.batch));
    setItems(page.cues.flatMap((cue, index) => ids.has(cue.id) ? [{ cueId: cue.id, number: page.offset + index + 1, before: cue.source.plain, state: 'waiting' as const }] : []));
    setAccepted(new Set()); setRunning(false); setApplying(false); stopped.current = false;
    setLanguage(memory.language ?? transcription.language); setPrompt(memory.prompt ?? '');
    setModels(undefined);
    let live = true;
    void window.subtitleStudio.listTranscriptionResources({}).then(result => {
      if (!live) return;
      const ready = result.ok ? result.value.resources.filter(item => item.resourceType === 'model' && item.status === 'ready')
        .map(item => ({ id: item.resourceId, resource: item })) : [];
      setModels(ready);
      const preferred = [memory.modelId, transcription.modelId].find(value => value && ready.some(model => model.id === value));
      setModelId(preferred ?? ready[0]?.id ?? '');
    }, () => { if (live) setModels([]); });
    return () => { live = false; };
    // Only a new request resets the dialog; page reloads while it is open keep its results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.serial]);

  const stop = () => {
    stopped.current = true;
    void window.subtitleStudio.cancelCueRecognition({});
  };
  const close = () => { if (running) stop(); onClose(); };
  const update = (cueId: string, patch: Partial<Item>) => setItems(current => current.map(item => item.cueId === cueId ? { ...item, ...patch } : item));
  const recognize = async () => {
    if (!modelId || running) return;
    memory.modelId = modelId; memory.language = language; memory.prompt = prompt;
    stopped.current = false; setRunning(true); setAccepted(new Set());
    setItems(current => current.map(item => ({ cueId: item.cueId, number: item.number, before: item.before, state: 'waiting' })));
    const chosen = new Set<string>();
    for (const item of items) {
      if (stopped.current) break;
      update(item.cueId, { state: 'running' });
      let result: Awaited<ReturnType<typeof window.subtitleStudio.recognizeCue>>;
      try {
        result = await window.subtitleStudio.recognizeCue({ documentId, cueId: item.cueId, modelId, language,
          devicePreference: transcription.devicePreference, ...(prompt.trim() ? { initialPrompt: prompt.trim() } : {}) });
      } catch { result = { ok: false, error: 'transcription_failed' }; }
      if (!result.ok) {
        update(item.cueId, { state: stopped.current ? 'waiting' : 'error', error: result.error });
        // The model or server will not do better for the next cue.
        if (result.error === 'resource_busy' || result.error === 'needs_configuration') break;
        continue;
      }
      const text = result.value.text;
      update(item.cueId, { state: 'done', text });
      if (text && text !== item.before.trim()) { chosen.add(item.cueId); setAccepted(new Set(chosen)); }
    }
    setRunning(false);
  };
  const changed = items.filter(item => item.state === 'done' && item.text && item.text !== item.before.trim());
  const apply = async () => {
    const operations: Extract<CueEditOperation, { kind: 'source' }>[] = changed.filter(item => accepted.has(item.cueId)).flatMap(item => {
      const cue = page.cues.find(value => value.id === item.cueId);
      return cue ? [{ kind: 'source' as const, cueId: cue.id, text: editedText(cue.source, item.text!) }] : [];
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
    return <li key={item.cueId} data-testid="studio-cue-recognize-item" data-state={item.state} data-accepted={checked || undefined}>
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
                <SelectValue placeholder={models ? t('studio:cue_recognize.no_model') : t('studio:loading')} />
              </SelectTrigger>
              <SelectContent>{(models ?? []).map(model => <SelectItem key={model.id} value={model.id}>{resourceDisplayName(key => t(key), model.resource)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={language} disabled={running} onValueChange={setLanguage}>
              <SelectTrigger aria-label={t('studio:cue_recognize.language')} data-testid="studio-cue-recognize-language" size="sm" className="w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{TRANSCRIPTION_LANGUAGES.map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}
                {!TRANSCRIPTION_LANGUAGES.some(([value]) => value === language) && <SelectItem value={language}>{language}</SelectItem>}</SelectContent>
            </Select>
          </div>
          <label htmlFor={`${id}-prompt`} className="sr-only">{t('studio:cue_recognize.prompt')}</label>
          <Input id={`${id}-prompt`} data-testid="studio-cue-recognize-prompt" className="h-8 text-xs" maxLength={CUE_RECOGNIZE_LIMITS.promptChars} value={prompt} disabled={running}
            placeholder={t('studio:cue_recognize.prompt_placeholder')} onChange={event => setPrompt(event.target.value)} />
          {noModels && <div className="studio-translation-configuration" data-testid="studio-cue-recognize-no-model">
            <p><AlertCircle className="size-4 shrink-0" />{t('studio:cue_recognize.no_model_hint')}</p>
            <Button variant="outline" size="sm" onClick={() => { close(); onOpenTranscription(); }}>{t('studio:cue_recognize.open_transcription')}</Button>
          </div>}
          {request && request.cueIds.length > CUE_RECOGNIZE_LIMITS.batch && <p className="studio-cue-revision-hint">{t('studio:cue_recognize.limited', { limit: CUE_RECOGNIZE_LIMITS.batch })}</p>}
        </div>
        {running && <div className="studio-cue-revision-progress" role="status" data-testid="studio-cue-recognize-progress">
          <span><LoaderCircle className="animate-spin" />{t('studio:cue_recognize.progress', { done: Math.min(done + 1, items.length), total: items.length })}</span>
          <span className="studio-cue-revision-bar" aria-hidden="true"><span style={{ width: `${done / Math.max(1, items.length) * 100}%` }} /></span>
        </div>}
        <section className="studio-cue-revision-result" aria-label={t('studio:cue_recognize.title')} data-testid="studio-cue-recognize-result">
          {started && !running && <div className="studio-cue-revision-summary"><span aria-live="polite" data-testid="studio-cue-recognize-summary">
            {t('studio:cue_recognize.summary', { done, changed: changed.length })}</span></div>}
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
        <Button variant={started ? 'outline' : 'default'} size="sm" data-testid="studio-cue-recognize-start" disabled={running || applying || !modelId || !items.length} onClick={() => void recognize()}>
          {running ? <LoaderCircle className="animate-spin" /> : started ? <RotateCcw /> : <AudioWaveform />}{t(started ? 'studio:cue_recognize.restart' : 'studio:cue_recognize.start')}
        </Button>
        {changed.length > 0 && <Button size="sm" data-testid="studio-cue-recognize-apply" disabled={running || applying || !!editBlocked || !selectedCount} onClick={() => void apply()}>
          {applying ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}{t('studio:cue_recognize.apply', { count: selectedCount })}
        </Button>}
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
