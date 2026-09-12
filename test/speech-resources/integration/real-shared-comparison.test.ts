import { describe, expect, it } from 'vitest';
import { REAL_SHARED_BUDGET, realSharedEnabled, realSharedMatrix, runRealSharedComparison, realSharedErrorEvidence } from './real-shared-comparison-harness';

describe('real shared evidence safeguards without inference', () => {
  it('preserves nested cleanup errors and their causes while bounding cyclic evidence', () => {
    const source = Object.assign(new Error('Still busy'), { localSubtitleCode: 'resource_busy' });
    const error = new AggregateError([new AggregateError([source], 'Resource cleanup failed')], 'Application cleanup failed', { cause: source });
    expect(realSharedErrorEvidence(error)).toMatchObject({ name: 'AggregateError', message: 'Application cleanup failed',
      errors: [{ name: 'AggregateError', errors: [{ name: 'Error', message: 'Still busy', code: 'resource_busy' }] }], cause: { code: 'resource_busy' } });
    source.cause = source; expect(realSharedErrorEvidence(source).cause).toMatchObject({ truncated: true });
  });
  it('requires both explicit flags and fixes a bounded four-run matrix', () => {
    expect(realSharedEnabled({})).toBe(false); expect(realSharedEnabled({ FUSIONKIT_REAL_ASR: '1' })).toBe(false);
    expect(realSharedEnabled({ FUSIONKIT_REAL_SHARED_ASR: '1' })).toBe(false);
    expect(realSharedEnabled({ FUSIONKIT_REAL_ASR: '1', FUSIONKIT_REAL_SHARED_ASR: '1' })).toBe(true);
    expect(realSharedMatrix()).toEqual([{ backend: 'cpu', side: 'legacy' }, { backend: 'cpu', side: 'studio' },
      { backend: 'cuda', side: 'legacy' }, { backend: 'cuda', side: 'studio' }]);
    expect(REAL_SHARED_BUDGET.startupMs).toBe(120000); expect(REAL_SHARED_BUDGET.caseMs).toBe(900000);
  });
});

it.runIf(realSharedEnabled())('migrates one copy and transcribes through both real consumers on CPU and CUDA', async () => {
  const report = await runRealSharedComparison();
  expect(report.status, JSON.stringify({ root: report.outputRoot, error: report.error, cleanup: report.cleanup })).toBe('completed');
  expect(report.chains).toHaveLength(4); expect(report.comparisons).toHaveLength(2); expect(report.sourcesUnchanged).toBe(true);
  expect(report.cleanup).toMatchObject({ joined: true, rootRemoved: true, serverDisposed: true, noObservedProcessAlive: true });
  expect(report.migrationPreservedPayloadIdentity).toBe(true); expect(report.legacyResourceRootsRemoved).toBe(true);
  expect(report.qualityStatus).toBe('requires_review');
}, REAL_SHARED_BUDGET.overallMs + REAL_SHARED_BUDGET.cleanupMs * 4);
