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
    expect(SPEECH_MODEL_MANIFEST).toEqual(modelSource);
    expect(SPEECH_VAD_MANIFEST).toEqual(vadSource);
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
