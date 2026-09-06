import {mkdtemp, readFile, rm, access} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {encodeLocalSubtitleArtifact} from "../../electron/main/local-subtitle/subtitle-formats";
import type {LocalSubtitleTranscript} from "../../src/type/localSubtitle";
import {parseSubtitleCueDocument, validateCommittedSubtitle} from "../../src/utils/subtitleCueProtocol";
import {SRTTranslator} from "../../electron/main/translation/class/srt-translator";
import {LRCTranslator} from "../../electron/main/translation/class/lrc-translator";
import {sendModelRuntimeText} from "../../electron/main/ai/model-runtime-client";
import {SubtitleSliceType, TaskStatus, type SubtitleTranslatorTask} from "../../electron/main/translation/typing";

vi.mock("electron",()=>({BrowserWindow:{getAllWindows:()=>[]},ipcMain:{handle:vi.fn(),on:vi.fn()}}));
vi.mock("../../electron/main/ai/model-runtime-client",()=>({sendModelRuntimeText:vi.fn()}));
const roots:string[]=[];
const source:LocalSubtitleTranscript={schemaVersion:1,source:{displayName:"handoff.wav",durationMs:12000},
  model:{engine:"whisper_cpp",modelId:"fixture-model",modelHash:"a".repeat(64),backend:"cpu"},segments:[
    {id:"intro",startMs:2000,endMs:5000,text:"こちらから案内します"},
    {id:"identity",startMs:5000,endMs:7000,text:"僕だ"},
    {id:"multiline",startMs:7000,endMs:9000,text:"次の説明を始めます\n静かに聞いてください"},
    {id:"repeat-a",startMs:9000,endMs:9004,text:"はい"},
    {id:"repeat-b",startMs:9004,endMs:9010,text:"はい"},
    {id:"last",startMs:9010,endMs:12000,text:"あの もう一度お願いします"},
  ]};
const translateLine=(line:string)=>`结构占位译文：${line}`;
const currentPayload=(prompt:string)=>JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{"cues":')+2)) as {cues:{id:string;lines:string[]}[]};
beforeEach(()=>{vi.mocked(sendModelRuntimeText).mockReset();vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});});
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0)){const relative=path.relative(os.tmpdir(),root);if(!relative.startsWith("fusionkit-handoff-structure-")||relative.includes(path.sep))throw Error("Unexpected test cleanup path");await rm(root,{recursive:true,force:true});}});

async function setup(format:"SRT"|"LRC",mode:"bilingual"|"target_only",budget:number){
  const root=await mkdtemp(path.join(os.tmpdir(),"fusionkit-handoff-structure-"));roots.push(root);
  const content=Buffer.from(encodeLocalSubtitleArtifact(format,source)).toString("utf8");
  const Parent=format==="SRT"?SRTTranslator:LRCTranslator;
  const translator=new(class extends Parent{constructor(){super({apiKey:"test-only",endpoint:"https://example.test",apiModel:"test-model"});this.retryPolicy={...this.retryPolicy,maxAttempts:1};}})();
  const task:SubtitleTranslatorTask={taskId:"generated-handoff",fileName:`handoff.${format.toLowerCase()}`,fileContent:content,
    originFileURL:"/test-only/handoff",targetFileURL:root,status:TaskStatus.PENDING,sliceType:SubtitleSliceType.CUSTOM,customSliceLength:budget,
    translationOutputMode:mode,concurrentSlices:false,executionBinding:{status:"ready",profileId:"fixture",profileLabel:"Fixture",apiKey:"test-only",apiModel:"test-model",endPoint:"https://example.test/chat/completions"}};
  return{translator,task,content,output:path.join(root,task.fileName)};
}

describe.each(["SRT","LRC"] as const)("local %s artifact translation structure",format=>{
  it.each(["bilingual","target_only"] as const)("preserves source cues in %s output across slice budgets",async mode=>{
    for(const budget of [1,10000]){
      vi.mocked(sendModelRuntimeText).mockReset();
      vi.mocked(sendModelRuntimeText).mockImplementation(async request=>{
        const prompt=request.messages[0].content as string;
        const payload=currentPayload(prompt);
        expect(JSON.stringify(payload)).not.toMatch(/-->|\[00:/u);
        return{apiFormat:"chat_completions",content:JSON.stringify({cues:payload.cues.map(c=>({id:c.id,lines:c.lines.map(translateLine)})).reverse()})};
      });
      const f=await setup(format,mode,budget);
      await f.translator.translate(f.task);
      const output=await readFile(f.output,"utf8"),input=parseSubtitleCueDocument(f.content,format);
      validateCommittedSubtitle(input,output,mode==="bilingual");
      const expected=source.segments.map((cue,i)=>{
        const part=input.parts.filter(p=>p.cueId)[i];
        return format==="SRT"?[...part.prefix,...part.original.flatMap(line=>mode==="bilingual"?[line,translateLine(line)]:[translateLine(line)])].join("\n"):
          (mode==="bilingual"?`${part.prefix[0]}${part.original[0]}\n`:"")+part.prefix[0]+translateLine(part.original[0]);
      }).join(format==="SRT"?"\n\n":"\n");
      expect(output.trimEnd()).toBe(expected);
      expect(vi.mocked(sendModelRuntimeText).mock.calls.length).toBe(budget===1?6:1);
      expect(f.task.fileContent).toBe(f.content);
    }
  });
  it.each(["missing_id","duplicate_id","forged_time"] as const)("rejects %s before committing an output",async failure=>{
    vi.mocked(sendModelRuntimeText).mockImplementation(async request=>{
      const payload=currentPayload(request.messages[0].content as string);
      const cues=payload.cues.map(c=>({id:c.id,lines:c.lines.map(translateLine)}));
      if(failure==="missing_id")cues.pop();
      if(failure==="duplicate_id")cues[1].id=cues[0].id;
      if(failure==="forged_time")cues[0].lines[0]="[00:01.00]伪造时间";
      return{apiFormat:"chat_completions",content:JSON.stringify({cues})};
    });
    const f=await setup(format,"bilingual",10000);
    await expect(f.translator.translate(f.task)).rejects.toThrow();
    await expect(access(f.output)).rejects.toMatchObject({code:"ENOENT"});
    expect(f.task.fileContent).toBe(f.content);
  });
});
