import manifest from '../../../../resources/speech-resources/manifests/speech-asmr-vad.v1.json';
import { JAPANESE_ASMR_VAD_MODEL_ID } from '../../../../src/subtitle-studio/transcription/japanese-asmr-contract';
import type { LocalSubtitleVadDefinition } from './vad-manager';

export const ASMR_VAD_DEFINITION = Object.freeze({
  resourceId: JAPANESE_ASMR_VAD_MODEL_ID,
  displayName: 'Whisper VAD EncDec ASMR',
  version: manifest.sourceRevision,
  fileName: manifest.fileName,
  downloadUrl: manifest.downloadUrl,
  allowedDownloadHosts: Object.freeze(['huggingface.co', '*.hf.co']),
  byteSize: manifest.byteSize,
  sha256: manifest.sha256,
  isDefault: false,
  manifestFileName: 'manifest.json',
  manifestBytes: Buffer.from(JSON.stringify(manifest), 'utf8'),
} satisfies LocalSubtitleVadDefinition);
