/** Shared by the offline page and the attachment importer. No filesystem authority. */
export const STAGE_DIMENSIONS = ['segmentation', 'readability', 'timing', 'content'];
export const STAGE_VERDICTS = ['unreviewed', 'good', 'issues', 'uncertain'];

export function validateStageReview(data) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (data?.schema !== 'fusionkit-stage-review-v1' || !hash(data.reviewId) ||
      !Array.isArray(data.tracks) || !data.tracks.length || data.tracks.length > 8) throw Error('Invalid stage review');
  const ids = new Set();
  for (const track of data.tracks) {
    if (typeof track.id !== 'string' || !track.id || ids.has(track.id) ||
        !hash(track.audioSha256) || !hash(track.subtitleSha256) ||
        !Number.isFinite(track.durationMs) || track.durationMs <= 0 || track.sourceStartMs !== 0 ||
        !Array.isArray(track.cues) || track.cues.length > 10000 || !Array.isArray(track.bookmarks)) throw Error('Invalid track');
    ids.add(track.id);
    let previous = -1;
    for (const cue of track.cues) {
      if (!Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) || cue.startMs < previous ||
          cue.endMs <= cue.startMs || cue.endMs > track.durationMs + 10 || typeof cue.text !== 'string' || !cue.text.trim()) throw Error('Invalid cue');
      previous = cue.startMs;
    }
    for (const point of track.bookmarks) {
      if (!Number.isSafeInteger(point.startMs) || point.startMs < 0 || point.startMs >= track.durationMs ||
          typeof point.label !== 'string' || typeof point.history !== 'string') throw Error('Invalid bookmark');
    }
  }
  return true;
}

export function emptyStageAnnotations(data) {
  validateStageReview(data);
  return { schema: 'fusionkit-stage-listening-v1', reviewId: data.reviewId, exportedAt: null,
    tracks: data.tracks.map(track => ({ id: track.id, audioSha256: track.audioSha256,
      subtitleSha256: track.subtitleSha256, durationMs: track.durationMs, sourceStartMs: track.sourceStartMs,
      judgments: Object.fromEntries(STAGE_DIMENSIONS.map(key => [key, 'unreviewed'])), note: '', issues: [], history: [] })) };
}

export function validateStageAnnotations(report, data) {
  validateStageReview(data);
  if (report?.schema !== 'fusionkit-stage-listening-v1' || report.reviewId !== data.reviewId ||
      !(report.exportedAt === null || (typeof report.exportedAt === 'string' && Number.isFinite(Date.parse(report.exportedAt)))) ||
      !Array.isArray(report.tracks) || report.tracks.length !== data.tracks.length) throw Error('Annotation dataset mismatch');
  const result = emptyStageAnnotations(data);
  result.exportedAt = report.exportedAt;
  result.tracks = report.tracks.map((entry, index) => {
    const expected = result.tracks[index];
    if (!entry || ['id', 'audioSha256', 'subtitleSha256', 'durationMs', 'sourceStartMs'].some(key => entry[key] !== expected[key]) ||
        !entry.judgments || Object.keys(entry.judgments).length !== STAGE_DIMENSIONS.length ||
        STAGE_DIMENSIONS.some(key => !STAGE_VERDICTS.includes(entry.judgments[key])) ||
        typeof entry.note !== 'string' || entry.note.length > 4000 || !Array.isArray(entry.issues) || entry.issues.length > 100 ||
        !Array.isArray(entry.history) || entry.history.length > 200) throw Error('Invalid track annotations');
    const issues = entry.issues.map(issue => {
      if (!Number.isSafeInteger(issue.atMs) || issue.atMs < 0 || issue.atMs > expected.durationMs || typeof issue.note !== 'string' || issue.note.length > 2000) throw Error('Invalid issue');
      return { atMs: issue.atMs, note: issue.note };
    });
    const history = entry.history.map(event => {
      if (!['play_request', 'seek', 'pause'].includes(event.kind) || event.evidence !== 'interaction_only' ||
          !Number.isFinite(event.atMs) || event.atMs < 0 || event.atMs > expected.durationMs + 100 ||
          !Number.isFinite(event.rate) || event.rate <= 0 || event.rate > 4 ||
          typeof event.recordedAt !== 'string' || !Number.isFinite(Date.parse(event.recordedAt))) throw Error('Invalid playback history');
      return { kind: event.kind, evidence: event.evidence, atMs: event.atMs, rate: event.rate, recordedAt: event.recordedAt };
    });
    return { ...expected, judgments: Object.fromEntries(STAGE_DIMENSIONS.map(key => [key, entry.judgments[key]])), note: entry.note, issues, history };
  });
  return result;
}

export function activeStageCues(cues, atMs) {
  return cues.flatMap((cue, index) => cue.startMs <= atMs && atMs < cue.endMs ? [index] : []);
}
