import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSpeechCoverage } from './speech-coverage-diagnostics.mjs';
const interval = (startMs,endMs) => ({startMs,endMs});
test('one raw cue can cover every detector candidate while bridging a twenty-second gap', () => {
 const result=diagnoseSpeechCoverage({durationMs:30000,segments:[interval(3840,25340)],evidence:{source:'silero-v6.2.0/current',intervals:[interval(3840,4540),interval(24740,25340)]}});
 assert.equal(result.candidateCoverageRatio,1);
 assert.equal(result.candidateDurationMs,1300);
 assert.deepEqual(result.bridges,[{segmentIndex:0,startMs:4540,endMs:24740,gapMs:20200}]);
 assert.deepEqual(result.uncoveredCandidates,[]);
});
test('missing evidence stays unknown; an empty detector result is not proof of silence', () => {
 assert.equal(diagnoseSpeechCoverage({durationMs:30000,segments:[]}).evidenceStatus,'unknown');
 const result=diagnoseSpeechCoverage({durationMs:30000,segments:[],evidence:{source:'detector',intervals:[]}});
 assert.equal(result.candidateCoverageRatio,null);
 assert.equal(result.interpretation,'review_required_not_accuracy_or_silence_proof');
});
test('candidate intervals without transcript are review targets', () => {
 const result=diagnoseSpeechCoverage({durationMs:10000,segments:[interval(2000,3000)],evidence:{source:'relaxed detector',intervals:[interval(1000,4000),interval(6000,7000)]}});
 assert.equal(result.candidateCoverageRatio,0.25);
 assert.deepEqual(result.uncoveredCandidates,[interval(1000,2000),interval(3000,4000),interval(6000,7000)]);
});
test('overlapping detector and raw intervals do not inflate coverage', () => {
 const segments=[interval(0,3000),interval(2000,5000)];
 const result=diagnoseSpeechCoverage({durationMs:10000,segments,evidence:{source:'detector',intervals:[interval(0,3000),interval(2000,5000)]}});
 assert.equal(result.candidateDurationMs,5000);
 assert.equal(result.coveredCandidateMs,5000);
 assert.equal(result.candidateCoverageRatio,1);
 assert.deepEqual(segments,[interval(0,3000),interval(2000,5000)]);
});
test('malformed evidence cannot be used for a numerical quality claim', () => {
 for(const intervals of [[interval(2,1)],[interval(-1,2)],[interval(1,Infinity)],[interval(0,11000)]]) {
  assert.throws(()=>diagnoseSpeechCoverage({durationMs:10000,segments:[],evidence:{source:'detector',intervals}}));
 }
 assert.throws(()=>diagnoseSpeechCoverage({durationMs:10000,segments:[],evidence:{source:'',intervals:[]}}));
});
