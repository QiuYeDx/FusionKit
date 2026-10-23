import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import modelSource from '../../../resources/speech-resources/migration/legacy/local-subtitle-models.v1.json';
import vadSource from '../../../resources/speech-resources/migration/legacy/local-subtitle-vad.v1.json';
import cudaSource from '../../../resources/speech-resources/migration/legacy/local-subtitle-windows-cuda-pack.v1.json';
import studioCudaSource from '../../../resources/speech-resources/migration/studio/subtitle-studio-windows-cuda-pack.v1.json';
import {
  SPEECH_CUDA_MANIFEST, SPEECH_CUDA_PACK_DEFINITION, SPEECH_CUDA_RESOURCE_ID,
  SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST, canonicalResourceId,
} from '../../../electron/main/speech-resources/catalog';
import { parseLocalSubtitleAcceleratorManifest } from '../../../electron/main/speech-resources/engine/accelerator-manifest';
import { LocalSubtitleModelManager } from '../../../electron/main/speech-resources/engine/model-manager';
import { localSubtitleSessionSnapshotSchema } from '../../../src/speech-resources/schemas';

describe('neutral resource catalog', () => {
  it('retains the exact fixed model and VAD definitions independently of the retired tool', () => {
    // Later models are appended; the historical pins keep their values and order.
    const { models, ...engine } = SPEECH_MODEL_MANIFEST;
    expect({ ...engine, models: models.slice(0, modelSource.models.length) }).toEqual(modelSource);
    expect(SPEECH_VAD_MANIFEST).toEqual(vadSource);
  });

  it('pins the later models to reviewed revisions without changing the recommended default', () => {
    const added = SPEECH_MODEL_MANIFEST.models.slice(modelSource.models.length);
    expect(added.map(model => [model.id, model.fileName, model.byteSize, model.sha256, model.ggml.headerInt32Le.at(-3), model.ggml.headerInt32Le.at(-1)])).toEqual([
      ['large-v3-turbo-q8_0', 'ggml-large-v3-turbo-q8_0.bin', 874_188_075, '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1', 4, 2_007],
      ['belle-large-v3-turbo-zh', 'ggml-belle-large-v3-turbo-zh.bin', 1_624_555_275, '2a3bba5bfdb4d4da3d9949a83b405711727ca1941d4d5810895e077eb3cb4d99', 4, 1],
      ['anime-whisper-q8_0', 'ggml-anime-whisper-q8_0.bin', 818_305_955, '6a04b7460bdcf2a16aa568c96dd670070abe553936c82fbbff86fc41d02ac3f3', 2, 2_007],
    ]);
    for (const model of added) {
      expect(model).toMatchObject({ engineCompatibility: 'whisper.cpp-v1.9.1', allowedDownloadHosts: ['huggingface.co', '*.hf.co'],
        bundledInInstaller: false, defaultRecommended: false });
      expect(new URL(model.downloadUrl).pathname).toMatch(new RegExp(`^/[^/]+/[^/]+/resolve/${model.sourceRevision}/[^/]+$`));
    }
    expect(SPEECH_MODEL_MANIFEST.models.filter(model => model.defaultRecommended).map(model => model.id)).toEqual(['large-v3-q5_0']);
  });

  it('changes only CUDA package identity and metadata path, retaining every payload pin', () => {
    const expected = structuredClone(cudaSource);
    expected.packId = SPEECH_CUDA_RESOURCE_ID;
    expected.staging.manifestRelativePath = 'manifests/speech-windows-cuda-pack.v1.json';
    expect(SPEECH_CUDA_MANIFEST).toEqual(expected);
    expect(SPEECH_CUDA_MANIFEST.artifacts).toEqual(studioCudaSource.artifacts);
    expect(SPEECH_CUDA_PACK_DEFINITION.artifacts).toHaveLength(20);
    expect(JSON.parse(SPEECH_CUDA_PACK_DEFINITION.manifestBytes.toString('utf8'))).toEqual(expected);
    expect(createHash('sha256').update(SPEECH_CUDA_PACK_DEFINITION.manifestBytes).digest('hex')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps only the two exact legacy CUDA aliases into the single canonical installation', () => {
    for (const id of [cudaSource.packId, studioCudaSource.packId, SPEECH_CUDA_RESOURCE_ID]) {
      expect(canonicalResourceId(id)).toBe(SPEECH_CUDA_RESOURCE_ID);
    }
    for (const id of ['large-v3', SPEECH_VAD_MANIFEST.vad.id, `${cudaSource.packId}-unknown`, '../models']) {
      expect(canonicalResourceId(id)).toBe(id);
    }
  });

  it('rejects a renamed old manifest or a modified payload pin', () => {
    expect(() => parseLocalSubtitleAcceleratorManifest(cudaSource)).toThrow();
    const changed = structuredClone(SPEECH_CUDA_MANIFEST);
    changed.artifacts[0]!.sha256 = 'a'.repeat(64);
    expect(() => parseLocalSubtitleAcceleratorManifest(changed)).toThrow();
  });

  it('requires real composition to supply both smoke callbacks', () => {
    expect(() => new LocalSubtitleModelManager(undefined as never)).toThrow(TypeError);
    expect(() => new LocalSubtitleModelManager({ smokeModel: async () => undefined } as never)).toThrow(TypeError);
  });

  it('keeps batch and task state outside the resource registry DTO', () => {
    expect(localSubtitleSessionSnapshotSchema.safeParse({ schemaVersion: 1, revision: 0, batches: [], resourceJobs: [] }).success).toBe(true);
    expect(localSubtitleSessionSnapshotSchema.safeParse({ schemaVersion: 1, revision: 0, batches: [{}], resourceJobs: [] }).success).toBe(false);
  });
});
