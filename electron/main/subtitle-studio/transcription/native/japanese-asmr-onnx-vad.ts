import * as ort from 'onnxruntime-node';
import { JAPANESE_ASMR_FRAME_DURATION_MS, JAPANESE_ASMR_SAMPLE_RATE } from '../../../../../src/subtitle-studio/transcription/japanese-asmr-contract';
import { computeWhisperLogMel, WHISPER_CHUNK_LENGTH_SECONDS, WHISPER_FEATURE_SIZE, WHISPER_MAX_FRAMES } from '../../../../../src/subtitle-studio/transcription/whisper-log-mel';

const INPUT = 'input_features';
const OUTPUT = 'frame_logits';
const SAMPLES_PER_FRAME = JAPANESE_ASMR_FRAME_DURATION_MS * JAPANESE_ASMR_SAMPLE_RATE / 1000;
const WINDOW_SAMPLES = WHISPER_CHUNK_LENGTH_SECONDS * JAPANESE_ASMR_SAMPLE_RATE;
const WINDOW_FRAMES = WINDOW_SAMPLES / SAMPLES_PER_FRAME;

export interface JapaneseAsmrOnnxVad {
  readonly inputName: string;
  readonly outputName: string;
  readonly run: (audio: Float32Array) => Promise<Float32Array>;
  readonly release: () => Promise<void>;
}

export async function createJapaneseAsmrOnnxVad(modelPath: string): Promise<JapaneseAsmrOnnxVad> {
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 4 });
  if (session.inputNames.length !== 1 || session.inputNames[0] !== INPUT
    || session.outputNames.length !== 1 || session.outputNames[0] !== OUTPUT) {
    await session.release();
    throw new Error('The Japanese ASMR VAD model has unexpected inputs or outputs.');
  }
  let activeRun: Promise<Float32Array> | undefined;
  let release: Promise<void> | undefined;

  async function infer(audio: Float32Array) {
    const features = computeWhisperLogMel(audio);
    const input = new ort.Tensor('float32', features, [1, WHISPER_FEATURE_SIZE, WHISPER_MAX_FRAMES]);
    const output = await session.run({ [INPUT]: input });
    const tensor = output[OUTPUT];
    if (!tensor || !(tensor.data instanceof Float32Array) || tensor.dims.length !== 2
      || tensor.dims[0] !== 1 || tensor.dims[1] !== WINDOW_FRAMES || !tensor.data.every(Number.isFinite))
      throw new Error('The Japanese ASMR VAD output tensor is invalid.');
    const validFrames = Math.ceil(audio.length / SAMPLES_PER_FRAME);
    return Float32Array.from(tensor.data.subarray(0, validFrames), logit => 1 / (1 + Math.exp(-logit)));
  }

  return {
    inputName: INPUT,
    outputName: OUTPUT,
    async run(audio) {
      if (release) throw new Error('The Japanese ASMR VAD session has been released.');
      if (activeRun) throw new Error('The Japanese ASMR VAD session already has an active inference.');
      if (audio.length > WINDOW_SAMPLES || !audio.every(Number.isFinite)) throw new RangeError('Invalid Japanese ASMR VAD PCM window.');
      if (!audio.length) return new Float32Array();
      activeRun = infer(audio);
      try { return await activeRun; }
      finally { activeRun = undefined; }
    },
    release() {
      const pending = activeRun;
      return release ??= (async () => {
        await pending?.catch(() => undefined);
        await session.release();
      })();
    },
  };
}
