import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonText, summarizeWindowStability } from './window-stability.mjs';

function experiment() {
  return {
    windows: [
      {id:'a',group:'g',clipId:'clip',startMs:1000,endMs:6000},
      {id:'b',group:'g',clipId:'clip',startMs:2000,endMs:7000},
    ], variants:[{id:'vad'}], results:[
      {window:'a',variant:'vad',segments:[{text:'テスト。',localStartMs:2000,localEndMs:3000}]},
      {window:'b',variant:'vad',segments:[{text:'テスト',localStartMs:1000,localEndMs:2300}]},
    ],
  };
}

test('comparison removes punctuation but preserves lexical kana differences and repeats',()=>{
  assert.equal(comparisonText(' テスト、です。'),'テストです');
  assert.notEqual(comparisonText('テスト'),comparisonText('てすと'));
  assert.notEqual(comparisonText('test test'),comparisonText('test'));
});

test('matching wrong words remain unverified; map origin and report timing spread',()=>{
  const input=experiment();
  input.results[0].segments[0].clipStartMs=999999;
  const result=summarizeWindowStability(input)[0];
  assert.equal(result.textStatus,'agrees_unverified');
  assert.equal(result.acousticTruth,'unverified');
  assert.equal(result.automaticReplacementAllowed,false);
  assert.equal(result.matchingCues[0].startSpreadMs,0);
  assert.equal(result.matchingCues[0].endSpreadMs,300);
  assert.equal(result.matchingCues[0].entries[0].clipStartMs,3000);
});

test('empty outputs never prove silence; mixed empty and text differ',()=>{
  const input=experiment();
  input.results[0].segments=[];
  assert.equal(summarizeWindowStability(input)[0].textStatus,'differs');
  input.results[1].segments=[];
  const result=summarizeWindowStability(input)[0];
  assert.equal(result.textStatus,'all_empty_unverified');
  assert.equal(result.automaticReplacementAllowed,false);
});

test('preserve native overrun as evidence instead of clamping or failing the report',()=>{
  const input=experiment();
  input.results[0].segments[0].localEndMs=5020;
  const result=summarizeWindowStability(input)[0];
  assert.equal(result.invalidBoundsCount,1);
  assert.equal(result.rows[0].segments[0].clipEndMs,6020);
});

test('duplicate cues in one window do not count as independent agreement',()=>{
  const input=experiment();
  input.results[0].segments.push({...input.results[0].segments[0]});
  input.results[1].segments=[];
  const match=summarizeWindowStability(input)[0].matchingCues[0];
  assert.equal(match.distinctWindows,1);
  assert.equal(match.repeatedWithinWindow,true);
});

test('reject incomplete, duplicate, mixed-clip or non-overlapping comparisons and invalid numbers',()=>{
  const missing=experiment(); missing.results.pop();
  assert.throws(()=>summarizeWindowStability(missing),/Incomplete/);
  const duplicate=experiment(); duplicate.results.push(duplicate.results[0]);
  assert.throws(()=>summarizeWindowStability(duplicate),/duplicate/);
  const mixed=experiment(); mixed.windows[1].clipId='other';
  assert.throws(()=>summarizeWindowStability(mixed),/share a clip/);
  const disjoint=experiment(); disjoint.windows[1].startMs=6000;
  assert.throws(()=>summarizeWindowStability(disjoint),/overlap/);
  const invalid=experiment(); invalid.results[0].segments[0].localEndMs=NaN;
  assert.throws(()=>summarizeWindowStability(invalid),/Non-finite/);
});
