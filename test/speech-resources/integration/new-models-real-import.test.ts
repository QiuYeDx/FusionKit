import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SPEECH_MODEL_MANIFEST } from '../../../electron/main/speech-resources/catalog';
import { SpeechResourceService } from '../../../electron/main/speech-resources/service';
import { createSpeechResourceSmoke } from '../../../electron/main/subtitle-studio/transcription/shared-resources';
import { createTestRun } from '../../support/testRun';

/**
 * The models the catalog added later, imported from files already on disk into an isolated userData
 * with the production shared service: copy, size, SHA-256, ggml header and a CPU load check, no network.
 * Opt-in: FUSIONKIT_REAL_NEW_MODELS=1; FUSIONKIT_REAL_NEW_MODELS_DIR names the folder (read only).
 */
const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));
const enabled = process.env.FUSIONKIT_REAL_NEW_MODELS === '1';
const sourceDirectory = process.env.FUSIONKIT_REAL_NEW_MODELS_DIR ?? 'D:/fusionkit-asr-eval/models';
const LATER = ['large-v3-turbo-q8_0', 'belle-large-v3-turbo-zh', 'anime-whisper-q8_0'];
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

it.runIf(enabled)('imports and loads each later catalog model through the shared service in an isolated userData', async () => {
  const run = await createTestRun(path.join(PROJECT, 'test-results', 'asr-quality-models'), 'import-');
  const userDataRoot = path.join(run, 'user-data'), managedResourceRoot = path.join(userDataRoot, 'speech-resources');
  const noNetwork = async (): Promise<never> => { throw new Error('This check imports local files only.'); };
  const smoke = createSpeechResourceSmoke({ managedResourceRoot, sessionRoot: path.join(userDataRoot, 'smoke'), environment: { mode: 'development', appRoot: PROJECT } });
  const service = new SpeechResourceService({ userDataRoot, smokeModel: smoke.smokeModel, smokeVad: smoke.smokeVad,
    downloadResource: noNetwork, vadOptions: { downloadResource: noNetwork }, acceleratorOptions: { downloadResource: noNetwork } });
  const results: Record<string, unknown>[] = [];
  try {
    await service.initialize();
    const client = service.createClient({ id: 'studio', isResourceBusy: () => false });
    const owner = Object.freeze({ webContentsId: 0, ownerSessionId: randomUUID() });
    for (const id of LATER) {
      const model = SPEECH_MODEL_MANIFEST.models.find(candidate => candidate.id === id)!;
      const filePath = path.join(sourceDirectory, model.fileName);
      expect(existsSync(filePath), filePath).toBe(true);
      const started = Date.now(), job = client.importModel({ owner, filePath, modelId: id, mode: 'copy' });
      let current = job;
      while (!terminal(current.status)) {
        await new Promise(resolve => setTimeout(resolve, 250));
        current = client.getSessionSnapshot(owner).resourceJobs.find(candidate => candidate.jobId === job.jobId) ?? current;
        if (Date.now() - started > 180_000) throw new Error(`Import of ${id} did not finish in three minutes.`);
      }
      const listed = (await client.listManagedResources(owner)).find(resource => resource.resourceId === id);
      const resolved = current.status === 'completed' ? await client.resolveManagedModel(id) : undefined;
      results.push({ id, status: current.status, error: current.error ?? null, listed: listed?.status, quantization: listed?.quantization,
        byteSize: resolved?.byteSize, sha256: resolved?.sha256, insideManagedRoot: resolved ? resolved.absolutePath.startsWith(managedResourceRoot + path.sep) : null,
        sourceKept: existsSync(filePath), elapsedMs: Date.now() - started });
      expect(current.status, JSON.stringify(current.error)).toBe('completed');
      expect(listed?.status).toBe('ready');
      expect(resolved).toMatchObject({ id, byteSize: model.byteSize, sha256: model.sha256 });
      expect(existsSync(filePath)).toBe(true);
    }
  } finally {
    await writeFile(path.join(run, 'result.json'), `${JSON.stringify({ sourceDirectory, results }, null, 2)}\n`);
    await Promise.allSettled([service.shutdown(), smoke.shutdown('app_quit')]);
  }
}, 900_000);
