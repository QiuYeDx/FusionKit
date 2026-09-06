import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyStageAnnotations,validateStageAnnotations,validateStageReview,activeStageCues} from './stage-listening-contract.mjs';
import {parseStageSrt,parseStageLrc} from './build-stage-listening.mjs';
const hash='a'.repeat(64);
const review=()=>({schema:'fusionkit-stage-review-v1',reviewId:hash,tracks:[{id:'sample',durationMs:10000,sourceStartMs:0,audioSha256:hash,subtitleSha256:hash,cues:[{startMs:0,endMs:500,text:'はい'},{startMs:1000,endMs:1500,text:'はい'}],bookmarks:[]}]});
test('historical approval never preselects the new whole-track judgment',()=>{
 const data=review();data.tracks[0].bookmarks=[{startMs:1000,label:'Previously accepted',history:'Local timing only'}];
 const result=emptyStageAnnotations(data);assert.ok(Object.values(result.tracks[0].judgments).every(v=>v==='unreviewed'));assert.equal(validateStageAnnotations(result,data).tracks[0].issues.length,0);
});
test('binds annotations to media, subtitles, track order, duration and package identity',()=>{
 for(const [key,value]of [['id','wrong'],['audioSha256','b'.repeat(64)],['subtitleSha256','b'.repeat(64)],['durationMs',9999],['sourceStartMs',100]]){
  const data=review(),report=emptyStageAnnotations(data);report.tracks[0][key]=value;assert.throws(()=>validateStageAnnotations(report,data));
 }
 const data=review(),report=emptyStageAnnotations(data);report.reviewId='c'.repeat(64);assert.throws(()=>validateStageAnnotations(report,data));
});
test('retains incomplete and uncertain answers without claiming all accepted',()=>{
 const data=review(),report=emptyStageAnnotations(data);report.tracks[0].judgments.timing='uncertain';report.tracks[0].note='尾音可能来自前文，不代表精确界点';report.tracks[0].issues=[{atMs:900,note:'大致位置'}];
 assert.deepEqual(validateStageAnnotations(report,data),report);
});
test('rejects bad answers, out-of-range marks and playback promoted to heard evidence',()=>{
 const data=review();for(const mutate of [r=>r.tracks[0].judgments.timing='accepted_automatically',r=>r.tracks[0].note='x'.repeat(4001),r=>r.tracks[0].issues=[{atMs:10001,note:''}],r=>r.tracks[0].issues=[{atMs:-1,note:''}],r=>r.tracks[0].history=[{kind:'play_request',evidence:'heard_all',atMs:0,rate:1,recordedAt:new Date().toISOString()}]]){const report=emptyStageAnnotations(data);mutate(report);assert.throws(()=>validateStageAnnotations(report,data));}
});
test('sanitizes arbitrary annotation fields and keeps interaction-only history',()=>{
 const data=review(),report=emptyStageAnnotations(data);report.tracks[0].secret='discard';report.tracks[0].history=[{kind:'seek',evidence:'interaction_only',atMs:250,rate:.8,recordedAt:new Date().toISOString(),extra:'discard'}];const parsed=validateStageAnnotations(report,data);assert.equal(parsed.tracks[0].secret,undefined);assert.equal(parsed.tracks[0].history[0].extra,undefined);
});
test('preserves real repeats, silence gaps and simultaneous active cues',()=>{
 const cues=review().tracks[0].cues;assert.deepEqual(activeStageCues(cues,500),[]);assert.deepEqual(activeStageCues(cues,1000),[1]);assert.deepEqual(activeStageCues([...cues,{startMs:1000,endMs:1500,text:'別の字幕'}],1200),[1,2]);
});
test('reads SRT ends and multiline text; LRC never acquires invented ends',()=>{
 assert.deepEqual(parseStageSrt('1\n00:00:00,000 --> 00:00:01,000\nA\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA'),[{startMs:0,endMs:1000,text:'A\nB'},{startMs:1000,endMs:2000,text:'A'}]);
 assert.deepEqual(parseStageLrc('[00:01.00]はい\n[00:01.00]はい'),[{startMs:1000,text:'はい'},{startMs:1000,text:'はい'}]);assert.throws(()=>parseStageSrt('malformed'));
});
test('rejects missing identity, duplicate tracks and invalid cue times',()=>{
 for(const mutate of [d=>d.tracks.push(d.tracks[0]),d=>d.tracks[0].cues[0].endMs=20000,d=>d.tracks[0].audioSha256='',d=>d.tracks[0].cues[1].startMs=-1]){const data=review();mutate(data);assert.throws(()=>validateStageReview(data));}
});
