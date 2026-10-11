import { useSyncExternalStore } from 'react';
import type { CueAudioPadding, CueAudioResult, CueAudioTarget, CueAudioUnavailable } from '@/subtitle-studio/cue-audio';
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
export type CueAudioFailure = CueAudioUnavailable | 'failed';
export type CueAudioPlayback = { key: string; documentId: string; rows: readonly string[]; phase: 'loading' | 'playing' | 'error'; progress: number; reason?: CueAudioFailure };

type AudioLike = Pick<HTMLAudioElement, 'play' | 'pause' | 'addEventListener' | 'currentTime' | 'duration' | 'src'>;
export type CueAudioPlayerDependencies = {
  read: (request: { documentId: string; target: CueAudioTarget; padMs: CueAudioPadding }) => Promise<StudioResult<CueAudioResult>>;
  padMs: () => CueAudioPadding;
  createAudio?: () => AudioLike;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  frame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Called when a document's media turned out missing or moved, so its status can be read again. */
  onMediaProblem?: (documentId: string) => void;
};

const CACHE_SIZE = 6;
const ERROR_MS = 4000;

/**
 * One player for the whole studio: starting a clip stops the one before.
 * Clips are decoded by the main process on request; the last few stay in
 * memory as object URLs so playing a cue again starts at once.
 */
export function createCueAudioPlayer(dependencies: CueAudioPlayerDependencies) {
  const createUrl = dependencies.createUrl ?? (blob => URL.createObjectURL(blob));
  const revokeUrl = dependencies.revokeUrl ?? (url => URL.revokeObjectURL(url));
  const frame = dependencies.frame ?? (callback => requestAnimationFrame(callback));
  const cancelFrame = dependencies.cancelFrame ?? (handle => cancelAnimationFrame(handle));
  const listeners = new Set<() => void>();
  const cache = new Map<string, string>();
  const epochs = new Map<string, number>();
  let audio: AudioLike | undefined;
  let state: CueAudioPlayback | null = null;
  let serial = 0;
  let ticking: number | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  /** An uncached clip's URL, released when the next clip starts. */
  let transient: string | undefined;

  const publish = (next: CueAudioPlayback | null) => { state = next; for (const listener of listeners) listener(); };
  const stopTicking = () => { if (ticking !== undefined) cancelFrame(ticking); ticking = undefined; };
  const release = () => { if (transient) revokeUrl(transient); transient = undefined; };
  function element() {
    if (audio) return audio;
    const created = audio = dependencies.createAudio?.() ?? new Audio();
    created.addEventListener('ended', () => { if (state?.phase === 'playing') { stopTicking(); publish(null); } });
    return created;
  }
  function tick(current: number) {
    ticking = undefined;
    if (current !== serial || state?.phase !== 'playing' || !audio) return;
    const duration = audio.duration;
    const progress = Number.isFinite(duration) && duration > 0 ? Math.min(1, audio.currentTime / duration) : 0;
    if (Math.abs(progress - state.progress) >= 0.01) publish({ ...state, progress });
    ticking = frame(() => tick(current));
  }
  function fail(current: number, base: Omit<CueAudioPlayback, 'phase' | 'progress'>, reason: CueAudioFailure) {
    if (current !== serial) return;
    publish({ ...base, phase: 'error', progress: 0, reason });
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { if (current === serial && state?.phase === 'error') publish(null); }, ERROR_MS);
  }
  function remember(key: string, url: string) {
    cache.delete(key); cache.set(key, url);
    while (cache.size > CACHE_SIZE) {
      const [oldest, old] = cache.entries().next().value as [string, string];
      cache.delete(oldest); revokeUrl(old);
    }
  }
  const cacheKey = (request: CueAudioRequest, padMs: CueAudioPadding, revision = request.revision) => revision === undefined ? undefined
    : `${request.documentId}|${revision}|${epochs.get(request.documentId) ?? 0}|${padMs}|${JSON.stringify(request.target)}`;

  function stop() {
    serial++;
    clearTimeout(errorTimer);
    stopTicking();
    audio?.pause();
    if (state) publish(null);
  }
  async function start(key: string, request: CueAudioRequest) {
    stop();
    const current = serial;
    const base = { key, documentId: request.documentId, rows: request.rows ?? [] };
    publish({ ...base, phase: 'loading', progress: 0 });
    const padMs = dependencies.padMs();
    let url = (() => { const known = cacheKey(request, padMs); const found = known && cache.get(known); if (found) remember(known, found); return found; })();
    if (!url) {
      let result: StudioResult<CueAudioResult>;
      try { result = await dependencies.read({ documentId: request.documentId, target: request.target, padMs }); }
      catch { return fail(current, base, 'failed'); }
      if (current !== serial) return;
      if (!result.ok) return fail(current, base, 'failed');
      if (result.value.kind === 'unavailable') {
        if (result.value.reason === 'no_media' || result.value.reason === 'media_unavailable') dependencies.onMediaProblem?.(request.documentId);
        return result.value.reason === 'cancelled' ? publish(null) : fail(current, base, result.value.reason);
      }
      const clip = result.value;
      url = createUrl(new Blob([clip.bytes as Uint8Array<ArrayBuffer>], { type: clip.mimeType }));
      const known = request.revision === clip.revision ? cacheKey(request, padMs, clip.revision) : undefined;
      release();
      if (known) remember(known, url); else transient = url;
    }
    const player = element();
    player.src = url;
    player.currentTime = 0;
    try { await player.play(); }
    catch { return fail(current, base, 'failed'); }
    if (current !== serial) return;
    publish({ ...base, phase: 'playing', progress: 0 });
    ticking = frame(() => tick(current));
  }

  return {
    /** Plays the request, or stops it when the same key is already loading or playing. */
    toggle(key: string, request: CueAudioRequest) {
      if (state?.key === key && state.phase !== 'error') { stop(); return; }
      void start(key, request);
    },
    stop,
    /** Stops only if the playing clip belongs to the document (or the key). */
    stopFor(documentId: string) { if (state?.documentId === documentId) stop(); },
    /** Drops a document's clips, after its media changed. */
    invalidate(documentId: string) {
      epochs.set(documentId, (epochs.get(documentId) ?? 0) + 1);
      for (const [key, url] of [...cache]) if (key.startsWith(`${documentId}|`)) { cache.delete(key); revokeUrl(url); }
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

export const cueAudioPlayer = createCueAudioPlayer({
  read: request => window.subtitleStudio.readCueAudio(request),
  padMs: () => useStudioPreferences.getState().cueAudioPadMs,
  onMediaProblem: documentId => { for (const listener of mediaProblemListeners) listener(documentId); },
});

/** The playback of one key, or null: other keys' progress never re-renders this caller. */
export function useCueAudio(key: string, player: CueAudioPlayer = cueAudioPlayer): CueAudioPlayback | null {
  return useSyncExternalStore(player.subscribe, () => { const state = player.snapshot(); return state?.key === key ? state : null; });
}
/** The cue rows of a document that the playing clip covers, joined; changes only when playback starts or stops. */
export function useCueAudioRows(documentId: string, player: CueAudioPlayer = cueAudioPlayer): string {
  return useSyncExternalStore(player.subscribe, () => { const state = player.snapshot(); return state?.documentId === documentId && state.phase !== 'error' ? state.rows.join(',') : ''; });
}
