import {expect,it} from "vitest";
import {summarizeLocalSubtitleCues} from "../../electron/main/local-subtitle/cue-summary";
import {sanitizeLocalSubtitleCueSummary} from "../../src/type/localSubtitle";
import {localSubtitleCueSummarySchema} from "../../src/type/localSubtitleIpc";
const targets={maxCueDurationMs:6000,maxCueChars:20,maxLineChars:12};
it("counts final cues once per cue, without changing text or boundaries",()=>{
  const cues=[{id:"a",startMs:0,endMs:6000,text:"123456789012"},
    {id:"b",startMs:6000,endMs:12001,text:"hi"},
    {id:"c",startMs:12001,endMs:14000,text:"1234567890123"},
    {id:"d",startMs:14000,endMs:20001,text:"12345678901\n12345678901"}];
  const copy=structuredClone(cues);
  expect(summarizeLocalSubtitleCues(cues,targets)).toEqual({cueCount:4,exceedsTargetCount:3});
  expect(cues).toEqual(copy);
});
it("uses the final split instead of the earlier over-target parent count",()=>{
  const parent=[{id:"a",startMs:0,endMs:12000,text:"part one part two"}];
  const final=[{id:"a",startMs:0,endMs:6000,text:"part one"},{id:"b",startMs:6000,endMs:12000,text:"part two"}];
  expect(summarizeLocalSubtitleCues(parent,targets).exceedsTargetCount).toBe(1);
  expect(summarizeLocalSubtitleCues(final,targets)).toEqual({cueCount:2,exceedsTargetCount:0});
});
it("projects bounded numbers while dropping internal fields",()=>{
  expect(sanitizeLocalSubtitleCueSummary({cueCount:3,exceedsTargetCount:1,path:"private",rawText:"private"})).toEqual({cueCount:3,exceedsTargetCount:1});
  expect(localSubtitleCueSummarySchema.safeParse({cueCount:3,exceedsTargetCount:1,path:"private"}).success).toBe(false);
});
for(const value of [undefined,null,[],{cueCount:0,exceedsTargetCount:0},{cueCount:2,exceedsTargetCount:3},{cueCount:3.5,exceedsTargetCount:0},{cueCount:3,exceedsTargetCount:-1},{cueCount:3,exceedsTargetCount:NaN},{cueCount:Number.MAX_SAFE_INTEGER,exceedsTargetCount:0}])it(`refuses unavailable or invalid counts: ${JSON.stringify(value)}`,()=>{
  expect(sanitizeLocalSubtitleCueSummary(value)).toBeUndefined();expect(localSubtitleCueSummarySchema.safeParse(value).success).toBe(false);
});
