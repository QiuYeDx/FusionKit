import { describe, expect, it } from "vitest";
import { planOverlapGroupReview } from "../../../electron/main/subtitle-studio/transcription/native/overlap-group-review";
import { draftOverlapGroupSplice, inspectOverlapGroupSplice } from "../../../electron/main/subtitle-studio/transcription/native/overlap-group-splice";
import { overlapGroupSourceOptions, selectOverlapGroupSource } from "../../../electron/main/subtitle-studio/transcription/native/overlap-group-selection";
import type { LocalSubtitleServerRawSegment as Raw } from "../../../electron/main/subtitle-studio/transcription/native/server-contract";
import type { PrefixOverlapView } from "../../../electron/main/subtitle-studio/transcription/native/cue-prefix-overlap-evidence";
const first = "最初のお知らせ", last = "続きのお知らせ", phrase = first + last;
const raw = (startMs: number, endMs: number, text: string): Raw => ({id: 0, startMs, endMs, text,
  temperature: 0, averageLogProbability: -0.1, noSpeechProbability: 0.01});
function fixture(manyLeft = false, prefix = "") {
  const window = (key: string, startMs: number, endMs: number, coreStartMs: number, coreEndMs: number) => ({
    windowKey: key, rootWindowKey: key, rootPlanId: "p", retryDepth: 0, startMs, endMs, coreStartMs, coreEndMs,
    startFrame: startMs*16, endFrame: endMs*16, coreStartFrame: coreStartMs*16, coreEndFrame: coreEndMs*16});
  const leftWindow = window("l", 0, 30000, 0, 27500), rightWindow = window("r", 25000, 55000, 27500, 55000);
  const leftRaw = manyLeft ? [raw(25800, 26700, first), raw(26700, 29000, last)] : [raw(25800, 29000, prefix+phrase)];
  const rightRaw = manyLeft ? [raw(800, 4000, phrase)] : [raw(800, 2800, first), raw(2800, 4000, last)];
  const cues = [...leftRaw.map(s => ({...s, endMs: Math.min(27500, s.endMs)})),
    ...rightRaw.map(s => ({...s, startMs: Math.max(27500, s.startMs+25000), endMs: s.endMs+25000}))]
    .map((s, i) => ({...s, id: "c"+i}));
  const review = planOverlapGroupReview({sourceIdentity: "pcm", durationMs: 55000, leftWindow, rightWindow, leftRaw, rightRaw, cues})!;
  const text = prefix+phrase;
  const points = [...prefix].map(() => 25900).concat([...first].map((_, i) => 26100 + i*180), [...last].map((_, i) => 28000 + i*100));
  const views: PrefixOverlapView[] = review.windows.map(w => ({id: w.windowKey, sourceIdentity: "pcm", mode: "uncompressed_non_vad",
    windowStartMs: w.startMs, windowEndMs: w.endMs, segments: [{...raw(25800-w.startMs, 29000-w.startMs, text),
      dtwTokens: [...text].map((text, i) => ({text, pointMs: points[i]-w.startMs}))}]}));
  return {review, cues, views};
}
describe("whole source-group splice", () => {
  it("selects the only complete supported side and retains independent leading content", () => {
    const f = fixture(false, "ん、");
    expect(overlapGroupSourceOptions(f.review, f.cues)).toEqual(["left"]);
    expect(selectOverlapGroupSource(f.review, f.cues, f.views)).toMatchObject({status: "supported", keep: "left"});
  });
  it("can select the right side when it uniquely retains all content", () => {
    const f = fixture(false, "ん、");
    const review = {...f.review, left: f.review.left.map(m => ({...m, observed: {...m.observed, text: phrase}})),
      right: f.review.right.map((m,i) => ({...m, observed: {...m.observed, text: (i ? "" : "ん、") + m.observed.text}}))};
    f.cues[0].text = phrase;f.cues[1].text = "ん、"+first;
    expect(overlapGroupSourceOptions(review,f.cues)).toEqual(["right"]);
    expect(selectOverlapGroupSource(review,f.cues,f.views)).toMatchObject({status:"supported",keep:"right"});
  });
  it("keeps left divisions deterministically when both complete sources are supported", () => {
    const f = fixture();
    expect(overlapGroupSourceOptions(f.review,f.cues)).toEqual(["left","right"]);
    expect(selectOverlapGroupSource(f.review,f.cues,f.views)).toMatchObject({status:"supported",keep:"left",reason:"equivalent_sources_keep_left"});
  });
  it("does not make a choice without independent observations", () => {
    const f = fixture();
    expect(selectOverlapGroupSource(f.review,f.cues,[])).toMatchObject({status:"rejected",reason:"unsupported_observations"});
  });
  it.each([false, true])("restores a complete existing source across a seam (%s)", manyLeft => {
    const f = fixture(manyLeft), before = structuredClone(f);
    const result = draftOverlapGroupSplice(f.review, f.cues, manyLeft ? "right" : "left");
    expect(result.status).toBe("review_required");if (result.status === "rejected") return;
    expect(result.replacements).toEqual([{id: manyLeft ? "c2" : "c0", startMs: 25800, endMs: 29000, text: phrase, estimatedTiming: true}]);
    expect(result.proposedCues).toHaveLength(1);expect(result).not.toHaveProperty("automaticAcceptance");
    expect(f).toEqual(before);
  });
  it("retains the selected side's native phrase divisions", () => {
    const f = fixture(), r = draftOverlapGroupSplice(f.review, f.cues, "right");
    expect(r.status).toBe("review_required");if (r.status === "rejected") return;
    expect(r.replacements.map(c => [c.startMs, c.endMs, c.text])).toEqual([[25800, 27800, first], [27800, 29000, last]]);
  });
  it("preserves independent throat clearing and exposes a source choice that would lose it", () => {
    const f = fixture(false, "ん、");
    const left = draftOverlapGroupSplice(f.review, f.cues, "left"), right = draftOverlapGroupSplice(f.review, f.cues, "right");
    expect(left.status === "review_required" && left.retainedText).toBe("ん、"+phrase);
    expect(right.status === "review_required" && right.warnings).toEqual(["unaccounted_source_content"]);
    expect(inspectOverlapGroupSplice(f.review, f.cues, "right", f.views)).toMatchObject({status: "rejected", reason: "unaccounted_source_content"});
    expect(inspectOverlapGroupSplice(f.review, f.cues, "left", f.views).status).toBe("supported");
  });
  it.each(["text", "time", "indices", "neighbor", "ids"])("rejects stale or conflicting draft input: %s", mode => {
    const f = fixture();let review = f.review;
    if (mode === "text") f.cues[0].text += "変更";
    if (mode === "time") f.cues[0].startMs++;
    if (mode === "indices") review = {...review, indices: [0, 2, 3]};
    if (mode === "neighbor") f.cues.push({...f.cues[2], id: "outside", startMs: 28900, endMs: 30000});
    if (mode === "ids") f.cues[2].id = f.cues[0].id;
    expect(draftOverlapGroupSplice(review, f.cues, "left").status).toBe("rejected");
  });
  it.each([["今日は食べます", "今日は食べません"], ["今日二個食べます", "今日三個食べます"], ["今日はビールです", "今日はビルです"]])("does not erase lexical differences: %s / %s", (phrase, replacement) => {
    const f = fixture();
    const review = {...f.review, left: [{...f.review.left[0], observed: {...f.review.left[0].observed, text: phrase+"確認です"}}]};
    f.cues[0].text = phrase+"確認です";
    review.right = f.review.right.map((m, i) => ({...m, observed: {...m.observed, text: i ? "確認です" : replacement}}));
    f.cues[1].text = replacement;f.cues[2].text = "確認です";
    expect(inspectOverlapGroupSplice(review, f.cues, "left", f.views)).toMatchObject({status: "rejected", reason: "unaccounted_source_content"});
  });
  it("requires complete text and timing independently", () => {
    const f = fixture();
    expect(inspectOverlapGroupSplice(f.review, f.cues, "left", f.views).status).toBe("supported");
  });
  it("supports a complete one-to-one group", () => {
    const f = fixture(), right = {...f.review.right[0], observed: {...f.review.right[0].observed, endMs: 29000, text: phrase}};
    const review = {...f.review, right: [right], indices: [0, 1]};
    const cues = [f.cues[0], {...f.cues[1], text: phrase, endMs: 29000}];
    expect(inspectOverlapGroupSplice(review, cues, "right", f.views).status).toBe("supported");
  });
  it("does not carry old word timestamps into a restored cue interval", () => {
    const f = fixture();
    const cues = f.cues.map(c => ({...c, words: [{text: "最初", startMs: 27000, endMs: 27100}]}));
    const r = draftOverlapGroupSplice(f.review, cues, "left");
    expect(r.status === "review_required" && r.replacements[0]).not.toHaveProperty("words");
    expect(cues[0].words).toHaveLength(1);
  });
  it("rejects other words inside the group even if complete text occurs exactly once", () => {
    const f = fixture();
    const views = f.views.map(v => ({...v, segments: [{...raw(25000-v.windowStartMs, 25800-v.windowStartMs, "ん"),
      dtwTokens: [{text: "ん", pointMs: 25900-v.windowStartMs}]}, ...v.segments]}));
    expect(inspectOverlapGroupSplice(f.review, f.cues, "left", views)).toMatchObject({status: "rejected", reason: "unaccounted_observation_content"});
  });
  it.each(["same_id", "same_window", "other_source", "missing_view", "missing_token", "null_point", "drift", "extra_words", "repeated", "wrong_words"])("rejects unsupported evidence: %s", mode => {
    const f = fixture();let views = structuredClone(f.views);
    if (mode === "same_id") views[1] = {...views[1], id: views[0].id};
    if (mode === "same_window") views[1] = {...views[0], id: views[1].id};
    if (mode === "other_source") views[1] = {...views[1], sourceIdentity: "other"};
    if (mode === "missing_view") views = views.slice(0, 1);
    if (["missing_token", "null_point", "drift", "extra_words", "repeated", "wrong_words"].includes(mode)) {
      const s = views[1].segments[0], ts = [...s.dtwTokens!];let text = s.text;
      if (mode === "missing_token") ts.pop();
      if (mode === "null_point") ts[4] = {...ts[4], pointMs: null};
      if (mode === "drift") for (let i = 0; i < ts.length; i++) ts[i] = {...ts[i], pointMs: ts[i].pointMs! + 350};
      if (mode === "extra_words") {text += "ん";ts.push({text: "ん", pointMs: ts.at(-1)!.pointMs!+10});}
      if (mode === "repeated") {text += text;ts.push(...ts.map(t => ({...t, pointMs: t.pointMs!+3300})));}
      if (mode === "wrong_words") {text = text.replace("最", "別");ts[0] = {...ts[0], text: "別"};}
      views[1] = {...views[1], segments: [{...s, text, dtwTokens: ts}]};
    }
    expect(inspectOverlapGroupSplice(f.review, f.cues, "left", views).status).toBe("rejected");
  });
});
