import test from "node:test";
import assert from "node:assert/strict";
import { auditCompleteOverlapWitness as audit } from "./complete-overlap-witness-audit.mjs";

const seg = (text, startMs, endMs) => ({ text, startMs, endMs,
  dtwTokens: [{ text, pointMs: startMs + 40 }] });
function input() {
  const l = "は?でも調子になんで", r = "は?でも女子になんてこと聞くんだ";
  return { mediaSha256: "a".repeat(64), rightWindowStartMs: 75000,
    review: { left: seg(l, 74610, 77500), right: seg(r, 77500, 81000),
      leftObservation: seg(l, 24610, 30000), rightObservation: seg(r, 2370, 6000),
      window: { startMs: 70000, endMs: 90000 } },
    candidate: [seg("ね?", 4380, 4620), seg("は?", 7280, 7520), seg("でも", 8020, 8360),
      seg("女子になんてこと聞くんだ", 8360, 11000)] };
}

test("proposes existing complete observation and its original onset, for listening only", () => {
  const data = input(), before = structuredClone(data), result = audit(data);
  assert.equal(result.status, "listening_candidate");
  assert.equal(result.automaticAcceptance, false);
  assert.equal(result.replacement.text, data.review.right.text);
  assert.equal(result.replacement.startMs, 77370);
  assert.equal(result.replacement.endMs, 81000);
  assert.deepEqual(result.evidence.removedDisplayRange, [74610, 77370]);
  assert.deepEqual(data, before);
});
test("also handles different text without fixing a sample timestamp", () => {
  const data = input();
  data.review.left.text = data.review.leftObservation.text = "それでも昨日のはなしは";
  data.review.right.text = data.review.rightObservation.text = "それでも昨日の話はまだ終わっていません";
  data.candidate = [seg("それでも", 7280, 7520), seg("昨日の話は", 8020, 8360), seg("まだ終わっていません", 8360, 11000)];
  assert.equal(audit(data).status, "listening_candidate");
});
for (const scenario of ["repeat", "nearby_words", "changed_word", "late_onset", "early_tail", "bad_point", "missing_tokens", "partial_segment", "too_many_parts", "exact_prefix", "invalid_identity"]) {
  test("rejects " + scenario, () => {
    const data = input();
    if (scenario === "repeat") data.candidate.push(seg(data.review.right.text, 12000, 18000));
    if (scenario === "nearby_words") data.candidate.splice(1, 0, seg("もう一度", 5000, 6000));
    if (scenario === "changed_word") data.candidate[3] = seg("男子になんてこと聞くんだ", 8360, 11000);
    if (scenario === "late_onset") data.review.rightObservation.startMs = 3000;
    if (scenario === "early_tail") data.candidate[3].endMs = 10400;
    if (scenario === "bad_point") data.candidate[3].dtwTokens[0].pointMs = 0;
    if (scenario === "missing_tokens") delete data.candidate[2].dtwTokens;
    if (scenario === "partial_segment") data.candidate[3] = seg("女子になんてこと聞くんだそれから", 8360, 11000);
    if (scenario === "too_many_parts") data.candidate = Array.from(data.review.right.text.replace(/\?/g, ""), (c, i) => seg(c, 7280 + i * 150, 7430 + i * 150));
    if (scenario === "exact_prefix") data.review.left.text = data.review.leftObservation.text = "は?でも女子になんて";
    if (scenario === "invalid_identity") data.mediaSha256 = "unknown";
    assert.equal(audit(data).status, "rejected");
  });
}
test("does not treat repeated words on a nonverbal control as supporting evidence", () => {
  const data = input(); data.candidate = Array.from({ length: 9 }, (_, i) => seg("はい", i * 2000, i * 2000 + 2000));
  assert.equal(audit(data).status, "rejected");
});
test("rejects disordered segments and fixed input budgets", () => {
  const data = input(); data.candidate[2].startMs = 7000;
  assert.equal(audit(data).status, "rejected");
  assert.equal(audit({ ...input(), candidate: Array(129).fill(seg("あ", 0, 1)) }).status, "rejected");
  assert.equal(audit().status, "rejected");
});
