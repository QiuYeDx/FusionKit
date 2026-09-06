import assert from "node:assert/strict";
import test from "node:test";
import { auditLocalAnchoredDtwBoundaries as audit } from "./local-anchored-dtw-audit.mjs";

const sha = "a".repeat(64);
const source = { text: "前置き私は学生です今日は家で勉強します最後の挨拶", startMs: 1000, endMs: 12000, mediaSha256: sha };
const at = source.text.indexOf("今日");
function view(id, offset = 0) {
  const tokens = [["え", 1000], ["、", 1200], ["私", 2000], ["は", 2300], ["学生", 3000], ["です", 4000], ["。", 4200],
    ["今日", 6000], ["は", 6400], ["家", 6700], ["で", 7000], ["勉強", 7300], ["します", 7600], ["。", 7800], ["違う末尾", 8500]];
  const words = tokens.map(([word, ms]) => ({ word, t_dtw: (ms - offset) / 10 }));
  return { id, mode: "uncompressed_non_vad", mediaSha256: sha, windowStartMs: offset, windowEndMs: 15000,
    segments: [{ text: words.map(w => w.word).join(""), start: 0, end: (10000 - offset) / 1000, words }] };
}
const run = (a = view("a"), b = view("b", 500), s = source) => audit(s, [a, b]);
const rewrite = (v, fn) => { fn(v.segments[0].words); v.segments[0].text = v.segments[0].words.map(w => w.word).join(""); return v; };

test("remote lexical differences allow only a locally exact, two-sided listening proposal", () => {
  const result = run();
  assert.equal(result.automaticAcceptance, false);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].offset, at);
  assert.equal(result.proposals[0].candidateMs, 6000);
  assert.deepEqual(result.proposals[0].spread, { leftPointMs: 0, rightPointMs: 0 });
  assert.equal(source.text, "前置き私は学生です今日は家で勉強します最後の挨拶");
});

test("target-local edits cannot be jumped over as in a subsequence alignment", () => {
  const b = rewrite(view("b", 500), ws => { ws[5].word = "でした"; });
  const result = run(view("a"), b);
  assert.equal(result.proposals.length, 0);
  assert.ok(result.rejected[0].reasons.includes("invalid_observation"));
});

test("a change on the right anchor also rejects the boundary", () => {
  const b = rewrite(view("b", 500), ws => { ws[7].word = "明日"; });
  assert.equal(run(view("a"), b).proposals.length, 0);
});

test("repeated source anchors cannot be disambiguated by native time", () => {
  for (const text of [source.text + source.text, source.text + "私は学生です", source.text + "今日は家で勉強します"]) {
    assert.equal(run(view("a"), view("b", 500), { ...source, text }).proposals.length, 0);
  }
});

test("repeated candidate anchors are not silently deduplicated", () => {
  const a = rewrite(view("a"), ws => ws.push({ word: "私は学生です", t_dtw: 900 }));
  assert.equal(run(a).proposals.length, 0);
});

test("commas, token interiors and dependent endings cannot create sentence cuts", () => {
  const comma = rewrite(view("a"), ws => { ws[6].word = "、"; });
  assert.equal(run(comma).proposals.length, 0);
  const inside = rewrite(view("a"), ws => ws.splice(5, 3, { word: "です。今日", t_dtw: 600 }));
  assert.equal(run(inside).proposals.length, 0);
  const dependent = rewrite(view("a"), ws => ws.splice(7, 0, { word: "だ", t_dtw: 590 }));
  assert.equal(run(dependent, view("b", 500), { ...source, text: source.text.replace("今日", "だ今日") }).proposals.length, 0);
});

test("native segment separation is distinct from inserted sentence punctuation", () => {
  const a = view("a"), ws = a.segments[0].words;
  a.segments = [{ text: ws.slice(0, 6).map(w => w.word).join(""), start: 0, end: 5, words: ws.slice(0, 6) },
    { text: ws.slice(7).map(w => w.word).join(""), start: 5, end: 10, words: ws.slice(7) }];
  assert.equal(run(a).proposals.length, 1);
  assert.equal(run(a).observations[0].boundaries[0].nativeBoundary, true);
});

test("a short, one-sided or single-token left anchor is rejected", () => {
  const a = rewrite(view("a"), ws => ws.splice(2, 4, { word: "私は学生です", t_dtw: 400 }));
  assert.equal(run(a).proposals.length, 0);
  const result = run();
  assert.ok(result.observations.every(o => o.boundaries.every(b => b.offset !== source.text.indexOf("私"))));
});

test("two-token Han copular replies are complete short anchors; kana near-misses are not", () => {
  for (const reply of ["私だ", "僕だ", "春だ", "のだ", "んだ"]) {
    const s = { ...source, text: source.text.replace("私は学生です", reply) };
    const replace = v => rewrite(v, ws => ws.splice(2, 4,
      { word: reply[0], t_dtw: (3000 - v.windowStartMs) / 10 },
      { word: "だ", t_dtw: (4000 - v.windowStartMs) / 10 }));
    const result = run(replace(view("a")), replace(view("b", 500)), s);
    assert.equal(result.proposals.length, /^[私僕春]/u.test(reply) ? 1 : 0);
  }
});

test("word points need exact token coverage, order, noncollapse and original time bounds", () => {
  for (const mutate of [v => { v.segments[0].words[7].t_dtw = -1; },
    v => { v.segments[0].words[7].t_dtw = 1.2; }, v => { v.segments[0].words[7].t_dtw = 1600; },
    v => { v.segments[0].words[7].t_dtw = 350; }, v => { v.segments[0].text += "余"; }]) {
    const b = view("b", 500); mutate(b);
    assert.equal(run(view("a"), b).proposals.length, 0);
  }
});

test("a collapsed or excessively separated adjacent point pair never qualifies", () => {
  for (const point of [400, 660]) {
    const a = view("a");
    if (point === 660) for (let i = 8; i < a.segments[0].words.length; i++) a.segments[0].words[i].t_dtw += 100;
    a.segments[0].words[7].t_dtw = point;
    assert.equal(run(a).proposals.length, 0);
  }
});

test("does not assign grapheme positions through separately tokenized combining marks", () => {
  const a = rewrite(view("a"), ws => ws.unshift({ word: "e", t_dtw: 10 }, { word: "\u0301", t_dtw: 20 }));
  assert.equal(run(a).proposals.length, 0);
  assert.deepEqual(run(a).observations[0].reasons, ["token_grapheme_mismatch"]);
});

test("a repeated false-word transcript has no unique local anchor, even as a supplied source", () => {
  const text = "もやし".repeat(4), s = { ...source, text };
  const a = { ...view("a"), segments: Array.from({ length: 4 }, (_, i) => ({ text: "もやし", start: i * 2, end: i * 2 + 2,
    words: [{ word: "も", t_dtw: i * 200 + 30 }, { word: "やし", t_dtw: i * 200 + 80 }] })) };
  assert.deepEqual(run(a, view("b", 500), s).observations[0].boundaries, []);
});

test("does not average a later conflicting view into the favorable pair", () => {
  const c = view("c", 700); c.segments[0].words[7].t_dtw += 35;
  const result = audit(source, [view("a"), view("b", 500), c]);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.rejected[0].spread.rightPointMs, 350);
});

test("a crop lacking anchor audio is retained as nonsupport, not counted as confirmation", () => {
  const short = { ...view("short"), windowStartMs: 5000, windowEndMs: 15000,
    segments: [{ text: "今日は家で勉強します", start: 0, end: 5,
      words: [{ word: "今日は家で勉強します", t_dtw: 200 }] }] };
  const result = audit(source, [view("a"), view("b", 500), short]);
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.proposals[0].votes[2].reasons, ["insufficient_audio_context"]);
  assert.equal(audit(source, [view("a"), short]).proposals.length, 0);
});

test("invalid provenance cannot hide behind missing audio context", () => {
  const b = view("b", 500); b.windowStartMs = NaN;
  assert.equal(run(view("a"), b).proposals.length, 0);
  b.windowStartMs = 500; b.mediaSha256 = "b".repeat(64);
  assert.equal(run(view("a"), b).proposals.length, 0);
});

test("same-start or duplicated observations do not establish shifted support", () => {
  const b = view("b"); b.windowEndMs = 16000;
  assert.equal(run(view("a"), b).proposals.length, 0);
  assert.equal(run(view("a"), view("a", 500)).proposals.length, 0);
});

test("does not normalize whitespace, spelling, kana length or quotation structure", () => {
  for (const text of [source.text.replace("今日", "今 日"), source.text.replace("今日", "きょう"), `「${source.text}」`]) {
    if (text.startsWith("「")) assert.throws(() => run(view("a"), view("b", 500), { ...source, text }), /invalid_audit_input/);
    else assert.equal(run(view("a"), view("b", 500), { ...source, text }).proposals.length, 0);
  }
});

test("retains original grapheme offsets in the presence of supplementary characters", () => {
  const s = { ...source, text: "😀" + source.text };
  assert.equal(run(view("a"), view("b", 500), s).proposals[0].offset, at + 1);
});

test("fixed resource budgets fail closed", () => {
  assert.throws(() => audit(source, Array.from({ length: 9 }, (_, i) => view(`${i}`, i * 10))), /invalid_audit_input/);
  const b = view("b", 500); b.segments = Array.from({ length: 129 }, () => b.segments[0]);
  assert.equal(run(view("a"), b).proposals.length, 0);
  const large = { ...source, text: "漢".repeat(2000) };
  const a = { ...view("a"), segments: [{ text: "漢".repeat(2000), start: 0, end: 10, words: [{ word: "漢".repeat(2000), t_dtw: 200 }] }] };
  assert.deepEqual(audit(large, [a, view("b", 500)]).observations[0].reasons, ["comparison_budget_exceeded"]);
});
