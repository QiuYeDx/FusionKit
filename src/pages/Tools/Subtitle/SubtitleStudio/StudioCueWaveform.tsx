import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { CueAudioPeaks, CueAudioRequest } from '@/services/subtitle-studio/cue-audio-player';
import { CueAudioButton } from './StudioCueAudio';

/** What the time editor needs to show a cue's waveform: how to load it and how to play a stretch. */
export type CueWaveformSource = {
  load: (startMs: number, endMs: number, buckets: number) => Promise<CueAudioPeaks | null>;
  playKey: string;
  request: (startMs: number, endMs: number) => CueAudioRequest;
};

const BUCKETS = 320;
const HEIGHT = 36;
/** Dragged times snap to 10 ms. */
const STEP_MS = 10;

/**
 * The waveform around a cue being retimed, with its start and end as markers.
 * Dragging a marker (or pressing anywhere) moves the nearer one and writes the
 * time back to the editor's fields; the fields stay the source of truth.
 */
export function StudioCueWaveform({ source, viewStartMs, viewEndMs, startMs, endMs, onMove }: {
  source: CueWaveformSource;
  viewStartMs: number; viewEndMs: number;
  /** The times in the fields, or null while a field does not hold a valid time. */
  startMs: number | null; endMs: number | null;
  onMove: (which: 'start' | 'end', ms: number) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  // undefined while loading, null when the media could not be read.
  const [peaks, setPeaks] = useState<CueAudioPeaks | null | undefined>(undefined);
  const dragging = useRef<'start' | 'end' | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Loaded once per stretch: the list re-renders while it plays and passes a new source each time.
  const load = useRef(source.load);
  load.current = source.load;
  useEffect(() => {
    let live = true;
    void load.current(viewStartMs, viewEndMs, BUCKETS).then(value => { if (live) setPeaks(value); });
    return () => { live = false; };
  }, [viewStartMs, viewEndMs]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !peaks || !width) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(width * ratio); element.height = Math.round(HEIGHT * ratio);
    const context = element.getContext('2d');
    if (!context) return;
    const style = getComputedStyle(box.current!);
    const dim = style.getPropertyValue('--studio-wave-dim').trim(), active = style.getPropertyValue('--studio-wave-active').trim();
    const marker = style.getPropertyValue('--studio-wave-marker').trim();
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, HEIGHT);
    const span = viewEndMs - viewStartMs, x = (ms: number) => (ms - viewStartMs) / span * width;
    const middle = HEIGHT / 2, bars = peaks.peaks.length / 2;
    // Scaled to the loudest point shown, so quiet speech is still readable; near-silence is not blown up.
    let loudest = 0;
    for (const value of peaks.peaks) loudest = Math.max(loudest, Math.abs(value));
    const gain = 1 / Math.max(loudest, 0.05);
    for (let column = 0; column < width; column++) {
      const bucket = Math.min(bars - 1, Math.floor(column / width * bars));
      const min = peaks.peaks[bucket * 2] * gain, max = peaks.peaks[bucket * 2 + 1] * gain;
      const at = viewStartMs + (column + 0.5) / width * span;
      context.fillStyle = startMs !== null && at >= startMs && at <= (endMs ?? viewEndMs) ? active : dim;
      const top = middle - Math.max(0.5, max * (middle - 2)), bottom = middle - Math.min(-0.5, min * (middle - 2));
      context.fillRect(column, top, 1, bottom - top);
    }
    // Markers in the text colour, so they stand out from the highlighted stretch they bound.
    context.fillStyle = marker;
    for (const ms of [startMs, endMs]) {
      if (ms === null || ms < viewStartMs || ms > viewEndMs) continue;
      const left = Math.round(x(ms)) - 1;
      context.fillRect(left, 0, 2, HEIGHT);
      context.fillRect(left - 2, 0, 6, 4);
    }
  }, [peaks, width, startMs, endMs, viewStartMs, viewEndMs]);

  if (peaks === null) return null;
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ms = viewStartMs + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (viewEndMs - viewStartMs);
    return Math.round(ms / STEP_MS) * STEP_MS;
  };
  const playable = startMs !== null && endMs !== null && endMs > startMs;
  return <div className="studio-cue-waveform" data-testid="studio-cue-waveform" data-loaded={!!peaks || undefined}>
    <div ref={box} className="studio-cue-waveform-canvas" role="img" aria-label={t('studio:cue_listen.waveform')}
      // Keep focus in the time fields: leaving them saves the edit.
      onMouseDown={event => event.preventDefault()}
      onPointerDown={event => {
        if (!peaks || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const ms = at(event);
        const which = startMs === null ? 'start' : endMs === null ? (ms > startMs ? 'end' : 'start') : Math.abs(ms - startMs) <= Math.abs(ms - endMs) ? 'start' : 'end';
        dragging.current = which;
        event.currentTarget.setPointerCapture(event.pointerId);
        onMove(which, ms);
      }}
      onPointerMove={event => { if (dragging.current) onMove(dragging.current, at(event)); }}
      onPointerUp={event => { dragging.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragging.current = null; }}>
      {peaks && <canvas ref={canvas} style={{ width, height: HEIGHT }} />}
    </div>
    <CueAudioButton playKey={source.playKey} request={source.request(startMs ?? viewStartMs, playable ? endMs! : viewEndMs)}
      label={t('studio:cue_listen.play_edited')} data-testid="studio-cue-waveform-play" disabled={!playable} />
  </div>;
}
