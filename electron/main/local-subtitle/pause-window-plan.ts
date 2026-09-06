/** Low-energy intervals are cut candidates, not proof that speech is absent. */
export interface LocalSubtitleQuietCandidate {
  readonly startFrame: number;
  readonly endFrame: number;
}

export const LOCAL_SUBTITLE_PAUSE_POLICY = Object.freeze({
  id: "acoustic_quiet_v1" as const,
  sampleRateHz: 16_000,
  analysisFrameSamples: 160,
  rmsDb: -55,
  peakDb: -45,
  minQuietFrames: 9_600,
  guardFrames: 4_800,
  minWindowFrames: 288_000,
  targetWindowFrames: 400_000,
  searchEndFrames: 464_000,
  maxWindowFrames: 480_000,
  overlapFrames: 80_000,
  maxTotalFrames: 16_000 * 60 * 60 * 24,
});

/** Carries partial analysis frames across I/O chunks; retains no audio buffers. */
export class LocalSubtitleQuietScanner {
  #frames = 0;
  #count = 0;
  #energy = 0;
  #peak = 0;
  #quietStart: number | undefined;
  #finished = false;
  #candidates: LocalSubtitleQuietCandidate[] = [];

  push(pcm: Buffer): void {
    if (this.#finished || !Buffer.isBuffer(pcm) || pcm.length % 2 ||
        this.#frames + pcm.length / 2 > LOCAL_SUBTITLE_PAUSE_POLICY.maxTotalFrames) throw new TypeError("Invalid PCM scan chunk");
    for (let i = 0; i < pcm.length; i += 2) {
      const value = pcm.readInt16LE(i);
      this.#energy += value * value;
      this.#peak = Math.max(this.#peak, Math.abs(value));
      this.#frames++;
      if (++this.#count === LOCAL_SUBTITLE_PAUSE_POLICY.analysisFrameSamples) this.#flushFrame();
    }
  }

  finish(): readonly LocalSubtitleQuietCandidate[] {
    if (this.#finished || !this.#frames) throw new TypeError("Invalid PCM scan completion");
    if (this.#count) this.#flushFrame();
    this.#endQuiet(this.#frames);
    this.#finished = true;
    return Object.freeze(this.#candidates);
  }

  #flushFrame(): void {
    const p = LOCAL_SUBTITLE_PAUSE_POLICY, start = this.#frames - this.#count;
    if (this.#energy / this.#count <= 32768 ** 2 * 10 ** (p.rmsDb / 10) &&
        this.#peak <= 32768 * 10 ** (p.peakDb / 20)) this.#quietStart ??= start;
    else this.#endQuiet(start);
    this.#energy = this.#peak = this.#count = 0;
  }

  #endQuiet(endFrame: number): void {
    if (this.#quietStart !== undefined && endFrame - this.#quietStart >= LOCAL_SUBTITLE_PAUSE_POLICY.minQuietFrames)
      this.#candidates.push(Object.freeze({ startFrame: this.#quietStart, endFrame }));
    this.#quietStart = undefined;
  }
}

export interface LocalSubtitlePauseRange {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly coreStartFrame: number;
  readonly coreEndFrame: number;
}

/** Deterministic geometry only. The media owner must establish PCM provenance. */
export function planLocalSubtitlePauseRanges(
  totalFrames: number,
  candidates: readonly LocalSubtitleQuietCandidate[],
): readonly LocalSubtitlePauseRange[] {
  const p = LOCAL_SUBTITLE_PAUSE_POLICY;
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0 || totalFrames > p.maxTotalFrames ||
      !Array.isArray(candidates) || candidates.length > Math.floor(totalFrames / p.minQuietFrames)) {
    throw new TypeError("Invalid pause planning input");
  }
  let previousEnd = 0;
  for (const c of candidates) {
    if (!c || Object.keys(c).length !== 2 || !Number.isSafeInteger(c.startFrame) ||
        !Number.isSafeInteger(c.endFrame) || c.startFrame < previousEnd || c.endFrame > totalFrames ||
        c.endFrame - c.startFrame < p.minQuietFrames) throw new TypeError("Invalid quiet candidate");
    previousEnd = c.endFrame;
  }
  const windows: LocalSubtitlePauseRange[] = [];
  let startFrame = 0, coreStartFrame = 0, cursor = 0;
  while (startFrame < totalFrames) {
    let endFrame = Math.min(totalFrames, startFrame + p.maxWindowFrames);
    let coreEndFrame = endFrame, nextStart = endFrame;
    if (endFrame < totalFrames) {
      const low = startFrame + p.minWindowFrames, high = startFrame + p.searchEndFrames;
      const target = startFrame + p.targetWindowFrames;
      while (cursor < candidates.length && candidates[cursor].endFrame - p.guardFrames < low) cursor++;
      let best: number | undefined;
      for (let i = cursor; i < candidates.length && candidates[i].startFrame + p.guardFrames <= high; i++) {
        const from = Math.max(low, candidates[i].startFrame + p.guardFrames);
        const to = Math.min(high, candidates[i].endFrame - p.guardFrames);
        if (from > to) continue;
        const cut = Math.max(from, Math.min(to, target));
        if (best === undefined || Math.abs(cut - target) < Math.abs(best - target) ||
            (Math.abs(cut - target) === Math.abs(best - target) && cut < best)) best = cut;
      }
      if (best !== undefined) endFrame = coreEndFrame = nextStart = best;
      else {
        coreEndFrame = endFrame - p.overlapFrames / 2;
        nextStart = endFrame - p.overlapFrames;
      }
    }
    windows.push(Object.freeze({ startFrame, endFrame, coreStartFrame, coreEndFrame }));
    startFrame = nextStart;
    coreStartFrame = coreEndFrame;
  }
  return Object.freeze(windows);
}
