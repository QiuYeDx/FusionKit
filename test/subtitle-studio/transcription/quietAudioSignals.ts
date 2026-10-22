/** Deterministic synthetic 16 kHz mono PCM16 windows for quiet-audio conditioning tests. */
export type QuietSignalPart =
  | { readonly speechMs: number; readonly rmsDb: number }
  | { readonly pauseMs: number }
  | { readonly clickMs: number; readonly peak: number };

export interface QuietSignal {
  readonly pcm: Buffer;
  /** Sample ranges [start, end) of the speech parts. */
  readonly speech: readonly (readonly [number, number])[];
  /** Sample ranges [start, end) of the clicks. */
  readonly clicks: readonly (readonly [number, number])[];
}

const SAMPLES_PER_MS = 16;

/** Lays the parts out in order over white noise at `noiseDb` dBFS RMS; null leaves pauses digitally silent. */
export function quietSignal(parts: readonly QuietSignalPart[], noiseDb: number | null, seed = 1): QuietSignal {
  const total = parts.reduce((sum, part) => sum + partMs(part) * SAMPLES_PER_MS, 0);
  const samples = new Float64Array(total);
  const speech: [number, number][] = [], clicks: [number, number][] = [];
  let offset = 0;
  for (const part of parts) {
    const length = partMs(part) * SAMPLES_PER_MS;
    if ('speechMs' in part) {
      // Four harmonics of 200 Hz, a 4 Hz syllable envelope and 10 ms fades, scaled to the RMS.
      const burst = new Float64Array(length), fade = 10 * SAMPLES_PER_MS;
      for (let i = 0; i < length; i++) {
        const t = i / 16000, edge = Math.min(1, i / fade, (length - 1 - i) / fade);
        const envelope = (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t)) * (0.5 - 0.5 * Math.cos(Math.PI * edge));
        let voice = 0;
        for (let k = 1; k <= 4; k++) voice += Math.sin(2 * Math.PI * 200 * k * t) / k;
        burst[i] = envelope * voice;
      }
      const scale = 10 ** (part.rmsDb / 20) / Math.sqrt(burst.reduce((sum, value) => sum + value * value, 0) / length);
      for (let i = 0; i < length; i++) samples[offset + i] = burst[i]! * scale;
      speech.push([offset, offset + length]);
    } else if ('clickMs' in part) {
      for (let i = 0; i < length; i++) samples[offset + i] = part.peak * Math.sin(2 * Math.PI * 2000 * i / 16000 + Math.PI / 4);
      clicks.push([offset, offset + length]);
    }
    offset += length;
  }
  if (noiseDb !== null) {
    const next = random(seed), amplitude = 10 ** (noiseDb / 20) * Math.sqrt(3);
    for (let i = 0; i < total; i++) samples[i] += (next() * 2 - 1) * amplitude;
  }
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768))), i * 2);
  return { pcm, speech, clicks };
}

/** -65 dBFS speech over a -90 dBFS floor: below the whole-window policy's -60 dBFS gate. */
export const WHISPER_SIGNAL: readonly QuietSignalPart[] = [
  { pauseMs: 600 }, { speechMs: 1200, rmsDb: -65 }, { pauseMs: 900 }, { speechMs: 1000, rmsDb: -65 }, { pauseMs: 1300 },
];

/** -40 dBFS speech over a -75 dBFS floor: the whole-window policy applies its 12 dB. */
export const MODERATE_SIGNAL: readonly QuietSignalPart[] = [
  { pauseMs: 800 }, { speechMs: 1500, rmsDb: -40 }, { pauseMs: 1500 }, { speechMs: 1000, rmsDb: -40 }, { pauseMs: 1200 },
];

/** -45 dBFS speech with four short -6 dBFS clicks: the whole-window policy refuses the limiting. */
export const TRANSIENT_SIGNAL: readonly QuietSignalPart[] = [
  { pauseMs: 500 }, { speechMs: 1200, rmsDb: -45 }, { clickMs: 4, peak: 0.5 }, { speechMs: 800, rmsDb: -45 },
  { pauseMs: 600 }, { clickMs: 4, peak: 0.5 }, { pauseMs: 400 }, { speechMs: 1000, rmsDb: -45 },
  { clickMs: 4, peak: 0.5 }, { pauseMs: 500 }, { clickMs: 4, peak: 0.5 }, { pauseMs: 484 },
];

function partMs(part: QuietSignalPart): number {
  return 'speechMs' in part ? part.speechMs : 'pauseMs' in part ? part.pauseMs : part.clickMs;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
