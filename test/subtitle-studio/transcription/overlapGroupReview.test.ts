import { describe, expect, it } from "vitest";
import { planOverlapGroupReview as plan } from "../../../electron/main/subtitle-studio/transcription/native/overlap-group-review";
import type { LocalSubtitlePostProcessingWindow as Window } from "../../../electron/main/subtitle-studio/transcription/native/subtitle-post-processor";
const first = "最初のお知らせ", second = "続きのお知らせ";
const window = (key: string, startMs: number, endMs: number, coreStartMs: number, coreEndMs: number): Window => ({
  windowKey: key, rootWindowKey: key, rootPlanId: "p", retryDepth: 0, startMs, endMs, coreStartMs, coreEndMs,
  startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: coreStartMs * 16, coreEndFrame: coreEndMs * 16,
});
const raw = (startMs: number, endMs: number, text: string) => ({ id: 0, startMs, endMs, text,
  temperature: 0, averageLogProbability: -0.2, noSpeechProbability: 0.01 });
function fixture(manyLeft = false) {
  const leftWindow = window("a", 0, 30000, 0, 27500), rightWindow = window("b", 25000, 55000, 27500, 55000);
  const leftRaw = manyLeft ? [raw(25800, 26800, first), raw(26800, 29000, second)] : [raw(26000, 29000, first + second)];
  const rightRaw = manyLeft ? [raw(900, 4000, first + second)] : [raw(800, 2800, first), raw(2800, 4000, second)];
  const cues = [...leftRaw.map(r => ({ ...r, startMs: r.startMs, endMs: Math.min(27500, r.endMs) })),
    ...rightRaw.map(r => ({ ...r, startMs: Math.max(27500, r.startMs + 25000), endMs: r.endMs + 25000 }))]
    .map((c, i) => ({ ...c, id: "c" + i }));
  return { sourceIdentity: "pcm-1", durationMs: 55000, leftWindow, rightWindow, leftRaw, rightRaw, cues };
}
describe("source-group review admission", () => {
  it.each([false, true])("maps one-to-many and many-to-one without assuming speech ends at the window tail (%s)", many => {
    const input = fixture(many), copy = structuredClone(input), review = plan(input)!;
    expect(review.status).toBe("review_required");
    expect(review.left.length).toBe(many ? 2 : 1); expect(review.right.length).toBe(many ? 1 : 2);
    expect(review.indices).toEqual([0, 1, 2]); expect(review).not.toHaveProperty("replacements");
    expect(review.windows.map(w => w.endMs - w.startMs)).toEqual([20000, 20000]);
    expect(input).toEqual(copy); expect(Object.isFrozen(review.left[0])).toBe(true);
  });
  it("ignores a raw trailing observation outside the owned core without losing the real boundary source", () => {
    const input = fixture(); input.leftRaw.push(raw(29000, 30000, "別の言葉"));
    expect(plan(input)?.left.map(m => m.rawIndex)).toEqual([0]);
  });
  it("keeps unique leading content in the review instead of discarding it as a fuzzy mismatch", () => {
    const input = fixture();input.leftRaw[0].text = "ん、" + input.leftRaw[0].text;input.cues[0].text = input.leftRaw[0].text;
    expect(plan(input)?.left[0].observed.text.startsWith("ん、")).toBe(true);
  });
  it("admits whole-phrase variants without requiring a multi-cue right side", () => {
    const input = fixture();
    input.rightRaw = [raw(900, 4000, first + "続きの御知らせ")];
    input.cues = [input.cues[0], { ...input.cues[1], text: input.rightRaw[0].text, endMs: 29000 }];
    const review = plan(input)!;
    expect(review.left).toHaveLength(1);expect(review.right).toHaveLength(1);
    expect(review.indices).toEqual([0, 1]);expect(review).not.toHaveProperty("replacements");
  });
  it.each(["missing_plan", "frame_mismatch", "invalid_core", "parent", "unowned_root"])("rejects invalid window provenance: %s", mode => {
    const input = fixture();
    if (mode === "missing_plan") {input.leftWindow = { ...input.leftWindow, rootPlanId: "" };input.rightWindow = { ...input.rightWindow, rootPlanId: "" };}
    if (mode === "frame_mismatch") input.leftWindow = { ...input.leftWindow, startFrame: 16000 };
    if (mode === "invalid_core") input.leftWindow = { ...input.leftWindow, coreStartMs: -1 };
    if (mode === "parent") input.leftWindow = { ...input.leftWindow, parentWindowKey: "earlier" };
    if (mode === "unowned_root") input.leftWindow = { ...input.leftWindow, rootWindowKey: "different" };
    expect(plan(input)).toBeUndefined();
  });
  it.each(["no_overlap", "other_plan", "changed_cue", "duplicate_cue", "unrelated", "no_margin", "retry"])("rejects %s", mode => {
    const input = fixture();
    if (mode === "no_overlap") input.rightWindow = window("b", 30000, 55000, 30000, 55000);
    if (mode === "other_plan") input.rightWindow = { ...input.rightWindow, rootPlanId: "other" };
    if (mode === "changed_cue") input.cues[0].text += "変更";
    if (mode === "duplicate_cue") input.cues.push({ ...input.cues[0], id: "ambiguous" });
    if (mode === "unrelated") {input.rightRaw[0].text = "別件の挨拶です";input.cues[1].text = input.rightRaw[0].text;input.rightRaw[1].text = "お元気ですか";input.cues[2].text = input.rightRaw[1].text;}
    if (mode === "no_margin") input.durationMs = 30000;
    if (mode === "retry") input.leftWindow = { ...input.leftWindow, retryDepth: 1 };
    expect(plan(input)).toBeUndefined();
  });
  it("never treats a similar repeated phrase as deletion evidence", () => {
    const input = fixture();
    // Even this perfect textual match returns only source observations and new review windows.
    expect(plan(input)?.similarity).toBe(1);
    expect(input.cues).toHaveLength(3);
    expect(plan(input)).not.toHaveProperty("transcript");
  });
});
