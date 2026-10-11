import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type MouseEvent } from 'react';
import { AlertCircle, AudioLines, FileAudio, LoaderCircle, Play, Repeat, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CueAudioPadding, CueAudioTempo, CueMediaStatus } from '@/subtitle-studio/cue-audio';
import { cueAudioPlayer, onCueMediaProblem, useCueAudio, type CueAudioFailure, type CueAudioRequest } from '@/services/subtitle-studio/cue-audio-player';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import { ToolRadioButtonGroup } from '../../_shared/ui/ToolRadioButtonGroup';
import { StudioFileName } from './StudioControls';
import './StudioCueAudio.css';

const failureKeys = {
  no_media: 'studio:cue_audio.errors.no_media',
  media_unavailable: 'studio:cue_audio.errors.media_unavailable',
  no_audio: 'studio:cue_audio.errors.no_audio',
  decode_failed: 'studio:cue_audio.errors.decode_failed',
  runtime_unavailable: 'studio:cue_audio.errors.runtime_unavailable',
  cancelled: 'studio:cue_audio.errors.failed',
  failed: 'studio:cue_audio.errors.failed',
} as const satisfies Record<CueAudioFailure, string>;

/* Media status per document, shared by the list, its toolbar and the dialogs; read once and again after changes. */
const statuses = new Map<string, CueMediaStatus>();
const reading = new Map<string, Promise<void>>();
const statusListeners = new Set<() => void>();
const announce = () => { for (const listener of statusListeners) listener(); };
function refreshMedia(documentId: string): Promise<void> {
  const pending = reading.get(documentId);
  if (pending) return pending;
  const next = window.subtitleStudio.getCueMedia({ documentId }).then(result => {
    if (result.ok) statuses.set(documentId, result.value); else statuses.delete(documentId);
  }, () => { statuses.delete(documentId); }).finally(() => { reading.delete(documentId); announce(); });
  reading.set(documentId, next);
  return next;
}
onCueMediaProblem(documentId => { void refreshMedia(documentId); });

export type CueMedia = ReturnType<typeof useCueMedia>;
/** The document's original media: its status (undefined until read) and the actions that change it. */
export function useCueMedia(documentId: string) {
  const status = useSyncExternalStore(listener => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; }, () => statuses.get(documentId));
  useEffect(() => { if (!statuses.has(documentId)) void refreshMedia(documentId); }, [documentId]);
  const refresh = useCallback(() => refreshMedia(documentId), [documentId]);
  const changed = (value: CueMediaStatus) => { statuses.set(documentId, value); cueAudioPlayer.stopFor(documentId); cueAudioPlayer.invalidate(documentId); announce(); };
  return {
    documentId, status, ready: status?.status === 'ready',
    refresh,
    /** Resolves false when the chosen file could not be used. */
    async choose() {
      const result = await window.subtitleStudio.chooseCueMedia({ documentId });
      if (result.ok && result.value) changed(result.value);
      return result.ok;
    },
    async clear() {
      const result = await window.subtitleStudio.clearCueMedia({ documentId });
      if (result.ok) changed(result.value);
      return result.ok;
    },
  };
}

/** Stops the clip when a dialog that may have started it closes. */
export function useStopCueAudioOnClose(open: boolean) {
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) cueAudioPlayer.stop();
    wasOpen.current = open;
  }, [open]);
}

const RING = 2 * Math.PI * 8.5;
/**
 * Plays or stops one stretch of original audio. Clicks never reach the row or
 * label behind it, so playing does not change a selection or a checkbox.
 */
export function CueAudioButton({ playKey, request, label, className, tabbable = true, ...props }: Omit<HTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  playKey: string; request: CueAudioRequest; label: string; tabbable?: boolean; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const playback = useCueAudio(playKey);
  const phase = playback?.phase ?? 'idle';
  const active = phase === 'loading' || phase === 'playing';
  const error = playback?.reason ? t(failureKeys[playback.reason]) : undefined;
  const click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); cueAudioPlayer.toggle(playKey, request); };
  return <Tooltip delayDuration={350} open={phase === 'error' ? true : undefined}>
    <TooltipTrigger asChild>
      <button type="button" {...props} className={cn('studio-cue-audio-button', className)} data-state={phase} tabIndex={tabbable ? undefined : -1}
        aria-label={active ? t('studio:cue_audio.stop') : label} aria-pressed={active} onClick={click} onPointerDown={event => event.stopPropagation()}
        // A click plays without taking focus, so focus stays in the list and no tooltip lingers over the row above.
        onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}>
        {phase === 'loading' ? <LoaderCircle className="studio-spin" />
          : phase === 'playing' ? <>
            <svg className="studio-cue-audio-ring" viewBox="0 0 20 20" aria-hidden="true"><circle className="studio-cue-audio-track" cx="10" cy="10" r="8.5" /><circle cx="10" cy="10" r="8.5" style={{ strokeDasharray: RING, strokeDashoffset: RING * (1 - (playback?.progress ?? 0)) } as CSSProperties} /></svg>
            <Square className="studio-cue-audio-stop" />
          </>
          : phase === 'error' ? <AlertCircle /> : <Play className="studio-cue-audio-play" />}
      </button>
    </TooltipTrigger>
    <TooltipContent sideOffset={6} className={error ? 'max-w-64' : undefined}>{error ?? (active ? t('studio:cue_audio.stop') : label)}</TooltipContent>
  </Tooltip>;
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
const PADDINGS = [
  { value: '0', key: 'studio:cue_audio.padding_none' }, { value: '300', key: 'studio:cue_audio.padding_short' }, { value: '1000', key: 'studio:cue_audio.padding_long' },
] as const satisfies readonly { value: `${CueAudioPadding}`; key: string }[];
const TEMPOS = ['0.5', '0.75', '1'] as const satisfies readonly `${CueAudioTempo}`[];

/** The list toolbar's original-audio button: which media the document plays from, choosing another, and the padding. */
export function StudioCueMediaControl({ media, openRequest = 0 }: { media: CueMedia;
  /** Increments to open the panel, as when P finds no media to play. */
  openRequest?: number }) {
  const { t } = useTranslation();
  const padMs = useStudioPreferences(state => state.cueAudioPadMs);
  const setPadMs = useStudioPreferences(state => state.setCueAudioPadMs);
  const tempo = useStudioPreferences(state => state.cueAudioTempo);
  const setTempo = useStudioPreferences(state => state.setCueAudioTempo);
  const loop = useStudioPreferences(state => state.cueAudioLoop);
  const setLoop = useStudioPreferences(state => state.setCueAudioLoop);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { status } = media;
  const handled = useRef(openRequest);
  useEffect(() => {
    if (openRequest === handled.current) return;
    handled.current = openRequest;
    setOpen(true); setFailed(false); void media.refresh();
  });
  const label = status?.status === 'ready' ? t('studio:cue_audio.media_ready', { name: status.name }) : status?.status === 'unavailable' ? t('studio:cue_audio.status.unavailable') : t('studio:cue_audio.media');
  // Busy buttons stay enabled: disabling the focused button would drop focus out of the panel and close it.
  const act = async (action: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { setFailed(!await action()); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setFailed(false); void media.refresh(); } }}>
    {/* The tooltip would cover the panel it names. */}
    <Tooltip delayDuration={350} open={open ? false : undefined}>
      <TooltipTrigger asChild><PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} data-testid="studio-cue-media" data-status={status?.status ?? 'loading'} className="studio-cue-media-trigger">
          <AudioLines />{status && status.status !== 'ready' ? <span className="studio-cue-media-dot" aria-hidden="true" />
            // Non-default playback shows on the button, so a slow or looping list is never a surprise.
            : tempo !== 1 ? <span className="studio-cue-media-badge" data-testid="studio-cue-media-tempo-badge" aria-hidden="true">{String(tempo).replace(/^0/, '')}</span>
            : loop ? <span className="studio-cue-media-badge" data-testid="studio-cue-media-loop-badge" aria-hidden="true"><Repeat /></span> : null}
        </Button>
      </PopoverTrigger></TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
    {/* Portaled, but React still bubbles its events to the cue list, whose selection would take focus and close it. */}
    <PopoverContent align="end" sideOffset={6} collisionPadding={8} className="studio-cue-media-panel" data-testid="studio-cue-media-panel"
      onMouseDown={stop} onPointerDown={stop} onPointerUp={stop} onPointerMove={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop}
      onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>('[data-testid=studio-cue-list]')?.focus({ preventScroll: true }); }}>
      <div className="studio-cue-media-title"><AudioLines />{t('studio:cue_audio.media')}</div>
      {status && status.status !== 'missing' ? <div className="studio-cue-media-file" data-status={status.status} data-testid="studio-cue-media-file">
        <FileAudio />
        <div>
          <div className="studio-cue-media-name"><StudioFileName name={status.name} /></div>
          <div className="studio-cue-media-via">{status.status === 'unavailable' ? t('studio:cue_audio.status.unavailable') : t(`studio:cue_audio.via.${status.via}`)}</div>
          {status.track && (() => {
            const label = [t('studio:cue_audio.track', { number: status.track.ordinal }), status.track.language, status.track.title].filter(Boolean).join(' · ');
            return <div className="studio-cue-media-track" data-testid="studio-cue-media-track" title={label}>{label}</div>;
          })()}
        </div>
      </div> : <p className="studio-cue-media-missing" data-testid="studio-cue-media-missing">{status ? t('studio:cue_audio.status.missing') : t('studio:loading')}</p>}
      {status && status.status !== 'ready' && <p className="studio-cue-media-hint">{t(status.status === 'missing' ? 'studio:cue_audio.status.missing_hint' : 'studio:cue_audio.status.unavailable_hint')}</p>}
      <div className="studio-cue-media-actions">
        <Button size="sm" variant="outline" aria-busy={busy} data-testid="studio-cue-media-choose" onClick={() => void act(media.choose)}>
          {busy ? <LoaderCircle className="studio-spin" /> : null}{t(status && status.status !== 'missing' ? 'studio:cue_audio.change' : 'studio:cue_audio.choose')}
        </Button>
        {status?.status !== 'missing' && status?.via === 'linked' && <Button size="sm" variant="ghost" aria-busy={busy} data-testid="studio-cue-media-clear" onClick={() => void act(media.clear)}>{t('studio:cue_audio.clear')}</Button>}
      </div>
      {failed && <p className="studio-cue-media-hint text-destructive" role="alert">{t('studio:cue_audio.choose_failed')}</p>}
      <div className="studio-cue-media-padding">
        <span>{t('studio:cue_audio.padding')}</span>
        <ToolRadioButtonGroup ariaLabel={t('studio:cue_audio.padding')} value={String(padMs) as `${CueAudioPadding}`}
          options={PADDINGS.map(option => ({ value: option.value, label: t(option.key), testId: `studio-cue-media-padding-${option.value}` }))}
          onValueChange={value => setPadMs(Number(value) as CueAudioPadding)} />
      </div>
      <div className="studio-cue-media-padding">
        <span>{t('studio:cue_listen.tempo')}</span>
        <ToolRadioButtonGroup ariaLabel={t('studio:cue_listen.tempo')} value={String(tempo) as `${CueAudioTempo}`}
          options={TEMPOS.map(value => ({ value, label: `${value}×`, testId: `studio-cue-media-tempo-${value}` }))}
          onValueChange={value => setTempo(Number(value) as CueAudioTempo)} />
      </div>
      <div className="studio-cue-media-loop">
        <label htmlFor="studio-cue-media-loop">{t('studio:cue_listen.loop')}</label>
        <Switch id="studio-cue-media-loop" checked={loop} onCheckedChange={setLoop} />
      </div>
      <dl className="studio-cue-media-keys">
        <dt>P</dt><dd>{t('studio:cue_help.play.desc')}</dd>
        <dt>Shift+P</dt><dd>{t('studio:cue_help.follow.desc')}</dd>
        <dt>[ / ]</dt><dd>{t('studio:cue_help.mark.desc')}</dd>
      </dl>
    </PopoverContent>
  </Popover>;
}
