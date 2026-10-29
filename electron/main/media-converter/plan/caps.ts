import type { AudioStreamInfo, ConversionSettings, CoverStreamInfo, MediaInfo } from '../../../../src/media-converter/contract';
import { alacChannels } from './audio';
import type { PlannedOutput } from './types';

/**
 * The hard byte cap of each output (module-encode design §7; engine `-fs`). Probe metadata is an
 * estimate (FK-PIT-0042), so every cap is a generous upper bound: reaching it means something
 * went wrong, or, for "compress" with "discard if not smaller", that the result would not be smaller.
 */

export const CAP_POLICY = Object.freeze({
  /** "Compress" with "discard if not smaller": the output must stay under 98 % of the source. */
  notSmallerRatio: 0.98,
  remuxRatio: 1.05,
  /**
   * Container overhead, fonts and tags, none of which the probe sizes: added to every
   * `output_cap_exceeded` cap (the remux row of design §7 has it already). Copied cover art has its own bound.
   */
  allowanceBytes: 16 * 1024 * 1024,
  /**
   * Re-encoded video (design §7b): max(source × 4, 1.0 bit per output pixel × pixel rate × duration)
   * × 1.05 + the allowance. The earlier 0.15 bit was exceeded by encoders that really reach about 1.6
   * bits a pixel at the quality tier (MF, measured), so it is a bound on what goes wrong, not an estimate.
   */
  videoBitsPerPixel: 1.0,
  videoSourceFactor: 4,
  videoMargin: 1.05,
  /** Frames per second assumed when the source does not say. */
  fallbackFps: 60,
  lossyMargin: 1.2,
  pcmMargin: 1.01,
  flacRatio: 0.85,
  alacRatio: 0.9,
  /** Copied cover art: a 16-bit RGBA PNG without compression. */
  coverBytesPerPixel: 8,
  /** Without a known duration: four times the source size. */
  unknownDurationFactor: 4,
});

export interface OutputCap {
  capBytes: number;
  capSemantics: PlannedOutput['capSemantics'];
}

/** What the cap depends on: the decisions of the output and whether it only changes the container. */
export type CapInput = Pick<PlannedOutput, 'streams' | 'remux'>;

const PCM_BYTES: Readonly<Record<string, number>> = { pcm_s16le: 2, pcm_s24le: 3, pcm_s32le: 4, pcm_f32le: 4 };
const SAMPLE_FORMAT_BITS: Readonly<Record<string, number>> = { u8: 8, s16: 16, s32: 32, s64: 64, flt: 32, dbl: 64 };

/** Bytes per sample the source holds, 1 to 4 (FLAC and ALAC go no higher than 32 bits). */
function sourceSampleBytes(stream: AudioStreamInfo): number {
  const bits = stream.bitsPerRawSample ?? SAMPLE_FORMAT_BITS[(stream.sampleFormat ?? '').replace(/p$/, '')] ?? 32;
  return Math.min(4, Math.max(1, Math.ceil(bits / 8)));
}

/** Bytes per second of uncompressed PCM; unknown rates and channel counts take generous values. */
const pcmBytesPerSecond = (stream: AudioStreamInfo, bytesPerSample: number) => (stream.sampleRate || 192_000) * (stream.channels || 8) * bytesPerSample;

/**
 * A copied audio track without the video it came with: no more than the whole source, nor than
 * PCM of its rate and channels at 32 bits (64 for 64-bit samples) with the lossy margin, which no
 * audio codec reaches. The stated bit rate is not trusted (FK-PIT-0042). Without this bound a track
 * taken out of a 40 GB film would reserve 42 GB of disk and be refused on FAT32 (engine preflight).
 */
function copiedAudioBytes(stream: AudioStreamInfo, sizeBytes: number, seconds: number): number {
  const bits = stream.bitsPerRawSample ?? SAMPLE_FORMAT_BITS[(stream.sampleFormat ?? '').replace(/p$/, '')] ?? 32;
  const pcm = pcmBytesPerSecond(stream, Math.max(4, Math.ceil(bits / 8))) * seconds * CAP_POLICY.lossyMargin;
  return Math.min(sizeBytes * CAP_POLICY.remuxRatio, pcm);
}

/**
 * Cover art copied into an audio file, which can be a 20 MB scan: at most 8 bytes a pixel (16-bit
 * RGBA PNG) and never more than the whole source; the whole source when its size is unknown.
 */
function coverBytes(cover: CoverStreamInfo | undefined, sizeBytes: number): number {
  const whole = sizeBytes * CAP_POLICY.remuxRatio;
  return cover && cover.width > 0 && cover.height > 0 ? Math.min(whole, cover.width * cover.height * CAP_POLICY.coverBytesPerPixel) : whole;
}

const bounded = (bytes: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.ceil(bytes)));

export function outputCapBytes(output: CapInput, media: MediaInfo, settings: ConversionSettings): OutputCap {
  const size = media.sizeBytes;
  if (settings.task === 'compress' && settings.discardIfNotSmaller) {
    return { capBytes: Math.max(1, Math.floor(size * CAP_POLICY.notSmallerRatio)), capSemantics: 'not_smaller' };
  }
  const cap = (bytes: number): OutputCap => ({ capBytes: bounded(bytes + CAP_POLICY.allowanceBytes), capSemantics: 'output_cap_exceeded' });
  const kept = output.streams.filter(decision => decision.action !== 'drop');
  const carriesVideo = kept.some(decision => decision.source.kind === 'video');
  const durationUs = media.durationUs;
  // A remux of the video holds the whole source; so may any remux whose duration is unknown.
  if (output.remux && (carriesVideo || durationUs === null)) return cap(size * CAP_POLICY.remuxRatio);
  if (durationUs === null) return cap(size * CAP_POLICY.unknownDurationFactor);
  const seconds = durationUs / 1e6;

  const video = kept.find(decision => decision.source.kind === 'video' && decision.action === 'encode');
  const audioById = new Map(media.audio.map(stream => [stream.index, stream]));
  if (video && video.action === 'encode') {
    const primary = media.video.find(stream => stream.index === video.source.index);
    const frame = video.encode.frame ?? { width: primary?.width ?? 0, height: primary?.height ?? 0, fps: primary?.fps ?? null };
    const videoBits = CAP_POLICY.videoBitsPerPixel * frame.width * frame.height * (frame.fps ?? CAP_POLICY.fallbackFps);
    // The audio rides on the pixel term, so a small picture with many re-encoded channels is not cut
    // short; it only ever widens design §7b's bound. Copied tracks of unknown rate together carry at
    // most the whole source rate: counted once.
    let audioBits = 0, unknownCopy = false;
    for (const decision of kept) {
      if (decision.source.kind !== 'audio') continue;
      const rate = decision.action === 'encode' ? decision.encode.maxBitRate : audioById.get(decision.source.index)?.bitRate ?? null;
      if (rate !== null) audioBits += rate;
      else unknownCopy = true;
    }
    if (unknownCopy) audioBits += media.bitRate ?? 0;
    return cap(Math.max(size * CAP_POLICY.videoSourceFactor, (videoBits + audioBits) * seconds / 8) * CAP_POLICY.videoMargin);
  }

  // No video is encoded. A copied video comes with at most the whole source, the copied tracks
  // included; re-encoded audio adds its own formula, copied cover art its own bound. Subtitles are
  // in the allowance.
  let bytes = carriesVideo ? size * CAP_POLICY.remuxRatio : 0;
  const coverById = new Map(media.covers.map(cover => [cover.index, cover]));
  for (const decision of kept) {
    if (decision.source.kind === 'cover') {
      if (!carriesVideo) bytes += coverBytes(coverById.get(decision.source.index), size);
      continue;
    }
    const stream = audioById.get(decision.source.index);
    if (decision.source.kind !== 'audio' || !stream) continue;
    if (decision.action === 'copy') {
      if (!carriesVideo) bytes += copiedAudioBytes(stream, size, seconds);
      continue;
    }
    const { encoder, maxBitRate } = decision.encode;
    if (PCM_BYTES[encoder] !== undefined) bytes += pcmBytesPerSecond(stream, PCM_BYTES[encoder]) * seconds * CAP_POLICY.pcmMargin;
    else if (encoder === 'flac') bytes += pcmBytesPerSecond(stream, sourceSampleBytes(stream)) * seconds * CAP_POLICY.pcmMargin * CAP_POLICY.flacRatio;
    // ALAC may get more channels than the source: the nearest layout that places them all (quad → 5.0).
    else if (encoder === 'alac') {
      const output = { ...stream, channels: alacChannels(stream) ?? stream.channels };
      bytes += pcmBytesPerSecond(output, sourceSampleBytes(stream)) * seconds * CAP_POLICY.pcmMargin * CAP_POLICY.alacRatio;
    }
    else bytes += maxBitRate !== null ? maxBitRate * seconds / 8 * CAP_POLICY.lossyMargin : size * CAP_POLICY.unknownDurationFactor;
  }
  return cap(bytes);
}
