const onsetHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const onsetTime = value => Number.isSafeInteger(value) && value >= 0;
export const ONSET_PRECEDING = ["two", "one", "breath", "none", "other", "uncertain"];
export const ONSET_CONFIDENCE = ["clear", "approximate", "uncertain"];
export function validateOnsetManifest(data) {
  if (!data || data.schema !== "fusionkit-onset-review-v1" || !onsetHash(data.reviewId) ||
      !onsetHash(data.mediaSha256) || !onsetHash(data.audioSha256) ||
      typeof data.target !== "string" || !data.target || data.target.length > 128 ||
      !onsetTime(data.audioStartMs) || !onsetTime(data.audioDurationMs) || data.audioDurationMs < 1000 || data.audioDurationMs > 30000 ||
      !Number.isSafeInteger(data.audioStartMs + data.audioDurationMs)) throw new Error("invalid_onset_manifest");
  const end = data.audioStartMs + data.audioDurationMs;
  for (const range of [data.playbackRangeMs, data.markRangeMs]) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(onsetTime) || range[0] < data.audioStartMs ||
        range[1] > end || range[1] <= range[0]) throw new Error("invalid_onset_range");
  }
  if (data.markRangeMs[0] < data.playbackRangeMs[0] || data.markRangeMs[1] > data.playbackRangeMs[1]) throw new Error("invalid_onset_range");
  const w = data.waveform;
  if (!w || w.startMs !== data.playbackRangeMs[0] || w.endMs !== data.playbackRangeMs[1] ||
      !onsetTime(w.binMs) || w.binMs < 10 || w.binMs > 100 || !Array.isArray(w.peaks) ||
      w.peaks.length !== Math.ceil((w.endMs - w.startMs) / w.binMs) || w.peaks.length > 3000 ||
      w.peaks.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1) || p[0] > p[1])) throw new Error("invalid_onset_waveform");
  return data;
}
export function validateOnsetAnnotations(data, manifest) {
  validateOnsetManifest(manifest);
  if (!data || data.schema !== "fusionkit-onset-listening-v1" || data.reviewId !== manifest.reviewId ||
      data.mediaSha256 !== manifest.mediaSha256 || data.audioSha256 !== manifest.audioSha256 ||
      data.target !== manifest.target || data.automaticAcceptance !== false ||
      typeof data.exportedAt !== "string" || !Number.isFinite(Date.parse(data.exportedAt))) throw new Error("onset_binding_mismatch");
  if (!ONSET_PRECEDING.includes(data.preceding) || !ONSET_CONFIDENCE.includes(data.confidence) ||
      typeof data.note !== "string" || data.note.length > 2000) throw new Error("incomplete_onset_answers");
  if (data.estimatedOnsetMs === null ? data.confidence !== "uncertain" :
      !onsetTime(data.estimatedOnsetMs) || data.estimatedOnsetMs < manifest.markRangeMs[0] || data.estimatedOnsetMs > manifest.markRangeMs[1])
    throw new Error("invalid_onset_estimate");
  if (data.historyIsNotListeningProof !== true || !onsetTime(data.droppedHistoryCount) || data.droppedHistoryCount > 1000000 ||
      !Array.isArray(data.history) || data.history.length > 100) throw new Error("invalid_onset_history");
  const inside = point => onsetTime(point) && point >= manifest.audioStartMs && point <= manifest.audioStartMs + manifest.audioDurationMs;
  for (const event of data.history) {
    if (!event || !["request", "play", "pause", "seek", "mark"].includes(event.kind) ||
        !onsetTime(event.at) || !inside(event.positionMs) || !Number.isFinite(event.rate) || event.rate < .25 || event.rate > 4 ||
        (event.kind === "request" && (!inside(event.fromMs) || !inside(event.toMs) || event.toMs <= event.fromMs)) ||
        (event.kind === "seek" && !["request", "manual"].includes(event.origin))) throw new Error("invalid_onset_history");
  }
  return { valid: true, automaticAcceptance: false, onsetIsSubjective: true };
}
