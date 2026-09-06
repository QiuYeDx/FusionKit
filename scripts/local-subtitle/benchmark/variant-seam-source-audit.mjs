/** Source accounting for one terminal substitution; never an automatic deletion decision. */
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const indexed = text => {
  const original = Array.from(graphemes.segment(text), x => x.segment), units = [], offsets = [];
  original.forEach((g, i) => { if (!/^[、。！？!?，,；;：:\s]+$/u.test(g)) { units.push(g); offsets.push(i); } });
  return { original, units, offsets };
};
const time = n => Number.isSafeInteger(n) && n >= 0;
const valid = s => s && typeof s.id === 'string' && s.id && typeof s.text === 'string' && s.text.length > 0 && s.text.length <= 2048 &&
  !/[「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u.test(s.text) &&
  [s.startMs, s.endMs, s.observedStartMs, s.observedEndMs].every(time) && s.observedStartMs <= s.startMs && s.startMs < s.endMs && s.endMs <= s.observedEndMs;
const positions = (a, b) => a.flatMap((_, i) => i + b.length <= a.length && b.every((x, j) => a[i + j] === x) ? [i] : []);
export function auditVariantSeamSources({ left, right } = {}) {
  const reject = reason => ({ status: 'rejected', automaticAcceptance: false, reason });
  if (!Array.isArray(right) || !right.length || right.length > 8 || ![left, ...right].every(valid) ||
      new Set([left, ...right].map(s => s.id)).size !== right.length + 1 || left.endMs !== right[0].startMs ||
      right.some((s, i) => i && s.startMs !== right[i - 1].endMs) ||
      Math.min(left.observedEndMs, right[0].observedEndMs) <= Math.max(left.observedStartMs, right[0].observedStartMs)) return reject('invalid_provenance');
  const a = indexed(left.text), b = indexed(right[0].text), length = b.units.length, from = a.units.length - length;
  if (length < 7 || from < 6 || a.units.length > 1024) return reject('short_relation');
  const suffix = a.units.slice(from);
  if (!suffix.slice(0, -1).every((g, i) => g === b.units[i]) || suffix.at(-1) === b.units.at(-1)) return reject('not_terminal_variant');
  const anchor = b.units.slice(0, -1), rightFull = indexed(right.map(s => s.text).join(''));
  if (positions(a.units, anchor).length !== 1 || positions(rightFull.units, anchor).length !== 1) return reject('ambiguous_variant');
  const cut = a.offsets[from], retainedLeft = a.original.slice(0, cut).join('').trimEnd();
  return { status: 'source_accounting_only', automaticAcceptance: false,
    leftPrefix: { sourceId: left.id, startGrapheme: 0, endGrapheme: cut, text: retainedLeft },
    leftVariant: { sourceId: left.id, startGrapheme: cut, endGrapheme: a.original.length, text: a.original.slice(cut).join('') },
    terminalDifference: { left: suffix.at(-1), right: b.units.at(-1) },
    retainedRight: right.map(s => ({ sourceId: s.id, startGrapheme: 0, endGrapheme: indexed(s.text).original.length, text: s.text })),
    rightText: right.map(s => s.text).join(''),
    unresolved: ['same_utterance_requires_audio', 'terminal_variant_requires_review', 'complete_sentence_and_onset_require_audio'] };
}
