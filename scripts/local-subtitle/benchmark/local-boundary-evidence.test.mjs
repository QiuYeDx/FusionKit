import assert from "node:assert/strict";
import test from "node:test";
import { findInsertionOnlySpans, reviewLocalBoundaries, renderLocalSeparatorPreview } from "./local-boundary-evidence.mjs";

const sha = "a".repeat(64);
const clone = value => structuredClone(value);
const source = (text = "Hello!World!") => ({ text, contextText: text, contextStart: 0,
  contextEnd: Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)).length,
  startMs: 1000, endMs: 5000, mediaSha256: sha });
const segment = (text, start, end) => ({ text, start, end, words: [{ word: text, start, end }] });
const view = (id, windowEndMs = 8000) => ({ id, mediaSha256: sha, mode: "uncompressed_non_vad", windowStartMs: 0, windowEndMs,
  segments: [segment("Hello!", 1, 3), segment("World!", 3, 5)] });

test("entire candidate must map; repeated words, existing punctuation and spaces cannot disappear", () => {
  for (const [original, candidate] of [["go go", "go"], ["Hello!World!", "HelloWorld!"], ["a b", "ab"]]) {
    const spans = findInsertionOnlySpans(original, candidate);
    assert.ok(spans.every(span => span.start !== 0 || span.end !== Array.from(original).length));
  }
  assert.deepEqual(findInsertionOnlySpans("Go", "Gone"), []);
  assert.deepEqual(findInsertionOnlySpans("Go", "fakeGo"), []);
});

test("matching records exact insertion positions and permits fully mapped context", () => {
  const [match] = findInsertionOnlySpans("前你好再见后", "「你好，再见。」");
  assert.equal(match.start, 1);
  assert.equal(match.end, 5);
  assert.deepEqual(match.insertions.map(item => item.offset), [1, 3, 5, 5]);
});

test("two consistent native boundaries qualify only for listening, never automatic acceptance", () => {
  const result = reviewLocalBoundaries(source(), [view("a"), view("b", 9000)], "en");
  assert.equal(result.edits.length, 1);
  assert.equal(result.timingCandidates[0].qualifiedForListening, true);
  assert.equal(result.automaticAcceptance, false);
});

test("text separators survive a bad timestamp while time qualification fails", () => {
  const broken = view("b", 9000);
  broken.segments[1].words[0].end = 3;
  const result = reviewLocalBoundaries(source(), [view("a"), broken], "en");
  assert.equal(result.edits.length, 1);
  assert.ok(result.timingCandidates[0].reasons.includes("invalid_adjacent_word"));
  assert.equal(result.timingCandidates[0].qualifiedForListening, false);
  const preview = renderLocalSeparatorPreview(source(), result);
  assert.equal(preview.text, "Hello! World!");
  assert.equal(preview.startMs, 1000);
  assert.equal(preview.endMs, 5000);
});

test("punctuation-only second view cannot be reported as native time corroboration", () => {
  const s = source("你好再见"), a = view("a"), b = view("b", 9000);
  a.segments = [segment("你好", 1, 3), segment("再见", 3, 5)];
  b.segments = [segment("你好，再见", 1, 5)];
  const result = reviewLocalBoundaries(s, [a, b], "zh");
  assert.deepEqual(result.edits, [{ offset: 2, insert: " " }]);
  assert.ok(result.timingCandidates[0].reasons.includes("missing_native_anchor"));
});

test("rejects a lone view, repeated view and uncompressed identity violations", () => {
  assert.equal(reviewLocalBoundaries(source(), [view("a")], "en").edits.length, 0);
  assert.equal(reviewLocalBoundaries(source(), [view("a"), view("b")], "en").reason, "duplicate_observation");
  for (const change of [{ mode: "vad_compressed" }, { mediaSha256: "b".repeat(64) }]) {
    const bad = { ...view("b", 9000), ...change };
    const result = reviewLocalBoundaries(source(), [view("a"), bad], "en");
    assert.equal(result.edits.length, 0);
    assert.equal(result.observations[1].reason, "invalid_provenance");
  }
});

test("a contradicting third view is not discarded to select the favorable pair", () => {
  const bad = view("c", 10000);
  bad.segments = [segment("Changed!World!", 1, 5)];
  const result = reviewLocalBoundaries(source(), [view("a"), view("b", 9000), bad], "en");
  assert.equal(result.edits.length, 0);
});

test("rejects window-sensitive times without moving them toward each other", () => {
  const bad = view("b", 9000);
  bad.segments[0] = segment("Hello!", 1.5, 3.5);
  bad.segments[1] = segment("World!", 3.5, 5.5);
  const result = reviewLocalBoundaries(source(), [view("a"), bad], "en");
  assert.ok(result.timingCandidates[0].reasons.includes("window_disagreement"));
  assert.deepEqual(result.timingCandidates[0].anchors.map(anchor => anchor.atMs), [3000, 3500]);
});

test("refuses dependent Japanese endings and word-internal cuts", () => {
  for (const [text, left, right] of [["誰だ", "誰", "だ"], ["そなた", "そ", "なた"], ["そうだ", "そ", "うだ"]]) {
    const a = view("a"), b = view("b", 9000);
    a.segments = b.segments = [segment(left, 1, 3), segment(right, 3, 5)];
    assert.equal(reviewLocalBoundaries(source(text), [a, b]).edits.length, 0);
  }
});

test("never invents text for an empty accepted source", () => {
  const result = reviewLocalBoundaries(source(""), [view("a"), view("b", 9000)]);
  assert.equal(result.reason, "no_accepted_source_text");
  assert.deepEqual(result.edits, []);
});

test("an existing word space is preserved without adding another separator", () => {
  const s = source("Hello! World!"), a = view("a"), b = view("b", 9000);
  a.segments[1] = b.segments[1] = segment(" World!", 3, 5);
  const result = reviewLocalBoundaries(s, [a, b], "en");
  assert.deepEqual(result.edits, []);
  assert.equal(renderLocalSeparatorPreview(s, result).text, s.text);
});

test("preserves grapheme offsets, original repeated text, and rejects non-punctuation edits", () => {
  const s = source("e\u0301再见再见"), [match] = findInsertionOnlySpans(s.text, "e\u0301，再见再见");
  assert.deepEqual(match.insertions, [{ offset: 1, insert: "，" }]);
  assert.equal(renderLocalSeparatorPreview(s, { edits: match.insertions }).text, "e\u0301，再见再见");
  assert.throws(() => renderLocalSeparatorPreview(s, { edits: [{ offset: 1, insert: "fake" }] }), /invalid_insertion/);
  assert.throws(() => renderLocalSeparatorPreview(s, { edits: [{ offset: 1, insert: " " }, { offset: 1, insert: " " }] }), /invalid_insertion/);
});

test("bad adjacent coverage and stretched words cannot supply time anchors", () => {
  for (const mutate of [
    v => { v.segments[0].words[0].word = "Other!"; },
    v => { v.segments[0].words[0].start = 0; },
    v => { v.segments[1].words[0].end = Infinity; },
  ]) {
    const bad = clone(view("b", 9000)); mutate(bad);
    const result = reviewLocalBoundaries(source(), [view("a"), bad], "en");
    assert.equal(result.timingCandidates[0].qualifiedForListening, false);
  }
});
