import { expect, it } from "vitest";
import { hasMultiOverlapBudget, planMultiOverlapReview } from "../../electron/main/local-subtitle/cue-multi-overlap-resolver";
const win = (startMs: number, key: string) => ({windowKey:key,rootWindowKey:key,rootPlanId:"p",retryDepth:0,startMs,endMs:startMs+30000,
  coreStartMs:startMs+2500,coreEndMs:startMs+27500,startFrame:startMs*16,endFrame:(startMs+30000)*16,
  coreStartFrame:(startMs+2500)*16,coreEndFrame:(startMs+27500)*16});
const raw = (text:string,startMs:number,endMs:number) => ({id:0,text,startMs,endMs,temperature:0,averageLogProbability:-.1,noSpeechProbability:.01});
const input=()=>{
  const a="説明を聞いた後で順番に",b="手順を確認する必要",r="順番に手順を確認する必要があると伝えました 次は資料を読んで内容を詳しく確認してから提出してください";
  return {sourceIdentity:"task-pcm",durationMs:175000,leftWindow:win(100000,"a"),rightWindow:win(125000,"b"),
    leftRaw:[raw(a,21980,26880),raw(b,26880,30020)],rightRaw:[raw(r,710,18440)],
    cues:[{id:"a",text:a,startMs:121980,endMs:126880},{id:"b",text:b,startMs:126880,endMs:127500},{id:"c",text:r.replace(" 次","\n次"),startMs:127500,endMs:143440}]};
};
it("plans two complete 25-second witnesses from exact three-cue provenance",()=>{
  const p=planMultiOverlapReview(input())!;expect(p.indices).toEqual([0,1,2]);expect(p.budgetRoots).toEqual(["a","b"]);
  expect(p.windows.map(w=>[w.startMs,w.endMs])).toEqual([[120000,145000],[119000,144000]]);
  expect(p.source.leftObserved[1].endMs).toBe(130020);
});
it.each(["owner","changed","overrun","retry","plan","duration","gap","duplicate"])("rejects invalid multi-parent planning: %s",scenario=>{
  const d=input();
  if(scenario==="owner")d.cues[2].startMs++;
  if(scenario==="changed")d.cues[2].text+="ね";
  if(scenario==="overrun")d.leftRaw[1].endMs=30101;
  if(scenario==="retry")d.leftWindow.retryDepth=1;
  if(scenario==="plan")d.rightWindow.rootPlanId="different";
  if(scenario==="duration")d.durationMs=144999;
  if(scenario==="gap")d.leftRaw[1].startMs++;
  if(scenario==="duplicate")d.cues.push(...d.cues);
  expect(planMultiOverlapReview(d)).toBeUndefined();
});
it("admits only two extra requests while preserving used root slots and base recovery",()=>{
  const primary=new Map([["a",2],["b",2],["c",2],["d",2],["e",2],["f",1],["g",1]]);
  const counts=new Map([...primary,["c",3],["d",3]]);
  expect(hasMultiOverlapBudget(["a","b"],7,primary,counts)).toBe(true);
  expect(hasMultiOverlapBudget(["a","b"],7,primary,new Map([...counts,["g",2]]))).toBe(false);
  expect(hasMultiOverlapBudget(["c","d"],7,primary,counts)).toBe(false);
  expect(hasMultiOverlapBudget(["a","a"],7,primary,counts)).toBe(false);
  expect(hasMultiOverlapBudget(["a","b"],7,new Map([...primary,["a",3]]),new Map([...counts,["a",3]]))).toBe(false);
  expect(hasMultiOverlapBudget(["a","missing"],7,primary,counts)).toBe(false);
});
