import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createTestRun } from '../support/testRun';
import { asrAbEnabled, asrAbTimeoutMs, parseAsrAbSelection } from './ab-config';

const enabled = asrAbEnabled();
// Parsed only when enabled, so a stray variable never breaks ordinary runs.
const selection = enabled ? parseAsrAbSelection() : undefined;
const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test-results/asr-quality-ab');

// Explicit: FUSIONKIT_ASR_AB=1 runs real models on real audio for minutes to hours. See ab-config.ts for the selection.
it.runIf(enabled)('transcribes each selected sample with each audio type and writes the A/B reports', async () => {
  // The native modules load only when the comparison really runs.
  const { runAsrAbComparison } = await import('./ab-comparison-harness');
  const { report, failures, outputRoot, sourcesUnchanged, workRemoved } = await runAsrAbComparison(selection!, await createTestRun(artifacts));
  const missing = report.samples.filter(sample => sample.status !== 'present').map(sample => `${sample.id}: ${sample.reason}`);
  if (missing.length) console.warn(`[ASR A/B] Recorded as missing, not run: ${missing.join('; ')}`);
  expect(failures, `Evidence: ${outputRoot}`).toEqual([]);
  expect(sourcesUnchanged).toBe(true); expect(workRemoved).toBe(true);
  const present = report.samples.filter(sample => sample.status === 'present');
  expect(report.cases).toHaveLength(present.length * selection!.variants.length);
  for (const value of report.cases) {
    expect(['completed', 'no_content', 'not_implemented'], `${value.sampleId} / ${value.variant}: ${value.error}`).toContain(value.status);
    if (value.status === 'not_implemented') continue;
    expect(value.cleanup).toEqual({ joined: true, processesExited: true, workRemoved: true });
    expect(value.processIds.length).toBeGreaterThan(0); expect(value.requests.length).toBeGreaterThan(0);
    if (value.variant === 'standard') expect(value.profileApplied).toBe(false);
  }
}, selection ? asrAbTimeoutMs(selection) : undefined);
