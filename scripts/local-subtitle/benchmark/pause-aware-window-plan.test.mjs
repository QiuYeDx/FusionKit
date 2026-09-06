import test from 'node:test';import assert from 'node:assert/strict';
import {findAcousticQuietCandidates,planPauseAwareWindows} from './pause-aware-window-plan.mjs';
const frames = seconds => seconds * 16000;
const check = plan => { let end = 0; for (const w of plan.windows) { assert.equal(w.coreStartFrame, end); assert.ok(w.startFrame <= w.coreStartFrame && w.coreStartFrame < w.coreEndFrame && w.coreEndFrame <= w.endFrame); assert.ok(w.endFrame - w.startFrame <= frames(30)); end = w.coreEndFrame; } assert.equal(end, plan.totalFrames); };
test('continuous input retains fixed overlap geometry and complete sample coverage',()=>{
  const p=planPauseAwareWindows(frames(77)+13,[]);check(p);
  assert.deepEqual(p.windows.map(w=>[w.startFrame/16000,w.endFrame/16000]),[[0,30],[25,55],[50,77+13/16000]]);
});
test('quiet cut retains 300ms on each side and reduces overlaps',()=>{
  const candidates=[{startFrame:frames(24.4),endFrame:frames(25.6)}];const p=planPauseAwareWindows(frames(65),candidates);check(p);
  assert.equal(p.windows[0].endFrame,frames(25));assert.equal(p.windows[1].startFrame,frames(25));assert.equal(p.windows[1].reason,'overlap_fallback');
  assert.deepEqual(planPauseAwareWindows(frames(65),candidates),p);
});
test('near-limit pause cannot create an overlong block or omit final fractional frame',()=>{
  const p=planPauseAwareWindows(frames(70)+1,[{startFrame:frames(28.8),endFrame:frames(30)}]);check(p);assert.equal(p.windows[0].reason,'overlap_fallback');
});
test('full silence keeps original duration instead of concatenating speech',()=>{
  const pcm=Buffer.alloc(frames(65)*2),c=findAcousticQuietCandidates(pcm);assert.equal(c.length,1);const p=planPauseAwareWindows(pcm.length/2,c);check(p);assert.ok(p.windows.every(w=>w.reason!=='overlap_fallback'));
});
test('peak and RMS must both pass; a short quiet gap is not a candidate',()=>{
  const pcm=Buffer.alloc(frames(2)*2);for(let i=0;i<frames(2);i++)pcm.writeInt16LE(300,i*2);
  pcm.fill(0,0,frames(.5)*2);assert.deepEqual(findAcousticQuietCandidates(pcm),[]);
  pcm.fill(0,0,frames(1)*2);assert.deepEqual(findAcousticQuietCandidates(pcm),[{startFrame:0,endFrame:frames(1)}]);
  for(let i=0;i<frames(1);i+=160)pcm.writeInt16LE(-220,i*2);assert.deepEqual(findAcousticQuietCandidates(pcm),[]);
});
test('invalid or unordered input fails rather than producing gaps',()=>{
  assert.throws(()=>findAcousticQuietCandidates(Buffer.alloc(3)));assert.throws(()=>planPauseAwareWindows(0,[]));
  assert.throws(()=>planPauseAwareWindows(frames(40),[{startFrame:frames(20),endFrame:frames(21)},{startFrame:0,endFrame:frames(1)}]));
});
