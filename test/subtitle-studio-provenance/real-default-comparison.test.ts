import { describe, expect, it } from 'vitest';
import { observeRealMethod, realDefaultConfig, realDefaultMatrix, REAL_DEFAULT_BUDGET, runRealDefaultComparison } from './real-default-comparison-harness';

describe('T08 observation safety without ASR', () => {
  it('preserves synchronous ticket identity, receiver, arguments and result Promise', async () => {
    const ticket = Object.freeze({}), result = Promise.resolve({ response: 'real delegated value' }), operation = Object.freeze({ ticket, result });
    const argument = {}, pending = new Set<Promise<void>>(), seen: unknown[] = [], failures: unknown[] = [];
    class Target { begin(value: unknown) { expect(this).toBe(instance); expect(value).toBe(argument); return operation; } }
    const instance = new Target(), original = Target.prototype.begin;
    const restore = observeRealMethod({ target: Target.prototype, method: 'begin', pending, onError: error => failures.push(error),
      begin: args => { expect(args[0]).toBe(argument); return { resolved: value => seen.push(value) }; }, selectPromise: value => (value as typeof operation).result });
    try { expect(instance.begin(argument)).toBe(operation); expect(instance.begin(argument).ticket).toBe(ticket);
      expect(instance.begin(argument).result).toBe(result); await Promise.all([...pending]); expect(seen).toHaveLength(3); expect(failures).toEqual([]); }
    finally { restore(); }
    expect(Target.prototype.begin).toBe(original);
  });
  it('reports observer failures without changing synchronous exceptions or rejected original Promises', async () => {
    const failure = new Error('production failure'), observationFailure = new Error('observation failed');
    const rejection = Promise.reject(failure); void rejection.catch(() => undefined);
    const target = { sync() { throw failure; }, async() { return rejection; } };
    const pending = new Set<Promise<void>>(), failures: unknown[] = [], original = target.sync;
    const options = { target, pending, onError: (error: unknown) => failures.push(error), begin: () => ({ rejected: () => { throw observationFailure; } }) };
    const restoreSync = observeRealMethod({ ...options, method: 'sync' }), restoreAsync = observeRealMethod({ ...options, method: 'async' });
    try { expect(() => target.sync()).toThrow(failure); expect(target.async()).toBe(rejection); await expect(rejection).rejects.toBe(failure);
      await Promise.all([...pending]); expect(failures).toEqual([observationFailure, observationFailure]); }
    finally { restoreAsync(); restoreSync(); }
    expect(target.sync).toBe(original);
  });
  it('fixes 24 sequential pairs plus exactly one CUDA A repeat per side within production startup limits', () => {
    const matrix = realDefaultMatrix(); expect(matrix).toHaveLength(26);
    expect(matrix.slice(-2).map(value => [value.sample.id, value.backend, value.side, value.repeat]))
      .toEqual([['A', 'cuda', 'legacy', true], ['A', 'cuda', 'studio', true]]);
    for (let index = 0; index < 24; index += 2) { expect(matrix[index]!.side).toBe('legacy'); expect(matrix[index + 1]!.side).toBe('studio');
      expect(matrix[index]!.sample).toBe(matrix[index + 1]!.sample); expect(matrix[index]!.backend).toBe(matrix[index + 1]!.backend); }
    expect(realDefaultConfig('cpu')).toEqual({ ...realDefaultConfig('cuda'), devicePreference: 'cpu' });
    expect(REAL_DEFAULT_BUDGET.startupMs).toBe(120000);
  });
});

describe('explicit real default VAD CPU/CUDA comparison', () => {
  it.runIf(process.env.FUSIONKIT_REAL_DEFAULT_ASR === '1')('records all fixed cases and reopens successful Studio documents without claiming quality acceptance', async () => {
    const report = await runRealDefaultComparison();
    expect(report.status, `Evidence: ${report.outputRoot}\n${JSON.stringify(report.error ?? report.integrityErrors)}`).toBe('completed');
    expect(report.chains).toHaveLength(26); expect(report.sourcesUnchanged).toBe(true); expect(report.qualityStatus).toBe('requires_review');
    for (const chain of report.chains) {
      expect(chain.cleanup?.joined).toBe(true); expect(chain.cleanup?.noObservedProcessAlive).toBe(true); expect(chain.observerErrors).toEqual([]);
      if (chain.side === 'studio' && chain.status === 'completed') {
        expect(chain.document?.reopenedAfterShutdown).toBe(true);
        expect(chain.documentIntegrity).toMatchObject({ validDocument: true, canonicalEqual: true, mappingEqual: true, projectionEqual: true });
      }
      if (chain.status === 'no_speech_detected') { expect(chain.canonicalTranscript).toBeUndefined(); expect(chain.document).toBeUndefined(); }
    }
  }, REAL_DEFAULT_BUDGET.overallMs + REAL_DEFAULT_BUDGET.cleanupMs);
});
