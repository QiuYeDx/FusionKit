import { createHash } from 'node:crypto';
import legacyModels from '../../../resources/speech-resources/migration/legacy/local-subtitle-models.v1.json';
import legacyVad from '../../../resources/speech-resources/migration/legacy/local-subtitle-vad.v1.json';
import legacyCuda from '../../../resources/speech-resources/migration/legacy/local-subtitle-windows-cuda-pack.v1.json';
import studioModels from '../../../resources/speech-resources/migration/studio/subtitle-studio-models.v1.json';
import studioVad from '../../../resources/speech-resources/migration/studio/subtitle-studio-vad.v1.json';
import studioCuda from '../../../resources/speech-resources/migration/studio/subtitle-studio-windows-cuda-pack.v1.json';
import { SPEECH_CUDA_MANIFEST, SPEECH_CUDA_PACK_DEFINITION, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from './catalog';
import type { SpeechMigrationFile, SpeechMigrationResource, SpeechMigrationSourceRoot } from './migration';

const sources = [
  { root: 'local-subtitle' as const, models: legacyModels, vad: legacyVad, cuda: legacyCuda },
  { root: 'subtitle-studio/transcription' as const, models: studioModels, vad: studioVad, cuda: studioCuda },
];
const exactJsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
function metadata(relativePath: string, value: unknown, canonical = false): SpeechMigrationFile {
  const contents = exactJsonBytes(value);
  return Object.freeze({ relativePath, byteSize: contents.length, sha256: createHash('sha256').update(contents).digest('hex'),
    ...(canonical ? { contents } : {}) });
}
function payload(relativePath: string, definition: { byteSize: number; sha256: string }): SpeechMigrationFile {
  return Object.freeze({ relativePath, byteSize: definition.byteSize, sha256: definition.sha256 });
}
function assertPayload(actual: { byteSize: number; sha256: string } | undefined, expected: { byteSize: number; sha256: string }) {
  if (!actual || actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256) throw new TypeError('The fixed source resource is incompatible with the shared catalog.');
}
function freezeResource(resource: SpeechMigrationResource): SpeechMigrationResource {
  return Object.freeze({ ...resource, files: Object.freeze([...resource.files]), sources: Object.freeze(resource.sources.map(source =>
    Object.freeze({ ...source, files: Object.freeze([...source.files]) }))) });
}

/** Fixed historical data only: no imports from either tool's resource manager or runtime. */
export const SPEECH_MIGRATION_RESOURCES: readonly SpeechMigrationResource[] = Object.freeze([
  ...SPEECH_MODEL_MANIFEST.models.map(model => freezeResource({
    id: model.id,
    relativeDirectory: `models/${model.id}`,
    // Managed model installations contain the one model file; they have no manifest sidecar.
    files: [payload(model.fileName, model)],
    sources: sources.map(source => {
      const previous = source.models.models.find(candidate => candidate.id === model.id);
      assertPayload(previous, model);
      if (previous!.fileName !== model.fileName) throw new TypeError('The fixed model payload path changed.');
      return { root: source.root, relativeDirectory: `models/${previous!.id}`, files: [payload(previous!.fileName, previous!)] };
    }),
  })),
  freezeResource({
    id: SPEECH_VAD_MANIFEST.vad.id,
    relativeDirectory: `vad/${SPEECH_VAD_MANIFEST.vad.id}`,
    files: [payload(SPEECH_VAD_MANIFEST.vad.fileName, SPEECH_VAD_MANIFEST.vad), metadata('manifest.json', SPEECH_VAD_MANIFEST, true)],
    sources: sources.map(source => {
      assertPayload(source.vad.vad, SPEECH_VAD_MANIFEST.vad);
      if (source.vad.vad.fileName !== SPEECH_VAD_MANIFEST.vad.fileName) throw new TypeError('The fixed VAD payload path changed.');
      return { root: source.root, relativeDirectory: `vad/${source.vad.vad.id}`,
        // Both historical managers serialized the complete VAD manifest, not only its vad entry.
        files: [payload(source.vad.vad.fileName, source.vad.vad), metadata('manifest.json', source.vad)] };
    }),
  }),
  freezeResource({
    id: SPEECH_CUDA_PACK_DEFINITION.resourceId,
    relativeDirectory: `accelerators/${SPEECH_CUDA_PACK_DEFINITION.resourceId}`,
    files: [...SPEECH_CUDA_PACK_DEFINITION.artifacts.map(artifact => payload(artifact.relativePath, artifact)),
      metadata(SPEECH_CUDA_PACK_DEFINITION.manifestRelativePath, SPEECH_CUDA_MANIFEST, true)],
    sources: sources.map(source => {
      if (JSON.stringify(source.cuda.engine) !== JSON.stringify(SPEECH_CUDA_MANIFEST.engine)
        || JSON.stringify(source.cuda.target) !== JSON.stringify(SPEECH_CUDA_MANIFEST.target)
        || source.cuda.artifacts.length !== SPEECH_CUDA_PACK_DEFINITION.artifacts.length) throw new TypeError('The fixed CUDA generation is incompatible.');
      for (const artifact of SPEECH_CUDA_PACK_DEFINITION.artifacts) {
        assertPayload(source.cuda.artifacts.find(candidate => candidate.relativePath === artifact.relativePath), artifact);
      }
      return { root: source.root satisfies SpeechMigrationSourceRoot, relativeDirectory: `accelerators/${source.cuda.packId}`,
        files: [...source.cuda.artifacts.map(artifact => payload(artifact.relativePath, artifact)),
          metadata(source.cuda.staging.manifestRelativePath, source.cuda)] };
    }),
  }),
]);
