import { auditContainedSeamSources } from './contained-seam-source-audit.mjs';

const split = text => Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), x => x.segment);
const units = text => split(text).filter(x => !/^[、。！？!?，,；;：:\s]+$/u.test(x));
const positions = (a, b) => a.flatMap((_, i) => i + b.length <= a.length && b.every((x, j) => a[i + j] === x) ? [i] : []);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const reject = (reason, observations = []) => ({ status: 'rejected', automaticAcceptance: false, reason, observations });

/** A scoped human label permits a listening experiment, never a default deletion. */
export function auditContainedSeamListening(source, annotation, views) {
  if (!source || !hash(source.mediaSha256)) return reject('invalid_source');
  const { left, right, following } = source;
  const relation = auditContainedSeamSources({ left: [left], right });
  if (relation.kind !== 'right_contained' || !relation.before.trim() || !relation.after ||
      !following || typeof following.text !== 'string' || following.text.length > 2048 || !following.text ||
      !time(following.startMs) || !time(following.endMs) || right.endMs !== following.startMs ||
      following.endMs <= following.startMs || left.endMs !== right.startMs ||
      /[「」『』“”"'（）()【】\[\]{}]/u.test(left.text + right.text + following.text)) return reject('unsupported_source');
  const from = relation.match.endGrapheme, original = split(left.text);
  if (!annotation || annotation.judgment !== 'absent' || annotation.mediaSha256 !== source.mediaSha256 ||
      annotation.sourceId !== left.id || annotation.sourceText !== left.text || annotation.from !== from ||
      annotation.to !== original.length || annotation.text !== relation.after ||
      !hash(annotation.feedbackSha256) || !hash(annotation.reviewId)) return reject('unbound_human_label');
  const pieces = [relation.before.trimEnd(), right.text, following.text];
  if (pieces.some(p => units(p).length < 6)) return reject('short_context');
  const anchors = [0, 1].map(i => [...units(pieces[i]).slice(-2), ...units(pieces[i + 1]).slice(0, 6)]);
  if (!Array.isArray(views) || views.length !== 2 || new Set(views.map(v => v?.id)).size !== 2 ||
      new Set(views.map(v => v?.windowStartMs)).size !== 2) return reject('two_distinct_views_required');
  const observations = [];
  for (const view of views) {
    if (!view || !view.id || view.mediaSha256 !== source.mediaSha256 || view.mode !== 'uncompressed_non_vad' ||
        !time(view.windowStartMs) || !time(view.windowEndMs) || view.windowEndMs <= view.windowStartMs ||
        !Array.isArray(view.segments) || !view.segments.length || view.segments.length > 128) return reject('invalid_view', observations);
    let cursor = 0, previous = -1, segmentEnd = 0, tokenCount = 0;
    const tokens = [], full = [];
    for (const s of view.segments) {
      if (!s || typeof s.text !== 'string' || s.text.length > 2048 || !time(s.startMs) || !time(s.endMs) ||
          s.startMs < segmentEnd || s.endMs <= s.startMs || s.endMs > view.windowEndMs - view.windowStartMs ||
          !Array.isArray(s.dtwTokens) || (tokenCount += s.dtwTokens.length) > 4096 ||
          s.dtwTokens.some(t => typeof t?.text !== 'string') || s.dtwTokens.map(t => t.text).join('') !== s.text)
        return reject('invalid_coverage', observations);
      segmentEnd = s.endMs;full.push(...units(s.text));
      if (full.length > 4096) return reject('text_limit', observations);
      for (const token of s.dtwTokens) {
        const length = units(token.text).length;if (!length) continue;
        if (!time(token.pointMs) || token.pointMs < previous || token.pointMs > view.windowEndMs - view.windowStartMs)
          return reject('invalid_points', observations);
        previous = token.pointMs;
        tokens.push({ from: cursor, to: cursor + length, pointMs: view.windowStartMs + token.pointMs });cursor += length;
      }
    }
    if (cursor !== full.length) return reject('invalid_coverage', observations);
    if (positions(full, units(annotation.text)).length) return reject('contradicting_extra_words', observations);
    if ([pieces[1], pieces[2]].some(p => positions(full, units(p).slice(0, 6)).length !== 1))
      return reject('repeated_or_missing_phrase', observations);
    const points = [];
    for (const anchor of anchors) {
      const found = positions(full, anchor);
      if (found.length !== 1) return reject('ambiguous_or_missing_anchor', observations);
      const offset = found[0] + 2, i = tokens.findIndex(t => t.from === offset), target = tokens[i], prior = tokens[i - 1];
      if (!target || !prior || prior.to !== offset || target.pointMs <= left.startMs || target.pointMs >= following.endMs ||
          target.pointMs - prior.pointMs < 120 || target.pointMs - prior.pointMs > 8000) return reject('unsupported_anchor_point', observations);
      points.push(target.pointMs);
    }
    observations.push({ id: view.id, points, fullText: view.segments.map(s => s.text).join(''), completeTextAgreementRequired: false });
  }
  if ([0, 1].some(i => Math.abs(observations[0].points[i] - observations[1].points[i]) > 300)) return reject('unstable_time', observations);
  const [first, second] = observations[0].points, boundaries = [left.startMs, first, second, following.endMs];
  if (boundaries.some((x, i) => i && x - boundaries[i - 1] < 600)) return reject('short_result', observations);
  return { status: 'listening_candidate', automaticAcceptance: false, actualApplicationOutput: false,
    annotation, sourceAccounting: relation, observations, scope: 'human_scoped_deletion_with_local_timing_only',
    replacements: [left, right, following].map((s, i) => ({ ...s, text: pieces[i], startMs: boundaries[i], endMs: boundaries[i + 1] })) };
}
