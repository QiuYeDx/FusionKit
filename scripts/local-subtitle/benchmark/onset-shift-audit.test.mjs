import assert from "node:assert/strict";
import test from "node:test";
import { auditOnsetShift } from "./onset-shift-audit.mjs";
function fixture() {
  const source = { contentSha256: "a".repeat(64), protocolSha256: "b".repeat(64), sourceStartMs: 4000, contentDurationMs: 10000, targets: ["続けます"] };
  const views = [0, 1000, 2000].map(paddingMs => ({ ...source, id: String(paddingMs), paddingMs,
    segments: [{ text: "それでは続けます。", start: paddingMs / 1000, end: 8 + paddingMs / 1000,
      words: ["それでは", "続け", "ます", "。"].map((word, i) => ({ word, start: 1 + i + paddingMs / 1000,
        end: 2 + i + paddingMs / 1000, t_dtw: 100 + i * 100 + paddingMs / 10 })) }] }));
  return { source, views };
}
test("maps padding through source time without accepting an onset", () => {
  const f = fixture(), before = structuredClone(f), r = auditOnsetShift(f.source, f.views);
  assert.equal(r.targets[0].dtwStartSpreadMs, 0);assert.equal(r.targets[0].within300MsAcrossAll, true);
  assert.equal(r.targets[0].dtwEndSpreadMs, 0);
  assert.equal(r.targets[0].entries[2].target.dtwStartMs, 6000);assert.equal(r.automaticAcceptance, false);
  assert.deepEqual(f, before);
});
for (const kind of ["missing", "repeat", "partial", "coverage", "reverse", "outside", "uncomputed", "ordinary", "native", "content", "protocol", "origin", "duration", "drift"]) {
  test(`retains adverse last observation: ${kind}`, () => {
    const f = fixture(), v = f.views[2], s = v.segments[0];
    if (kind === "missing") { s.text = "別の言葉";s.words = [{word:s.text,start:2,end:5,t_dtw:300}]; }
    if (kind === "repeat") { s.text += s.text;s.words.push(...structuredClone(s.words).map(w => ({...w,t_dtw:800}))); }
    if (kind === "partial") { s.words[0].word += s.words[1].word;s.words.splice(1,1); }
    if (kind === "coverage") s.words.pop();
    if (kind === "reverse") s.words[2].t_dtw = 1;
    if (kind === "outside") s.words.at(-1).t_dtw = 9999;
    if (kind === "uncomputed") s.words[1].t_dtw = -1;
    if (kind === "ordinary") s.words[1].start = -1;
    if (kind === "native") s.end = 99;
    if (kind === "content") v.contentSha256 = "c".repeat(64);
    if (kind === "protocol") v.protocolSha256 = "c".repeat(64);
    if (kind === "origin") v.sourceStartMs++;
    if (kind === "duration") v.contentDurationMs++;
    if (kind === "drift") s.words.forEach(w => w.t_dtw += 100);
    const r = auditOnsetShift(f.source, f.views);
    assert.equal(r.targets[0].within300MsAcrossAll, false);assert.equal(r.observations.length, 3);
    assert.equal(r.observations[2].text, s.text);assert.equal(r.automaticAcceptance, false);
  });
}
test("preserves negative mapped points instead of clamping", () => {
  const f = fixture();f.views[2].segments[0].words.forEach((w,i) => {w.t_dtw=i*10;});
  const r = auditOnsetShift(f.source,f.views);
  assert.equal(r.targets[0].entries[2].target.dtwStartMs,2100);
  assert.ok(r.observations[2].tokensMappedBeforeSource.length);assert.equal(r.targets[0].within300MsAcrossAll,false);
});
test("keeps whole-window changes visible despite a stable target", () => {
  const f=fixture(),s=f.views[1].segments[0];s.text='では続けます。';s.words[0].word='では';
  const r=auditOnsetShift(f.source,f.views);assert.equal(r.wholeTextIdentical,false);assert.equal(r.targets[0].within300MsAcrossAll,true);assert.equal(r.automaticAcceptance,false);
});
for(const kind of ['one','duplicate_id','duplicate_padding','no_baseline','too_many','empty_target','large_padding','overflow']) test(`rejects invalid plan: ${kind}`,()=>{
  const f=fixture();
  if(kind==='one')f.views.length=1;
  if(kind==='duplicate_id')f.views[1].id=f.views[0].id;
  if(kind==='duplicate_padding')f.views[1].paddingMs=0;
  if(kind==='no_baseline')f.views.shift();
  if(kind==='too_many')f.views.push(...Array(6).fill(f.views[0]));
  if(kind==='empty_target')f.source.targets=['。'];
  if(kind==='large_padding')f.views[2].paddingMs=3000;
  if(kind==='overflow')f.source.sourceStartMs=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>auditOnsetShift(f.source,f.views),/invalid_shift_audit_input/);
});
