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
