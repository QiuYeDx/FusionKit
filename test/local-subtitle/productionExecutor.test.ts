import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  createLocalSubtitleBatchConfigSnapshot,
  type LocalSubtitleBatchConfigSnapshot,
  type LocalSubtitleConflictPolicy,
  type LocalSubtitleFormat,
  type LocalSubtitleTaskSummary,
} from "../../src/type/localSubtitle";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import {
  LocalSubtitleBackendResolver,
  type LocalSubtitleVerifiedBackendResolution,
} from "../../electron/main/local-subtitle/backend-resolver";
import type {
  LocalSubtitleJobBatchRuntime,
  LocalSubtitleJobTaskExecutionContext,
} from "../../electron/main/local-subtitle/job-manager";
import type {
  LocalSubtitleBrandedPcmWindow,
  LocalSubtitleMediaStructuralWindow,
  LocalSubtitleNormalizedPcm,
  LocalSubtitleResolvedPcmWindow,
} from "../../electron/main/local-subtitle/media-normalizer";
import { LocalSubtitleProductionExecutor } from "../../electron/main/local-subtitle/production-executor";
import type { LocalSubtitleVerifiedRuntimeBundle } from "../../electron/main/local-subtitle/resource-path";
import type {
  LocalSubtitleServerInferenceRequest,
  LocalSubtitleServerInferenceResponse,
} from "../../electron/main/local-subtitle/server-contract";
import type {
  LocalSubtitleServerInferenceOperation,
  LocalSubtitleServerLease,
  LocalSubtitleServerRequestTicket,
  LocalSubtitleServerRuntimePin,
  LocalSubtitleServerSupervisorInferenceResponse,
} from "../../electron/main/local-subtitle/server-supervisor";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";
import {
  LocalSubtitleExporter,
  type LocalSubtitleExporterDependencies,
} from "../../electron/main/local-subtitle/subtitle-exporter";
import {
  localSubtitleFilesystemObjectIdentityForPath,
} from "../../electron/main/local-subtitle/filesystem-object-identity";
import type { LocalSubtitleVerifiedAcceleratorPack } from "../../electron/main/local-subtitle/accelerator-manager";
import { createAcceleratorFixture } from "./acceleratorFixture";

const OWNER: LocalSubtitleOwnerKey = Object.freeze({
  webContentsId: 71,
  ownerSessionId: "production-executor-owner",
});
const MODEL_HASH = LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256;
const WINDOW_HASH = "a".repeat(64);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local subtitle production executor", () => {
  it("keeps a lone short-suffix cue without reading PCM or requesting a forward witness", async () => {
    const accelerator = await createAcceleratorFixture();
    try {
      const text = "こちらから案内します 僕だ";
      const harness = await createHarness({backend:"cuda", acceleratorPack:accelerator.proof, modelId:"large-v3", totalFrames:30*16000, vadEnabled:true,
        inference:({request,window}) => {
          const response=serverResponse(request,window.endMs-window.startMs,[rawSegment(0,2000,10000,text)]);
          return {processEpoch:request.vadEnabled?1:2,response:{...response,result:{...response.result,language:"ja",wordTimelineStatus:request.vadEnabled?"discarded_vad_compressed_timeline":"dtw_token_points"}}};
        }});
      expect((await harness.executor.execute(harness.context)).status).toBe("completed");
      expect(harness.media.readPrefixSamples).not.toHaveBeenCalled();
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
      expect(harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments.map(c=>c.text)).toEqual([text]);
    } finally {await accelerator.cleanup();}
  });

  it.each(["valid", "unstable", "missing", "silence", "pcm_failure", "media_changed", "startup_failure", "native_failure", "cancel", "cleanup_failure"] as const)("bounds the final short-onset witness and preserves accepted text: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const prefix = "こちらから案内します", target = "僕だ", next = "次の説明を始めます静かに聞いてください";
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 30 * 16000, vadEnabled: true, formats: ["SRT", "LRC"],
        inference: ({request, window}) => {
          const witness = window.windowKey.includes(".short-onset");
          if (witness && scenario === "native_failure") throw new Error("short witness unavailable");
          if (witness && scenario === "cancel") harness.controller.abort();
          const segments = request.vadEnabled ? [rawSegment(0, 2000, 7000, prefix + " " + target), rawSegment(1, 7000, 15000, next)] : [
            { ...rawSegment(0, 2000, 7000, "ん ん 僕だ"), dtwTokens: [
              {text:"ん ", pointMs:2550}, {text:"ん ", pointMs:3300},
              {text:"僕", pointMs:witness && scenario === "unstable" ? 5550 : 5100},
              {text:"だ", pointMs:witness && scenario === "unstable" ? 5650 : 5500},
            ] },
            { ...rawSegment(1, 7000, 15000, next), dtwTokens: [{text:next, pointMs:7200}] },
          ];
          if (witness && scenario === "missing") (segments[0] as any).dtwTokens = [];
          const response = serverResponse(request, window.endMs-window.startMs, segments);
          return {processEpoch:request.vadEnabled ? 1 : witness ? 3 : 2, response:{...response, result:{...response.result, language:"ja", wordTimelineStatus:request.vadEnabled ? "discarded_vad_compressed_timeline" : "dtw_token_points"}}};
        },
      });
      harness.media.readPrefixSamples.mockImplementation(async (_normalized, frames) => {
        if (scenario === "pcm_failure") throw new Error("optional PCM read failed");
        if (scenario === "media_changed") throw Object.assign(new Error("PCM changed"), {code:"media_changed"});
        const samples = new Int16Array(frames);
        if (scenario !== "silence") for (const [start,end] of [[2100,2400],[2500,2800],[3200,3450],[5000,5800],[7000,8500]])
          for (let i=start*16;i<end*16;i++) samples[i]=Math.round(3000*Math.sin(i/8));
        return samples;
      });
      if (scenario === "startup_failure") {
        const acquire = harness.supervisor.acquirePinnedSeparatorLease;
        acquire.mockImplementationOnce(acquire.getMockImplementation()!).mockRejectedValueOnce(new Error("fresh startup unavailable"));
      }
      if (scenario === "cleanup_failure") harness.media.disposeWindow.mockImplementation(async (window?: any) => {
        if (window?.descriptor.windowKey.includes(".short-onset")) throw Object.assign(new Error("cleanup failed"),{code:"cleanup_failed"});
        return {removed:true};
      });
      const result = await harness.executor.execute(harness.context);
      expect(harness.media.readPrefixSamples).toHaveBeenCalledWith(expect.anything(), 288000, harness.controller.signal);
      const witnesses = harness.media.materializeWindow.mock.calls.filter(([r]) => r.descriptor.windowKey.includes(".short-onset"));
      expect(witnesses.length).toBe(["silence","pcm_failure","media_changed","startup_failure"].includes(scenario) ? 0 : 1);
      expect(harness.supervisor.beginInference.mock.calls.length).toBeLessThanOrEqual(3);
      for (const [request] of witnesses) expect(request.conditionQuietAudio).toBe(false);
      if (!["silence","pcm_failure","media_changed"].includes(scenario)) expect(harness.supervisor.acquirePinnedSeparatorLease.mock.calls.at(-1)?.[2]).toEqual({freshInferenceState:true});
      if (["media_changed","cancel","cleanup_failure"].includes(scenario)) {
        expect(result.status).toBe(scenario === "cancel" ? "cancelled" : "failed");
        expect(result).not.toHaveProperty("cueSummary");
        expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
      } else {
        expect(result.status, JSON.stringify(result)).toBe("completed");
        const cues = harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
        expect(result).toMatchObject({cueSummary:{cueCount:cues.length,exceedsTargetCount:1}});
        expect(cues.map(c=>c.text.replace(/\s/gu," ")).join("").replace(/\s/gu,"")).toBe(prefix+target+next);
        expect(cues.map(c=>[c.startMs,c.endMs,c.text])).toEqual(scenario === "valid" ?
          [[2000,5100,prefix],[5100,7000,target],[7000,15000,next]] : [[2000,7000,prefix+" "+target],[7000,15000,next]]);
      }
    } finally { await accelerator.cleanup(); }
  });

  it.each(["valid", "unstable", "missing", "startup_failure", "native_failure", "cancel", "cleanup_failure"] as const)("preserves all three earlier repairs while applying one terminal variant group: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const vp="説明が終わって安心したわね", parts=["次の資料を読んだ","後で静かな部屋に","ミナミを呼んでから","詳しい話を聞いているわ"], vl=vp+" 次の資料を読んで";
      const cp="こちらの図書館にいるけど", cm="その人は資料を持っていて", cf="静かな場所で本を読んでいるよ";
      const a = "説明を聞いた後で順番に", b = "手順を確認する必要", rest = "があると伝えました";
      const next = "次は資料を読んで内容を詳しく確認してから提出してください", right = "順番に" + b + rest + " " + next;
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 175 * 16000, vadEnabled: true, quietAudioGainDb: 12, formats: ["SRT", "LRC"],
        inference: ({ request, window }) => {
          const variant=window.windowKey.includes(".variant-"), contained=window.windowKey.includes(".contained-"), multi = window.windowKey.includes(".multi-"), prefix = window.windowKey.includes(".prefix-"), second = window.windowKey.endsWith("-1");
          if (variant && second && scenario === "native_failure") throw new Error("multi witness failed");
          if (variant && second && scenario === "cancel") harness.controller.abort();
          let segments;
          if (variant) {
            segments=[vp,parts.join("")].map((text,i)=>({...rawSegment(i,[140000,153180][i]-window.startMs,[153180,169000][i]-window.startMs,text),dtwTokens:Array.from(text).map((text,j)=>({text,pointMs:(i===0?144800+j*300:153360+(second?(scenario==="unstable"?600:20):0)+j*200)-window.startMs}))}));
            if(second&&scenario==="missing")segments[1].dtwTokens=[];
          } else if (contained) {
            segments=[cp,cm,cf].map((text,i)=>({...rawSegment(i,[95000,99000,104000][i]-window.startMs,[99000,104000,111000][i]-window.startMs,text),dtwTokens:Array.from(text).map((text,j)=>({text,pointMs:[96500,(second?100900:100860),second?104780:104740][i]+j*150-window.startMs}))}));

          } else if (multi) {
            const seg = (id: number, text: string, start: number, end: number, pairs: [string, number][]) => ({ ...rawSegment(id, start-window.startMs, end-window.startMs,text),dtwTokens:pairs.map(([text,point])=>({text,pointMs:point-window.startMs})) });
            segments = [seg(0,a+b+rest,window.startMs,132000,[["説明を聞いた後で",123000],["順番に",125900],[b,128000],[rest,131000]]),
              seg(1,next,132000,143440,[["次は",second ? 133240 : 133200],["資料を読んで",134000],["内容を詳しく確認してから提出してください",140000]])];
          } else if (prefix) {
            segments = [{...rawSegment(0,0,7000,"前置き説明をもう一度"),dtwTokens:[{text:"前置き",pointMs:1000},{text:"説明をもう一度",pointMs:51000-window.startMs}]},
              {...rawSegment(1,7000,61230-window.startMs,"確認してから始めます"),dtwTokens:[{text:"確認",pointMs:(second?56000:55880)-window.startMs},{text:"してから",pointMs:58000-window.startMs},{text:"始めます",pointMs:60500-window.startMs}]}];
          } else if ([25000,50000,75000,100000,125000].includes(window.startMs) && request.vadSpeechPadMs !== undefined) segments=[0,1,2].map(i=>rawSegment(i,i*1000,i*1000+1000,"はい"));
          else if (window.startMs===25000) segments=[rawSegment(0,20570,26720,"前置き説明をもう一度")];
          else if (window.startMs===50000) segments=[rawSegment(0,160,11230,"説明をもう一度 確認してから始めます")];
          else if (window.startMs===75000) segments=[rawSegment(0,21170,30000,cp+cm+"明日は")];
          else if (window.startMs===100000) segments=[rawSegment(0,770,4150,cm),rawSegment(1,4150,9930,cf),rawSegment(2,21980,26880,a),rawSegment(3,26880,30000,b)];
          else if (window.startMs===125000) segments=[rawSegment(0,710,18440,right),rawSegment(1,18440,30000,vl)];
          else if (window.startMs===150000) segments=[rawSegment(0,0,1840,"安心したわね"),...parts.map((text,i)=>rawSegment(i+1,[1840,5180,7480,11080][i],[5180,7480,11080,14820][i],text))];
          else segments=[rawSegment(0,3000,4000,"こんにちは。")];
          const response=serverResponse(request,window.endMs-window.startMs,segments);
          return {processEpoch:multi?second?5:4:prefix?second?3:2:1,response:{...response,result:{...response.result,language:"ja",wordTimelineStatus:variant||contained||multi||prefix?"dtw_token_points":"discarded_vad_compressed_timeline"}}};
        } });
      if (scenario === "startup_failure") {const acquire=harness.supervisor.acquirePinnedSeparatorLease;const original=acquire.getMockImplementation()!;acquire.mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockRejectedValueOnce(new Error("second variant load failed"));}
      if (scenario === "cleanup_failure") harness.media.disposeWindow.mockImplementation(async brand=>{if(brand.descriptor.windowKey.endsWith("variant-1"))throw new Error("cleanup failed");return {removed:true};});
      const result=await harness.executor.execute(harness.context);
      const optional=harness.media.materializeWindow.mock.calls.map(([r])=>r).filter(r=>/\.(prefix|multi|contained|variant)-/u.test(r.descriptor.windowKey));
      expect(optional.map(r=>r.descriptor.startMs)).toEqual(scenario==="startup_failure"?[45000,44000,120000,119000,95000,94000,140000]:[45000,44000,120000,119000,95000,94000,140000,139000]);
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(scenario==="startup_failure"?19:20);
      expect(optional.every(r=>!r.conditionQuietAudio)).toBe(true);
      for(const call of harness.supervisor.acquirePinnedSeparatorLease.mock.calls) expect(call[2]).toEqual({freshInferenceState:true});
      if(scenario==="cancel"||scenario==="cleanup_failure") {expect(result.status).toBe(scenario==="cancel"?"cancelled":"failed");expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();}
      else {
        expect(result.status).toBe("completed");const cues=harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
        expect(cues.find(c=>c.startMs===55880)?.text).toBe("確認してから始めます");
        expect(cues.find(c=>c.startMs===121980)).toMatchObject({text:a+b+rest,endMs:133200});expect(cues.find(c=>c.startMs===133200)?.text).toBe(next);
        expect(cues.find(c=>c.startMs===96170)).toMatchObject({text:cp,endMs:100860});expect(cues.find(c=>c.startMs===100860)).toMatchObject({text:cm,endMs:104740});expect(cues.find(c=>c.startMs===104740)).toMatchObject({text:cf,endMs:109930});
        if(scenario==="valid") {
          expect(cues.find(c=>c.startMs===143440)).toMatchObject({text:vp,endMs:153360});
          expect(cues.find(c=>c.startMs===153360)).toMatchObject({text:parts.join(""),endMs:164820});
          expect(cues.some(c=>[152500,155180,157480,161080].includes(c.startMs))).toBe(false);
        } else {
          expect(cues.find(c=>c.startMs===143440)?.text).toBe(vl);
          expect(cues.filter(c=>[152500,155180,157480,161080].includes(c.startMs)).map(c=>c.text)).toEqual(parts);
        }

      }
    } finally {await accelerator.cleanup();}
  });

  it.each(["valid", "unstable", "missing", "startup_failure", "native_failure", "cancel", "cleanup_failure"] as const)("preserves prefix and multi repairs while applying one contained group: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const cp="こちらの図書館にいるけど", cm="その人は資料を持っていて", cf="静かな場所で本を読んでいるよ";
      const a = "説明を聞いた後で順番に", b = "手順を確認する必要", rest = "があると伝えました";
      const next = "次は資料を読んで内容を詳しく確認してから提出してください", right = "順番に" + b + rest + " " + next;
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 175 * 16000, vadEnabled: true, quietAudioGainDb: 12, formats: ["SRT", "LRC"],
        inference: ({ request, window }) => {
          const contained=window.windowKey.includes(".contained-"), multi = window.windowKey.includes(".multi-"), prefix = window.windowKey.includes(".prefix-"), second = window.windowKey.endsWith("-1");
          if (contained && second && scenario === "native_failure") throw new Error("multi witness failed");
          if (contained && second && scenario === "cancel") harness.controller.abort();
          let segments;
          if (contained) {
            segments=[cp,cm,cf].map((text,i)=>({...rawSegment(i,[95000,99000,104000][i]-window.startMs,[99000,104000,111000][i]-window.startMs,text),dtwTokens:Array.from(text).map((text,j)=>({text,pointMs:[96500,(second&&scenario==="unstable"?101400:second?100900:100860),second?104780:104740][i]+j*150-window.startMs}))}));
            if(second&&scenario==="missing")segments[1].dtwTokens=[];
          } else if (multi) {
            const seg = (id: number, text: string, start: number, end: number, pairs: [string, number][]) => ({ ...rawSegment(id, start-window.startMs, end-window.startMs,text),dtwTokens:pairs.map(([text,point])=>({text,pointMs:point-window.startMs})) });
            segments = [seg(0,a+b+rest,window.startMs,132000,[["説明を聞いた後で",123000],["順番に",125900],[b,128000],[rest,131000]]),
              seg(1,next,132000,143440,[["次は",second ? 133240 : 133200],["資料を読んで",134000],["内容を詳しく確認してから提出してください",140000]])];
          } else if (prefix) {
            segments = [{...rawSegment(0,0,7000,"前置き説明をもう一度"),dtwTokens:[{text:"前置き",pointMs:1000},{text:"説明をもう一度",pointMs:51000-window.startMs}]},
              {...rawSegment(1,7000,61230-window.startMs,"確認してから始めます"),dtwTokens:[{text:"確認",pointMs:(second?56000:55880)-window.startMs},{text:"してから",pointMs:58000-window.startMs},{text:"始めます",pointMs:60500-window.startMs}]}];
          } else if ([25000,50000,75000,100000,125000].includes(window.startMs) && request.vadSpeechPadMs !== undefined) segments=[0,1,2].map(i=>rawSegment(i,i*1000,i*1000+1000,"はい"));
          else if (window.startMs===25000) segments=[rawSegment(0,20570,26720,"前置き説明をもう一度")];
          else if (window.startMs===50000) segments=[rawSegment(0,160,11230,"説明をもう一度 確認してから始めます")];
          else if (window.startMs===75000) segments=[rawSegment(0,21170,30000,cp+cm+"明日は")];
          else if (window.startMs===100000) segments=[rawSegment(0,770,4150,cm),rawSegment(1,4150,9930,cf),rawSegment(2,21980,26880,a),rawSegment(3,26880,30000,b)];
          else if (window.startMs===125000) segments=[rawSegment(0,710,18440,right)];
          else segments=[rawSegment(0,3000,4000,"こんにちは。")];
          const response=serverResponse(request,window.endMs-window.startMs,segments);
          return {processEpoch:multi?second?5:4:prefix?second?3:2:1,response:{...response,result:{...response.result,language:"ja",wordTimelineStatus:contained||multi||prefix?"dtw_token_points":"discarded_vad_compressed_timeline"}}};
        } });
      if (scenario === "startup_failure") {const acquire=harness.supervisor.acquirePinnedSeparatorLease;const original=acquire.getMockImplementation()!;acquire.mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockRejectedValueOnce(new Error("second multi load failed"));}
      if (scenario === "cleanup_failure") harness.media.disposeWindow.mockImplementation(async brand=>{if(brand.descriptor.windowKey.endsWith("contained-1"))throw new Error("cleanup failed");return {removed:true};});
      const result=await harness.executor.execute(harness.context);
      const optional=harness.media.materializeWindow.mock.calls.map(([r])=>r).filter(r=>/\.(prefix|multi|contained)-/u.test(r.descriptor.windowKey));
      expect(optional.map(r=>r.descriptor.startMs)).toEqual(scenario==="startup_failure"?[45000,44000,120000,119000,95000]:[45000,44000,120000,119000,95000,94000]);
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(scenario==="startup_failure"?17:18);
      expect(optional.every(r=>!r.conditionQuietAudio)).toBe(true);
      for(const call of harness.supervisor.acquirePinnedSeparatorLease.mock.calls) expect(call[2]).toEqual({freshInferenceState:true});
      if(scenario==="cancel"||scenario==="cleanup_failure") {expect(result.status).toBe(scenario==="cancel"?"cancelled":"failed");expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();}
      else {
        expect(result.status).toBe("completed");const cues=harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
        expect(cues.find(c=>c.startMs===55880)?.text).toBe("確認してから始めます");
        expect(cues.find(c=>c.startMs===121980)).toMatchObject({text:a+b+rest,endMs:133200});expect(cues.find(c=>c.startMs===133200)?.text).toBe(next);
        if(scenario==="valid") {expect(cues.find(c=>c.startMs===96170)).toMatchObject({text:cp,endMs:100860});expect(cues.find(c=>c.startMs===100860)).toMatchObject({text:cm,endMs:104740});expect(cues.find(c=>c.startMs===104740)).toMatchObject({text:cf,endMs:109930});}
        else {expect(cues.find(c=>c.startMs===96170)?.text).toBe(cp+cm+"明日は");expect(cues.some(c=>c.startMs===102500)).toBe(true);}

      }
    } finally {await accelerator.cleanup();}
  });

  it.each(["valid", "quoted", "unstable", "missing", "startup_failure", "native_failure", "cancel", "cleanup_failure"] as const)("preserves prefix repair while applying one bounded multi-parent group: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const a = "説明を聞いた後で順番に", b = "手順を確認する必要", rest = "があると伝えました";
      const next = "次は資料を読んで内容を詳しく確認してから提出してください", right = "順番に" + b + rest + " " + next;
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 175 * 16000, vadEnabled: true, quietAudioGainDb: 12, formats: ["SRT", "LRC"],
        inference: ({ request, window }) => {
          const multi = window.windowKey.includes(".multi-"), prefix = window.windowKey.includes(".prefix-"), second = window.windowKey.endsWith("-1");
          if (multi && second && scenario === "native_failure") throw new Error("multi witness failed");
          if (multi && second && scenario === "cancel") harness.controller.abort();
          let segments;
          if (multi) {
            const seg = (id: number, text: string, start: number, end: number, pairs: [string, number][]) => ({ ...rawSegment(id, start-window.startMs, end-window.startMs,text),dtwTokens:pairs.map(([text,point])=>({text,pointMs:point-window.startMs})) });
            segments = [seg(0,a+b+rest,window.startMs,132000,[["説明を聞いた後で",123000],["順番に",125900],[b,128000],[rest,131000]]),
              seg(1,next,132000,143440,[["次は",second ? scenario === "unstable" ? 134000 : 133240 : 133200],["資料を読んで",134000],["内容を詳しく確認してから提出してください",140000]])];
            if (second && scenario === "missing") segments[1].dtwTokens = [];
            if (second && scenario === "quoted") { segments[0].text = "「"+segments[0].text;segments[0].dtwTokens.unshift({text:"「",pointMs:0});segments[1].text+="」";segments[1].dtwTokens.push({text:"」",pointMs:24000}); }
          } else if (prefix) {
            segments = [{...rawSegment(0,0,7000,"前置き説明をもう一度"),dtwTokens:[{text:"前置き",pointMs:1000},{text:"説明をもう一度",pointMs:51000-window.startMs}]},
              {...rawSegment(1,7000,61230-window.startMs,"確認してから始めます"),dtwTokens:[{text:"確認",pointMs:(second?56000:55880)-window.startMs},{text:"してから",pointMs:58000-window.startMs},{text:"始めます",pointMs:60500-window.startMs}]}];
          } else if ([25000,50000,75000,100000,125000].includes(window.startMs) && request.vadSpeechPadMs !== undefined) segments=[0,1,2].map(i=>rawSegment(i,i*1000,i*1000+1000,"はい"));
          else if (window.startMs===25000) segments=[rawSegment(0,20570,26720,"前置き説明をもう一度")];
          else if (window.startMs===50000) segments=[rawSegment(0,160,11230,"説明をもう一度 確認してから始めます")];
          else if (window.startMs===100000) segments=[rawSegment(0,21980,26880,a),rawSegment(1,26880,30000,b)];
          else if (window.startMs===125000) segments=[rawSegment(0,710,18440,right)];
          else segments=[rawSegment(0,3000,4000,"こんにちは。")];
          const response=serverResponse(request,window.endMs-window.startMs,segments);
          return {processEpoch:multi?second?5:4:prefix?second?3:2:1,response:{...response,result:{...response.result,language:"ja",wordTimelineStatus:multi||prefix?"dtw_token_points":"discarded_vad_compressed_timeline"}}};
        } });
      if (scenario === "startup_failure") {const acquire=harness.supervisor.acquirePinnedSeparatorLease;const original=acquire.getMockImplementation()!;acquire.mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(original).mockRejectedValueOnce(new Error("second multi load failed"));}
      if (scenario === "cleanup_failure") harness.media.disposeWindow.mockImplementation(async brand=>{if(brand.descriptor.windowKey.endsWith("multi-1"))throw new Error("cleanup failed");return {removed:true};});
      const result=await harness.executor.execute(harness.context);
      const optional=harness.media.materializeWindow.mock.calls.map(([r])=>r).filter(r=>/\.(prefix|multi)-/u.test(r.descriptor.windowKey));
      expect(optional.map(r=>r.descriptor.startMs)).toEqual(scenario==="startup_failure"?[45000,44000,120000]:[45000,44000,120000,119000]);
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(scenario==="startup_failure"?15:16);
      expect(optional.every(r=>!r.conditionQuietAudio)).toBe(true);
      for(const call of harness.supervisor.acquirePinnedSeparatorLease.mock.calls) expect(call[2]).toEqual({freshInferenceState:true});
      if(scenario==="cancel"||scenario==="cleanup_failure") {expect(result.status).toBe(scenario==="cancel"?"cancelled":"failed");expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();}
      else {
        expect(result.status).toBe("completed");const cues=harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
        expect(cues.find(c=>c.startMs===55880)?.text).toBe("確認してから始めます");
        if(scenario==="valid"||scenario==="quoted") {expect(cues.find(c=>c.startMs===121980)).toMatchObject({text:a+b+rest,endMs:133200});expect(cues.find(c=>c.startMs===133200)).toMatchObject({text:next,endMs:143440});expect(cues.some(c=>c.startMs===127500)).toBe(false);}
        else {expect(cues.find(c=>c.startMs===126880)?.text).toBe(b);expect(cues.find(c=>c.startMs===127500)?.text.replace(/\s/gu,"")).toBe(right.replace(/\s/gu,""));}
      }
    } finally {await accelerator.cleanup();}
  });

  it.each(["valid", "unstable", "missing", "budget", "startup_failure", "native_failure", "cancel", "cleanup_failure"] as const)("applies a two-observation prefix group after primary fallback: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const left = "前置き説明をもう一度", right = "説明をもう一度 確認してから始めます";
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 105 * 16000, vadEnabled: true, quietAudioGainDb: 12, formats: ["SRT", "LRC"],
        inference: ({ request, window }) => {
          const witness = window.windowKey.includes(".prefix-");
          const second = window.windowKey.endsWith("prefix-1");
          if (witness && second && scenario === "native_failure") throw new Error("second witness failed");
          if (witness && second && scenario === "cancel") harness.controller.abort();
          const needsFallback = [25000, 50000].includes(window.startMs) || scenario === "budget" && window.startMs === 0;
          const segments = witness ? [
            { ...rawSegment(0, 0, 7000, left), dtwTokens: [{ text: "前置き", pointMs: 1000 }, { text: "説明をもう一度", pointMs: 51000 - window.startMs }] },
            { ...rawSegment(1, 7000, 61230 - window.startMs, "確認してから始めます"), dtwTokens: scenario === "missing" && second ? [] : [
              { text: "確認", pointMs: (second ? scenario === "unstable" ? 56800 : 56000 : 55880) - window.startMs },
              { text: "してから", pointMs: 58000 - window.startMs }, { text: "始めます", pointMs: 60500 - window.startMs }] },
          ] : needsFallback && request.vadSpeechPadMs !== undefined ? [0, 1, 2].map(i => rawSegment(i, i * 1000, i * 1000 + 1000, "はい"))
            : window.startMs === 25000 ? [rawSegment(0, 20570, 26720, left)]
              : window.startMs === 50000 ? [rawSegment(0, 160, 11230, right)] : [rawSegment(0, 3000, 4000, "こんにちは。")];
          const response = serverResponse(request, window.endMs - window.startMs, segments);
          return { processEpoch: witness ? second ? 3 : 2 : 1, response: { ...response, result: { ...response.result,
            language: "ja", wordTimelineStatus: witness ? "dtw_token_points" : "discarded_vad_compressed_timeline" } } };
        } });
      if (scenario === "startup_failure") {
        const acquire = harness.supervisor.acquirePinnedSeparatorLease;
        acquire.mockImplementationOnce(acquire.getMockImplementation()!).mockRejectedValueOnce(new Error("second load failed"));
      }
      if (scenario === "cleanup_failure") harness.media.disposeWindow.mockImplementation(async brand => {
        if (brand.descriptor.windowKey.endsWith("prefix-1")) throw new Error("cleanup failed");
        return { removed: true };
      });
      const result = await harness.executor.execute(harness.context);
      const witnessCalls = harness.media.materializeWindow.mock.calls.map(([r]) => r).filter(r => r.descriptor.windowKey.includes(".prefix-"));
      expect(witnessCalls.length).toBe(scenario === "budget" ? 0 : scenario === "startup_failure" ? 1 : 2);
      for (const call of witnessCalls) expect(call.conditionQuietAudio).toBe(false);
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(scenario === "budget" || scenario === "startup_failure" ? 7 : 8);
      for (const call of harness.supervisor.acquirePinnedSeparatorLease.mock.calls) expect(call[2]).toEqual({ freshInferenceState: true });
      if (scenario === "cancel" || scenario === "cleanup_failure") {
        expect(result.status).toBe(scenario === "cancel" ? "cancelled" : "failed");
        expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe("completed");
        const cues = harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
        expect(cues).toHaveLength(4);
        expect(cues[1]).toMatchObject({ text: left, startMs: 45570, endMs: 51720 });
        expect(cues[2]).toMatchObject({ text: scenario === "valid" ? "確認してから始めます" : right,
          startMs: scenario === "valid" ? 55880 : 52500, endMs: 61230 });
      }
    } finally { await accelerator.cleanup(); }
  });

  it.each(["valid", "changed", "other_words"] as const)("uses complete witness groups within the existing seam budget: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const left = "は?でも調子になんで", right = "は?でも女子になんてこと聞くんだ";
      const part = (id: number, text: string, start: number, end: number) => ({ ...rawSegment(id, start, end, text), dtwTokens: [{ text, pointMs: start + 40 }] });
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 55 * 16000, vadEnabled: true, formats: ["SRT", "LRC"], inference: ({ request, window }) => {
          const segments = request.vadEnabled ? window.startMs === 0 ? [rawSegment(0, 24610, 30000, left)] : [rawSegment(0, 2370, 6000, right)]
            : [part(0, "ね?", 4380, 4620), ...(scenario === "other_words" ? [part(1, "もう一度", 5000, 6000)] : []),
              part(2, "は?", 7280, 7520), part(3, "でも", 8020, 8360),
              part(4, scenario === "changed" ? "男子になんてこと聞くんだ" : "女子になんてこと聞くんだ", 8360, 11000)];
          const response = serverResponse(request, window.endMs - window.startMs, segments);
          return { processEpoch: request.vadEnabled ? 1 : 2, response: { ...response, result: { ...response.result,
            language: "ja", wordTimelineStatus: request.vadEnabled ? "discarded_vad_compressed_timeline" : "dtw_token_points" } } };
        } });
      const result = await harness.executor.execute(harness.context);
      expect(result.status).toBe("completed");
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(3);
      expect(harness.supervisor.acquirePinnedSeparatorLease).toHaveBeenLastCalledWith(expect.anything(), harness.context.signal, { freshInferenceState: true });
      const cues = harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
      expect(cues.map(c => c.text)).toEqual(scenario === "valid" ? [right] : [left, right]);
      if (scenario === "valid") expect(cues[0]).toMatchObject({ startMs: 27370, endMs: 31000 });
      expect(result.artifactResults).toHaveLength(2);
    } finally { await accelerator.cleanup(); }
  });
  it.each(["valid", "shared_budget", "ordering", "changed", "missing", "startup_failure", "native_failure", "cancel", "cleanup_failure"] as const)("reconciles a clipped cross-window variant with a bounded witness: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    try {
      const left = "ん?なんだどうして", right = "ん?何だ?どうしたのって何がだ?";
      const sibling = scenario === "shared_budget" ? [rawSegment(1, 10000, 20000, "今日はいい天気ですね明日は家で休みます")] : [];
      const leading = scenario === "ordering" ? [rawSegment(0, 0, 10000, "今日はいい天気ですね明日は家で休みます")] : [];
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof, modelId: "large-v3",
        totalFrames: 55 * 16000, vadEnabled: true, formats: ["SRT", "LRC"],
        inference: ({ request, window }) => {
          if (!request.vadEnabled && scenario === "native_failure") throw new Error("witness unavailable");
          if (!request.vadEnabled && scenario === "cancel") harness.controller.abort();
          const segments = request.vadEnabled ? window.startMs === 0
            ? [...leading, rawSegment(leading.length, 24960, 30000, left)] : [rawSegment(0, 1350, 6230, right), ...sibling]
            : scenario === "ordering" && window.startMs === 0 ? [
              { ...rawSegment(0, 0, 4000, "今日はいい天気ですね"), dtwTokens: [{ text: "今日はいい天気ですね", pointMs: 3700 }] },
              { ...rawSegment(1, 4000, 10000, "明日は家で休みます"), dtwTokens: [{ text: "明日は家で休みます", pointMs: 4500 }] },
            ]
            : [{ ...rawSegment(0, 4920, 11300, scenario === "changed" ? "別の話をしています" : "ん?なんだ どうしたのって何がだ"),
              dtwTokens: scenario === "missing" ? [] : [{ text: "ん?なんだ", pointMs: 6420 }, { text: " どうしたのって何がだ", pointMs: 11060 }] }];
          const response = serverResponse(request, window.endMs - window.startMs, segments);
          return { processEpoch: request.vadEnabled ? 1 : 2, response: { ...response, result: { ...response.result,
            language: "ja", wordTimelineStatus: request.vadEnabled ? "discarded_vad_compressed_timeline" : "dtw_token_points" } } };
        } });
      if (scenario === "cleanup_failure") harness.media.disposeWindow.mockImplementationOnce(async () => ({ removed: true }))
        .mockImplementationOnce(async () => ({ removed: true })).mockRejectedValueOnce(new Error("cleanup failed"));
      if (scenario === "startup_failure") {
        const acquire = harness.supervisor.acquirePinnedSeparatorLease;
        acquire.mockImplementationOnce(acquire.getMockImplementation()!).mockRejectedValueOnce(new Error("fresh witness unavailable"));
      }
      const result = await harness.executor.execute(harness.context);
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(scenario === "ordering" ? 4 : scenario === "startup_failure" ? 2 : 3);
      expect(harness.supervisor.acquirePinnedSeparatorLease).toHaveBeenLastCalledWith(expect.anything(), harness.context.signal, { freshInferenceState: true });
      if (scenario === "ordering") expect(harness.media.materializeWindow.mock.calls[2]![0]).toMatchObject({ descriptor: { windowKey: "w000000" } });
      if (scenario !== "startup_failure") expect(harness.media.materializeWindow.mock.calls.at(-1)![0]).toMatchObject({ conditionQuietAudio: false,
        descriptor: { startMs: 20000, endMs: 40000, windowKey: "w000001.seam", rootWindowKey: "w000001.seam" } });
      if (scenario === "cancel" || scenario === "cleanup_failure") {
        expect(result.status).toBe(scenario === "cancel" ? "cancelled" : "failed");
        expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe("completed");
        const cues = harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
        const accepted = ["valid", "shared_budget", "ordering"].includes(scenario);
        expect(cues.map(c => c.text)).toEqual([...(scenario === "ordering" ? ["今日はいい天気ですね", "明日は家で休みます"] : []),
          ...(accepted ? [right] : [left, right]), ...sibling.map(s => s.text)]);
        if (accepted) expect(cues[scenario === "ordering" ? 2 : 0]).toMatchObject({ startMs: 24960, endMs: 31230 });
        expect(result.artifactResults).toHaveLength(2);
      }
    } finally { await accelerator.cleanup(); }
  });
  it.each(["large-v3", undefined])("does not spend a request solely on a punctuated cue: %s", async modelId => {
    const accelerator = await createAcceleratorFixture();
    try {
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof,
        modelId, vadEnabled: true, inference: ({ request, window }) => {
          const response = serverResponse(request, window.endMs - window.startMs,
            [rawSegment(0, 0, 10000, "今日はいい天気ですね。明日は家で休みます")]);
          return { processEpoch: 1, response: { ...response, result: { ...response.result, language: "ja" } } };
        } });
      expect((await harness.executor.execute(harness.context)).status).toBe("completed");
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(1);
      expect(harness.supervisor.acquirePinnedSeparatorLease).not.toHaveBeenCalled();
    } finally { await accelerator.cleanup(); }
  });
  it.each(["valid", "missing", "changed", "punctuated"] as const)("exports bounded DTW enhancement through the default path: %s", async scenario => {
    const accelerator = await createAcceleratorFixture();
    const firstText = "今日はいい天気ですね" + (scenario === "punctuated" ? "。" : "");
    const text = firstText + "明日は家で休みます";
    const siblings = scenario === "punctuated"
      ? [rawSegment(1, 12000, 22000, "今日は読書をしていました明日は外で遊びます")] : [];
    try {
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof,
        modelId: "large-v3", vadEnabled: true, formats: ["SRT", "LRC"],
        totalFrames: (scenario === "punctuated" ? 22 : 10) * 16000,
        inference: ({ request, window }) => {
          const segments = request.vadEnabled ? [rawSegment(0, 0, 10000, text), ...siblings] : [
            { ...rawSegment(0, 0, 4000, firstText), dtwTokens: [
              { text: "今日は", pointMs: 1200 }, { text: "いい天気ですね", pointMs: 3700 },
              ...(scenario === "punctuated" ? [{ text: "。", pointMs: null }] : [])] },
            { ...rawSegment(1, 4000, 10000, scenario === "changed" ? "明日は外で遊びます" : "明日は家で休みます"), dtwTokens: [
              { text: "明日", pointMs: scenario === "missing" ? null : 4500 }, { text: "は家で休みます", pointMs: 6800 }] },
            ...siblings.map(segment => ({ ...segment, id: 2 })),
          ];
          const response = serverResponse(request, window.endMs - window.startMs, segments);
          return { processEpoch: request.vadEnabled ? 1 : 2, response: { ...response,
            result: { ...response.result, language: "ja", wordTimelineStatus: request.vadEnabled ? "discarded_vad_compressed_timeline" : "dtw_token_points" } } };
        } });
      const result = await harness.executor.execute(harness.context);
      expect(result.status).toBe("completed");
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
      expect(harness.supervisor.beginInference.mock.calls[0]![1].timingMode).toBeUndefined();
      expect(harness.supervisor.beginInference.mock.calls[1]![1]).toMatchObject({ timingMode: "dtw_large_v3", vadEnabled: false, language: "ja" });
      const cues = harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
      expect(cues.map(c => [c.startMs, c.endMs])).toEqual([
        ...(["valid", "punctuated"].includes(scenario) ? [[0, 4500], [4500, 10000]] : [[0, 10000]]),
        ...siblings.map(c => [c.startMs, c.endMs]),
      ]);
      expect(cues.map(c => c.text).join("").replace(/ /g, "")).toBe(text + siblings.map(c => c.text).join(""));
      expect(result.artifactResults).toHaveLength(2);
    } finally { await accelerator.cleanup(); }
  });

  it.each(["accept", "changed_text", "native_failure", "startup_failure", "stale_response", "cancel", "cleanup_failure"] as const)(
    "handles a bounded text-only separator candidate: %s", async (scenario) => {
      const accelerator = await createAcceleratorFixture();
      const text = "今日はいい天気ですね明日は家で休みます";
      try {
        const harness = await createHarness({
          backend: "cuda", acceleratorPack: accelerator.proof, vadEnabled: true,
          formats: ["SRT", "LRC"],
          inference: ({ request, window }) => {
            if (!request.vadEnabled && scenario === "native_failure") throw new Error("candidate crashed");
            if (!request.vadEnabled && scenario === "cancel") harness.controller.abort();
            const response = serverResponse(request, window.endMs - window.startMs,
              request.vadEnabled ? [rawSegment(0, 0, 10000, text)] : [
                rawSegment(0, 0, 4000, scenario === "changed_text" ? "今日は悪い天気ですね" : "今日は、いい天気ですね"),
                rawSegment(1, 4000, 10000, "明日は家で休みます"),
              ]);
            return { processEpoch: request.vadEnabled ? 1 : 2, response: {
              ...response, result: { ...response.result, language: "japanese" },
              ...(!request.vadEnabled && scenario === "stale_response" ? { requestGeneration: request.requestGeneration + 1 } : {}),
            } };
          },
        });
        if (scenario === "cleanup_failure") {
          harness.media.disposeWindow.mockImplementationOnce(async () => ({ removed: true }))
            .mockRejectedValueOnce(new Error("candidate cleanup failed"));
        }
        if (scenario === "startup_failure") harness.supervisor.acquirePinnedSeparatorLease.mockRejectedValueOnce(new Error("candidate unavailable"));
        const result = await harness.executor.execute(harness.context);
        expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledWith(
          expect.anything(), harness.context.signal, { freshInferenceState: true });
        expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(scenario === "startup_failure" ? 1 : 2);
        expect(harness.supervisor.acquirePinnedSeparatorLease).toHaveBeenCalledTimes(1);
        if (scenario !== "startup_failure") {
          const request = harness.supervisor.beginInference.mock.calls[1]![1];
          expect(request.vadEnabled).toBe(false);
          expect(request.vadSpeechPadMs).toBeUndefined();
          expect(harness.media.materializeWindow.mock.calls[1]![0].conditionQuietAudio).toBe(false);
        }
        expect(harness.supervisor.release.mock.invocationCallOrder[0]).toBeLessThan(
          harness.supervisor.acquirePinnedSeparatorLease.mock.invocationCallOrder[0]!);
        if (scenario === "cancel" || scenario === "cleanup_failure" || scenario === "stale_response") {
          expect(result.status).toBe(scenario === "cancel" ? "cancelled" : "failed");
          expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
        } else {
          expect(result.status).toBe("completed");
          const exported = harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments;
          expect(exported).toHaveLength(1);
          expect(exported[0]).toMatchObject({ startMs: 0, endMs: 10000,
            text: scenario === "accept" ? "今日は、いい天気ですね 明日は家で休みます" : text });
          expect(result.artifactResults).toHaveLength(2);
        }
      } finally { await accelerator.cleanup(); }
    },
  );

  it("stops separator decoding after two consecutive unchanged windows", async () => {
    const accelerator = await createAcceleratorFixture();
    try {
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof,
        vadEnabled: true, totalFrames: 90 * 16000,
        inference: ({ request, window }) => {
          const text = `今日はいい天気ですね明日は家で休みます${window.startMs}`;
          const response = serverResponse(request, window.endMs - window.startMs,
            [rawSegment(0, 5000, 15000, request.vadEnabled ? text : `違う${text}`)]);
          return { processEpoch: request.vadEnabled ? 1 : 2,
            response: { ...response, result: { ...response.result, language: "ja" } } };
        },
      });
      expect((await harness.executor.execute(harness.context)).status).toBe("completed");
      const requests = harness.supervisor.beginInference.mock.calls.map(call => call[1]);
      expect(requests.filter(request => request.vadEnabled).length).toBeGreaterThan(2);
      expect(requests.filter(request => !request.vadEnabled)).toHaveLength(2);
    } finally { await accelerator.cleanup(); }
  });

  it.each(["reject", "late_success"] as const)("discards a timed-out candidate (%s) and exports the primary result", async (outcome) => {
    const accelerator = await createAcceleratorFixture();
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      nativeSetTimeout(callback, ms === 30_000 ? 5 : ms, ...args)) as typeof setTimeout);
    try {
      const text = "今日はいい天気ですね明日は家で休みます";
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof,
        vadEnabled: true, beginInference: request => {
          const response = serverResponse(request, 10000, [rawSegment(0, 0, 10000, text)]);
          return { ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
            result: request.vadEnabled ? Promise.resolve({ processEpoch: 1,
              response: { ...response, result: { ...response.result, language: "ja" } } }) :
              new Promise((resolve, reject) => request.signal!.addEventListener("abort", () => {
                if (outcome === "reject") reject(new Error("candidate deadline"));
                else {
                  const candidate = serverResponse(request, 10000, [rawSegment(0, 0, 10000, "今日は、いい天気ですね明日は家で休みます")]);
                  resolve({ processEpoch: 2, response: { ...candidate, result: { ...candidate.result, language: "ja" } } });
                }
              }, { once: true })),
          };
        },
      });
      expect((await harness.executor.execute(harness.context)).status).toBe("completed");
      expect(harness.supervisor.cancelRequest).toHaveBeenCalledOnce();
      expect(harness.supervisor.beginInference.mock.calls[1]![1].signal!.aborted).toBe(true);
      expect(harness.exporter.exportArtifacts.mock.calls[0]![0].transcript.segments[0]!.text).toBe(text);
    } finally { timer.mockRestore(); await accelerator.cleanup(); }
  });

  it("shares the extra request budget with quiet-audio recovery", async () => {
    const accelerator = await createAcceleratorFixture();
    const text = "今日はいい天気ですね明日は家で休みます";
    try {
      const harness = await createHarness({ backend: "cuda", acceleratorPack: accelerator.proof,
        vadEnabled: true, quietAudioGainDb: 12, totalFrames: 30 * 16000,
        inference: ({ request, window, index }) => {
          const response = serverResponse(request, window.endMs - window.startMs,
            [rawSegment(0, 0, index === 0 ? 12000 : 10000, text)]);
          return { processEpoch: 1, response: { ...response, result: { ...response.result, language: "ja" } } };
        },
      });
      const result = await harness.executor.execute(harness.context);
      expect(result.status).toBe("completed");
      expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
      expect(harness.supervisor.acquirePinnedSeparatorLease).not.toHaveBeenCalled();
    } finally { await accelerator.cleanup(); }
  });

  it.each(["long", "repeat"])("retries a risky conditioned %s candidate on original audio once", async (risk) => {
    const harness = await createHarness({
      totalFrames: 30 * 16000, vadEnabled: true, quietAudioGainDb: 12,
      inference: ({request, window, index}) => ({
        processEpoch: 1,
        response: serverResponse(request, window.endMs - window.startMs,
          index === 0
            ? risk === "long" ? [rawSegment(0, 0, 12000, "Discarded candidate")]
              : [0, 1, 2].map(i => rawSegment(i, i * 1000, (i + 1) * 1000, "Discarded candidate"))
            : [rawSegment(0, 0, 12000, "Original output")]),
      }),
    });
    const result = await harness.executor.execute(harness.context);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact");
    const exported = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
    expect(exported.rawText).toContain("Original");
    expect(exported.rawText).not.toContain("Discarded");
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(harness.media.materializeWindow.mock.calls.map(([r]) => r.conditionQuietAudio)).toEqual([true, false]);
    expect(harness.supervisor.beginInference.mock.calls[0]?.[1]).toMatchObject({vadSpeechPadMs: 1000});
    expect(harness.supervisor.beginInference.mock.calls[1]?.[1]).not.toHaveProperty("vadSpeechPadMs");
  });

  it("does not retry an empty conditioned negative control", async () => {
    const harness = await createHarness({
      vadEnabled: true, quietAudioGainDb: 12,
      inference: ({request, window}) => ({processEpoch: 1,
        response: serverResponse(request, window.endMs - window.startMs, [])}),
    });
    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed", error: {code: "no_speech_detected"},
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
  });

  it.each([true, false])("binds quiet-window padding to actual conditioning and VAD (%s)", async (vadEnabled) => {
    const harness = await createHarness({vadEnabled, quietAudioGainDb: 12});
    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({status: "completed"});
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledWith(
      expect.anything(), harness.context.signal, { freshInferenceState: false });
    expect(harness.media.materializeWindow.mock.calls[0]?.[0]).toMatchObject({conditionQuietAudio: vadEnabled});
    const request = harness.supervisor.beginInference.mock.calls[0]?.[1];
    if (vadEnabled) expect(request).toMatchObject({vadSpeechPadMs: 1000});
    else expect(request).not.toHaveProperty("vadSpeechPadMs");
  });
  it("exports readable decoder cues separately in the default transcription path", async () => {
    const harness = await createHarness({
      inference: ({request, window}) => ({
        processEpoch: 1,
        response: serverResponse(request, window.endMs - window.startMs, [
          rawSegment(0, 1000, 4000, "First words"),
          rawSegment(1, 4000, 6000, "Following words"),
        ]),
      }),
    });
    const result = await harness.executor.execute(harness.context);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    const exported = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
    expect(exported.rawText).toContain("00:00:01,000 --> 00:00:04,000");
    expect(exported.rawText).toContain("00:00:04,000 --> 00:00:06,000");
    expect(exported.rawText).not.toContain("First words Following words");
    expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
  });

  it("exports long unpunctuated raw segments intact to both formats without extra inference", async () => {
    const text = "ああもしもし私だそうだイオリだお前は誰だそうかお兄さんか";
    const harness = await createHarness({
      totalFrames: 30 * 16000, formats: ["SRT", "LRC"], vadEnabled: true,
      inference: ({request, window}) => ({processEpoch: 1,
        response: serverResponse(request, window.endMs - window.startMs, [
          rawSegment(0, 2500, 16590, text),
          rawSegment(1, 17000, 17500, "うん"),
          rawSegment(2, 17700, 18200, "そうか"),
        ]),
      }),
    });
    const result = await harness.executor.execute(harness.context);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion.");
    expect(result.artifactResults).toHaveLength(2);
    for (const artifact of result.artifactResults) {
      if (artifact.status !== "committed") throw new Error("Expected artifact.");
      const exported = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
      expect(exported.rawText).toContain(text);
      expect(exported.rawText).not.toContain("うんそうか");
      if (artifact.format === "SRT") {
        expect(exported.rawText).toContain("00:00:02,500 --> 00:00:16,590");
        expect(exported.rawText).toContain("00:00:17,000 --> 00:00:17,500");
        expect(exported.rawText).toContain("00:00:17,700 --> 00:00:18,200");
      } else {
        expect(exported.rawText).toContain(`[00:02.50]${text}`);
        expect(exported.rawText).toContain("[00:17.00]うん");
        expect(exported.rawText).toContain("[00:17.70]そうか");
        expect(exported.rawText).not.toContain("[00:07.02]");
      }
    }
    expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
    expect(harness.supervisor.beginInference.mock.calls[0]?.[1]).toMatchObject({vadEnabled: true});
  });

  it("accepts a frozen translation post action without executing it locally", async () => {
    const harness = await createHarness({
      postAction: {
        mode: "enqueue_and_start_translation",
        preferredFormat: "SRT",
        translationSnapshotId: "translation-snapshot-1",
      },
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
  });

  it("forwards the frozen translate mode and session prompt to inference", async () => {
    const harness = await createHarness({
      taskMode: "translate_to_english",
      initialPrompt: "FusionKit product names",
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.supervisor.beginInference.mock.calls[0]?.[1]).toMatchObject({
      taskMode: "translate_to_english",
      initialPrompt: "FusionKit product names",
    });
  });

  it("reverifies and pins the exact admitted CUDA pack before inference", async () => {
    const accelerator = await createAcceleratorFixture();
    try {
      const harness = await createHarness({
        backend: "cuda",
        acceleratorPack: accelerator.proof,
      });

      await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
        status: "completed",
      });
      expect(harness.resolveCudaAccelerator).toHaveBeenCalledTimes(2);
      expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledWith(
        OWNER,
        "batch-1",
        expect.objectContaining({
          backend: "cuda",
          serverArtifactId: accelerator.proof.serverArtifactId,
          acceleratorPack: accelerator.proof,
        }),
        harness.sliceController.signal,
      );
    } finally {
      await accelerator.cleanup();
    }
  });

  it("binds one branded PCM attempt and activates a readable SRT artifact", async () => {
    const harness = await createHarness();

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      durationMs: 10_000,
      artifactResults: [{ format: "SRT", status: "committed" }],
    });
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    const first = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
    const second = await harness.artifacts.readText(OWNER, artifact.artifact.artifactRef);
    expect(second).toEqual(first);
    expect(first.rawText).toContain("00:00:01,000 --> 00:00:03,000");
    expect(harness.media.resolveWindow).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(1);
    const request = harness.supervisor.beginInference.mock.calls[0]![1];
    expect(request).toMatchObject({
      requestGeneration: 1,
      expectedFileIdentity: {
        objectIdentity: {
          dev: 1,
          ino: 1,
          birthtimeMs: 1,
        },
        size: expect.any(Number),
      },
      taskMode: "transcribe",
      vadEnabled: false,
    });
    expect(Object.isFrozen(request.expectedFileIdentity)).toBe(true);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
    expect(harness.supervisor.release).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.outputs.resolveBatchLease).toHaveBeenCalled();
    expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
    expect(harness.context.update.mock.calls.map(([update]) => update.status)).toEqual([
      "preparing_media",
      "loading_model",
      "loading_model",
      "transcribing",
      "transcribing",
      "post_processing",
      "post_processing",
      "exporting",
    ]);
  });

  it("pins the exact managed VAD and enables segment-only VAD inference", async () => {
    const harness = await createHarness({ vadEnabled: true });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledWith(
      OWNER,
      "batch-1",
      expect.objectContaining({
        purpose: "inference",
        model: harness.context.managedModel,
        vadModel: harness.managedVad,
      }),
      harness.sliceController.signal,
    );
    expect(harness.supervisor.beginInference.mock.calls[0]?.[1]).toMatchObject({
      vadEnabled: true,
      vadMinSilenceMs: 500,
    });
  });

  it("uses only the task input parent resolver for source output", async () => {
    const harness = await createHarness({ outputMode: "source" });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
      artifactResults: [{ format: "SRT", status: "committed" }],
    });

    expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
    expect(
      harness.inputs.resolveTaskSourceOutputDirectory,
    ).toHaveBeenCalledTimes(4);
    for (const call of harness.inputs.resolveTaskSourceOutputDirectory.mock.calls) {
      expect(call).toEqual([OWNER, "task-1", "file-token-1"]);
    }
  });

  it("consumes a verified Metal resolution in the queue-admission runtime pin", async () => {
    const harness = await createHarness({ backend: "metal" });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.context.config).toMatchObject({
      devicePreference: "auto",
      resolvedBackend: "metal",
    });
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquireBatchRuntimePin.mock.calls[0]?.[2]).toMatchObject({
      purpose: "inference",
      backend: "metal",
      serverArtifactId: "whisper-server-cpu",
    });
  });

  it("exports an LRC-only artifact through the production pipeline", async () => {
    const harness = await createHarness({ formats: ["LRC"] });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [{ format: "LRC", status: "committed" }],
    });
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    await expect(
      harness.artifacts.readText(OWNER, artifact.artifact.artifactRef),
    ).resolves.toMatchObject({
      format: "LRC",
      rawText: expect.stringMatching(/^\[00:01\.00\]/u),
    });
  });

  it.each([
    ["SRT", "LRC"],
    ["LRC", "SRT"],
  ] as const)(
    "commits source output formats in request order: %s then %s",
    async (first, second) => {
      const harness = await createHarness({
        outputMode: "source",
        formats: [first, second],
      });

      const result = await harness.executor.execute(harness.context);

      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [
          { format: first, status: "committed" },
          { format: second, status: "committed" },
        ],
      });
      expect(
        harness.inputs.resolveTaskSourceOutputDirectory,
      ).toHaveBeenCalledTimes(7);
      expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
    },
  );

  it("keeps the first production artifact when the second format fails", async () => {
    const harness = await createHarness({
      formats: ["SRT", "LRC"],
      failArtifactReserveFormat: "LRC",
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        { format: "SRT", status: "committed" },
        { format: "LRC", status: "failed", errorCode: "output_write_failed" },
      ],
    });
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    await expect(
      harness.artifacts.readText(OWNER, artifact.artifact.artifactRef),
    ).resolves.toMatchObject({ format: "SRT" });
  });

  it.each([
    ["without cancellation", false, "cleanup_failed"],
    ["after synchronous cancellation", true, "cancel_failed"],
  ] as const)(
    "keeps a readable SRT when LRC commit and partial cleanup fail %s",
    async (_case, abortDuringCleanup, expectedErrorCode) => {
      let failedLrcPartialPath: string | undefined;
      const harness = await createHarness({
        formats: ["SRT", "LRC"],
        exporterDependencies: (controller) => ({
          commitIndex: async (partialPath, finalPath) => {
            if (finalPath.endsWith(".lrc")) {
              failedLrcPartialPath = partialPath;
              throw Object.assign(new Error("LRC commit failed"), { code: "EIO" });
            }
            await link(partialPath, finalPath);
          },
          removeFile: async (filePath) => {
            if (filePath === failedLrcPartialPath) {
              if (abortDuringCleanup) controller.abort();
              throw Object.assign(new Error("LRC partial cleanup failed"), {
                code: "EACCES",
              });
            }
            await unlink(filePath);
          },
        }),
      });

      const result = await harness.executor.execute(harness.context);

      expect(harness.controller.signal.aborted).toBe(abortDuringCleanup);
      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [
          { format: "SRT", status: "committed" },
          { format: "LRC", status: "failed", errorCode: expectedErrorCode },
        ],
      });
      if (result.status !== "completed") throw new Error("Expected completion.");
      const artifact = result.artifactResults[0];
      if (artifact?.status !== "committed") throw new Error("Expected artifact.");
      const first = await harness.artifacts.readText(
        OWNER,
        artifact.artifact.artifactRef,
      );
      const second = await harness.artifacts.readText(
        OWNER,
        artifact.artifact.artifactRef,
      );
      expect(second).toEqual(first);
      expect(first).toMatchObject({ format: "SRT" });
      await expect(lstat(path.join(harness.outputRoot, "meeting.srt"))).resolves
        .toMatchObject({ size: expect.any(Number) });
      await expect(lstat(path.join(harness.outputRoot, "meeting.lrc"))).rejects
        .toMatchObject({ code: "ENOENT" });
      if (!failedLrcPartialPath) throw new Error("Expected failed LRC partial.");
      await expect(lstat(failedLrcPartialPath)).resolves.toMatchObject({
        size: expect.any(Number),
      });
    },
  );

  it.each(["custom", "source"] as const)(
    "keeps the first artifact when the %s directory resolver fails before the second format",
    async (outputMode) => {
      const harness = await createHarness({
        outputMode,
        formats: ["SRT", "LRC"],
      });
      let resolutions = 0;
      const failBeforeSecondFormat = async () => {
        resolutions += 1;
        const failingResolution = outputMode === "source" ? 5 : 4;
        if (resolutions === failingResolution) {
          throw Object.assign(new Error("output directory resolution failed"), {
            code: "output_write_failed",
          });
        }
        return resolvedOutputDirectory(harness.outputRoot);
      };
      if (outputMode === "source") {
        harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(
          failBeforeSecondFormat,
        );
      } else {
        harness.outputs.resolveBatchLease.mockImplementation(failBeforeSecondFormat);
      }

      const result = await harness.executor.execute(harness.context);

      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [
          { format: "SRT", status: "committed" },
          { format: "LRC", status: "failed", errorCode: "output_write_failed" },
        ],
      });
      if (result.status !== "completed") throw new Error("Expected completion.");
      const artifact = result.artifactResults[0];
      if (artifact?.status !== "committed") throw new Error("Expected artifact.");
      await expect(
        harness.artifacts.readText(OWNER, artifact.artifact.artifactRef),
      ).resolves.toMatchObject({ format: "SRT" });
      expect(resolutions).toBe(outputMode === "source" ? 5 : 4);
    },
  );

  it.each(["custom", "source"] as const)(
    "executes %s overwrite when the exporter has commit authority",
    async (outputMode) => {
      const commitOverwrite = vi.fn(rename);
      const harness = await createHarness({
        outputMode,
        conflictPolicy: "overwrite",
        exporterDependencies: () => ({ commitOverwrite }),
      });
      const finalPath = path.join(harness.outputRoot, "meeting.srt");
      await writeFile(finalPath, "previous subtitle", { mode: 0o600 });

      const result = await harness.executor.execute(harness.context);
      expect(result).toMatchObject({
        status: "completed",
        artifactResults: [{ format: "SRT", status: "committed" }],
      });
      expect(commitOverwrite).toHaveBeenCalledOnce();
      if (result.status !== "completed") throw new Error("Expected completion.");
      const artifact = result.artifactResults[0];
      if (artifact?.status !== "committed") throw new Error("Expected artifact.");
      await expect(harness.artifacts.readText(
        OWNER,
        artifact.artifact.artifactRef,
      )).resolves.toMatchObject({ rawText: expect.stringContaining("cue-0") });
    },
  );

  it("preserves the first production artifact when cancellation follows its commit", async () => {
    const harness = await createHarness({
      formats: ["SRT", "LRC"],
      abortAfterArtifactFormat: "SRT",
    });

    const result = await harness.executor.execute(harness.context);

    expect(harness.controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        { format: "SRT", status: "committed" },
        {
          format: "LRC",
          status: "skipped",
          errorCode: "cancelled_after_partial_commit",
        },
      ],
    });
  });

  it("fails source output preflight before media or runtime work", async () => {
    const harness = await createHarness({ outputMode: "source" });
    harness.inputs.resolveTaskSourceOutputDirectory.mockRejectedValueOnce(
      Object.assign(new Error("source parent changed"), {
        code: "media_changed",
      }),
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "preparing_media" },
      artifactResults: [],
    });

    expect(harness.media.normalizeTask).not.toHaveBeenCalled();
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
    expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
  });

  it("rejects source parent identity drift between preflight and export", async () => {
    const harness = await createHarness({ outputMode: "source" });
    const preflightRoot = path.join(harness.root, "preflight-parent");
    const exportRoot = path.join(harness.root, "export-parent");
    await Promise.all([mkdir(preflightRoot), mkdir(exportRoot)]);
    let resolution = 0;
    harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(async () =>
      resolvedOutputDirectory(resolution++ === 0 ? preflightRoot : exportRoot),
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "output_write_failed", stage: "exporting" },
    });

    expect(resolution).toBe(2);
    await expect(lstat(path.join(preflightRoot, "meeting.srt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(exportRoot, "meeting.srt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stabilizes a source parent failure during export", async () => {
    const harness = await createHarness({ outputMode: "source" });
    harness.inputs.resolveTaskSourceOutputDirectory
      .mockResolvedValueOnce(await resolvedOutputDirectory(harness.outputRoot))
      .mockRejectedValueOnce(
        Object.assign(new Error("source lease expired after transcription"), {
          code: "authorization_expired",
        }),
      );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "authorization_expired", stage: "preflight" },
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "authorization_expired" },
      ],
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.exporter.exportArtifacts).toHaveBeenCalledOnce();
  });

  it("resolves each source task to its own parent directory", async () => {
    const harness = await createHarness({ outputMode: "source" });
    const firstRoot = path.join(harness.root, "first-parent");
    const secondRoot = path.join(harness.root, "second-parent");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(
      async (_owner, taskId, expectedFileToken) => {
        expect(expectedFileToken).toBe(
          taskId === "task-1" ? "file-token-1" : "file-token-2",
        );
        return resolvedOutputDirectory(
          taskId === "task-1" ? firstRoot : secondRoot,
        );
      },
    );
    const sibling = createContext(
      new AbortController().signal,
      harness.context.admittedRuntimeGeneration,
      harness.context.batchRuntime,
      harness.context.config,
      harness.context.managedModel,
      harness.context.backendResolution,
      { taskId: "task-2", fileToken: "file-token-2" },
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.executor.execute(sibling)).resolves.toMatchObject({
      status: "completed",
    });

    await expect(lstat(path.join(firstRoot, "meeting.srt"))).resolves.toBeDefined();
    await expect(lstat(path.join(secondRoot, "meeting.srt"))).resolves.toBeDefined();
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
  });

  it("lets a source sibling continue after the first task parent preflight fails", async () => {
    const harness = await createHarness({ outputMode: "source" });
    harness.inputs.resolveTaskSourceOutputDirectory.mockImplementation(
      async (_owner, taskId) => {
        if (taskId === "task-1") {
          throw Object.assign(new Error("source parent is unavailable"), {
            code: "output_write_failed",
          });
        }
        return resolvedOutputDirectory(harness.outputRoot);
      },
    );
    const sibling = createContext(
      new AbortController().signal,
      harness.context.admittedRuntimeGeneration,
      harness.context.batchRuntime,
      harness.context.config,
      harness.context.managedModel,
      harness.context.backendResolution,
      { taskId: "task-2", fileToken: "file-token-2" },
    );

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "output_write_failed", stage: "exporting" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();

    await expect(harness.executor.execute(sibling)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
  });

  it.each(["custom", "source"] as const)(
    "rejects %s overwrite contexts before resolving or executing",
    async (outputMode) => {
      const harness = await createHarness();
      const config = createConfig(outputMode, "overwrite");
      expect(() =>
        harness.executor.beginBatchSlice(Object.freeze({
          owner: OWNER,
          batchId: "overwrite-batch",
          config,
          managedModel: harness.context.managedModel,
          admittedRuntimeGeneration: harness.context.admittedRuntimeGeneration,
          backendResolution: harness.context.backendResolution,
          signal: new AbortController().signal,
        }))).toThrow();

      await expect(
        harness.executor.execute(Object.freeze({ ...harness.context, config })),
      ).resolves.toMatchObject({
        status: "failed",
        error: { code: "invalid_ipc_request", stage: "preflight" },
      });
      expect(harness.inputs.resolveTaskSourceOutputDirectory).not.toHaveBeenCalled();
      expect(harness.outputs.resolveBatchLease).not.toHaveBeenCalled();
      expect(harness.media.normalizeTask).not.toHaveBeenCalled();
      expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
    },
  );

  it("splits a degenerate root into exact retry children with unique identities", async () => {
    const harness = await createHarness({
      totalFrames: 20 * 16_000,
      inference: ({ request, window, index }) =>
        index === 0
          ? repeatedResponse(request, window)
          : validResponse(request, window, `child-${index}`),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result.status).toBe("completed");
    expect(harness.media.materializeWindow).toHaveBeenCalledTimes(3);
    expect(
      harness.media.materializeWindow.mock.calls.map(
        ([options]) => options.descriptor.parentWindowKey,
      ),
    ).toEqual([undefined, "w000000", "w000000"]);
    const generations = harness.supervisor.beginInference.mock.calls.map(
      ([, request]) => request.requestGeneration,
    );
    expect(generations).toEqual([1, 2, 3]);
    expect(new Set(generations).size).toBe(3);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(3);
  });

  it("replays an unsplittable unstable window once with a fresh proof and temperature", async () => {
    const harness = await createHarness({
      totalFrames: 5 * 16_000,
      inference: ({ request, window, index }) =>
        index === 0
          ? repeatedResponse(request, window)
          : validResponse(request, window, "recovered"),
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.media.materializeWindow).toHaveBeenCalledTimes(2);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(
      harness.supervisor.beginInference.mock.calls.map(([, request]) => ({
        generation: request.requestGeneration,
        temperature: request.temperature,
      })),
    ).toEqual([
      { generation: 1, temperature: 0 },
      { generation: 2, temperature: 0.2 },
    ]);
  });

  it("returns actionable diagnostics when bounded quality recovery still fails", async () => {
    const harness = await createHarness({
      totalFrames: 5 * 16_000,
      inference: ({ request, window }) => repeatedResponse(request, window),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "transcript_quality_failed",
        stage: "post_processing",
        retryable: true,
        message:
          "Local transcription remained unstable after automatic quality recovery. No unreliable subtitle file was exported.",
        details: {
          summary: expect.stringContaining("quality guard"),
          lines: expect.arrayContaining([
            "reason=unsplittable",
            "automatic_quality_replays=1/1",
          ]),
          metadata: { attempt: 2, maxAttempts: 2, observed: 8 },
          truncated: false,
        },
      },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(harness.media.materializeWindow).toHaveBeenCalledTimes(2);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects a post-response PCM proof change before post-processing or export", async () => {
    const harness = await createHarness({ mutateSecondResolve: true });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "transcribing" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
  });

  it("rejects a branded window from another normalization", async () => {
    const harness = await createHarness({
      brandNormalizationId: "normalization-swapped",
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "transcribing" },
    });
    expect(harness.media.resolveWindow).not.toHaveBeenCalled();
    expect(harness.supervisor.beginInference).not.toHaveBeenCalled();
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects reuse of a branded window across retry attempts", async () => {
    const harness = await createHarness({
      totalFrames: 20 * 16_000,
      reuseWindowBrand: true,
      inference: ({ request, window }) => repeatedResponse(request, window),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_changed", stage: "transcribing" },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledOnce();
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects a stale response generation and leaves no artifact", async () => {
    const harness = await createHarness({
      inference: ({ request, window }) => ({
        processEpoch: 1,
        response: {
          ...validResponse(request, window, "stale").response,
          requestGeneration: request.requestGeneration + 1,
        },
      }),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "runtime_protocol_mismatch", stage: "transcribing" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("fails closed when retained raw text exceeds the file budget across roots", async () => {
    const harness = await createHarness({
      totalFrames: 50 * 16_000,
      retainedRawBudget: { maxSegments: 10, maxTextBytes: 20 },
      inference: ({ request, window, index }) =>
        validResponse(request, window, `rawtext${index}`),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "limit_exceeded", stage: "transcribing" },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(2);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("counts degenerate parents and retry children in one segment budget", async () => {
    const harness = await createHarness({
      totalFrames: 20 * 16_000,
      retainedRawBudget: { maxSegments: 8, maxTextBytes: 1_024 },
      inference: ({ request, window, index }) =>
        index === 0
          ? repeatedResponse(request, window)
          : validResponse(request, window, `child-${index}`),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "limit_exceeded", stage: "transcribing" },
    });
    expect(harness.supervisor.beginInference).toHaveBeenCalledTimes(2);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(2);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects runtime generation drift before acquiring a server lease", async () => {
    const harness = await createHarness({
      serverRuntimeGeneration: "c".repeat(64),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_runtime_invalid", stage: "loading_model" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.media.materializeWindow).not.toHaveBeenCalled();
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("rejects a runtime generation that changed after batch admission", async () => {
    const harness = await createHarness({
      admittedRuntimeGeneration: "c".repeat(64),
    });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "media_runtime_invalid", stage: "loading_model" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.media.materializeWindow).not.toHaveBeenCalled();
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("pins lazily after media succeeds and keeps the same pin for later tasks", async () => {
    const harness = await createHarness();
    harness.media.normalizeTask.mockRejectedValueOnce(new Error("decode failed"));

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "media_decode_failed" },
    });
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledTimes(2);
  });

  it("rejects exact server artifact drift after a batch pin is established", async () => {
    const generation = "b".repeat(64);
    const runtimeRoot = path.join(os.tmpdir(), "fusionkit-pinned-runtime-proof");
    const harness = await createHarness({
      serverRuntimeBundles: [
        fakeVerifiedServerRuntime(
          runtimeRoot,
          generation,
          path.join(runtimeRoot, "runtime", "server-a"),
        ),
        fakeVerifiedServerRuntime(
          runtimeRoot,
          generation,
          path.join(runtimeRoot, "runtime", "server-b"),
        ),
      ],
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "media_runtime_invalid", stage: "loading_model" },
    });

    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
  });

  it("releases a pin acquired after its batch runtime closes exactly once", async () => {
    const runtimePin = Object.freeze({}) as LocalSubtitleServerRuntimePin;
    let resolvePin!: (pin: LocalSubtitleServerRuntimePin) => void;
    const pendingPin = new Promise<LocalSubtitleServerRuntimePin>((resolve) => {
      resolvePin = resolve;
    });
    const harness = await createHarness({
      acquireBatchRuntimePin: () => pendingPin,
    });
    const execution = harness.executor.execute(harness.context);
    await waitFor(
      () => harness.supervisor.acquireBatchRuntimePin.mock.calls.length === 1,
    );

    harness.executor.endBatchSlice(harness.context.batchRuntime);
    resolvePin(runtimePin);

    await expect(execution).resolves.toMatchObject({
      status: "failed",
      error: { code: "owner_released", stage: "loading_model" },
    });
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledWith(runtimePin);
  });

  it("keeps a shared pending pin for a sibling when the current task is cancelled", async () => {
    const runtimePin = Object.freeze({}) as LocalSubtitleServerRuntimePin;
    let resolvePin!: (pin: LocalSubtitleServerRuntimePin) => void;
    const pendingPin = new Promise<LocalSubtitleServerRuntimePin>((resolve) => {
      resolvePin = resolve;
    });
    const harness = await createHarness({
      acquireBatchRuntimePin: () => pendingPin,
    });
    const first = harness.executor.execute(harness.context);
    await waitFor(
      () => harness.supervisor.acquireBatchRuntimePin.mock.calls.length === 1,
    );

    harness.controller.abort();

    await expect(first).resolves.toMatchObject({ status: "cancelled" });
    expect(harness.supervisor.releaseBatchRuntimePin).not.toHaveBeenCalled();
    expect(harness.supervisor.acquireBatchRuntimePin.mock.calls[0]![3]).toBe(
      harness.sliceController.signal,
    );

    resolvePin(runtimePin);
    await Promise.resolve();
    await Promise.resolve();
    const siblingController = new AbortController();
    const sibling = createContext(
      siblingController.signal,
      harness.context.admittedRuntimeGeneration,
      harness.context.batchRuntime,
      harness.context.config,
      harness.context.managedModel,
      harness.context.backendResolution,
    );

    await expect(harness.executor.execute(sibling)).resolves.toMatchObject({
      status: "completed",
    });
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledOnce();
    expect(harness.supervisor.releaseBatchRuntimePin).not.toHaveBeenCalled();

    harness.executor.endBatchSlice(harness.context.batchRuntime);
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledWith(runtimePin);
  });

  it("rejects a task after its batch runtime slice is closed", async () => {
    const harness = await createHarness();
    harness.executor.endBatchSlice(harness.context.batchRuntime);

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid_ipc_request", stage: "preflight" },
    });
    expect(harness.media.normalizeTask).not.toHaveBeenCalled();
    expect(harness.supervisor.acquireBatchRuntimePin).not.toHaveBeenCalled();
  });

  it("sanitizes Windows device names before reserving an artifact", async () => {
    const harness = await createHarness({ displayName: "CON.wav" });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "completed",
      artifactResults: [
        {
          format: "SRT",
          status: "committed",
          artifact: { displayName: "_CON.srt" },
        },
      ],
    });
  });

  it("keeps a long Windows device stem within the leaf byte limit", async () => {
    const harness = await createHarness({
      displayName: `CON.${"a".repeat(247)}.wav`,
    });

    const result = await harness.executor.execute(harness.context);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion.");
    const artifact = result.artifactResults[0];
    if (artifact?.status !== "committed") throw new Error("Expected artifact.");
    expect(artifact.artifact.displayName).toMatch(/^_CON\./u);
    expect(Buffer.byteLength(artifact.artifact.displayName, "utf8"))
      .toBeLessThanOrEqual(255);
  });

  it("cancels the active Supervisor ticket and cleans private media", async () => {
    const pending = deferred<LocalSubtitleServerSupervisorInferenceResponse>();
    const harness = await createHarness({
      beginInference: (request) => ({
        ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
        result: pending.promise,
      }),
      cancelRequest: async () => {
        pending.reject(new Error("aborted"));
      },
    });

    const execution = harness.executor.execute(harness.context);
    await waitFor(() => harness.supervisor.beginInference.mock.calls.length === 1);
    harness.controller.abort();
    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(harness.supervisor.cancelRequest).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.release).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeWindow).toHaveBeenCalledTimes(1);
    expect(harness.media.disposeNormalized).toHaveBeenCalledTimes(1);
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("promotes cancellation cleanup failure above ordinary cancellation", async () => {
    const pending = deferred<LocalSubtitleServerSupervisorInferenceResponse>();
    const harness = await createHarness({
      beginInference: () => ({
        ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
        result: pending.promise,
      }),
      cancelRequest: async () => {
        pending.reject(new Error("aborted"));
        throw new Error("native request did not settle cleanly");
      },
    });

    const execution = harness.executor.execute(harness.context);
    await waitFor(() => harness.supervisor.beginInference.mock.calls.length === 1);
    harness.controller.abort();
    const result = await execution;

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "cancel_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("blocks export when required media cleanup fails", async () => {
    const harness = await createHarness({ disposeNormalizedFailure: true });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "cleanup_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("continues normalized cleanup when Supervisor release fails", async () => {
    const harness = await createHarness({ releaseFailure: true });

    const result = await harness.executor.execute(harness.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "cleanup_failed", stage: "cleanup" },
    });
    expect(harness.supervisor.release).toHaveBeenCalledOnce();
    expect(harness.media.disposeNormalized).toHaveBeenCalledOnce();
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("keeps request generations monotonic across execute calls", async () => {
    const harness = await createHarness();

    const first = await harness.executor.execute(harness.context);
    const second = await harness.executor.execute(harness.context);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(
      harness.supervisor.beginInference.mock.calls.map(
        ([, request]) => request.requestGeneration,
      ),
    ).toEqual([1, 2]);
    expect(harness.supervisor.acquireBatchRuntimePin).toHaveBeenCalledOnce();
    expect(harness.supervisor.acquirePinnedTaskLease).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.release).toHaveBeenCalledTimes(2);
    harness.executor.endBatchSlice(harness.context.batchRuntime);
    expect(harness.supervisor.releaseBatchRuntimePin).toHaveBeenCalledOnce();
  });

  it("reports exporter cleanup failures at the cleanup stage", async () => {
    const returnedFailure = await createHarness();
    returnedFailure.exporter.exportArtifacts.mockResolvedValueOnce({
      status: "failed",
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "cancel_failed" },
      ],
    });

    await expect(returnedFailure.executor.execute(returnedFailure.context)).resolves
      .toMatchObject({
        status: "failed",
        error: { code: "cleanup_failed", stage: "cleanup" },
        artifactResults: [
          { format: "SRT", status: "failed", errorCode: "cleanup_failed" },
        ],
      });

    const thrownFailure = await createHarness();
    thrownFailure.exporter.exportArtifacts.mockRejectedValueOnce(
      Object.assign(new Error("partial cleanup failed"), {
        localSubtitleCode: "cancel_failed",
      }),
    );

    await expect(thrownFailure.executor.execute(thrownFailure.context)).resolves
      .toMatchObject({
        status: "failed",
        error: { code: "cleanup_failed", stage: "cleanup" },
      });
  });

  it.each([
    [
      ["SRT", "LRC"],
      [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
        { format: "LRC", status: "failed", errorCode: "cleanup_failed" },
      ],
    ],
    [
      ["LRC", "SRT"],
      [
        { format: "LRC", status: "failed", errorCode: "output_write_failed" },
        { format: "SRT", status: "failed", errorCode: "cleanup_failed" },
      ],
    ],
  ] as const)(
    "prioritizes a later cleanup failure for %j",
    async (formats, artifactResults) => {
      const harness = await createHarness({ formats });
      harness.exporter.exportArtifacts.mockResolvedValueOnce({
        status: "failed",
        artifactResults,
      });

      await expect(harness.executor.execute(harness.context)).resolves
        .toMatchObject({
          status: "failed",
          error: { code: "cleanup_failed", stage: "cleanup" },
          artifactResults,
        });
    },
  );

  it("normalizes every cleanup artifact when cancellation wins", async () => {
    const harness = await createHarness({ formats: ["SRT", "LRC"] });
    harness.exporter.exportArtifacts.mockImplementationOnce(async () => {
      harness.controller.abort();
      return {
        status: "failed",
        artifactResults: [
          { format: "SRT", status: "failed", errorCode: "output_write_failed" },
          { format: "LRC", status: "failed", errorCode: "cleanup_failed" },
        ],
      };
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "cancel_failed", stage: "cleanup" },
      artifactResults: [
        { format: "SRT", status: "failed", errorCode: "output_write_failed" },
        { format: "LRC", status: "failed", errorCode: "cancel_failed" },
      ],
    });
  });

  it("maps a non-cancel pipeline cleanup failure to cleanup_failed", async () => {
    const harness = await createHarness({
      normalizeFailure: Object.assign(new Error("media cleanup failed"), {
        localSubtitleCode: "cancel_failed",
      }),
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "cleanup_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });

  it("maps an aborted pipeline cleanup failure to cancel_failed", async () => {
    const harness = await createHarness();
    harness.media.normalizeTask.mockImplementationOnce(async () => {
      harness.controller.abort();
      throw Object.assign(new Error("media cleanup failed after abort"), {
        localSubtitleCode: "cleanup_failed",
      });
    });

    await expect(harness.executor.execute(harness.context)).resolves.toMatchObject({
      status: "failed",
      error: { code: "cancel_failed", stage: "cleanup" },
    });
    expect(harness.exporter.exportArtifacts).not.toHaveBeenCalled();
  });
});

interface HarnessOptions {
  readonly modelId?: string;
  readonly quietAudioGainDb?: number;
  readonly backend?: "cpu" | "cuda" | "metal";
  readonly acceleratorPack?: LocalSubtitleVerifiedAcceleratorPack;
  readonly totalFrames?: number;
  readonly displayName?: string;
  readonly brandNormalizationId?: string;
  readonly reuseWindowBrand?: boolean;
  readonly serverRuntimeGeneration?: string;
  readonly serverRuntimeBundles?: readonly LocalSubtitleVerifiedRuntimeBundle[];
  readonly admittedRuntimeGeneration?: string;
  readonly mutateSecondResolve?: boolean;
  readonly disposeNormalizedFailure?: boolean;
  readonly releaseFailure?: boolean;
  readonly acquireBatchRuntimePin?: () => Promise<LocalSubtitleServerRuntimePin>;
  readonly normalizeFailure?: unknown;
  readonly outputMode?: "custom" | "source";
  readonly conflictPolicy?: LocalSubtitleConflictPolicy;
  readonly formats?: readonly LocalSubtitleFormat[];
  readonly postAction?: LocalSubtitleBatchConfigSnapshot["postAction"];
  readonly taskMode?: LocalSubtitleBatchConfigSnapshot["taskMode"];
  readonly initialPrompt?: string;
  readonly vadEnabled?: boolean;
  readonly failArtifactReserveFormat?: LocalSubtitleFormat;
  readonly abortAfterArtifactFormat?: LocalSubtitleFormat;
  readonly exporterDependencies?: (
    controller: AbortController,
  ) => LocalSubtitleExporterDependencies;
  readonly retainedRawBudget?: Readonly<{
    maxSegments: number;
    maxTextBytes: number;
  }>;
  readonly inference?: (input: {
    readonly request: LocalSubtitleServerInferenceRequest;
    readonly window: LocalSubtitleMediaStructuralWindow;
    readonly index: number;
  }) => LocalSubtitleServerSupervisorInferenceResponse;
  readonly beginInference?: (
    request: LocalSubtitleServerInferenceRequest,
  ) => LocalSubtitleServerInferenceOperation;
  readonly cancelRequest?: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "fusionkit-production-executor-")),
  );
  tempRoots.push(root);
  const outputRoot = path.join(root, "output");
  await mkdir(outputRoot);
  const controller = new AbortController();
  const sliceController = new AbortController();
  const totalFrames = options.totalFrames ?? 10 * 16_000;
  const normalized: LocalSubtitleNormalizedPcm = Object.freeze({
    schemaVersion: 1,
    normalizationId: "normalization-1",
    taskId: "task-1",
    taskGeneration: 1,
    displayName: options.displayName ?? "meeting.wav",
    runtimeGeneration: "b".repeat(64),
    selectedStreamId: "stream-1",
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
    totalFrames,
    durationMs: Math.round((totalFrames * 1_000) / 16_000),
    dataSizeBytes: totalFrames * 2,
  });
  const windowByPath = new Map<string, LocalSubtitleMediaStructuralWindow>();
  const resolveCount = new Map<string, number>();
  let nextWindow = 0;
  let firstBrand: LocalSubtitleBrandedPcmWindow | undefined;
  const media = {
    readPrefixSamples: vi.fn(async (_normalized: LocalSubtitleNormalizedPcm, frameCount: number, _signal?: AbortSignal) => new Int16Array(frameCount)),
    normalizeTask: vi.fn(async (request: {
      taskId: string;
      taskGeneration: number;
      onProgress?: (value: number) => void;
    }) => {
      if (options.normalizeFailure !== undefined) throw options.normalizeFailure;
      request.onProgress?.(100);
      return deepFreeze({
        ...normalized,
        normalizationId:
          request.taskId === "task-1"
            ? normalized.normalizationId
            : `normalization-${request.taskId}`,
        taskId: request.taskId,
        taskGeneration: request.taskGeneration,
      });
    }),
    materializeWindow: vi.fn(async (request: {
      conditionQuietAudio?: boolean;
      normalized: LocalSubtitleNormalizedPcm;
      descriptor: LocalSubtitleMediaStructuralWindow;
    }) => {
      if (options.reuseWindowBrand && firstBrand) return firstBrand;
      const windowId = `window-${++nextWindow}`;
      const byteSize = 44 + (request.descriptor.endFrame - request.descriptor.startFrame) * 2;
      const brand = deepFreeze({
        schemaVersion: 1 as const,
        windowId,
        normalizationId:
          options.brandNormalizationId ?? request.normalized.normalizationId,
        taskId: request.normalized.taskId,
        taskGeneration: request.normalized.taskGeneration,
        descriptor: request.descriptor,
        frameCount: request.descriptor.endFrame - request.descriptor.startFrame,
        durationMs: request.descriptor.endMs - request.descriptor.startMs,
        byteSize,
        sha256: WINDOW_HASH,
        ...(request.conditionQuietAudio && options.quietAudioGainDb !== undefined ? {quietAudioGainDb: options.quietAudioGainDb} : {}),
      });
      firstBrand = brand;
      windowByPath.set(path.join(root, `${windowId}.wav`), request.descriptor);
      return brand;
    }),
    resolveWindow: vi.fn(async (brand: LocalSubtitleBrandedPcmWindow) => {
      const filePath = path.join(root, `${brand.windowId}.wav`);
      const count = (resolveCount.get(brand.windowId) ?? 0) + 1;
      resolveCount.set(brand.windowId, count);
      return Object.freeze({
        filePath,
        fileIdentity: Object.freeze({
          objectIdentity: Object.freeze({
            dev: 1,
            ino: nextWindow,
            birthtimeMs: 1,
          }),
          size: brand.byteSize,
          mtimeMs: 10,
          ctimeMs: 10,
        }),
        byteSize: brand.byteSize,
        ...(brand.quietAudioGainDb === undefined ? {} : {quietAudioGainDb: brand.quietAudioGainDb}),
        sha256:
          options.mutateSecondResolve && count === 2
            ? "c".repeat(64)
            : brand.sha256,
      }) as LocalSubtitleResolvedPcmWindow;
    }),
    disposeWindow: vi.fn(async () => ({ removed: true })),
    disposeNormalized: vi.fn(async () => {
      if (options.disposeNormalizedFailure) throw new Error("cleanup failed");
      return { removed: true };
    }),
  };
  let inferenceIndex = 0;
  const lease = Object.freeze({}) as LocalSubtitleServerLease;
  const runtimePin = Object.freeze({}) as LocalSubtitleServerRuntimePin;
  const supervisor = {
    acquireBatchRuntimePin: vi.fn(
      options.acquireBatchRuntimePin ?? (async () => runtimePin),
    ),
    acquirePinnedTaskLease: vi.fn(async () => lease),
    acquirePinnedSeparatorLease: vi.fn(async () => lease),
    beginInference: vi.fn((
      _lease: LocalSubtitleServerLease,
      request: LocalSubtitleServerInferenceRequest,
    ) => {
      if (options.beginInference) return options.beginInference(request);
      const window = windowByPath.get(request.filePath);
      if (!window) throw new Error("Missing fake window descriptor.");
      const result = options.inference?.({
        request,
        window,
        index: inferenceIndex++,
      }) ?? validResponse(request, window, `cue-${inferenceIndex++}`);
      return Object.freeze({
        ticket: Object.freeze({}) as LocalSubtitleServerRequestTicket,
        result: Promise.resolve(result),
      });
    }),
    cancelRequest: vi.fn(async () => options.cancelRequest?.()),
    release: vi.fn(async () => {
      if (options.releaseFailure) throw new Error("server release failed");
    }),
    releaseBatchRuntimePin: vi.fn(() => undefined),
  };
  const artifacts = new LocalSubtitleArtifactRegistry({
    tokenFactory: sequence("artifact"),
    reservationFactory: sequence("reservation"),
  });
  const exporterArtifacts = {
    reserve: (request: Parameters<typeof artifacts.reserve>[0]) => {
      if (request.format === options.failArtifactReserveFormat) {
        throw new Error("artifact reservation failed");
      }
      return artifacts.reserve(request);
    },
    activate: (...args: Parameters<typeof artifacts.activate>) => {
      const summary = artifacts.activate(...args);
      if (summary.format === options.abortAfterArtifactFormat) {
        controller.abort();
      }
      return summary;
    },
    revokeReservation: (reservation: string) =>
      artifacts.revokeReservation(reservation),
    revokeArtifact: (...args: Parameters<typeof artifacts.revokeArtifact>) =>
      artifacts.revokeArtifact(...args),
  };
  const realExporter = new LocalSubtitleExporter(exporterArtifacts, {
    ...options.exporterDependencies?.(controller),
    createPartialId: sequence("partial"),
  });
  const exporter = {
    exportArtifacts: vi.fn(realExporter.exportArtifacts.bind(realExporter)),
    supportsConflictPolicy: vi.fn(
      realExporter.supportsConflictPolicy.bind(realExporter),
    ),
  };
  const outputs = {
    resolveBatchLease: vi.fn(async () => resolvedOutputDirectory(outputRoot)),
  };
  const inputs = {
    resolveTaskSourceOutputDirectory: vi.fn(async () =>
      resolvedOutputDirectory(outputRoot),
    ),
  };
  const defaultServerRuntime = fakeVerifiedServerRuntime(
    root,
    options.serverRuntimeGeneration ?? normalized.runtimeGeneration,
    options.backend === "cuda",
  );
  let serverRuntimeIndex = 0;
  const resolveCudaAccelerator = vi.fn(async () => {
    if (!options.acceleratorPack) throw new Error("Missing CUDA accelerator fixture.");
    return options.acceleratorPack;
  });
  const executor = new LocalSubtitleProductionExecutor({
    media,
    supervisor,
    inputs,
    outputs,
    exporter,
    verifyServerRuntime: async () => {
      const configured = options.serverRuntimeBundles;
      if (!configured || configured.length === 0) return defaultServerRuntime;
      const runtime = configured[Math.min(serverRuntimeIndex, configured.length - 1)]!;
      serverRuntimeIndex += 1;
      return runtime;
    },
    ...(options.backend === "cuda" ? { resolveCudaAccelerator } : {}),
    validateWindowBrand: () => true,
    rootPlanIdFactory: () => "root-plan-1",
    cpuThreads: 2,
    ...(options.retainedRawBudget === undefined
      ? {}
      : { retainedRawBudget: options.retainedRawBudget }),
  });
  const admittedRuntimeGeneration =
    options.admittedRuntimeGeneration ?? normalized.runtimeGeneration;
  const config = createConfig(
    options.outputMode ?? "custom",
    options.conflictPolicy ?? "index",
    options.formats ?? ["SRT"],
    options.backend ?? "cpu",
    options.postAction,
    options.vadEnabled === true,
    options.taskMode,
    options.initialPrompt,
    options.modelId,
  );
  const managedModel = Object.freeze({
    storage: "managed" as const,
    id: options.modelId ?? LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    absolutePath: path.join(os.tmpdir(), "managed-model.bin"),
    byteSize: 1024,
    sha256: MODEL_HASH,
  });
  const managedVad = options.vadEnabled === true
    ? Object.freeze({
        storage: "managed" as const,
        id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        absolutePath: path.join(os.tmpdir(), "managed-vad.bin"),
        byteSize: 885_098,
        sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
      })
    : undefined;
  const backendResolution = await new LocalSubtitleBackendResolver({
    verifyServerRuntime: async () =>
      options.serverRuntimeBundles?.[0] ??
      fakeVerifiedServerRuntime(
        root,
        admittedRuntimeGeneration,
        options.backend === "cuda",
      ),
    selectCpuServerArtifact: (runtime) =>
      runtime.artifactPaths["whisper-server-cpu"]!,
    selectMetalServerArtifact: (runtime) =>
      runtime.artifactPaths["whisper-server-cpu"]!,
    metalAttestationAvailable: options.backend === "metal",
    cudaAttestationAvailable: options.backend === "cuda",
    ...(options.backend === "cuda" ? { resolveCudaAccelerator } : {}),
  }).resolveBackend({
    devicePreference: config.devicePreference,
    admittedRuntimeGeneration,
    model: managedModel,
  });
  const batchRuntime = executor.beginBatchSlice(Object.freeze({
    owner: OWNER,
    batchId: "batch-1",
    config,
    managedModel,
    ...(managedVad === undefined ? {} : { managedVad }),
    admittedRuntimeGeneration,
    backendResolution,
    signal: sliceController.signal,
  }));
  const context = createContext(
    controller.signal,
    admittedRuntimeGeneration,
    batchRuntime,
    config,
    managedModel,
    backendResolution,
    { taskId: "task-1", fileToken: "file-token-1" },
    managedVad,
  );
  return {
    root,
    outputRoot,
    controller,
    sliceController,
    context,
    executor,
    media,
    supervisor,
    inputs,
    outputs,
    exporter,
    artifacts,
    managedVad,
    resolveCudaAccelerator,
  };
}

function fakeVerifiedServerRuntime(
  root: string,
  runtimeGeneration: string,
  windowsOrServerPath: boolean | string = false,
): LocalSubtitleVerifiedRuntimeBundle {
  const windows = typeof windowsOrServerPath === "boolean"
    ? windowsOrServerPath
    : false;
  const serverAbsolutePath = typeof windowsOrServerPath === "string"
    ? windowsOrServerPath
    : path.join(
        root,
        "runtime",
        windows ? "whisper-server.exe" : "whisper-server",
      );
  return deepFreeze({
    schemaVersion: 1 as const,
    target: {
      platform: windows ? "win32" as const : "darwin" as const,
      arch: windows ? "x64" as const : "arm64" as const,
    },
    scope: "server" as const,
    root: path.join(root, "runtime"),
    manifestPath: path.join(root, "runtime", "manifest.json"),
    manifestSha256: runtimeGeneration,
    runtimeGeneration,
    integrityProfile: "development" as const,
    artifactPaths: {
      "whisper-server-cpu": {
        id: "whisper-server-cpu",
        kind: "server" as const,
        backend: windows ? "cpu" as const : "metal_cpu" as const,
        absolutePath: serverAbsolutePath,
        byteSize: 1024,
        sha256: "d".repeat(64),
        version: "1.9.1+b1ade71",
        signatureKind: "unsigned" as const,
      },
    },
    evidenceFileCount: 1,
    noPathFallback: true as const,
    ready: true as const,
  }) as LocalSubtitleVerifiedRuntimeBundle;
}

function createContext(
  signal: AbortSignal,
  admittedRuntimeGeneration: string,
  batchRuntime: LocalSubtitleJobBatchRuntime,
  config: LocalSubtitleBatchConfigSnapshot,
  managedModel: LocalSubtitleJobTaskExecutionContext["managedModel"],
  backendResolution: LocalSubtitleVerifiedBackendResolution,
  identity: Readonly<{
    taskId: string;
    fileToken: string;
  }> = { taskId: "task-1", fileToken: "file-token-1" },
  managedVad?: LocalSubtitleJobTaskExecutionContext["managedVad"],
) {
  const update = vi.fn(() => ({} as LocalSubtitleTaskSummary));
  return Object.freeze({
    owner: OWNER,
    batchId: "batch-1",
    taskId: identity.taskId,
    generation: 1,
    fileToken: identity.fileToken,
    config,
    managedModel,
    ...(managedVad === undefined ? {} : { managedVad }),
    admittedRuntimeGeneration,
    backendResolution,
    batchRuntime,
    signal,
    update,
  }) as LocalSubtitleJobTaskExecutionContext & { readonly update: typeof update };
}

function createConfig(
  outputMode: "custom" | "source" = "custom",
  conflictPolicy: "index" | "overwrite" = "index",
  formats: readonly LocalSubtitleFormat[] = ["SRT"],
  resolvedBackend: "cpu" | "cuda" | "metal" = "cpu",
  postAction: LocalSubtitleBatchConfigSnapshot["postAction"] = {
    mode: "export_only",
  },
  vadEnabled = false,
  taskMode: LocalSubtitleBatchConfigSnapshot["taskMode"] = "transcribe",
  initialPrompt?: string,
  modelId: string = LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
): LocalSubtitleBatchConfigSnapshot {
  return createLocalSubtitleBatchConfigSnapshot({
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    serverHttpContractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    snapshotId: "snapshot-1",
    createdAt: "2026-07-22T00:00:00.000Z",
    model: {
      engine: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.id,
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId,
      modelHash: MODEL_HASH,
    },
    devicePreference: "auto",
    resolvedBackend,
    language: "auto",
    taskMode,
    inference: {
      advanced: {
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        beamSize: 5,
        temperature: 0,
        vadMinSilenceMs: 500,
        maxCueDurationMs: 7_000,
        maxCueChars: 84,
        maxLineChars: 42,
      },
      vad: {
        enabled: vadEnabled,
        modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        tokenTimestamps: false,
        timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy,
      },
      rawQualityGate: {
        maxSegmentDurationMs:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
        repeatedCueThreshold:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
        repeatedCoverageMs:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
        maxRetryDepth:
          LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
      },
    },
    output: outputMode === "source"
      ? {
          mode: "source",
          formats: [...formats],
          conflictPolicy,
        }
      : {
          mode: "custom",
          formats: [...formats],
          conflictPolicy,
          directoryLeaseRef: "batch-1",
          displayLabel: "output",
        },
    postAction,
  });
}

async function resolvedOutputDirectory(directoryPath: string) {
  const identity =
    await localSubtitleFilesystemObjectIdentityForPath(directoryPath);
  return Object.freeze({
    directoryPath,
    directoryName: path.basename(directoryPath),
    identity,
    expiresAt: Date.now() + 60_000,
  });
}

function validResponse(
  request: LocalSubtitleServerInferenceRequest,
  window: LocalSubtitleMediaStructuralWindow,
  text: string,
): LocalSubtitleServerSupervisorInferenceResponse {
  const durationMs = window.endMs - window.startMs;
  const endMs = Math.min(durationMs, 3_000);
  const startMs = Math.min(1_000, Math.max(0, endMs - 1_000));
  return {
    processEpoch: 1,
    response: serverResponse(request, durationMs, [
      rawSegment(0, startMs, endMs, text),
    ]),
  };
}

function repeatedResponse(
  request: LocalSubtitleServerInferenceRequest,
  window: LocalSubtitleMediaStructuralWindow,
): LocalSubtitleServerSupervisorInferenceResponse {
  const durationMs = window.endMs - window.startMs;
  return {
    processEpoch: 1,
    response: serverResponse(
      request,
      durationMs,
      Array.from({ length: 8 }, (_, index) =>
        rawSegment(index, index * 2_000, index * 2_000 + 2_000, "repeat"),
      ),
    ),
  };
}

function serverResponse(
  request: LocalSubtitleServerInferenceRequest,
  durationMs: number,
  segments: LocalSubtitleServerInferenceResponse["result"]["segments"],
): LocalSubtitleServerInferenceResponse {
  return {
    requestGeneration: request.requestGeneration,
    sessionDisposition: "reusable",
    result: {
      contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
      task: request.taskMode === "translate_to_english"
        ? "translate"
        : "transcribe",
      language: "en",
      durationMs,
      text: segments.map((segment) => segment.text).join(" "),
      segments,
      wordTimelineStatus: request.vadEnabled
        ? "discarded_vad_compressed_timeline"
        : "not_requested",
    },
  };
}

function rawSegment(
  id: number,
  startMs: number,
  endMs: number,
  text: string,
) {
  return {
    id,
    startMs,
    endMs,
    text,
    temperature: 0,
    averageLogProbability: -0.2,
    noSpeechProbability: 0.01,
  };
}

function sequence(prefix: string) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the production executor.");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
