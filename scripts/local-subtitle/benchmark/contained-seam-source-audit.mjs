/** Source accounting only. Exact containment is never acoustic proof or deletion authority. */
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const indexed = text => {
  const original = Array.from(graphemes.segment(text), x => x.segment), units = [], offsets = [];
  original.forEach((g, i) => { if (!/^[\p{P}\s]+$/u.test(g)) { units.push(g); offsets.push(i); } });
  return { original, units, offsets };
};
const matches = (a, b) => a.flatMap((_, i) => i + b.length <= a.length && b.every((x, j) => a[i + j] === x) ? [i] : []);
const time = n => Number.isSafeInteger(n) && n >= 0;
const valid = s => s && typeof s.id === 'string' && s.id && typeof s.text === 'string' && s.text.length <= 2048 &&
  [s.startMs, s.endMs, s.observedStartMs, s.observedEndMs].every(time) && s.startMs < s.endMs &&
  s.observedStartMs <= s.startMs && s.endMs <= s.observedEndMs;
export function auditContainedSeamSources({ left, right } = {}) {
  const reject = reason => ({ automaticAcceptance: false, status: 'rejected', reason });
  if (!Array.isArray(left) || !left.length || left.length > 2 || ![...left, right].every(valid) ||
      new Set([...left, right].map(s => s.id)).size !== left.length + 1 ||
      left.some((s, i) => i && s.startMs < left[i - 1].endMs) || left.at(-1).endMs > right.startMs ||
      Math.min(left.at(-1).observedEndMs, right.observedEndMs) <= Math.max(left.at(-1).observedStartMs, right.observedStartMs))
    return reject('invalid_source_provenance');
  const parts = left.map(s => indexed(s.text)), x = indexed(left.map(s => s.text).join('')), y = indexed(right.text);
  if (Math.min(x.units.length, y.units.length) < 6) return reject('short_relation');
  const inside = matches(x.units, y.units);
  if (left.length === 1 && inside.length) {
    if (inside.length !== 1) return reject('ambiguous_containment');
    const from = x.offsets[inside[0]], to = x.offsets[inside[0] + y.units.length - 1] + 1;
    return { automaticAcceptance: false, status: 'source_accounting_only', kind: 'right_contained',
      match: { sourceId: left[0].id, startGrapheme: from, endGrapheme: to },
      before: x.original.slice(0, from).join(''), after: x.original.slice(to).join(''),
      unresolved: ['extra_source_words_require_review', 'same_utterance_requires_audio'] };
  }
  if (left.length !== 2) return reject('not_multiple_sources');
  let length = Math.min(x.units.length, y.units.length);
  for (; length >= 6; length--) if (x.units.slice(-length).every((s, i) => s === y.units[i])) break;
  if (length < 6 || length >= x.units.length || length >= y.units.length) return reject('no_partial_overlap');
  const overlap = y.units.slice(0, length);
  if (matches(x.units, overlap).length !== 1 || matches(y.units, overlap).length !== 1) return reject('ambiguous_overlap');
  const start = x.units.length - length;
  if (left.length === 2 && start >= parts[0].units.length) return reject('not_multiple_sources');
  let offset = 0;
  const coveredLeft = left.map((s, i) => {
    const p = parts[i], localStart = Math.max(0, start - offset);offset += p.units.length;
    return { sourceId: s.id, startGrapheme: p.offsets[localStart], endGrapheme: p.original.length };
  });
  const cut = y.offsets[length];
  const kept = [...left.map(s => ({ sourceId: s.id, startGrapheme: 0, endGrapheme: indexed(s.text).original.length, text: s.text })),
    { sourceId: right.id, startGrapheme: cut, endGrapheme: y.original.length, text: y.original.slice(cut).join('') }];
  return { automaticAcceptance: false, status: 'source_accounting_only', kind: 'multi_source_prefix', coveredLeft, kept,
    redundantRight: { sourceId: right.id, startGrapheme: 0, endGrapheme: cut, text: y.original.slice(0, cut).join('') },
    composedText: kept.map(p => p.text).join(''), unresolved: ['same_utterance_requires_audio', 'sentence_boundaries_require_audio'] };
}
