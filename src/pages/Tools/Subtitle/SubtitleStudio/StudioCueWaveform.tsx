import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useCueAudio, type CueAudioPeaks, type CueAudioRequest } from '@/services/subtitle-studio/cue-audio-player';
import { CueAudioButton } from './StudioCueAudio';

/** What the time editor needs to show a cue's waveform: how to load it and how to play a stretch. */
export type CueWaveformSource = {
  load: (startMs: number, endMs: number, buckets: number) => Promise<CueAudioPeaks | null>;
  playKey: string;
  request: (startMs: number, endMs: number) => CueAudioRequest;
};

const BUCKETS = 320;
const HEIGHT = 44;
/** Bars two pixels wide with a one-pixel gap. */
const BAR = 2, PITCH = 3;
/** Dragged times snap to 10 ms. */
const STEP_MS = 10;

/**
 * The waveform around a cue being retimed, with its start and end as bracket markers.
 * Dragging a marker (or pressing anywhere) moves the nearer one and writes the time back to
 * the editor's fields; the fields stay the source of truth. A cue without an end shows where
 * it is heard until (the next line's start) as a dashed marker, and plays to there.
 */
export function StudioCueWaveform({ source, viewStartMs, viewEndMs, startMs, endMs, impliedEnd, onMove }: {
  source: CueWaveformSource;
  viewStartMs: number; viewEndMs: number;
  /** The times in the fields, or null while a field does not hold a valid time. */
  startMs: number | null; endMs: number | null;
  /** Where a cue without an end stops being heard, used while the end field is empty: the next line's start, or a default length. */
  impliedEnd?: { ms: number; toNext: boolean };
  onMove: (which: 'start' | 'end', ms: number) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  // undefined while loading, null when the media could not be read.
  const [peaks, setPeaks] = useState<CueAudioPeaks | null | undefined>(undefined);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const playback = useCueAudio(source.playKey);
  const span = viewEndMs - viewStartMs;
  const implied = endMs === null && impliedEnd !== undefined;
  const shownEnd = endMs ?? impliedEnd?.ms ?? null;

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [peaks === null]);
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
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, HEIGHT);
    const middle = HEIGHT / 2, reach = middle - 4, buckets = peaks.peaks.length / 2;
    // Scaled to the loudest point shown, so quiet speech is still readable; near-silence is not blown up.
    let loudest = 0;
    for (const value of peaks.peaks) loudest = Math.max(loudest, Math.abs(value));
    const gain = 1 / Math.max(loudest, 0.05);
    // A hairline baseline, so silence reads as a line rather than a row of dots.
    context.fillStyle = dim;
    context.fillRect(0, middle - 0.5, width, 1);
    for (let left = 0; left + BAR <= width; left += PITCH) {
      // Each bar takes the loudest of the buckets under it.
      const from = Math.floor(left / width * buckets), to = Math.max(from + 1, Math.ceil((left + PITCH) / width * buckets));
      let low = 0, high = 0;
      for (let bucket = from; bucket < Math.min(to, buckets); bucket++) {
        low = Math.min(low, peaks.peaks[bucket * 2]); high = Math.max(high, peaks.peaks[bucket * 2 + 1]);
      }
      const at = viewStartMs + (left + BAR / 2) / width * span;
      context.fillStyle = startMs !== null && at >= startMs && at <= (shownEnd ?? viewEndMs) ? active : dim;
      const up = high * gain * reach, down = -low * gain * reach;
      // Near-silence is left to the baseline.
      if (up + down < 1.5) continue;
      context.beginPath();
      context.roundRect(left, middle - up, BAR, up + down, 1);
      context.fill();
    }
  }, [peaks, width, startMs, shownEnd, viewStartMs, viewEndMs, span]);

  if (peaks === null) return null;
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ms = viewStartMs + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * span;
    return Math.round(ms / STEP_MS) * STEP_MS;
  };
  const place = (ms: number) => ({ left: `${Math.min(100, Math.max(0, (ms - viewStartMs) / span * 100))}%` }) as CSSProperties;
  const inView = (ms: number | null): ms is number => ms !== null && ms >= viewStartMs && ms <= viewEndMs;
  const playable = startMs !== null && shownEnd !== null && shownEnd > startMs;
  const playhead = playback?.phase === 'playing' && playback.positionMs !== null && inView(playback.positionMs) ? playback.positionMs : null;
  const seconds = playable ? ((shownEnd - startMs) / 1000).toFixed(2) : null;
  return <div className="studio-cue-waveform" data-testid="studio-cue-waveform" data-loaded={!!peaks || undefined}>
    <div ref={box} className="studio-cue-waveform-canvas" role="img" aria-label={t('studio:cue_listen.waveform')} data-dragging={dragging ?? undefined}
      onPointerDown={event => {
        if (!peaks || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const ms = at(event);
        const which = startMs === null ? 'start' : endMs === null && !implied ? (ms > startMs ? 'end' : 'start')
          : Math.abs(ms - startMs) <= Math.abs(ms - shownEnd!) ? 'start' : 'end';
        setDragging(which);
        event.currentTarget.setPointerCapture(event.pointerId);
        onMove(which, ms);
      }}
      onPointerMove={event => { if (dragging) onMove(dragging, at(event)); }}
      onPointerUp={event => { setDragging(null); event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => setDragging(null)}>
      {startMs !== null && shownEnd !== null && shownEnd > startMs && <span className="studio-cue-wave-region" data-implied={implied || undefined}
        style={{ ...place(startMs), right: `${100 - Math.min(100, Math.max(0, (shownEnd - viewStartMs) / span * 100))}%` }} />}
      {peaks ? <canvas ref={canvas} style={{ width, height: HEIGHT }} /> : <span className="studio-cue-wave-loading" />}
      {inView(startMs) && <span className="studio-cue-wave-marker" data-which="start" data-active={dragging === 'start' || undefined} style={place(startMs)} />}
      {inView(shownEnd) && <span className="studio-cue-wave-marker" data-which="end" data-implied={implied || undefined} data-active={dragging === 'end' || undefined} style={place(shownEnd)} />}
      {playhead !== null && <span className="studio-cue-wave-playhead" data-testid="studio-cue-waveform-playhead" style={place(playhead)} />}
    </div>
    <div className="studio-cue-waveform-foot">
      <CueAudioButton playKey={source.playKey} request={source.request(startMs ?? viewStartMs, playable ? shownEnd : viewEndMs)}
        label={t('studio:cue_listen.play_edited')} data-testid="studio-cue-waveform-play" disabled={!playable} />
      {seconds !== null && <span className="studio-cue-waveform-length" data-testid="studio-cue-waveform-length">
        {t(!implied ? 'studio:cue_listen.length' : impliedEnd!.toNext ? 'studio:cue_listen.length_to_next' : 'studio:cue_listen.length_unknown', { seconds })}
      </span>}
    </div>
  </div>;
}
