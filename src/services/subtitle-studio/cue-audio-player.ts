import { useSyncExternalStore } from 'react';
import { CUE_AUDIO_LIMITS, type CueAudioClip, type CueAudioPadding, type CueAudioResult, type CueAudioTarget, type CueAudioTempo, type CueAudioUnavailable } from '@/subtitle-studio/cue-audio';
import type { StudioResult } from '@/subtitle-studio/ipc-contract';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';

/** What to play: cues of a document (or a stretch of it), and the cue rows it covers for display. */
export type CueAudioRequest = {
  documentId: string;
  target: CueAudioTarget;
  /** The document revision the caller shows; clips are reused only for the same revision. */
  revision?: number;
  /** Cue ids the stretch covers, so lists can mark them while it plays. */
  rows?: readonly string[];
};
/** Continuous playback from a point of the media to its end. */
export type CueAudioFollowRequest = { documentId: string; fromMs: number;
  /** Where the media ends, when known (transcribed documents); otherwise the main process reports the end. */
  endMs?: number };
export type CueAudioFailure = CueAudioUnavailable | 'failed';
export type CueAudioPlayback = {
  key: string; documentId: string; rows: readonly string[];
  /** One stretch, or continuous playback that a list follows. */
  mode: 'clip' | 'follow';
  phase: 'loading' | 'playing' | 'error';
  /** Played share of a stretch (0 while following). */
  progress: number;
  /** Where in the original media the audio is, in milliseconds; published about ten times a second. */
  positionMs: number | null;
  reason?: CueAudioFailure;
};
export type CueAudioSettings = { padMs: CueAudioPadding; tempo: CueAudioTempo; loop: boolean };

/** The parts of the Web Audio API the player uses, so tests can drive its clock. */
export type AudioBufferLike = { readonly duration: number; getChannelData(channel: number): Float32Array };
export type AudioSourceLike = {
  buffer: AudioBufferLike | null; loop: boolean; onended: (() => void) | null;
  connect(destination: unknown): unknown; disconnect(): void; start(when?: number): void; stop(when?: number): void;
};
export type AudioContextLike = {
  readonly currentTime: number; readonly destination: unknown; readonly outputLatency?: number; readonly baseLatency?: number; readonly state: string;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioSourceLike;
  resume(): Promise<void>;
};
export type CueAudioPlayerDependencies = {
  read: (request: { documentId: string; target: CueAudioTarget; padMs: CueAudioPadding; tempo: CueAudioTempo; purpose?: 'waveform' }) => Promise<StudioResult<CueAudioResult>>;
  settings: () => CueAudioSettings;
  createContext?: () => AudioContextLike;
  frame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Called when a document's media turned out missing or moved, so its status can be read again. */
  onMediaProblem?: (documentId: string) => void;
};

/** Loudness of a stretch for drawing: per bucket the lowest and highest sample, from -1 to 1. */
export type CueAudioPeaks = { startMs: number; endMs: number; peaks: Float32Array };
/** Folds a decoded WAV into `buckets` pairs of [min, max]. */
export function pcmPeaks(bytes: Uint8Array, buckets: number): Float32Array {
  const samples = Math.floor((bytes.length - 44) / 2);
  const pcm = new DataView(bytes.buffer, bytes.byteOffset + 44, samples * 2);
  const peaks = new Float32Array(buckets * 2);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = Math.floor(bucket * samples / buckets), to = Math.max(from + 1, Math.floor((bucket + 1) * samples / buckets));
    let min = 0, max = 0;
    for (let i = from; i < Math.min(to, samples); i++) { const value = pcm.getInt16(i * 2, true) / 32768; if (value < min) min = value; if (value > max) max = value; }
    peaks[bucket * 2] = min; peaks[bucket * 2 + 1] = max;
  }
  return peaks;
}

const CACHE_SIZE = 6;
const PEAKS_CACHE_SIZE = 4;
const ERROR_MS = 4000;
/** Continuous playback asks for the media in stretches of this length. */
export const FOLLOW_CHUNK_MS = 20_000;
const START_DELAY_S = 0.02;
const POSITION_STEP_MS = 100;

type Segment = { source: AudioSourceLike; ctxStart: number; duration: number; mediaStartMs: number; tempo: CueAudioTempo };
type Clip = { buffer: AudioBufferLike; meta: CueAudioClip };
type Session = {
  serial: number; key: string; documentId: string; rows: readonly string[]; mode: 'clip' | 'follow'; tempo: CueAudioTempo;
  segments: Segment[];
  /** A stretch: its media end, to restart there at another speed. */
  clipEndMs?: number;
  /** Following: the media start of the next stretch to ask for (null when the end is reached), its end and whether a request is out. */
  nextMs?: number | null; endMs?: number; fetching?: boolean;
};

type PeaksRequest = { documentId: string; revision?: number; startMs: number; endMs: number };

/**
 * One player for the whole studio: starting playback stops what played before.
 * Stretches are decoded by the main process on request and played through Web
 * Audio, so continuous playback joins them without gaps and the position in
 * the original media is known to the millisecond. Slower speeds are stretched
 * by the main process (the pitch stays); the player always plays at 1x and
 * converts the clock back to media time.
 */
export function createCueAudioPlayer(dependencies: CueAudioPlayerDependencies) {
  const frame = dependencies.frame ?? (callback => requestAnimationFrame(callback));
  const cancelFrame = dependencies.cancelFrame ?? (handle => cancelAnimationFrame(handle));
  const listeners = new Set<() => void>();
  const cache = new Map<string, Clip>();
  const peaksCache = new Map<string, CueAudioPeaks>();
  const epochs = new Map<string, number>();
  const peaksKey = (request: PeaksRequest, buckets: number) => request.revision === undefined ? undefined
    : `${request.documentId}|${request.revision}|${epochs.get(request.documentId) ?? 0}|${request.startMs}|${request.endMs}|${buckets}`;
  let context: AudioContextLike | undefined;
  let state: CueAudioPlayback | null = null;
  let session: Session | null = null;
  let serial = 0;
  let ticking: number | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  const audio = () => context ??= dependencies.createContext?.() ?? (new AudioContext() as unknown as AudioContextLike);
  const publish = (next: CueAudioPlayback | null) => { state = next; for (const listener of listeners) listener(); };
  const latency = (ctx: AudioContextLike) => ctx.outputLatency || ctx.baseLatency || 0;
  const stopTicking = () => { if (ticking !== undefined) cancelFrame(ticking); ticking = undefined; };

  function buffer(clip: CueAudioClip): AudioBufferLike {
    const samples = Math.floor((clip.bytes.length - 44) / 2);
    const pcm = new DataView(clip.bytes.buffer, clip.bytes.byteOffset + 44, samples * 2);
    const created = audio().createBuffer(1, Math.max(1, samples), CUE_AUDIO_LIMITS.sampleRate);
    const channel = created.getChannelData(0);
    for (let i = 0; i < samples; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
    return created;
  }
  function silence(current: Session | null) {
    for (const segment of current?.segments ?? []) {
      segment.source.onended = null;
      try { segment.source.stop(); } catch { /* Not started or already stopped. */ }
      segment.source.disconnect();
    }
  }
  /** Media time now, from the audio clock less the output delay; null before anything plays. */
  function position(current: Session): number | null {
    const ctx = context;
    if (!ctx || !current.segments.length) return null;
    const heard = ctx.currentTime - latency(ctx);
    const segment = [...current.segments].reverse().find(item => item.ctxStart <= heard) ?? current.segments[0];
    let elapsed = Math.max(0, heard - segment.ctxStart);
    elapsed = segment.source.loop ? elapsed % segment.duration : Math.min(elapsed, segment.duration);
    return Math.round(segment.mediaStartMs + elapsed * 1000 * segment.tempo);
  }
  function fail(current: Session, reason: CueAudioFailure) {
    if (current.serial !== serial) return;
    silence(current); session = null; stopTicking();
    publish({ key: current.key, documentId: current.documentId, rows: current.rows, mode: current.mode, phase: 'error', progress: 0, positionMs: null, reason });
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { if (current.serial === serial && state?.phase === 'error') publish(null); }, ERROR_MS);
  }
  function finish(current: Session) {
    if (current.serial !== serial) return;
    silence(current); session = null; stopTicking(); publish(null);
  }
  /** Media that went missing or moved has its status read again. */
  function noteUnavailable(documentId: string, reason: CueAudioUnavailable) {
    if (reason === 'no_media' || reason === 'media_unavailable') dependencies.onMediaProblem?.(documentId);
  }
  function unavailable(current: Session, documentId: string, reason: CueAudioUnavailable) {
    noteUnavailable(documentId, reason);
    if (reason === 'cancelled') { if (current.serial === serial) { session = null; stopTicking(); publish(null); } return; }
    fail(current, reason);
  }
  function schedule(current: Session, clip: Clip, loop: boolean) {
    const ctx = audio();
    const source = ctx.createBufferSource();
    source.buffer = clip.buffer; source.loop = loop;
    source.connect(ctx.destination);
    const last = current.segments.at(-1);
    const when = Math.max(ctx.currentTime + START_DELAY_S, last ? last.ctxStart + last.duration : 0);
    source.start(when);
    current.segments.push({ source, ctxStart: when, duration: clip.buffer.duration, mediaStartMs: clip.meta.clipStartMs, tempo: clip.meta.tempo });
    // Only a stretch ends by itself; following ends once its last stretch has played.
    if (current.mode === 'clip') source.onended = () => finish(current);
  }
  function tick(current: Session) {
    ticking = undefined;
    if (current.serial !== serial || session !== current || !context) return;
    const ctx = context;
    if (current.mode === 'follow') {
      const last = current.segments.at(-1);
      // Ask for the next stretch once the last one asked for has started playing.
      if (!current.fetching && current.nextMs != null && (!last || ctx.currentTime >= last.ctxStart)) void fetchNext(current);
      if (last && ctx.currentTime >= last.ctxStart + last.duration) {
        if (current.nextMs == null && !current.fetching) return finish(current);
        if (state?.phase === 'playing') publish({ ...state, phase: 'loading' });
      }
    }
    const positionMs = position(current);
    if (state && positionMs !== null) {
      let progress = 0;
      if (current.mode === 'clip') {
        const segment = current.segments[0];
        const elapsed = Math.max(0, ctx.currentTime - segment.ctxStart);
        progress = Math.min(1, (segment.source.loop ? elapsed % segment.duration : elapsed) / segment.duration);
      }
      const moved = state.positionMs === null || Math.abs(positionMs - state.positionMs) >= POSITION_STEP_MS || Math.abs(progress - state.progress) >= 0.01;
      const playing = state.phase === 'loading' && current.segments.some(segment => segment.ctxStart <= ctx.currentTime && ctx.currentTime < segment.ctxStart + segment.duration);
      if (moved || playing) publish({ ...state, progress, positionMs, phase: playing ? 'playing' : state.phase });
    }
    ticking = frame(() => tick(current));
  }
  async function fetchNext(current: Session) {
    const startMs = current.nextMs!;
    if (current.endMs !== undefined && startMs >= current.endMs) { current.nextMs = null; return; }
    current.fetching = true;
    const endMs = current.endMs !== undefined ? Math.min(startMs + FOLLOW_CHUNK_MS, current.endMs) : startMs + FOLLOW_CHUNK_MS;
    let result: StudioResult<CueAudioResult>;
    try { result = await dependencies.read({ documentId: current.documentId, target: { range: { startMs, endMs } }, padMs: 0, tempo: current.tempo }); }
    catch { return fail(current, 'failed'); }
    finally { current.fetching = false; }
    if (current.serial !== serial || session !== current) return;
    const started = current.segments.length > 0;
    // Past the end of the media: what is scheduled plays out.
    if ((!result.ok && result.error === 'invalid_input' && started) || (result.ok && result.value.kind === 'unavailable' && result.value.reason === 'no_audio' && started)) { current.nextMs = null; return; }
    if (!result.ok) return fail(current, 'failed');
    if (result.value.kind === 'unavailable') return unavailable(current, current.documentId, result.value.reason);
    const clip = result.value;
    schedule(current, { buffer: buffer(clip), meta: clip }, false);
    // A stretch cut short by the media's known length was the last one.
    current.nextMs = clip.endMs < endMs ? null : endMs;
    if (state?.phase === 'loading' && !started) publish({ ...state, phase: 'playing', positionMs: position(current) });
  }
  const cacheKey = (request: CueAudioRequest, settings: CueAudioSettings, revision = request.revision) => revision === undefined ? undefined
    : `${request.documentId}|${revision}|${epochs.get(request.documentId) ?? 0}|${settings.padMs}|${settings.tempo}|${JSON.stringify(request.target)}`;
  function remember(key: string, clip: Clip) {
    cache.delete(key); cache.set(key, clip);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  }
  function begin(key: string, documentId: string, rows: readonly string[], mode: 'clip' | 'follow', tempo: CueAudioTempo): Session {
    stop();
    const current: Session = { serial, key, documentId, rows, mode, tempo, segments: [] };
    session = current;
    void audio().resume().catch(() => undefined);
    publish({ key, documentId, rows, mode, phase: 'loading', progress: 0, positionMs: null });
    return current;
  }

  function stop() {
    serial++;
    clearTimeout(errorTimer);
    stopTicking();
    silence(session); session = null;
    if (state) publish(null);
  }
  async function playClip(key: string, request: CueAudioRequest, settings = dependencies.settings()) {
    const current = begin(key, request.documentId, request.rows ?? [], 'clip', settings.tempo);
    const known = cacheKey(request, settings);
    let clip = known ? cache.get(known) : undefined;
    if (clip && known) remember(known, clip);
    if (!clip) {
      let result: StudioResult<CueAudioResult>;
      try { result = await dependencies.read({ documentId: request.documentId, target: request.target, padMs: settings.padMs, tempo: settings.tempo }); }
      catch { return fail(current, 'failed'); }
      if (current.serial !== serial) return;
      if (!result.ok) return fail(current, 'failed');
      if (result.value.kind === 'unavailable') return unavailable(current, request.documentId, result.value.reason);
      clip = { buffer: buffer(result.value), meta: result.value };
      const store = request.revision === result.value.revision ? cacheKey(request, settings, result.value.revision) : undefined;
      if (store) remember(store, clip);
    }
    current.clipEndMs = clip.meta.clipEndMs;
    schedule(current, clip, settings.loop);
    publish({ ...state!, phase: 'playing', positionMs: position(current) });
    ticking = frame(() => tick(current));
  }
  function playFollow(key: string, request: CueAudioFollowRequest, settings = dependencies.settings()) {
    const current = begin(key, request.documentId, [], 'follow', settings.tempo);
    current.nextMs = Math.max(0, request.fromMs);
    if (request.endMs !== undefined) current.endMs = request.endMs;
    ticking = frame(() => tick(current));
  }

  return {
    /** Plays the request, or stops it when the same key is already loading or playing. */
    toggle(key: string, request: CueAudioRequest) {
      if (state?.key === key && state.phase !== 'error') { stop(); return; }
      void playClip(key, request);
    },
    /** Plays continuously from a point to the end, for a list to follow; the same key stops it. */
    follow(key: string, request: CueAudioFollowRequest) {
      if (state?.key === key && state.phase !== 'error') { stop(); return; }
      playFollow(key, request);
    },
    stop,
    /** Stops only if the playing audio belongs to the document. */
    stopFor(documentId: string) { if (state?.documentId === documentId) stop(); },
    /** Drops a document's clips, after its media changed. */
    invalidate(documentId: string) {
      epochs.set(documentId, (epochs.get(documentId) ?? 0) + 1);
      for (const key of [...cache.keys()]) if (key.startsWith(`${documentId}|`)) cache.delete(key);
      for (const key of [...peaksCache.keys()]) if (key.startsWith(`${documentId}|`)) peaksCache.delete(key);
    },
    /**
     * The waveform of a stretch, decoded beside whatever plays (a waveform never stops playback);
     * null when the media cannot be read. The last few are kept for the document's revision.
     */
    async peaks(request: PeaksRequest, buckets: number): Promise<CueAudioPeaks | null> {
      const key = peaksKey(request, buckets);
      const known = key ? peaksCache.get(key) : undefined;
      if (known) return known;
      let result: StudioResult<CueAudioResult>;
      try { result = await dependencies.read({ documentId: request.documentId, target: { range: { startMs: request.startMs, endMs: request.endMs } }, padMs: 0, tempo: 1, purpose: 'waveform' }); }
      catch { return null; }
      if (!result.ok) return null;
      if (result.value.kind !== 'clip') { noteUnavailable(request.documentId, result.value.reason); return null; }
      const value = { startMs: result.value.clipStartMs, endMs: result.value.clipEndMs, peaks: pcmPeaks(result.value.bytes, buckets) };
      if (key) { peaksCache.set(key, value); while (peaksCache.size > PEAKS_CACHE_SIZE) peaksCache.delete(peaksCache.keys().next().value as string); }
      return value;
    },
    /** The kept waveform of a stretch, without reading the media; undefined when it has to be read. */
    knownPeaks(request: PeaksRequest, buckets: number): CueAudioPeaks | undefined {
      const key = peaksKey(request, buckets);
      return key ? peaksCache.get(key) : undefined;
    },
    /** Where in the media the document's audio is right now, or null when it is not playing. */
    positionFor(documentId: string): number | null {
      const current = session;
      if (!current || current.documentId !== documentId || state?.phase !== 'playing') return null;
      return position(current);
    },
    /** Applies changed settings to what plays: a new speed continues from the current position, looping turns on or off at once. */
    applySettings() {
      const current = session;
      if (!current || !state) return;
      const settings = dependencies.settings();
      if (settings.tempo !== current.tempo) {
        const from = position(current);
        if (from === null) return;
        const { key, documentId, rows, mode } = current;
        if (mode === 'follow') playFollow(key, { documentId, fromMs: from, ...(current.endMs !== undefined ? { endMs: current.endMs } : {}) }, settings);
        else if (current.clipEndMs !== undefined && current.clipEndMs > from) void playClip(key, { documentId, rows, target: { range: { startMs: from, endMs: current.clipEndMs } } }, { ...settings, padMs: 0 });
        return;
      }
      if (current.mode === 'clip') for (const segment of current.segments) segment.source.loop = settings.loop;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    /** For tests: how many clips are kept. */
    cachedClips: () => cache.size,
  };
}
export type CueAudioPlayer = ReturnType<typeof createCueAudioPlayer>;

const mediaProblemListeners = new Set<(documentId: string) => void>();
export const onCueMediaProblem = (listener: (documentId: string) => void) => { mediaProblemListeners.add(listener); return () => { mediaProblemListeners.delete(listener); }; };

const readSettings = (): CueAudioSettings => {
  const { cueAudioPadMs, cueAudioTempo, cueAudioLoop } = useStudioPreferences.getState();
  return { padMs: cueAudioPadMs, tempo: cueAudioTempo, loop: cueAudioLoop };
};
export const cueAudioPlayer = createCueAudioPlayer({
  read: request => window.subtitleStudio.readCueAudio(request),
  settings: readSettings,
  onMediaProblem: documentId => { for (const listener of mediaProblemListeners) listener(documentId); },
});
useStudioPreferences.subscribe((next, previous) => {
  if (next.cueAudioTempo !== previous.cueAudioTempo || next.cueAudioLoop !== previous.cueAudioLoop) cueAudioPlayer.applySettings();
});

/** The playback of one key, or null: other keys' progress never re-renders this caller. */
export function useCueAudio(key: string, player: CueAudioPlayer = cueAudioPlayer): CueAudioPlayback | null {
  return useSyncExternalStore(player.subscribe, () => { const state = player.snapshot(); return state?.key === key ? state : null; });
}
/** The cue rows of a document that the playing clip covers, joined; changes only when playback starts or stops. */
export function useCueAudioRows(documentId: string, player: CueAudioPlayer = cueAudioPlayer): string {
  return useSyncExternalStore(player.subscribe, () => { const state = player.snapshot(); return state?.documentId === documentId && state.mode === 'clip' && state.phase !== 'error' ? state.rows.join(',') : ''; });
}
/**
 * While a document plays continuously, what `select` makes of the position (such as the id of
 * the cue being heard); null otherwise. Re-renders only when that result changes.
 */
export function useCueAudioFollow<T extends string | number | null>(documentId: string, select: (positionMs: number) => T, player: CueAudioPlayer = cueAudioPlayer): T | null {
  return useSyncExternalStore(player.subscribe, () => {
    const state = player.snapshot();
    return state?.documentId === documentId && state.mode === 'follow' && state.positionMs !== null ? select(state.positionMs) : null;
  });
}
