/** Bounded input conditioning, not speech detection. Sample positions never change. */
export const LOCAL_SUBTITLE_QUIET_AUDIO_POLICY = Object.freeze({
  minRmsDb: -60, maxRmsDb: -30, targetRmsDb: -20,
  maxGainDb: 12, minGainDb: 6, maxPeakDb: -1, maxLimitedFraction: 0.001,
  vadSpeechPadMs: 1000, maxPcmBytes: 30 * 16000 * 2,
  maxConditionedSegmentMs: 7000, repeatedCueCount: 3,
});

/** Applied only to conditioned candidates, before display splitting or merging. */
export function shouldRetryUnconditionedAudio(assessment: {
  readonly contractValid: boolean;
  readonly valid: boolean;
  readonly longestSegmentDurationMs: number;
  readonly longestConsecutiveRepeatCueCount: number;
}): boolean {
  return assessment.contractValid && (!assessment.valid ||
    assessment.longestSegmentDurationMs > LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.maxConditionedSegmentMs ||
    assessment.longestConsecutiveRepeatCueCount >= LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.repeatedCueCount);
}

export function conditionQuietPcm16(input: Buffer): { readonly pcm: Buffer; readonly gainDb: number } {
  if (!Buffer.isBuffer(input) || !input.length || input.length % 2 ||
      input.length > LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.maxPcmBytes) throw new TypeError('Invalid bounded mono PCM16');
  let energy = 0, peak = 0;
  for (let offset = 0; offset < input.length; offset += 2) {
    const sample = input.readInt16LE(offset) / 32768;
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const unchanged = {pcm: input, gainDb: 0};
  if (!peak) return unchanged;
  const rmsDb = 10 * Math.log10(energy / (input.length / 2));
  const policy = LOCAL_SUBTITLE_QUIET_AUDIO_POLICY;
  if (rmsDb < policy.minRmsDb || rmsDb >= policy.maxRmsDb) return unchanged;
  const gainDb = Math.min(policy.maxGainDb, policy.targetRmsDb - rmsDb);
  if (gainDb < policy.minGainDb) return unchanged;
  const gain = 10 ** (gainDb / 20);
  const ceiling = 10 ** (policy.maxPeakDb / 20);
  const knee = ceiling * 0.9;
  let limitedSamples = 0;
  for (let offset = 0; offset < input.length; offset += 2) {
    if (Math.abs(input.readInt16LE(offset) / 32768 * gain) > knee) limitedSamples++;
  }
  // A few transients must not dictate the gain for an entire quiet utterance.
  // Refuse windows requiring sustained limiting; soften only isolated peaks.
  if (limitedSamples / (input.length / 2) > policy.maxLimitedFraction) return unchanged;
  const pcm = Buffer.allocUnsafe(input.length);
  for (let offset = 0; offset < input.length; offset += 2) {
    let sample = input.readInt16LE(offset) / 32768 * gain;
    if (Math.abs(sample) > knee) {
      sample = Math.sign(sample) * (knee + (ceiling - knee) * Math.tanh((Math.abs(sample) - knee) / (ceiling - knee)));
    }
    pcm.writeInt16LE(Math.round(sample * 32768), offset);
  }
  return {pcm, gainDb};
}

/** Gated per-frame gain for whispered speech (Studio quietAudioMode gated_v1); 10 ms frames. */
export const LOCAL_SUBTITLE_WHISPER_AUDIO_POLICY = Object.freeze({
  frameSamples: 160, minSignalSamples: 8000, minActiveSamples: 8000,
  noiseFloorPercentile: 0.1, activeAboveFloorDb: 10, minActiveDb: -80,
  speechPercentile: 0.8, targetSpeechDb: -23, maxGainDb: 30, minGainDb: 3,
  inactiveMaxGainDb: 6, leadFrames: 10, holdFrames: 25, peakGuardFrames: 2, smoothingFrames: 3,
});

/**
 * Boosts frames active above the noise floor towards -23 dBFS and all others by at most
 * 6 dB. Offline and zero-phase: sample positions and digital silence never change.
 */
export function conditionWhisperPcm16(input: Buffer): { readonly pcm: Buffer; readonly gainDb: number } {
  if (!Buffer.isBuffer(input) || !input.length || input.length % 2 ||
      input.length > LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.maxPcmBytes) throw new TypeError('Invalid bounded mono PCM16');
  const policy = LOCAL_SUBTITLE_WHISPER_AUDIO_POLICY;
  const samples = input.length / 2, frames = Math.ceil(samples / policy.frameSamples);
  const levels = new Float64Array(frames), peaks = new Float64Array(frames), lengths = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * policy.frameSamples, end = Math.min(samples, start + policy.frameSamples);
    let energy = 0, peak = 0;
    for (let index = start; index < end; index++) {
      const sample = input.readInt16LE(index * 2) / 32768;
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    levels[frame] = 10 * Math.log10(energy / (end - start));
    peaks[frame] = peak;
    lengths[frame] = end - start;
  }
  const unchanged = {pcm: input, gainDb: 0};
  const signal = [...levels.keys()].filter(frame => peaks[frame]! > 0);
  if (sumLengths(signal, lengths) < policy.minSignalSamples) return unchanged;
  const floorDb = percentile(signal.map(frame => levels[frame]!), policy.noiseFloorPercentile);
  const thresholdDb = Math.max(floorDb + policy.activeAboveFloorDb, policy.minActiveDb);
  const active = signal.filter(frame => levels[frame]! >= thresholdDb);
  if (sumLengths(active, lengths) < policy.minActiveSamples) return unchanged;
  const speechDb = percentile(active.map(frame => levels[frame]!), policy.speechPercentile);
  const gainDb = Math.min(policy.maxGainDb, Math.max(0, policy.targetSpeechDb - speechDb));
  if (gainDb < policy.minGainDb) return unchanged;
  const ceiling = 10 ** (LOCAL_SUBTITLE_QUIET_AUDIO_POLICY.maxPeakDb / 20);
  const knee = ceiling * 0.9;
  // Full gain covers each active frame from 100 ms before to 250 ms after it.
  const wanted = new Float64Array(frames).fill(Math.min(gainDb, policy.inactiveMaxGainDb));
  for (const frame of active) {
    wanted.fill(gainDb, Math.max(0, frame - policy.leadFrames), Math.min(frames, frame + policy.holdFrames + 1));
  }
  const limited = wanted.map((gain, frame) => peaks[frame] ? Math.min(gain, 20 * Math.log10(ceiling / peaks[frame]!)) : gain);
  // The ±2 frame minimum keeps every interpolated sample under its own frame's peak limit.
  const guarded = limited.map((_, frame) => Math.min(...neighbours(limited, frame, policy.peakGuardFrames)));
  const smoothed = guarded.map((_, frame) => {
    const values = neighbours(guarded, frame, (policy.smoothingFrames - 1) / 2);
    return 10 ** (values.reduce((sum, value) => sum + value, 0) / values.length / 20);
  });
  const pcm = Buffer.allocUnsafe(input.length);
  for (let index = 0; index < samples; index++) {
    const position = (index - (policy.frameSamples - 1) / 2) / policy.frameSamples;
    const lower = Math.max(0, Math.min(frames - 1, Math.floor(position)));
    const upper = Math.min(frames - 1, lower + 1), fraction = Math.max(0, Math.min(1, position - lower));
    let sample = input.readInt16LE(index * 2) / 32768 * (smoothed[lower]! + (smoothed[upper]! - smoothed[lower]!) * fraction);
    // The same soft knee as conditionQuietPcm16, as a backstop below -1 dBFS.
    if (Math.abs(sample) > knee) {
      sample = Math.sign(sample) * (knee + (ceiling - knee) * Math.tanh((Math.abs(sample) - knee) / (ceiling - knee)));
    }
    pcm.writeInt16LE(Math.round(sample * 32768), index * 2);
  }
  return {pcm, gainDb};
}

function sumLengths(frames: readonly number[], lengths: Float64Array): number {
  return frames.reduce((sum, frame) => sum + lengths[frame]!, 0);
}

/** Linearly interpolated percentile. */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction, lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function neighbours(values: Float64Array, frame: number, radius: number): number[] {
  return [...values.subarray(Math.max(0, frame - radius), Math.min(values.length, frame + radius + 1))];
}
