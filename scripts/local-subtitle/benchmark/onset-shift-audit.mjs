// Diagnostic only: timing equivariance does not establish word presence or onset accuracy.
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const ms = value => Number.isSafeInteger(value) && value >= 0;
const split = new Intl.Segmenter("und", { granularity: "grapheme" });
const units = text => Array.from(split.segment(text), item => item.segment)
  .filter(item => !/^[、。！？!?，,；;：:\s]+$/u.test(item));
const spread = values => values.length ? Math.max(...values) - Math.min(...values) : null;

function inspectView(source, view) {
  const reasons = [], tokens = [], body = view.segments;
  if (!hash(view.contentSha256) || view.contentSha256 !== source.contentSha256 ||
      view.protocolSha256 !== source.protocolSha256 || view.sourceStartMs !== source.sourceStartMs ||
      view.contentDurationMs !== source.contentDurationMs) reasons.push("incompatible_provenance");
  if (!Array.isArray(body) || !body.length || body.length > 128 ||
      body.some(s => typeof s?.text !== "string") || body.reduce((n, s) => n + s.text.length, 0) > 8192)
    return { id: view.id, reasons: [...reasons, "invalid_segments"], text: null, targets: [] };
  const text = body.map(s => s.text).join(""), lexical = units(text);
  const toSource = seconds => source.sourceStartMs + Math.round(seconds * 1000) - view.paddingMs;
  let cursor = 0, previous = -1, previousEnd = 0, count = 0;
  for (const [segmentIndex, segment] of body.entries()) {
    if (![segment.start, segment.end].every(Number.isFinite) || segment.start < previousEnd ||
        segment.end < segment.start || segment.end * 1000 > view.paddingMs + source.contentDurationMs)
      reasons.push("invalid_native_timeline");
    previousEnd = segment.end;
    if (!Array.isArray(segment.words) || (count += segment.words.length) > 8192 ||
        segment.words.some(word => typeof word?.word !== "string") || segment.words.map(w => w.word).join("") !== segment.text) {
      reasons.push("incomplete_token_coverage");continue;
    }
    for (const word of segment.words) {
      const length = units(word.word).length;
      const point = word.t_dtw;
      if (!Number.isSafeInteger(point) || point < 0 || point < previous || point * 10 > view.paddingMs + source.contentDurationMs)
        reasons.push("invalid_dtw_points");
      previous = point;
      if (![word.start, word.end].every(Number.isFinite) || word.start < 0 || word.end < word.start ||
          word.end * 1000 > view.paddingMs + source.contentDurationMs) reasons.push("invalid_ordinary_timeline");
      if (length) tokens.push({ text: word.word, from: cursor, to: cursor + length, segmentIndex,
        dtwMs: Number.isSafeInteger(point) ? source.sourceStartMs + point * 10 - view.paddingMs : null,
        startMs: toSource(word.start), endMs: toSource(word.end),
        nativeStartMs: toSource(segment.start), nativeEndMs: toSource(segment.end) });
      cursor += length;
    }
  }
  if (cursor !== lexical.length) reasons.push("incomplete_grapheme_coverage");
  const targets = source.targets.map(target => {
    const needle = units(target), at = lexical.flatMap((_, i) => needle.every((g, j) => g === lexical[i + j]) ? [i] : []);
    if (at.length !== 1) return { target, occurrences: at.length, reasons: [at.length ? "ambiguous_target" : "missing_target"] };
    const first = tokens.findIndex(token => token.from === at[0]);
    const last = tokens.findIndex(token => token.to === at[0] + needle.length);
    if (first < 0 || last < first) return { target, occurrences: 1, reasons: ["partial_token"] };
    const a = tokens[first], b = tokens[last];
    return { target, occurrences: 1, reasons: a.dtwMs < source.sourceStartMs ? ["target_in_padding"] : [],
      dtwStartMs: a.dtwMs, dtwEndMs: b.dtwMs, ordinaryStartMs: a.startMs, ordinaryEndMs: b.endMs,
      nativeStartMs: a.nativeStartMs, nativeEndMs: b.nativeEndMs,
      tokens: tokens.slice(first, last + 1), before: tokens[first - 1] ?? null, after: tokens[last + 1] ?? null };
  });
  return { id: view.id, paddingMs: view.paddingMs, reasons: [...new Set(reasons)], text, targets,
    tokensMappedBeforeSource: tokens.filter(t => t.dtwMs !== null && t.dtwMs < source.sourceStartMs) };
}

export function auditOnsetShift(source, views) {
  if (!source || !hash(source.contentSha256) || !hash(source.protocolSha256) || !ms(source.sourceStartMs) ||
      !ms(source.contentDurationMs) || source.contentDurationMs < 1 || source.contentDurationMs > 30000 ||
      !Number.isSafeInteger(source.sourceStartMs + source.contentDurationMs) ||
      !Array.isArray(source.targets) || !source.targets.length || source.targets.length > 8 ||
      source.targets.some(t => typeof t !== "string" || t.length > 128 || !units(t).length) ||
      new Set(source.targets.map(t => units(t).join(""))).size !== source.targets.length ||
      !Array.isArray(views) || views.length < 2 || views.length > 8 ||
      views.some(v => !v || typeof v.id !== "string" || !v.id || v.id.length > 128 || !ms(v.paddingMs) || v.paddingMs > 2000) ||
      new Set(views.map(v => v.id)).size !== views.length || new Set(views.map(v => v.paddingMs)).size !== views.length ||
      !views.some(v => v.paddingMs === 0)) throw new Error("invalid_shift_audit_input");
  const observations = views.map(view => inspectView(source, view));
  const targets = source.targets.map(target => {
    const entries = observations.map(view => ({ id: view.id, reasons: view.reasons,
      target: view.targets.find(item => item.target === target) ?? null }));
    const qualified = entries.every(e => !e.reasons.length && e.target && !e.target.reasons.length);
    const points = entries.flatMap(e => Number.isFinite(e.target?.dtwStartMs) ? [e.target.dtwStartMs] : []);
    return { target, entries, completeComparableEvidence: qualified, dtwStartSpreadMs: spread(points),
      dtwEndSpreadMs: spread(entries.flatMap(e => Number.isFinite(e.target?.dtwEndMs) ? [e.target.dtwEndMs] : [])),
      ordinaryStartSpreadMs: spread(entries.flatMap(e => Number.isFinite(e.target?.ordinaryStartMs) ? [e.target.ordinaryStartMs] : [])),
      within300MsAcrossAll: qualified && points.length === views.length && spread(points) <= 300 };
  });
  return { kind: "onset_shift_diagnostic", automaticAcceptance: false, source, observations, targets,
    wholeTextIdentical: observations.every(o => o.text !== null && o.text === observations[0].text) };
}
