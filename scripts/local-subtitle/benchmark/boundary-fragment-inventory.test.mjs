import test from "node:test";
import assert from "node:assert/strict";
import { inventoryBoundaryFragments as inventory } from "./boundary-fragment-inventory.mjs";
const seg = text => ({ text, startMs: 0, endMs: 30000 });
const input = (l, r) => ({ leftWindow: { rootPlanId: "a", retryDepth: 0, startMs: 0, endMs: 30000, coreEndMs: 27500 },
  rightWindow: { rootPlanId: "a", retryDepth: 0, startMs: 25000, endMs: 55000, coreStartMs: 27500 }, leftRaw: [seg(l)], rightRaw: [seg(r)] });
test("records suffix/prefix spans without creating a replacement or timestamp", () => {
  const data = input("先ほどの説明をもう一度", "説明をもう一度確認します"), before = structuredClone(data), result = inventory(data);
  assert.equal(result.automaticAcceptance, false);
  assert.equal(result.relations[0].kind, "suffix_prefix");
  assert.equal(result.relations[0].matchedText, "説明をもう一度");
  assert.equal(result.relations[0].ambiguous, false);
  assert.equal(result.relations[0].observedOverlapMs, 5000);
  assert.equal(result.replacement, undefined);
  assert.deepEqual(data, before);
});
for (const [l, r, kind] of [["今日はいい天気", "今日はいい天気", "equal"],
  ["今日はいい天気", "それでは今日はいい天気です", "left_contained"],
  ["それでは今日はいい天気です", "今日はいい天気", "right_contained"]])
  test("classifies " + kind, () => assert.equal(inventory(input(l, r)).relations[0].kind, kind));
test("keeps repeated matches explicitly ambiguous", () => {
  assert.equal(inventory(input("今日はいい天気", "今日はいい天気今日はいい天気")).relations[0].ambiguous, true);
});
test("does not normalize Japanese lexical differences or use a short particle join", () => {
  for (const [l, r] of [["私はケーキはいいかな", "あ、いや"], ["今日はいい天気", "きょうはいい天気"], ["もしもし", "もしもしー"]])
    assert.deepEqual(inventory(input(l, r)).relations, []);
});
test("retains source grapheme positions around punctuation", () => {
  const result = inventory(input("前置き。今日はいい天気！", "今日は、いい天気。それから"));
  assert.deepEqual(result.relations[0].leftSpan, [4, 11]);
  assert.deepEqual(result.relations[0].rightSpan, [0, 8]);
});
test("same text without actual observation overlap is not listed", () => {
  const data = input("今日はいい天気", "今日はいい天気");data.leftRaw[0].endMs = 24000;
  assert.deepEqual(inventory(data).relations, []);
});
test("guards window identity, retries and input limits", () => {
  const data = input("今日はいい天気", "今日はいい天気");data.rightWindow.rootPlanId = "another";
  assert.equal(inventory(data).reason, "invalid_windows");
  const retry = input("今日はいい天気", "今日はいい天気");retry.leftWindow.retryDepth = 1;
  assert.equal(inventory(retry).reason, "invalid_windows");
  assert.equal(inventory().reason, "invalid_windows");
  assert.equal(inventory(input("あ".repeat(1025), "あ".repeat(1025))).reason, "invalid_segments");
});
test("preserves small native overruns explicitly and rejects larger invalid bounds", () => {
  const data = input("今日はいい天気", "今日はいい天気");data.leftRaw[0].endMs = 30020;
  const result = inventory(data);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].leftObservedMs[1], 30020);
  assert.equal(result.nativeOverrunMs.left, 20);
  data.leftRaw[0].endMs = 30101;
  assert.equal(inventory(data).reason, "invalid_segments");
});
