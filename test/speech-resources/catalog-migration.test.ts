import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SPEECH_MIGRATION_RESOURCES } from '../../electron/main/speech-resources/catalog-migration';
import { SPEECH_CUDA_MANIFEST, SPEECH_CUDA_PACK_DEFINITION, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../../electron/main/speech-resources/catalog';
import { LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION } from '../../electron/main/speech-resources/engine/vad-manager';
import legacyVad from '../../resources/speech-resources/migration/legacy/local-subtitle-vad.v1.json';
import studioVad from '../../resources/speech-resources/migration/studio/subtitle-studio-vad.v1.json';
import legacyCuda from '../../resources/speech-resources/migration/legacy/local-subtitle-windows-cuda-pack.v1.json';
import studioCuda from '../../resources/speech-resources/migration/studio/subtitle-studio-windows-cuda-pack.v1.json';

const jsonBytes = (x: unknown) => Buffer.from(`${JSON.stringify(x, null, 2)}\n`);
const hash = (x: Uint8Array) => createHash('sha256').update(x).digest('hex');
describe('production fixed speech migration catalog', () => {
  it('includes both model generations and exactly the two authorized historical roots', () => {
    expect(SPEECH_MIGRATION_RESOURCES.map(r => r.id)).toEqual(['large-v3-q5_0', 'large-v3', 'silero-vad-v6.2.0-ggml', 'speech-windows-x64-cuda-12.4-v1']);
    for (const resource of SPEECH_MIGRATION_RESOURCES) expect(resource.sources.map(s => s.root)).toEqual(['local-subtitle', 'subtitle-studio/transcription']);
    for (const model of SPEECH_MODEL_MANIFEST.models) {
      const resource = SPEECH_MIGRATION_RESOURCES.find(r => r.id === model.id)!;
      expect(resource.relativeDirectory).toBe(`models/${model.id}`);
      expect(resource.files).toEqual([{ relativePath: model.fileName, byteSize: model.byteSize, sha256: model.sha256 }]);
      for (const source of resource.sources) expect(source.files).toEqual(resource.files);
    }
  });

  it('matches the actual whole-manifest VAD installation receipt, including terminal LF', () => {
    const resource = SPEECH_MIGRATION_RESOURCES.find(r => r.id === SPEECH_VAD_MANIFEST.vad.id)!;
    const receipt = resource.files.find(f => f.relativePath === 'manifest.json')!;
    expect(Buffer.from(receipt.contents!)).toEqual(LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.manifestBytes);
    expect(Buffer.from(receipt.contents!)).toEqual(jsonBytes(SPEECH_VAD_MANIFEST));
    expect(receipt.sha256).not.toBe(hash(jsonBytes(SPEECH_VAD_MANIFEST.vad)));
    for (const [i, manifest] of [legacyVad, studioVad].entries()) {
      expect(resource.sources[i]!.files.find(f => f.relativePath === 'manifest.json')).toEqual({ relativePath: 'manifest.json', byteSize: jsonBytes(manifest).length, sha256: hash(jsonBytes(manifest)) });
    }
  });

  it('preserves all 20 CUDA binary hashes and changes only fixed small metadata', () => {
    const resource = SPEECH_MIGRATION_RESOURCES.find(r => r.id === SPEECH_CUDA_PACK_DEFINITION.resourceId)!;
    const native = resource.files.filter(f => f.contents === undefined);
    expect(native).toHaveLength(20); expect(resource.relativeDirectory).toBe('accelerators/speech-windows-x64-cuda-12.4-v1');
    const receipt = resource.files.find(f => f.contents !== undefined)!;
    expect(receipt.relativePath).toBe('manifests/speech-windows-cuda-pack.v1.json');
    expect(Buffer.from(receipt.contents!)).toEqual(SPEECH_CUDA_PACK_DEFINITION.manifestBytes);
    expect(Buffer.from(receipt.contents!)).toEqual(jsonBytes(SPEECH_CUDA_MANIFEST));
    for (const [i, manifest] of [legacyCuda, studioCuda].entries()) {
      const source = resource.sources[i]!;
      expect(source.relativeDirectory).toBe(`accelerators/${manifest.packId}`);
      expect(source.files.filter(f => !f.relativePath.startsWith('manifests/'))).toEqual(native);
      const metadata = source.files.find(f => f.relativePath === manifest.staging.manifestRelativePath)!;
      expect(metadata.sha256).toBe(hash(jsonBytes(manifest)));
      expect(metadata.contents).toBeUndefined(); expect(metadata.byteSize).toBe(jsonBytes(manifest).length);
    }
  });

  it('provides no binary contents or runtime/path escape authority in migration descriptors', () => {
    for (const resource of SPEECH_MIGRATION_RESOURCES) {
      expect(Object.isFrozen(resource)).toBe(true);
      for (const f of resource.files) if (f.contents !== undefined) {
        expect(f.relativePath.endsWith('.json')).toBe(true); expect(f.byteSize).toBeLessThan(1024 * 1024);
        expect(f.contents.byteLength).toBe(f.byteSize); expect(hash(f.contents)).toBe(f.sha256);
      }
      for (const f of [...resource.files, ...resource.sources.flatMap(s => s.files)]) expect(f.relativePath).not.toMatch(/(?:^\/|\\|(?:^|\/)\.\.(?:\/|$))/);
      for (const source of resource.sources) expect(source.files.every(f => f.contents === undefined)).toBe(true);
    }
  });
});
