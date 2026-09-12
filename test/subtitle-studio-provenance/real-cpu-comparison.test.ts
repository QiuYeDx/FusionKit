import { describe, expect, it } from 'vitest';
import { runRealCpuComparison } from './real-cpu-comparison-harness';

describe('explicit real CPU production comparison', () => {
  // Opt-in is required: ordinary tests never load a model, download or run ASR.
  it.runIf(process.env.FUSIONKIT_REAL_ASR === '1')('compares real legacy cues with a reopened Studio schema-2 document', async () => {
    const report = await runRealCpuComparison();
    expect(report.status, `Evidence: ${report.outputRoot}\n${report.error ?? ''}`).toBe('passed');
    expect(report.sourcesUnchanged).toBe(true);
    expect(report.comparison?.equalCueTextAndTiming).toBe(true);
    expect(report.studio.document?.reopenedAfterShutdown).toBe(true);
    expect(report.legacy.cleanup?.noObservedProcessAlive).toBe(true);
    expect(report.studio.cleanup?.noObservedProcessAlive).toBe(true);
  }, 22 * 60_000);
});
