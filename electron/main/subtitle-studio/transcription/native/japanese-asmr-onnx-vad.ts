import * as ort from 'onnxruntime-node';
import { computeWhisperLogMel, WHISPER_FEATURE_SIZE, WHISPER_MAX_FRAMES } from '../../../../../src/subtitle-studio/transcription/whisper-log-mel';

export interface JapaneseAsmrOnnxVad {
  readonly inputName: string;
  readonly outputName: string;
  readonly run: (audio: Float32Array) => Promise<Float32Array>;
  readonly release: () => void;
}

export async function createJapaneseAsmrOnnxVad(modelPath: string): Promise<JapaneseAsmrOnnxVad> {
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) throw new Error('The Japanese ASMR VAD model has no input or output tensor.');
  let released = false;
  return {
    inputName,
    outputName,
    async run(audio) {
      if (released) throw new Error('The Japanese ASMR VAD session has been released.');
      const features = computeWhisperLogMel(audio);
      const input = new ort.Tensor('float32', features, [1, WHISPER_FEATURE_SIZE, WHISPER_MAX_FRAMES]);
      const output = await session.run({ [inputName]: input });
      const tensor = output[outputName];
      if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error('The Japanese ASMR VAD output tensor is invalid.');
      return Float32Array.from(tensor.data, value => 1 / (1 + Math.exp(-value)));
    },
    release() { released = true; },
  };
}
