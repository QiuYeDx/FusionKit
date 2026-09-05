import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildListeningReview, summarizeReviewWav, validateReviewRegions, importReviewAnnotations } from './build-listening-review.mjs';

function wav() {
  const buffer=Buffer.alloc(44+3200);
  buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(3200,40);
  buffer.writeInt16LE(-32768,44);buffer.writeInt16LE(16384,46);
  return buffer;
}

test('reads PCM duration and bipolar waveform peaks without changing sample data',()=>{
  const input=wav();const copy=Buffer.from(input);
  const summary=summarizeReviewWav(input,4);
  assert.equal(summary.durationMs,100);assert.equal(summary.peaks[0],1);assert.equal(summary.peaks.length,4);
  assert.deepEqual(input,copy);
});
test('rejects unsupported/truncated audio and invalid region provenance',()=>{
  const unsupported=wav();unsupported.writeUInt16LE(2,22);
  assert.throws(()=>summarizeReviewWav(unsupported));assert.throws(()=>summarizeReviewWav(wav().subarray(0,100)));
  const clips=[{id:'A',durationMs:100}];
  assert.throws(()=>validateReviewRegions([],clips));
  assert.throws(()=>validateReviewRegions([{id:'r',clipId:'A',startMs:90,endMs:120,reason:'candidate'}],clips));
  assert.throws(()=>validateReviewRegions([{id:'r',clipId:'missing',startMs:0,endMs:90,reason:'candidate'}],clips));
});
test('imports legacy judgments without inventing playback history and validates provenance',()=>{
  const clips=[{id:'C',sha256:'a'.repeat(64),sourceStartMs:660000,durationMs:30000}];
  const regions=[{id:'tail',clipId:'C',startMs:20150,endMs:20840,reason:'mixed tail and sound'}];
  const report={schemaVersion:1,datasetId:'dataset',clips,regions:[{...regions[0],verdict:'non_speech',note:'tail of previous word, then sound'}]};
  const copy=structuredClone(report);
  const annotations=importReviewAnnotations(report,'dataset',clips,regions);
  assert.deepEqual(annotations.tail,{verdict:'non_speech',note:report.regions[0].note,lastPlaybackRequest:null});
  assert.deepEqual(report,copy);
  assert.throws(()=>importReviewAnnotations({...report,datasetId:'other'},'dataset',clips,regions),/dataset mismatch/);
  assert.throws(()=>importReviewAnnotations({...report,clips:[{...clips[0],sha256:'b'.repeat(64)}]},'dataset',clips,regions),/clip mismatch/);
  assert.throws(()=>importReviewAnnotations({...report,regions:[{...report.regions[0],startMs:19000}]},'dataset',clips,regions),/Invalid annotation/);
  const request={evidence:'playback_request_only',paddingMs:1000,rate:1,startMs:19150,endMs:21840,status:'started',requestedAt:'2026-09-05T00:00:00.000Z'};
  const current={...report,schemaVersion:2,regions:[{...report.regions[0],lastPlaybackRequest:request}]};
  assert.deepEqual(importReviewAnnotations(current,'dataset',clips,regions).tail.lastPlaybackRequest,request);
  assert.throws(()=>importReviewAnnotations({...current,regions:[{...current.regions[0],lastPlaybackRequest:{...request,startMs:20150}}]},'dataset',clips,regions),/Invalid playback/);
});
test('builds an offline, source-path-free review package and escapes embedded labels',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusionkit-review-'));
  try{
    const file=path.join(root,'private-name.wav');await fs.writeFile(file,wav());
    const reason='candidate $& $` </script><script>invalid</script>';
    const manifest={clips:[{id:'A',file,sourceStartMs:30000}],regions:[{id:'r',clipId:'A',startMs:0,endMs:90,reason}]};
    const output=path.join(root,'review.html');const result=await buildListeningReview(manifest,output);
    const html=await fs.readFile(output,'utf8');
    assert.equal(result.regionCount,1);assert.ok(html.includes('data:audio/wav;base64,'));assert.ok(!html.includes(file));assert.ok(!html.includes('private-name.wav'));assert.ok(!html.includes(reason));
    const json=html.match(/const data = ([\s\S]*?);\nconst storageKey/)[1];
    assert.equal(JSON.parse(json).regions[0].reason,reason);
    // Syntax-only check; this does not execute the page or stand in for browser UI acceptance.
    assert.doesNotThrow(()=>new vm.Script(html.match(/<script>\n([\s\S]*?)\n<\/script>/)[1]));
    assert.match(JSON.parse(json).clips[0].sha256,/^[a-f0-9]{64}$/);
    await assert.rejects(()=>buildListeningReview(manifest,file),/Output cannot replace/);
    assert.deepEqual(await fs.readFile(file),wav());
    const changed=await buildListeningReview({...manifest,regions:[{...manifest.regions[0],endMs:80}]},output);
    assert.notEqual(changed.datasetId,result.datasetId);
  }finally{
    const relative=path.relative(os.tmpdir(),root);
    assert.ok(relative.startsWith('fusionkit-review-')&&!relative.includes(path.sep));
    await fs.rm(root,{recursive:true,force:true});
  }
});
