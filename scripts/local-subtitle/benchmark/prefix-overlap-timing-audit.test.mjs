import test from "node:test";
import assert from "node:assert/strict";
import { auditPrefixOverlapTiming as audit } from "./prefix-overlap-timing-audit.mjs";
const sha = "a".repeat(64);
const left = { text: "前置き説明をもう一度", startMs: 1000, endMs: 6000 };
const right = { text: "説明をもう一度 確認してから始めます", startMs: 6500, endMs: 12000 };
const source = () => ({ mediaSha256: sha, left: { ...left }, right: { ...right }, leftObservation: { ...left }, rightObservation: { ...right, startMs: 5000 } });
function view(id = "a", origin = 0, shift = 0) {
  const segment = (pairs, start, end) => ({ text: pairs.map(p => p[0]).join(""), startMs: start - origin, endMs: end - origin,
    dtwTokens: pairs.map(([text, point]) => ({ text, pointMs: point - origin })) });
  return { id, mediaSha256: sha, mode: "uncompressed_non_vad", windowStartMs: origin, windowEndMs: 14000,
    segments: [segment([["前置き", 2000], ["説明を", 5000], ["もう一度", 5500]], 1000, 6000),
      segment([["確認", 9000 + shift], ["してから", 9700], ["始めます", 11000]], 6000, 12000)] };
}
const pair = () => [view(), view("b", 500, 100)];
test("preserves the complete remainder and explicitly marks a long-gap listening proposal", () => {
  const s = source(), before = structuredClone(s), result = audit(s, pair());
  assert.equal(result.status, "listening_candidate");assert.equal(result.automaticAcceptance, false);
  assert.deepEqual(result.replacement, { ...right, text: "確認してから始めます", startMs: 9000 });
  assert.equal(result.removedPrefix, "説明をもう一度 ");
  assert.equal(result.observations[0].longGap, true);assert.deepEqual(s, before);
});
test("retains a contradicting later observation instead of selecting the favorable pair", () => {
  const r = audit(source(), [...pair(), view("c", 1000, 500)]);
  assert.equal(r.reason, "unstable_time");assert.equal(r.observations.length, 3);
});
test("requires two distinct input origins and matching media provenance", () => {
  assert.equal(audit(source(), [view()]).status, "rejected");
  assert.equal(audit(source(), [view(), view("b")]).reason, "duplicate_observations");
  const views = pair();views[1].mediaSha256 = "b".repeat(64);
  assert.equal(audit(source(), views).reason, "unsupported_observation");
});
for (const scenario of ["edit", "repeat", "missing", "interior", "no_boundary", "reverse", "out_of_bounds", "far_gap"]) {
  test("rejects " + scenario + " evidence without changing words", () => {
    const s = source(), views = pair(), v = views[1];
    if (scenario === "edit") { v.segments[1].text = v.segments[1].text.replace("確認", "相談");v.segments[1].dtwTokens[0].text = "相談"; }
    if (scenario === "repeat") { v.segments[1].text += v.segments[1].text;v.segments[1].dtwTokens.push(...structuredClone(v.segments[1].dtwTokens)); }
    if (scenario === "missing") delete v.segments[1].dtwTokens;
    if (scenario === "interior") { v.segments[0].text += "確認";v.segments[0].dtwTokens.at(-1).text += "確認";v.segments[1].text = v.segments[1].text.slice(2);v.segments[1].dtwTokens.shift(); }
    if (scenario === "no_boundary") { v.segments[0].text += v.segments[1].text;v.segments[0].dtwTokens.push(...v.segments[1].dtwTokens);v.segments[0].endMs = v.segments[1].endMs;v.segments.pop(); }
    if (scenario === "reverse") v.segments[1].dtwTokens[1].pointMs = 0;
    if (scenario === "out_of_bounds") v.segments[1].dtwTokens.at(-1).pointMs = 15000;
    if (scenario === "far_gap") {
      s.right.endMs = s.rightObservation.endMs = 22000;
      v.windowEndMs = 24000;
      v.segments[1].endMs = 22000 - v.windowStartMs;
      v.segments[1].dtwTokens.forEach(t => { t.pointMs += 7000; });
    }
    const result = audit(s, views);
    assert.equal(result.status, "rejected");
    if (scenario === "far_gap") assert.equal(result.observations[1].reason, "time_bounds");
  });
}
test("source timing, repeated prefixes and quoted structures do not justify deletion", () => {
  const s = source();s.rightObservation.startMs = 6100;
  assert.equal(audit(s, pair()).status, "rejected");
  const repeated = source();repeated.left.text += "説明をもう一度";repeated.leftObservation.text = repeated.left.text;
  assert.equal(audit(repeated, pair()).status, "rejected");
  const quoted = source();quoted.left.text = "「" + quoted.left.text + "」";
  assert.equal(audit(quoted, pair()).status, "rejected");
});
test("never uses an empty or repeated nonverbal control as positive evidence", () => {
  const views = pair();views[1].segments = [];
  assert.equal(audit(source(), views).status, "rejected");
  views[1].segments = Array.from({ length: 129 }, () => views[0].segments[0]);
  assert.equal(audit(source(), views).status, "rejected");
  assert.equal(audit(null, []).status, "rejected");
});
