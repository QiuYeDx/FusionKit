// Selection for the real-audio A/B comparison. Pure: it reads only the given environment.
import path from 'node:path';

export const ASR_AB_VARIANTS = ['standard', 'quiet_whisper_v1', 'noisy_music_v1'] as const;
export type AsrAbVariant = typeof ASR_AB_VARIANTS[number];
export type AsrAbDevice = 'cuda' | 'cpu';

/** A repository review sample is pinned by bytes; an external one is found by name in the user's folder. */
export type AsrAbSampleDefinition = { id: string; language: 'ja' | 'zh'; description: string } & (
  | { kind: 'review'; relativePath: string; byteSize: number; sha256: string }
  | { kind: 'external'; matches: (fileName: string) => boolean });

/** The six samples of the T08 comparison (same hashes) and the user's long BGM/drama samples on E:. */
export const ASR_AB_SAMPLES: readonly AsrAbSampleDefinition[] = Object.freeze([
  { id: 'A', kind: 'review', language: 'ja', description: '30 s 日语 ASMR', relativePath: 'vad-baseline-isolated/A.wav', byteSize: 960078, sha256: '196a524c3805cdc5cccd9711711220bc5591c04906be442c6fa00955874798c5' },
  { id: 'B', kind: 'review', language: 'ja', description: '30 s 日语 ASMR（低音量）', relativePath: 'vad-baseline-isolated/B.wav', byteSize: 960078, sha256: '43e4541f77f7c9e0b9351431da61ff6912814f963159b17d5a51b1ba3b14bd93' },
  { id: 'C', kind: 'review', language: 'ja', description: '30 s 日语 ASMR', relativePath: 'vad-baseline-isolated/C.wav', byteSize: 960078, sha256: 'e57ad65505ebb1e8042939cb71023807d6761810c112fdcefc2653c54433b8b7' },
  { id: 'B-noise', kind: 'review', language: 'ja', description: '18 s 非语音负对照', relativePath: 'annotation-followup/B-noise.wav', byteSize: 576078, sha256: '2f979f0bbb50c3a3896cee437e9b9ea7bd7745bb55bbd4b6decf24280da0d510' },
  { id: 'independent', kind: 'review', language: 'ja', description: '176 s 日语', relativePath: 'phase12/final-separators-production/app-inputs-isolated/independent.wav', byteSize: 5631844, sha256: '9c80350769700f72edc5bd7e7428122f42b1c8eede81967dbe723e5fb7c4fc10' },
  { id: 'full', kind: 'review', language: 'ja', description: '216 s 日语', relativePath: 'phase12/final-separators-production/app-inputs-isolated/full.wav', byteSize: 83025744, sha256: '9ae30957514dd75faa08464f3aeee6025cb2d9bdb98ae98bd703649451ded527' },
  { id: 'drama', kind: 'external', language: 'ja', description: '753 s 日语广播剧', matches: name => name.startsWith('01.') && name.toLowerCase().endsWith('.wav') },
  { id: 'pv-zh', kind: 'external', language: 'zh', description: '游戏 PV 中文配音（BGM 重）', matches: name => name.includes(' p01 ') && name.toLowerCase().endsWith('.mp4') },
  { id: 'pv-ja', kind: 'external', language: 'ja', description: '游戏 PV 日语配音（BGM 重）', matches: name => name.includes(' p02 ') && name.toLowerCase().endsWith('.mp4') },
]);

export const ASR_AB_BUDGET = Object.freeze({ caseMs: 20 * 60_000, startupMs: 120_000, cleanupMs: 45_000, resourcesMs: 10 * 60_000 });

export interface AsrAbSelection {
  sampleIds: string[]; variants: AsrAbVariant[]; device: AsrAbDevice;
  modelId: string; modelPath?: string; resourceRoot: string; externalRoot: string;
}
type Environment = Readonly<Record<string, string | undefined>>;

export function asrAbEnabled(environment: Environment = process.env) { return environment.FUSIONKIT_ASR_AB === '1'; }

const list = (value: string | undefined) => value?.split(',').map(item => item.trim()).filter(Boolean);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** A downloaded `ggml-<id>.bin` names its own model unless FUSIONKIT_ASR_AB_MODEL says otherwise. */
export function modelIdOfFile(file: string) { return path.basename(file).replace(/\.bin$/iu, '').replace(/^ggml-/iu, ''); }

export function parseAsrAbSelection(environment: Environment = process.env): AsrAbSelection {
  const known = ASR_AB_SAMPLES.map(sample => sample.id);
  const sampleIds = [...new Set(list(environment.FUSIONKIT_ASR_AB_SAMPLES) ?? known)];
  const unknownSamples = sampleIds.filter(id => !known.includes(id));
  if (!sampleIds.length || unknownSamples.length)
    throw new Error(`FUSIONKIT_ASR_AB_SAMPLES must name known samples (${known.join(', ')}); got: ${unknownSamples.join(', ') || '(empty)'}`);
  const variants = [...new Set(list(environment.FUSIONKIT_ASR_AB_VARIANTS) ?? ASR_AB_VARIANTS)] as AsrAbVariant[];
  const unknownVariants = variants.filter(value => !ASR_AB_VARIANTS.includes(value));
  if (!variants.length || unknownVariants.length)
    throw new Error(`FUSIONKIT_ASR_AB_VARIANTS must name ${ASR_AB_VARIANTS.join(', ')}; got: ${unknownVariants.join(', ') || '(empty)'}`);
  const device = environment.FUSIONKIT_ASR_AB_DEVICE || 'cuda';
  if (device !== 'cuda' && device !== 'cpu') throw new Error(`FUSIONKIT_ASR_AB_DEVICE must be cuda or cpu; got: ${device}`);
  const modelPath = environment.FUSIONKIT_ASR_AB_MODEL_PATH ? path.resolve(environment.FUSIONKIT_ASR_AB_MODEL_PATH) : undefined;
  const modelId = environment.FUSIONKIT_ASR_AB_MODEL || (modelPath ? modelIdOfFile(modelPath) : 'large-v3');
  if (!MODEL_ID.test(modelId)) throw new Error(`The A/B model ID is invalid: ${modelId}`);
  const appData = environment.APPDATA ?? path.join(environment.USERPROFILE ?? '', 'AppData', 'Roaming');
  return { sampleIds, variants, device, modelId, ...(modelPath ? { modelPath } : {}),
    resourceRoot: path.resolve(environment.FUSIONKIT_ASR_AB_RESOURCE_ROOT || path.join(appData, 'FusionKit', 'speech-resources')),
    externalRoot: path.resolve(environment.FUSIONKIT_ASR_AB_EXTERNAL_ROOT || 'E:/workspace/fusionkit') };
}

/** Every case may use its whole budget; resource checks and hashing share one more. */
export function asrAbTimeoutMs(selection: Pick<AsrAbSelection, 'sampleIds' | 'variants'>) {
  return selection.sampleIds.length * selection.variants.length * (ASR_AB_BUDGET.caseMs + ASR_AB_BUDGET.cleanupMs) + ASR_AB_BUDGET.resourcesMs;
}
