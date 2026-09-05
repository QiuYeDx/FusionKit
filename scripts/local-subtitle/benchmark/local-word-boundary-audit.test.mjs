import assert from "node:assert/strict";
import test from "node:test";
import { auditLocalWordBoundary, auditLocalDtwBoundary } from "./local-word-boundary-audit.mjs";

const sha = "a".repeat(64);
const text = "昨日は晴れ今日は雨です明日は晴れ";
const source = { text, startMs: 0, endMs: 10000, mediaSha256: sha };
const word = (word, start, end) => ({ word, start, end });
function view(id, offset = 0) {
  const shift = offset / 1000;
  return { id, mode: "uncompressed_non_vad", mediaSha256: sha, windowStartMs: offset, windowEndMs: 11000,
    segments: [{ text: "昨日は晴れ。今日は雨です。明日は晴れ", start: 1 - shift, end: 8 - shift,
      words: [word("昨日は晴れ", 1 - shift, 3 - shift), word("。", 3 - shift, 3.1 - shift),
        word("今日は雨です", 3.2 - shift, 5 - shift), word("。", 5 - shift, 5.1 - shift),
        word("明日は晴れ", 5.2 - shift, 7 - shift)] }] };
}
const audit = (a = view("a"), b = view("b", 500), s = source, at = 5) => auditLocalWordBoundary(s, at, [a, b]);

test("shifted views compare original-media word edges without inventing a native boundary", () => {
  const result = audit();
  assert.equal(result.stableWordEvidence, true);
  assert.equal(result.automaticAcceptance, false);
  assert.deepEqual(result.observations[1].interval, { leftEndMs: 3000, rightStartMs: 3200 });
  assert.equal(result.observations[1].nativeBoundaryMs, null);
});

test("records a native segment boundary separately from punctuation and word times", () => {
  const a = view("a");
  a.segments = [{ text: "昨日は晴れ。", start: 1, end: 3.1, words: a.segments[0].words.slice(0, 2) },
    { text: "今日は雨です。明日は晴れ", start: 3.1, end: 8, words: a.segments[0].words.slice(2) }];
  assert.equal(audit(a).observations[0].nativeBoundaryMs, 3100);
});

test("whole local groups can map without allowing incorrect neighboring segments", () => {
  const a = view("a");
  a.segments.unshift({ text: "誤認識", start: 0, end: 0.5, words: [word("誤認識", 0, 0.5)] });
  const result = audit(a);
  assert.equal(result.stableWordEvidence, true);
  assert.deepEqual(result.observations[0].group, [1, 1]);
});

test("never mines an exact substring inside a segment with changed words", () => {
  const a = view("a"); a.segments[0].text = "誤" + a.segments[0].text;
  assert.deepEqual(audit(a).observations[0].reasons, ["no_exact_complete_group"]);
});

test("ambiguous repeated phrases cannot be resolved by their apparent timestamps", () => {
  const result = audit(view("a"), view("b", 500), { ...source, text: text + text });
  assert.equal(result.stableWordEvidence, false);
  assert.deepEqual(result.observations[0].reasons, ["no_exact_complete_group"]);
});

test("same-start and duplicate observations do not establish independent stability", () => {
  const b = view("b"); b.windowEndMs = 12000;
  assert.ok(audit(view("a"), b).reasons.includes("no_shifted_window"));
  assert.ok(audit(view("a"), view("b")).reasons.includes("duplicate_observation"));
});

test("does not discard a third disagreeing crop or average its time into the others", () => {
  const c = view("c", 700); c.segments[0].words[2].start += 0.5;
  const result = auditLocalWordBoundary(source, 5, [view("a"), view("b", 500), c]);
  assert.equal(result.stableWordEvidence, false);
  assert.deepEqual(result.spread, { leftEndMs: 0, rightStartMs: 500 });
  assert.ok(result.reasons.includes("window_disagreement"));
  assert.equal(result.observations[2].interval.rightStartMs, 3700);
});

test("zero-length speech, stretched words and long gaps fail even when repeated", () => {
  for (const change of [w => { w[2].end = w[2].start; }, w => { w[2].start = 1; },
    w => { w[0].end = 1.5; w[1].start = 1.5; }]) {
    const a = view("a"); change(a.segments[0].words);
    assert.equal(audit(a).stableWordEvidence, false);
  }
});

test("word strings must cover segments exactly; token interiors cannot become cuts", () => {
  const a = view("a"); a.segments[0].words[2].word = "違う";
  assert.deepEqual(audit(a).observations[0].reasons, ["word_text_coverage_mismatch"]);
  assert.deepEqual(audit(view("a"), view("b", 500), source, 4).observations[0].reasons, ["inside_token"]);
});

test("rejects compressed times, other media, non-finite and disordered intervals", () => {
  for (const change of [a => { a.mode = "vad_compressed"; }, a => { a.mediaSha256 = "b".repeat(64); },
    a => { a.segments[0].words[2].start = NaN; }, a => { a.segments[0].start = -1; }]) {
    const a = view("a"); change(a); assert.equal(audit(a).stableWordEvidence, false);
  }
});

test("preserves original whitespace and punctuation instead of silently normalizing", () => {
  for (const inserted of [" ", "!"]) {
    assert.equal(audit(view("a"), view("b", 500), { ...source, text: text.slice(0, 5) + inserted + text.slice(5) }).stableWordEvidence, false);
  }
});

test("bounds inputs and rejects fractional source positions", () => {
  assert.throws(() => auditLocalWordBoundary(source, 2.5, [view("a"), view("b", 500)]), /invalid_audit_input/);
  const a = view("a"); a.segments = Array.from({ length: 129 }, () => a.segments[0]);
  assert.equal(audit(a).stableWordEvidence, false);
});

function dtwView(id, offset = 0) {
  const result = view(id, offset);
  for (const word of result.segments[0].words) word.t_dtw = Math.round((word.start + word.end) * 50);
  return result;
}
const dtwAudit = (a = dtwView("a"), b = dtwView("b", 500)) => auditLocalDtwBoundary(source, 5, [a, b]);

test("DTW uses ten-millisecond points plus real crop offset, not ordinary word edges", () => {
  const a = dtwView("a"); a.segments[0].words[0].start = a.segments[0].words[0].end;
  const result = dtwAudit(a);
  assert.equal(result.stableDtwEvidence, true);
  assert.equal(result.automaticAcceptance, false);
  assert.equal(result.observations[0].semantics, "token_interior_points_not_speech_edges");
  assert.deepEqual(result.observations[1].points, { leftPointMs: 2000, rightPointMs: 4100 });
});

test("uncomputed, fractional, out-of-window or backward DTW values fail closed", () => {
  for (const value of [-1, 1.2, NaN, 2000, 100]) {
    const a = dtwView("a"); a.segments[0].words[2].t_dtw = value;
    assert.equal(dtwAudit(a).stableDtwEvidence, false);
    assert.deepEqual(dtwAudit(a).observations[0].reasons, ["invalid_dtw_sequence"]);
  }
});

test("DTW punctuation points cannot mask a collapsed speech boundary", () => {
  const a = dtwView("a"); a.segments[0].words[2].t_dtw = a.segments[0].words[0].t_dtw;
  a.segments[0].words[1].t_dtw = 500;
  assert.deepEqual(dtwAudit(a).observations[0].reasons, ["degenerate_dtw_boundary"]);
});

test("DTW reports disagreeing points without converting them into duration intervals", () => {
  const b = dtwView("b", 500); b.segments[0].words[2].t_dtw += 40;
  const result = dtwAudit(dtwView("a"), b);
  assert.equal(result.stableDtwEvidence, false);
  assert.ok(result.reasons.includes("window_disagreement"));
  assert.deepEqual(result.spread, { leftPointMs: 0, rightPointMs: 400 });
  assert.equal(result.observations[0].interval, undefined);
});
