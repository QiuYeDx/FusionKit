import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioError, validateDocument, type MediaSubtitleDocument } from '../../src/subtitle-studio/domain';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT, type LocalSubtitleTranscript } from '../../src/subtitle-studio/transcription/domain';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import {
  createSubtitlePostProcessPolicy,
  planLocalSubtitleRootWindows,
  postProcessLocalSubtitleTranscript,
} from '../../electron/main/subtitle-studio/transcription/native/subtitle-post-processor';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-transcript-confidence-')); roots.push(root);
  return path.join(root, 'documents');
}

/** A real post-processor result: three raw segments in one 30 s window. */
function postProcessed(): LocalSubtitleTranscript {
  const policy = createSubtitlePostProcessPolicy({
    advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500, maxCueDurationMs: 7_000, maxCueChars: 84, maxLineChars: 42 },
    vad: { enabled: true, modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id, tokenTimestamps: false,
      timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy },
    rawQualityGate: {
      maxSegmentDurationMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
      repeatedCueThreshold: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
      repeatedCoverageMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
      maxRetryDepth: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
    },
  });
  const rootPlan = planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames: 30_000 * 16, policy });
  const segments = [[1_000, 3_000, 'おはよう', -0.2, 0.01], [4_000, 6_500, 'ご視聴ありがとうございました', -1.4, 0.3],
    [8_000, 9_000, '♪～♪', -3.2, 0.6]].map(([startMs, endMs, text, averageLogProbability, noSpeechProbability], id) => ({
    id, startMs: startMs as number, endMs: endMs as number, text: text as string, temperature: 0,
    averageLogProbability: averageLogProbability as number, noSpeechProbability: noSpeechProbability as number }));
  return postProcessLocalSubtitleTranscript({
    source: { displayName: 'asmr.wav', durationMs: 30_000, totalFrames: 30_000 * 16, sampleRateHz: 16_000 },
    model: { engine: 'whisper_cpp', modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256, backend: 'cpu' },
    taskMode: 'transcribe', policy, rootPlan,
    attempts: [{ window: rootPlan.windows[0]!, windowAttempt: 1, processEpoch: 1, requestGeneration: 1, response: {
      requestGeneration: 1, sessionDisposition: 'reusable', result: { contractVersion: 1, task: 'transcribe', language: 'japanese',
        durationMs: 30_000, text: segments.map(segment => segment.text).join(' '), segments,
        wordTimelineStatus: 'discarded_vad_compressed_timeline' } } }],
  }).transcript;
}
/** What a transcript written before per-segment confidence looks like. */
function withoutConfidence(transcript: LocalSubtitleTranscript): LocalSubtitleTranscript {
  return { ...transcript, segments: transcript.segments.map(({ confidence, ...segment }) => segment) };
}

describe('transcript confidence in Studio documents', () => {
  it('keeps every new segment confidence through document creation, validation and reopening', async () => {
    const transcript = postProcessed();
    expect(transcript.segments.map(segment => segment.confidence)).toEqual([0.811, 0.173, 0.016]);
    const document = transcriptToDocument(transcript);
    expect(() => validateDocument(document)).not.toThrow();
    expect(document.preservation.transcript).toEqual(transcript);
    // Cues carry no copy; the transcript evidence is the single source of the value.
    expect(document.cues.every(cue => !('confidence' in cue))).toBe(true);
    const directory = await repository();
    await new DocumentRepository(directory).create(document);
    const reopened = await new DocumentRepository(directory).read(document.id) as MediaSubtitleDocument;
    expect(reopened).toEqual(document);
    for (const segment of reopened.preservation.transcript.segments) {
      expect(segment.confidence).toBeGreaterThanOrEqual(0);
      expect(segment.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('opens documents whose transcript has no confidence, or only some segments with it', async () => {
    const old = withoutConfidence(postProcessed());
    const mixed = { ...old, segments: old.segments.map((segment, index) => index === 1 ? { ...segment, confidence: 0.5 } : segment) };
    const directory = await repository();
    for (const transcript of [old, mixed]) {
      const document = transcriptToDocument(transcript);
      expect(() => validateDocument(document)).not.toThrow();
      await new DocumentRepository(directory).create(document);
      const reopened = await new DocumentRepository(directory).read(document.id) as MediaSubtitleDocument;
      expect(reopened.preservation.transcript).toEqual(transcript);
      expect(reopened.cues.map(cue => cue.source.plain)).toEqual(transcript.segments.map(segment => segment.text));
    }
    expect(transcriptToDocument(old).preservation.transcript.segments.some(segment => 'confidence' in segment)).toBe(false);
  });

  it.each([1.2, -0.1, Number.NaN, '0.5'])('rejects an out-of-contract confidence %s', value => {
    const transcript = postProcessed();
    const invalid = { ...transcript, segments: transcript.segments.map((segment, index) => index ? segment : { ...segment, confidence: value }) };
    expect(() => transcriptToDocument(invalid)).toThrow(StudioError);
    const document = structuredClone(transcriptToDocument(transcript)) as any;
    document.preservation.transcript.segments[0].confidence = value;
    expect(() => validateDocument(document)).toThrow(StudioError);
  });
});
