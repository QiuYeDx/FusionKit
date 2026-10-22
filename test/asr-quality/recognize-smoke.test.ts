import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createTestRun } from '../support/testRun';
import { ASR_AB_BUDGET, asrAbEnabled } from './ab-config';

const enabled = asrAbEnabled();
const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test-results/asr-quality-recognize');

// Explicit: FUSIONKIT_ASR_AB=1 runs the downloaded recognize-only models on real audio for minutes.
// See recognize-smoke-harness.ts for the models, the samples and where the cues come from.
it.runIf(enabled)('recognizes cues again with each recognize-only model through the app path and writes the report', async () => {
  // The native modules load only when the smoke really runs.
  const { ASR_RECOGNIZE_SMOKE, parseAsrRecognizeSelection, runAsrRecognizeSmoke } = await import('./recognize-smoke-harness');
  const { report, failures, outputRoot, sourcesUnchanged, workRemoved } = await runAsrRecognizeSmoke(parseAsrRecognizeSelection(), await createTestRun(artifacts));
  expect(failures, `Evidence: ${outputRoot}`).toEqual([]);
  expect(sourcesUnchanged).toBe(true); expect(workRemoved).toBe(true);
  expect(report.models.map(run => run.modelId)).toEqual(ASR_RECOGNIZE_SMOKE.map(smoke => smoke.modelId));
  for (const run of report.models) {
    expect(run.cleanup).toEqual({ joined: true, processesExited: true, killed: [], workRemoved: true });
    expect(run.processIds.length).toBeGreaterThan(0);
    expect(run.serverLoads.every(load => load.startsWith('inference/') && load.endsWith(`/${run.modelId}`))).toBe(true);
    expect(run.cues.length).toBeGreaterThan(0);
    for (const cue of run.cues) {
      // A recognize-only model is asked for text only, without voice detection or a hint.
      expect(cue.result, `${run.modelId} ${cue.sampleId} #${cue.index}`).toBeDefined();
      expect(cue.fields).toMatchObject({ no_timestamps: 'true', vad: 'false' });
      expect(cue.fields).not.toHaveProperty('prompt');
      expect(cue.timed?.fields).toMatchObject({ no_timestamps: 'false' });
    }
  }
}, ASR_AB_BUDGET.resourcesMs + 2 * (ASR_AB_BUDGET.caseMs + ASR_AB_BUDGET.cleanupMs));
