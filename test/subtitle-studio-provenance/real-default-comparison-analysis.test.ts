import { describe, expect, it } from 'vitest';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import type { LocalSubtitleTranscript } from '../../src/type/localSubtitle';
import { analyzeRealDefaultComparison, type RealDefaultComparisonSide, type RealDefaultRawAttempt } from './real-default-comparison-analysis';

function transcript(): LocalSubtitleTranscript {
  return {
    schemaVersion: 1, source: { displayName: 'A.wav', durationMs: 30_000 },
    model: { engine: 'whisper_cpp', modelId: 'large-v3-q5_0', modelHash: 'a'.repeat(64), backend: 'cpu' },
    detectedLanguage: 'ja', languageProbability: 0.97,
    segments: [
      { id: 'cue-000001', startMs: 120, endMs: 1500, text: 'はい。', confidence: 0.91, speaker: 'A',
        words: [{ text: 'はい。', startMs: 150, endMs: 1400, probability: 0.87 }] },
      { id: 'cue-000002', startMs: 2000, endMs: 3500, text: '次の行。', estimatedTiming: true },
    ],
  };
}

function window(startMs = 0, endMs = 30_000, id = 'window-1') {
  return {
    windowId: id, quietAudioGainDb: 12,
    descriptor: { windowKey: id, rootPlanId: `plan-${id}`, rootWindowKey: id, retryDepth: 0,
      startMs, endMs, coreStartMs: startMs, coreEndMs: endMs,
      startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 },
  };
}

function raw(ordinal = 1, branded = window()): RealDefaultRawAttempt {
  return { ordinal, window: branded, request: { requestGeneration: ordinal, vadEnabled: true },
    response: { processEpoch: 1, response: { requestGeneration: ordinal, sessionDisposition: 'reusable',
      result: { contractVersion: 1, task: 'transcribe', language: 'ja', durationMs: 30_000, text: 'はい。',
        wordTimelineStatus: 'not_requested', segments: [{ id: 0, startMs: 120, endMs: 1500, text: 'はい。',
          temperature: 0, averageLogProbability: -0.5, noSpeechProbability: 0.1 }] } } },
  };
}

function side(value = transcript()): RealDefaultComparisonSide {
  return { canonicalTranscript: value, rawAttempts: [raw()],
    windowPlan: { totalFrames: 480_000, quietCandidates: [], windows: [window()] } };
}

function compare(legacy = side(), studio = side()) {
  const fullStudio = studio.document || studio.documentCues ? studio
    : { ...studio, document: transcriptToDocument(studio.canonicalTranscript) };
  return analyzeRealDefaultComparison({ sampleId: 'A', backend: 'cpu', legacy, studio: fullStudio });
}

describe('real default comparison evidence analysis', () => {
  it('compares the whole canonical evidence and document without issuing an accuracy verdict', () => {
    const result = compare();
    expect(result.canonical).toMatchObject({ equal: true, semanticEqual: true, differences: [] });
    expect(result.documents.studio).toMatchObject({ availability: 'full_document', validDocument: true, canonicalEqual: true, mappingEqual: true });
    expect(result.windows).toMatchObject({ comparable: true, equal: true });
    expect(result.requiresReview).toBe(false);
    expect(result).not.toHaveProperty('qualityPassed');
    expect(result.limitations.join(' ')).toContain('not recognition accuracy');
  });

  it('retains random segment identities but excludes only those fields from semantic equality', () => {
    const modified = structuredClone(transcript());
    modified.segments.forEach((segment, index) => Object.assign(segment, { id: `different-id-${index}` }));
    const result = compare(side(), side(modified));
    expect(result.canonical.equal).toBe(false);
    expect(result.canonical.semanticEqual).toBe(true);
    expect(result.canonical.identityDifferences.map(value => value.path)).toEqual(['/segments/0/id', '/segments/1/id']);
    expect(result.documents.studio.mappingEqual).toBe(true);
    expect(result.requiresReview).toBe(false);
  });

  it.each([
    ['/source/displayName', (value: LocalSubtitleTranscript) => Object.assign(value.source, { displayName: 'renamed.wav' })],
    ['/source/durationMs', (value: LocalSubtitleTranscript) => Object.assign(value.source, { durationMs: 30_001 })],
    ['/model/modelHash', (value: LocalSubtitleTranscript) => Object.assign(value.model, { modelHash: 'b'.repeat(64) })],
    ['/model/modelId', (value: LocalSubtitleTranscript) => Object.assign(value.model, { modelId: 'large-v3' })],
    ['/detectedLanguage', (value: LocalSubtitleTranscript) => Object.assign(value, { detectedLanguage: 'en' })],
    ['/languageProbability', (value: LocalSubtitleTranscript) => Object.assign(value, { languageProbability: 0.970001 })],
    ['/segments/0/text', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0], { text: 'はい！' })],
    ['/segments/0/startMs', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0], { startMs: 121 })],
    ['/segments/0/endMs', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0], { endMs: 1501 })],
    ['/segments/0/confidence', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0], { confidence: 0.92 })],
    ['/segments/0/speaker', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0], { speaker: 'B' })],
    ['/segments/0/words/0/startMs', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0].words![0], { startMs: 151 })],
    ['/segments/0/words/0/endMs', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0].words![0], { endMs: 1401 })],
    ['/segments/0/words/0/text', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0].words![0], { text: 'はい' })],
    ['/segments/0/words/0/probability', (value: LocalSubtitleTranscript) => Object.assign(value.segments[0].words![0], { probability: 0.870001 })],
    ['/segments/1/estimatedTiming', (value: LocalSubtitleTranscript) => Reflect.deleteProperty(value.segments[1], 'estimatedTiming')],
  ] as const)('retains a strict difference at %s even if cue count or displayed text agrees', (location, mutate) => {
    const changed = structuredClone(transcript()); mutate(changed);
    const result = compare(side(), side(changed));
    expect(result.canonical.semanticEqual).toBe(false);
    expect(result.canonical.semanticDifferences.map(value => value.path)).toEqual([location]);
    expect(result.reviewReasons).toContain('canonical_semantic_differences');
    expect(result.summary.legacyCueCount).toBe(result.summary.studioCueCount);
  });

  it('distinguishes missing and explicitly undefined optional evidence in a serializable report', () => {
    const changed = structuredClone(transcript());
    Object.assign(changed.segments[1], { speaker: undefined });
    // The full document normally has JSON-persisted fields; use projection-only input for this malformed capture witness.
    const result = compare(side(), { ...side(changed), documentCues: changed.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })) });
    const diff = JSON.parse(JSON.stringify(result.canonical.semanticDifferences));
    expect(diff).toEqual([{ path: '/segments/1/speaker', legacy: { present: false }, studio: { present: true, type: 'undefined' } }]);
  });

  it('does not align away insertion, whitespace, punctuation or near-duplicate text', () => {
    const changed = structuredClone(transcript());
    Object.assign(changed, { segments: [changed.segments[0],
      { id: 'extra', startMs: 1500, endMs: 1800, text: 'はい。 ' }, changed.segments[1]] });
    const result = compare(side(), side(changed));
    expect(result.textDifferences.map(value => value.index)).toEqual([1, 2]);
    expect(result.canonical.semanticDifferences.some(value => value.path === '/segments/2')).toBe(true);
    expect(result.exactTextRepetitions.studio).toEqual([]);
    expect(result.textDifferences[1]).toMatchObject({ index: 2, legacy: null, studio: { id: 'cue-000002', text: '次の行。' } });
  });

  it('locates all exact repetitions without changing transcript text or declaring hallucination', () => {
    const repeatedTranscript = structuredClone(transcript());
    Object.assign(repeatedTranscript.segments[1], { text: 'はい。' });
    const before = structuredClone(repeatedTranscript), result = compare(side(repeatedTranscript), side(repeatedTranscript));
    expect(result.exactTextRepetitions.studio).toEqual([{ text: 'はい。', locations: [
      { index: 0, id: 'cue-000001', startMs: 120, endMs: 1500 },
      { index: 1, id: 'cue-000002', startMs: 2000, endMs: 3500 },
    ] }]);
    expect(repeatedTranscript).toEqual(before);
    expect(result.requiresReview).toBe(false);
    expect(result.limitations.join(' ')).toContain('legitimate speech');
  });

  it('bounds only the summary and keeps every difference and its complete values', () => {
    const original = { ...transcript(), segments: Array.from({ length: 31 }, (_, index) => ({
      id: `cue-${index}`, startMs: index * 100, endMs: index * 100 + 50, text: `text ${index}`,
    })) };
    const changed = { ...original, segments: original.segments.map(segment => ({ ...segment, text: `${segment.text}!` })) };
    const result = compare(side(original), side(changed));
    expect(result.summary.firstSemanticDifferencePaths).toHaveLength(20);
    expect(result.summary.remainingSemanticDifferencePathCount).toBe(11);
    expect(result.canonical.semanticDifferences).toHaveLength(31);
    expect(result.textDifferences).toHaveLength(31);
    expect(result.canonical.semanticDifferences.at(-1)).toMatchObject({ path: '/segments/30/text', studio: { value: 'text 30!' } });
  });

  it('detects lost preserved word evidence despite a completely equal visible cue projection', () => {
    const input = transcript(), document = transcriptToDocument(input);
    Reflect.deleteProperty(document.preservation.transcript.segments[0], 'words');
    const result = compare(side(input), { ...side(input), document });
    expect(result.documents.studio).toMatchObject({ validDocument: true, canonicalEqual: false, mappingEqual: true });
    expect(result.documents.studio.canonicalDifferences[0].path).toBe('/preservation/transcript/segments/0/words');
    expect(result.reviewReasons).toContain('studio_document_mismatch');
  });

  it.each([
    ['sourceRevision', (document: ReturnType<typeof transcriptToDocument>) => { document.cues[0].sourceRevision = 2; }],
    ['timingRevision', (document: ReturnType<typeof transcriptToDocument>) => { document.cues[0].timingRevision = 2; }],
    ['segmentId', (document: ReturnType<typeof transcriptToDocument>) => { document.cues[0].segmentId = 'other-segment'; }],
    ['source/spans/0/marks/0', (document: ReturnType<typeof transcriptToDocument>) => { document.cues[0].source.spans[0].marks.push('b'); }],
  ] as const)('checks the full document cue field %s rather than text/time alone', (field, mutate) => {
    const input = transcript(), document = transcriptToDocument(input); mutate(document);
    const result = compare(side(input), { ...side(input), document });
    expect(result.documents.studio.validDocument).toBe(false);
    expect(result.documents.studio.mappingDifferences[0].path).toBe(`/cues/0/${field}`);
    expect(result.reviewReasons).toContain('studio_document_mismatch');
  });

  it('checks document identity validity within each side instead of comparing random cue UUIDs', () => {
    const input = transcript(), document = transcriptToDocument(input);
    document.cues[1].id = document.cues[0].id;
    const result = compare(side(input), { ...side(input), document });
    expect(result.documents.studio.mappingEqual).toBe(true);
    expect(result.documents.studio.validDocument).toBe(false);
    expect(result.reviewReasons).toContain('studio_document_mismatch');
  });

  it('reports projection-only and absent raw evidence as incomplete, never equal full evidence', () => {
    const input = transcript();
    const result = analyzeRealDefaultComparison({ sampleId: 'A', backend: 'cpu', legacy: { canonicalTranscript: input },
      studio: { canonicalTranscript: input, documentCues: input.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })) } });
    expect(result.documents.studio).toMatchObject({ availability: 'projection_only', projectionEqual: true, canonicalEqual: null });
    expect(result.windows).toMatchObject({ comparable: false, equal: null });
    expect(result.reviewReasons).toContain('studio_full_document_not_captured');
    expect(result.reviewReasons).toContain('legacy_raw_evidence_incomplete');
  });

  it('requires schema-2 evidence only on actual Studio runs when analyzing first/repeat controls', () => {
    const legacyControl = analyzeRealDefaultComparison({ sampleId: 'A-legacy-first-vs-repeat', backend: 'cpu',
      comparisonKind: 'legacy_repeat', legacy: side(), studio: side() });
    expect(legacyControl.requiresReview).toBe(false);
    expect(legacyControl.comparisonKind).toBe('legacy_repeat');
    const studioControl = analyzeRealDefaultComparison({ sampleId: 'A-studio-first-vs-repeat', backend: 'cpu',
      comparisonKind: 'studio_repeat', legacy: side(), studio: { ...side(), document: transcriptToDocument(transcript()) } });
    expect(studioControl.reviewReasons).toContain('legacy_full_document_not_captured');
  });

  it('maps known raw segments through exact normalized window geometry without reinterpreting DTW points', () => {
    const attempt = raw(7, window(20_000, 50_000));
    const response = attempt.response as any;
    response.response.result.wordTimelineStatus = 'dtw_token_points';
    response.response.result.segments[0].dtwTokens = [{ text: 'はい', pointMs: 500 }, { text: '。', pointMs: null }];
    attempt.request.vadEnabled = false; attempt.request.timingMode = 'dtw_large_v3';
    const result = compare(side(), { ...side(), rawAttempts: [attempt] });
    expect(result.raw.studio.observations[0]).toMatchObject({ status: 'response', ordinal: 7, quietAudioGainDb: 12,
      vadEnabled: false, timingMode: 'dtw_large_v3', dtwTokenPointCount: 2 });
    expect(result.raw.studio.segments[0]).toMatchObject({ ordinal: 7, segmentIndex: 0,
      localStartMs: 120, localEndMs: 1500, absoluteStartMs: 20_120, absoluteEndMs: 21_500 });
    expect(result.raw.studio.segments[0]).not.toHaveProperty('words');
  });

  it('retains repeated attempts and distinguishes same-window retries from another window', () => {
    const result = compare(side(), { ...side(), rawAttempts: [raw(), raw(2), raw(3, window(20_000, 50_000, 'next'))] });
    const group = result.raw.studio.exactTextRepetitions[0];
    expect(group).toMatchObject({ text: 'はい。', acrossAttempts: true, acrossWindowGeometry: true });
    expect(group.locations.map(location => location.ordinal)).toEqual([1, 2, 3]);
    const retryOnly = compare(side(), { ...side(), rawAttempts: [raw(), raw(2)] });
    expect(retryOnly.raw.studio.exactTextRepetitions[0].acrossWindowGeometry).toBe(false);
    expect(result.limitations.join(' ')).toContain('later be discarded');
  });

  it('keeps raw failure evidence and refuses to infer data from an unknown response wrapper', () => {
    const result = compare(side(), { ...side(), rawAttempts: [
      { ordinal: 1, request: {}, window: window(), error: { name: 'Error', code: 'no_speech_detected', message: 'No transcript' } },
      { ordinal: 2, request: {}, window: window(), response: { text: 'unrecognized shape', segments: [] } },
    ] });
    expect(result.raw.studio.observations.map(value => value.status)).toEqual(['error', 'unsupported_response']);
    expect(result.raw.studio.observations[0].error?.code).toBe('no_speech_detected');
    expect(result.raw.studio.segments).toEqual([]);
    expect(result.reviewReasons).toContain('studio_raw_evidence_incomplete');
    expect(result.limitations.join(' ')).toContain('does not establish acoustic silence');
  });

  it('compares plan geometry while preserving meaningful changes and ignoring ephemeral window identities', () => {
    const same = compare(side(), { ...side(), windowPlan: { totalFrames: 480_000, quietCandidates: [], windows: [window(0, 30_000, 'new-id')] } });
    expect(same.windows.equal).toBe(true);
    const changed = window(); changed.descriptor.coreStartFrame = 160; changed.descriptor.coreStartMs = 10;
    const result = compare(side(), { ...side(), windowPlan: { totalFrames: 480_000, quietCandidates: [], windows: [changed] } });
    expect(result.windows.differences.map(value => value.path)).toEqual(['/windows/0/coreStartFrame', '/windows/0/coreStartMs']);
    expect(result.reviewReasons).toContain('window_geometry_differences');
  });

  it('does not guess absolute time or report equal geometry from inconsistent frame/ms evidence', () => {
    const changed = window(); changed.descriptor.startMs = 1;
    const result = compare(side(), { ...side(), rawAttempts: [raw(1, changed)],
      windowPlan: { totalFrames: 480_000, quietCandidates: [], windows: [changed] } });
    expect(result.windows.studio.availability).toBe('unsupported');
    expect(result.windows.equal).toBeNull();
    expect(result.raw.studio.segments[0].absoluteStartMs).toBeNull();
    expect(result.reviewReasons).toContain('studio_raw_evidence_incomplete');
  });

  it('reports a shared wrong backend even when the paired transcripts agree', () => {
    const input = transcript();
    const result = analyzeRealDefaultComparison({ sampleId: 'A', backend: 'cuda', legacy: side(input),
      studio: { ...side(input), document: transcriptToDocument(input) } });
    expect(result.canonical.semanticEqual).toBe(true);
    expect(result.reviewReasons).toContain('backend_mismatch');
  });

  it('does not mutate inputs or retain aliases to recorded difference values', () => {
    const original = transcript(), changed = structuredClone(original);
    Reflect.deleteProperty(changed.segments[0], 'words');
    const legacy = side(original), studio = side(changed), before = structuredClone({ legacy, studio });
    const result = compare(legacy, studio);
    expect({ legacy, studio }).toEqual(before);
    Object.assign(original.segments[0].words![0], { text: 'mutated later' });
    expect(result.canonical.differences[0].legacy).toMatchObject({ value: [{ text: 'はい。' }] });
  });
});
