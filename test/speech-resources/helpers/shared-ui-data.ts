import { createHash } from 'node:crypto';
import { SPEECH_MODEL_MANIFEST } from '../../../electron/main/speech-resources/catalog';
import type { SpeechMigrationResource } from '../../../electron/main/speech-resources/migration';

/** Synthetic UI bytes: correct fixed GGML header, tiny payload; never an ASR model. */
export const UI_MODELS = SPEECH_MODEL_MANIFEST.models.map((model, ordinal) => {
  const bytes = Buffer.alloc(256 + ordinal * 64, 0x5a);
  Buffer.from(model.ggml.magicHex, 'hex').copy(bytes);
  model.ggml.headerInt32Le.forEach((value, index) => bytes.writeInt32LE(value, 4 + index * 4));
  return { model: { ...model, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, bytes };
});
export const UI_MIGRATION: readonly SpeechMigrationResource[] = UI_MODELS.map(({ model }) => {
  const files = [{ relativePath: model.fileName, byteSize: model.byteSize, sha256: model.sha256 }];
  return { id: model.id, relativeDirectory: `models/${model.id}`, files,
    sources: [{ root: 'local-subtitle', relativeDirectory: `models/${model.id}`, files },
      { root: 'subtitle-studio/transcription', relativeDirectory: `models/${model.id}`, files }] };
});
