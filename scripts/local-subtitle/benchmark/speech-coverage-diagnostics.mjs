/** Diagnostic only: detector candidates are not ground truth and never authorize text edits. */
export function diagnoseSpeechCoverage({ durationMs, segments, evidence, bridgeThresholdMs = 2000 }) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(bridgeThresholdMs) || bridgeThresholdMs < 0) throw Error('Invalid diagnostic duration/threshold');
  const validate = intervals => {
    if (!Array.isArray(intervals)) throw Error('Intervals must be an array');
    return intervals.map(interval => {
      const { startMs, endMs } = interval;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > durationMs) throw Error('Invalid diagnostic interval');
      return { startMs, endMs };
    });
  };
  const union = intervals => {
    const result = [];
    for (const interval of [...intervals].sort((a,b) => a.startMs-b.startMs)) {
      const last = result.at(-1);
      if (last && interval.startMs <= last.endMs) last.endMs = Math.max(last.endMs, interval.endMs);
      else result.push({...interval});
    }
    return result;
  };
  const raw = validate(segments);
  if (!evidence) return { evidenceStatus: 'unknown', reason: 'speech_candidate_evidence_missing', segmentCount: raw.length };
  if (typeof evidence.source !== 'string' || !evidence.source.trim()) throw Error('Evidence requires provenance');
  const candidates = union(validate(evidence.intervals));
  const transcript = union(raw);
  const overlap = (a,b) => Math.max(0, Math.min(a.endMs,b.endMs)-Math.max(a.startMs,b.startMs));
  const candidateDurationMs = candidates.reduce((sum,c) => sum+c.endMs-c.startMs,0);
  const coveredCandidateMs = candidates.reduce((sum,c) => sum+transcript.reduce((total,s) => total+overlap(c,s),0),0);
  const bridges = [];
  raw.forEach((segment, segmentIndex) => {
    const intersections = candidates.filter(c => overlap(c,segment)>0).map(c => ({startMs: Math.max(c.startMs,segment.startMs),endMs:Math.min(c.endMs,segment.endMs)}));
    for (let i=1;i<intersections.length;i++) {
      const gapMs = intersections[i].startMs-intersections[i-1].endMs;
      if(gapMs >= bridgeThresholdMs) bridges.push({segmentIndex,startMs:intersections[i-1].endMs,endMs:intersections[i].startMs,gapMs});
    }
  });
  const uncoveredCandidates = candidates.flatMap(candidate => {
    const gaps = [];
    let cursor = candidate.startMs;
    for(const segment of transcript) {
      if(segment.endMs<=cursor) continue;
      if(segment.startMs>=candidate.endMs) break;
      if(segment.startMs>cursor) gaps.push({startMs:cursor,endMs:segment.startMs});
      cursor=Math.min(candidate.endMs,Math.max(cursor,segment.endMs));
    }
    if(cursor<candidate.endMs) gaps.push({startMs:cursor,endMs:candidate.endMs});
    return gaps;
  });
  return { evidenceStatus:'detector_candidates', source:evidence.source, candidateDurationMs, coveredCandidateMs,
    candidateCoverageRatio:candidateDurationMs ? coveredCandidateMs/candidateDurationMs : null,
    bridges, uncoveredCandidates, interpretation:'review_required_not_accuracy_or_silence_proof' };
}
