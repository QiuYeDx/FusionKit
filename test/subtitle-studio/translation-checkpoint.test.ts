import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateSnapshot, type DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { planTranslation } from '../../electron/main/subtitle-studio/translation-planner';
import { checkpointForPlan } from '../../electron/main/subtitle-studio/translation-recovery';

function snapshot(): DocumentSnapshot {
  const doc = importSubtitleText('[00:01]First sentence\n[00:02]Second sentence\n', { format: 'lrc', encoding: 'utf-8', displayName: 'checkpoint.lrc', digest: 'f'.repeat(64) }, randomUUID);
  const config = { model: { profileId: 'fixture', modelKey: 'fixture', endpoint: 'https://example.invalid', apiFormat: 'chat_completions' as const }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
  const plan = planTranslation(doc, config);
  const trackId = randomUUID();
  doc.translationTracks.push({ id: trackId, revision: 1, language: 'zh', entries: {} });
  return { schemaVersion: 1, document: doc, tasks: [{ id: randomUUID(), trackId, generation: 1, status: 'interrupted', attempts: 0, completedBatchIds: [], uncertainBatchIds: [],
    translation: { config, totalBatches: plan.batches.length, estimatedInputTokens: plan.batches.reduce((n, b) => n + b.estimatedInputTokens, 0), outputTokenReserve: 2048,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, checkpoint: checkpointForPlan(plan, doc) } }] };
}

describe('persisted translation checkpoint integrity', () => {
  it('keeps legacy task snapshots readable without inventing a recovery manifest', () => {
    const old = snapshot();
    delete old.tasks[0].translation!.checkpoint;
    expect(validateSnapshot(old)).toEqual(old);
    const minimal = structuredClone(old); delete minimal.tasks[0].translation;
    expect(validateSnapshot(minimal)).toEqual(minimal);
  });

  it.each([
    ['duplicate batch ids', (value: DocumentSnapshot) => { value.tasks[0].translation!.checkpoint!.batches[1].id = 'b1'; }],
    ['duplicate cue membership', (value: DocumentSnapshot) => { const batches = value.tasks[0].translation!.checkpoint!.batches; batches[1].cueIds = batches[0].cueIds; }],
    ['non-prefix completion', (value: DocumentSnapshot) => { value.tasks[0].completedBatchIds = ['b2']; }],
    ['unknown pending batch', (value: DocumentSnapshot) => { value.tasks[0].uncertainBatchIds = ['b3']; }],
    ['unknown in-flight batch', (value: DocumentSnapshot) => { value.tasks[0].translation!.inFlightBatchId = 'b3'; }],
    ['completed in-flight batch', (value: DocumentSnapshot) => { value.tasks[0].completedBatchIds = ['b1']; value.tasks[0].translation!.inFlightBatchId = 'b1'; }],
    ['in-flight without manifest', (value: DocumentSnapshot) => { delete value.tasks[0].translation!.checkpoint; value.tasks[0].translation!.inFlightBatchId = 'b1'; }],
    ['inconsistent batch count', (value: DocumentSnapshot) => { value.tasks[0].translation!.totalBatches = 3; }],
    ['premature completion', (value: DocumentSnapshot) => { value.tasks[0].status = 'completed'; }],
    ['credential field', (value: DocumentSnapshot) => { Object.assign(value.tasks[0].translation!.config.model, { apiKey: 'synthetic-not-persisted' }); }],
  ] as const)('rejects %s before publishing a snapshot', (_name, mutate) => {
    const value = snapshot(); mutate(value);
    expect(() => validateSnapshot(value)).toThrow('invalid_input');
  });
});
