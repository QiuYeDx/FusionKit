import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, validateDocument, type MediaSubtitleDocument } from '../../src/subtitle-studio/domain';
import { analyzeBilingual, applyBilingual, hasBilingualCandidates } from '../../src/subtitle-studio/bilingual';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { validateSnapshot } from '../../src/subtitle-studio/persistence-contract';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { LOCAL_SUBTITLE_LIMITS, type LocalSubtitleTranscript } from '../../src/subtitle-studio/transcription/domain';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { ExportService, publishSource, sourceBytes } from '../../electron/main/subtitle-studio/export-service';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'studio-transcript-document-')); roots.push(root); return root; }
const transcript = (): LocalSubtitleTranscript => ({
  schemaVersion: 1, source: { displayName: 'interview.wav', durationMs: 8000 },
  model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cpu' },
  detectedLanguage: 'ja', languageProbability: 0.973,
  segments: [
    { id: 'original-segment-000001', startMs: 123, endMs: 2456, text: 'はい、はい。\n次の行。', confidence: 0.823, speaker: '話者 A',
      words: [{ text: 'はい、はい。', startMs: 123, endMs: 1400, probability: 0.867 }, { text: '次の行。', startMs: 1700, endMs: 2456 }] },
    { id: 'original-segment-000002', startMs: 2701, endMs: 7503, text: '繰り返しをそのまま。', estimatedTiming: true },
  ],
});
const options = (format: 'srt' | 'lrc' = 'srt'): ExportOptions => ({ mode: 'source', format, order: 'source-first', encoding: 'utf-8', bom: false,
  newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' } });
const manySegments = (count: number, text = 'A'): LocalSubtitleTranscript => ({ ...transcript(), source: { displayName: 'long.wav', durationMs: count },
  segments: Array.from({ length: count }, (_, index) => ({ id: `segment-${index}`, startMs: index, endMs: index + 1, text })) });

describe('canonical transcript document adaptation', () => {
  it('retains exact evidence and stable segment mapping without inventing raw-source or word evidence', () => {
    const input = transcript(), before = structuredClone(input), id = randomUUID();
    const doc = transcriptToDocument(input, { documentId: id });
    expect(doc).toMatchObject({ schemaVersion: 2, id, revision: 1, capabilities: { translate: true, preserveSource: false }, diagnostics: [] });
    expect(doc.preservation).toEqual({ schemaVersion: 1, kind: 'transcription', transcript: before });
    expect(doc.origin).toEqual({ format: 'media', displayName: 'interview.wav', durationMs: 8000,
      transcriptDigest: createHash('sha256').update(JSON.stringify(doc.preservation.transcript)).digest('hex') });
    expect(doc.preservation).not.toHaveProperty('rawText');
    expect(doc.preservation).not.toHaveProperty('nodes');
    expect(doc.origin).not.toHaveProperty('digest');
    expect(doc.origin).not.toHaveProperty('encoding');
    for (const [index, cue] of doc.cues.entries()) {
      const segment = before.segments[index];
      expect(cue.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(cue.id).not.toBe(segment.id);
      expect(cue).not.toHaveProperty('nodeId');
      expect(cue.segmentId).toBe(segment.id);
      expect(cue.source).toEqual({ plain: segment.text, spans: [{ text: segment.text, marks: [] }] });
      expect(cue.timing).toEqual({ startMs: segment.startMs, endMs: segment.endMs, provenance: 'transcription' });
    }
    expect(doc.preservation.transcript.segments[1]).not.toHaveProperty('words');
    expect(doc.preservation.transcript.segments[1]).not.toHaveProperty('confidence');
    expect(doc.preservation.transcript.segments[0].words![1]).not.toHaveProperty('probability');
    input.segments[0].words![0].probability = 0.1;
    expect(doc.preservation.transcript).toEqual(before);
  });

  it.each([
    ['duplicate segment IDs', (value: LocalSubtitleTranscript) => { value.segments[1].id = value.segments[0].id; }],
    ['word outside segment', (value: LocalSubtitleTranscript) => { value.segments[0].words![0].startMs = 0; }],
    ['overlapping words', (value: LocalSubtitleTranscript) => { value.segments[0].words![1].startMs = 1399; }],
    ['word confidence range', (value: LocalSubtitleTranscript) => { value.segments[0].words![0].probability = 1.1; }],
    ['fractional timing', (value: LocalSubtitleTranscript) => { value.segments[1].startMs = 2701.5; }],
    ['overlapping segments', (value: LocalSubtitleTranscript) => { value.segments[1].startMs = 2455; }],
    ['reversed timing', (value: LocalSubtitleTranscript) => { value.segments[1].endMs = 2700; }],
    ['out-of-source timing', (value: LocalSubtitleTranscript) => { value.segments[1].endMs = 8001; }],
    ['estimated word evidence', (value: LocalSubtitleTranscript) => { value.segments[0].estimatedTiming = true; }],
    ['unsafe authority fields', (value: LocalSubtitleTranscript) => { Object.assign(value.source, { filePath: '/private/media.wav' }); }],
    ['unbounded line', (value: LocalSubtitleTranscript) => { value.segments[1].text = 'a'.repeat(1025); }],
  ] as const)('rejects %s without normalization', (_name, mutate) => {
    const input = transcript(); mutate(input);
    expect(() => transcriptToDocument(input)).toThrow('invalid_input');
  });

  it.each([
    ['source text', (doc: MediaSubtitleDocument) => { doc.cues[0].source.plain += '!'; }],
    ['span evidence', (doc: MediaSubtitleDocument) => { doc.cues[0].source.spans[0].marks.push('b'); }],
    ['timing', (doc: MediaSubtitleDocument) => { doc.cues[0].timing.endMs++; }],
    ['mapping', (doc: MediaSubtitleDocument) => { doc.cues[0].segmentId = 'different-segment'; }],
    ['order', (doc: MediaSubtitleDocument) => { doc.cues.reverse(); }],
    ['source metadata', (doc: MediaSubtitleDocument) => { doc.origin.durationMs++; }],
    ['fake raw node', (doc: MediaSubtitleDocument) => { Object.assign(doc.cues[0], { nodeId: randomUUID() }); }],
  ] as const)('rejects persisted projection drift in %s', (_name, mutate) => {
    const doc = transcriptToDocument(transcript()); mutate(doc);
    expect(() => validateDocument(doc)).toThrow('invalid_input');
    expect(() => validateSnapshot({ schemaVersion: 1, document: doc, tasks: [] })).toThrow('invalid_input');
  });

  it('accepts exactly 100000 cues and rejects 100001 without splitting or truncation', () => {
    expect(LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments).toBe(200000);
    const doc = transcriptToDocument(manySegments(LIMITS.cues));
    expect(doc.cues).toHaveLength(100000);
    expect(doc.preservation.transcript.segments).toHaveLength(100000);
    expect(doc.cues.at(-1)).toMatchObject({ segmentId: 'segment-99999', timing: { startMs: 99999, endMs: 100000 } });
    expect(() => transcriptToDocument(manySegments(LIMITS.cues + 1))).toThrow('limit_exceeded');
  }, 30000);

  it('bounds full snapshot bytes and both word budgets before publication', () => {
    const longText = Array(4).fill('x'.repeat(1023)).join('\n');
    expect(() => transcriptToDocument(manySegments(11000, longText))).toThrow('limit_exceeded');
    const input = transcript();
    const word = { text: 'word', startMs: 123, endMs: 124 };
    input.segments[0].words = Array(513).fill(word);
    expect(() => transcriptToDocument(input)).toThrow('limit_exceeded');
    const manyWords = manySegments(1954);
    manyWords.segments.forEach(segment => { segment.words = Array(512).fill(word); });
    expect(() => transcriptToDocument(manyWords)).toThrow('limit_exceeded');
  });

  it('counts cue and snapshot structure when source strings alone fit under 128 MiB', () => {
    const input = manySegments(100000, 'x'.repeat(350));
    expect(input.segments.length * 3 * Buffer.byteLength(JSON.stringify(input.segments[0].text))).toBeLessThan(LIMITS.snapshotBytes);
    expect(() => transcriptToDocument(input)).toThrow('limit_exceeded');
  }, 30000);
});

describe('media document consumers', () => {
  it('reopens text and media schemas together after the source media is removed', async () => {
    const root = await temporary(), source = path.join(root, 'interview.wav');
    await writeFile(source, 'original-media-fixture');
    const repository = new DocumentRepository(path.join(root, 'documents'));
    const media = transcriptToDocument(transcript());
    const text = importSubtitleText('[00:01]原文', { format: 'lrc', displayName: 'original.lrc', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);
    await repository.create(text); await repository.create(media); await rm(source);
    const reopened = new DocumentRepository(path.join(root, 'documents'));
    expect((await reopened.list()).map(doc => doc.origin.format).sort()).toEqual(['lrc', 'media']);
    expect(await reopened.read(text.id)).toEqual(text);
    expect(await reopened.read(media.id)).toEqual(media);
    expect(sourceBytes(await reopened.read(text.id)).toString('utf8')).toBe('[00:01]原文');
  });

  it('projects SRT/LRC from source cues and declares evidence loss without modifying the document', () => {
    const doc = transcriptToDocument(transcript()), before = structuredClone(doc);
    const srt = planSubtitleExport(doc, options());
    expect(srt.bytes?.toString('utf8')).toBe('1\n00:00:00,123 --> 00:00:02,456\nはい、はい。\n次の行。\n\n2\n00:00:02,701 --> 00:00:07,503\n繰り返しをそのまま。\n\n');
    const lrc = planSubtitleExport(doc, options('lrc'));
    expect(lrc.bytes?.toString('utf8')).toContain('[00:00.123]はい、はい。 次の行。');
    for (const plan of [srt, lrc]) {
      expect(plan.issues).toContainEqual({ code: 'transcription_evidence_omitted', count: 1, blocking: false, confirmation: true });
      expect(plan.issues.some(issue => issue.code === 'metadata_omitted')).toBe(false);
      expect(plan.bytes?.toString('utf8')).not.toContain('large-v3');
    }
    expect(doc).toEqual(before);
  });

  it('requires evidence-loss acceptance before publishing and rejects original-source download before writing', async () => {
    const root = await temporary(), repository = new DocumentRepository(path.join(root, 'documents'));
    const doc = transcriptToDocument(transcript()); await repository.create(doc);
    const service = new ExportService(repository), output = path.join(root, 'result.srt');
    try {
      const plan = await service.plan(3, doc.id, doc.revision, options());
      await expect(service.publish(3, doc.id, doc.revision, plan.planId!, [], output)).rejects.toThrow('invalid_input');
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      await service.publish(3, doc.id, doc.revision, plan.planId!, ['transcription_evidence_omitted'], output);
      expect(await readFile(output, 'utf8')).toContain('はい、はい。');
      expect(() => sourceBytes(doc)).toThrow('unsupported_feature');
      await expect(publishSource(doc, path.join(root, 'forbidden.wav'))).rejects.toThrow('unsupported_feature');
      expect((await readdir(root)).sort()).toEqual(['documents', 'result.srt']);
    } finally { service.dispose(); }
  });

  it('declines original-text bilingual splitting for media documents', () => {
    const doc = transcriptToDocument(transcript());
    const split = { sourceSide: 'first' as const, splitInline: false, overrides: [] };
    expect(hasBilingualCandidates(doc)).toBe(false);
    expect(() => analyzeBilingual(doc, split)).toThrow('unsupported_feature');
    expect(() => applyBilingual(doc, split, randomUUID, () => 'f'.repeat(64))).toThrow('unsupported_feature');
  });

  it('translates media cues through the existing service and reopens all timing and transcript evidence', async () => {
    const root = await temporary(), repository = new DocumentRepository(path.join(root, 'documents'));
    const doc = transcriptToDocument(transcript()), requests: string[] = [];
    await repository.create(doc);
    const service = new TranslationService(repository, async request => {
      requests.push(request.messages[1].content);
      const payload = JSON.parse(request.messages[1].content) as { items: { id: string; text: string }[] };
      return { apiFormat: request.model.apiFormat, content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `Translated ${item.text}` })) }),
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    });
    try {
      const started = await service.startConfigured(doc.id, doc.revision, {
        model: { profileId: 'fixture', modelKey: 'gpt-4o-mini', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' },
        language: 'English', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 2,
      }, 'fixture-key');
      await service.settled(started.taskId);
      const snapshot = await new DocumentRepository(path.join(root, 'documents')).readSnapshot(doc.id);
      expect(snapshot.tasks[0].status).toBe('completed');
      expect(snapshot.document.revision).toBeGreaterThan(doc.revision);
      expect(snapshot.document.origin).toEqual(doc.origin);
      expect(snapshot.document.preservation).toEqual(doc.preservation);
      expect(snapshot.document.cues).toEqual(doc.cues);
      const track = snapshot.document.translationTracks[0];
      expect(Object.keys(track.entries)).toHaveLength(2);
      expect(Object.values(track.entries).every(entry => entry.text.plain.startsWith('Translated '))).toBe(true);
      expect(requests.join('')).not.toMatch(/large-v3|modelHash|speaker|probability|original-segment|interview\.wav/);
      const exported = planSubtitleExport(snapshot.document, { ...options(), mode: 'target', trackId: track.id });
      expect(exported.bytes?.toString('utf8')).toContain('Translated');
    } finally { await service.dispose(); }
  });
});
