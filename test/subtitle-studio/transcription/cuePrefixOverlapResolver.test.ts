import { expect, it } from "vitest";
import { hasPrefixOverlapBudget, planPrefixOverlapReview } from "../../../electron/main/subtitle-studio/transcription/native/cue-prefix-overlap-resolver";
const win = (startMs: number, key: string) => ({ windowKey: key, rootWindowKey: key, rootPlanId: "p", retryDepth: 0,
  startMs, endMs: startMs + 30000, coreStartMs: startMs + 2500, coreEndMs: startMs + 27500,
  startFrame: startMs * 16, endFrame: (startMs + 30000) * 16,
  coreStartFrame: (startMs + 2500) * 16, coreEndFrame: (startMs + 27500) * 16 });
const raw = (text: string, startMs: number, endMs: number) => ({ id: 0, text, startMs, endMs,
  temperature: 0, averageLogProbability: -.1, noSpeechProbability: .01 });
const input = () => {
  const left = raw("前置き説明をもう一度", 45570, 51720), right = raw("説明をもう一度 確認してから始めます", 50160, 61230);
  return { sourceIdentity: "normalized-task", durationMs: 80000, leftWindow: win(25000, "a"), rightWindow: win(50000, "b"),
    leftRaw: [{ ...left, startMs: 20570, endMs: 26720 }], rightRaw: [{ ...right, startMs: 160, endMs: 11230 }],
    cues: [{ ...left, id: "left" }, { ...right, id: "right", startMs: 52500 }] };
};
it("plans two fixed original-audio windows and preserves absolute source observations", () => {
  const p = planPrefixOverlapReview(input())!;
  expect(p.windows.map(w => [w.startMs, w.endMs])).toEqual([[45000, 65000], [44000, 64000]]);
  expect(p.budgetRoots).toEqual(["a", "b"]);
  expect(p.source.rightObservation.startMs).toBe(50160);
  expect(p.source.right.startMs).toBe(52500);
});
it.each(["duration", "retry", "different_plan", "changed", "owner", "repeated", "no_overlap"])("rejects invalid source planning: %s", scenario => {
  const d = input();
  if (scenario === "duration") d.durationMs = 64999;
  if (scenario === "retry") d.rightWindow.retryDepth = 1;
  if (scenario === "different_plan") d.leftWindow.rootPlanId = "q";
  if (scenario === "changed") d.cues[1].text += "ね";
  if (scenario === "owner") d.cues[1].startMs++;
  if (scenario === "repeated") { d.leftRaw[0].text += "説明をもう一度"; d.cues[0].text = d.leftRaw[0].text; }
  if (scenario === "no_overlap") d.rightRaw[0].startMs = 2000;
  expect(planPrefixOverlapReview(d)).toBeUndefined();
});
it("requires two free root slots and two global request slots, including previous optional work", () => {
  const primary = new Map([["a", 2], ["b", 2], ["c", 1], ["d", 1]]);
  expect(hasPrefixOverlapBudget(["a", "b"], 4, primary, primary)).toBe(true);
  expect(hasPrefixOverlapBudget(["a", "a"], 4, primary, primary)).toBe(false);
  expect(hasPrefixOverlapBudget(["a", "b"], 4, primary, new Map([...primary, ["c", 2]]))).toBe(false);
  expect(hasPrefixOverlapBudget(["a", "b"], 5, primary, new Map([...primary, ["a", 3]]))).toBe(false);
  expect(hasPrefixOverlapBudget(["a", "b"], 5, new Map([["a", 3], ["b", 2]]), new Map([["a", 3], ["b", 2]]))).toBe(false);
  expect(hasPrefixOverlapBudget(["a", "missing"], 10, primary, primary)).toBe(false);
});
