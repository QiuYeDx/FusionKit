export const WHISPER_SAMPLE_RATE = 16_000;
export const WHISPER_N_FFT = 400;
export const WHISPER_HOP_LENGTH = 160;
export const WHISPER_FEATURE_SIZE = 80;
export const WHISPER_CHUNK_LENGTH_SECONDS = 30;
export const WHISPER_MAX_FRAMES = WHISPER_CHUNK_LENGTH_SECONDS * WHISPER_SAMPLE_RATE / WHISPER_HOP_LENGTH;

function reflectIndex(index: number, length: number): number {
  if (length <= 1) return 0;
  let value = index;
  while (value < 0 || value >= length) value = value < 0 ? -value : 2 * length - value - 2;
  return value;
}

function frequencyToMel(frequency: number): number {
  return 2595 * Math.log10(1 + frequency / 700);
}

function melToFrequency(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function createMelFilters(): Float32Array {
  const fftBins = WHISPER_N_FFT / 2 + 1;
  const minMel = frequencyToMel(0);
  const maxMel = frequencyToMel(WHISPER_SAMPLE_RATE / 2);
  const melPoints = Array.from({ length: WHISPER_FEATURE_SIZE + 2 }, (_, index) =>
    melToFrequency(minMel + (maxMel - minMel) * index / (WHISPER_FEATURE_SIZE + 1)));
  const filters = new Float32Array(WHISPER_FEATURE_SIZE * fftBins);
  for (let filter = 0; filter < WHISPER_FEATURE_SIZE; filter += 1) {
    const left = melPoints[filter]!;
    const center = melPoints[filter + 1]!;
    const right = melPoints[filter + 2]!;
    const normalization = 2 / Math.max(right - left, Number.EPSILON);
    for (let bin = 0; bin < fftBins; bin += 1) {
      const frequency = bin * WHISPER_SAMPLE_RATE / WHISPER_N_FFT;
      const rising = (frequency - left) / Math.max(center - left, Number.EPSILON);
      const falling = (right - frequency) / Math.max(right - center, Number.EPSILON);
      filters[filter * fftBins + bin] = Math.max(0, Math.min(rising, falling)) * normalization;
    }
  }
  return filters;
}

const MEL_FILTERS = createMelFilters();
const WINDOW = Float32Array.from({ length: WHISPER_N_FFT }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / WHISPER_N_FFT));

function powerSpectrum(frame: Float32Array): Float32Array {
  const half = WHISPER_N_FFT / 2 + 1;
  const spectrum = new Float32Array(half);
  for (let frequencyBin = 0; frequencyBin < half; frequencyBin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let sample = 0; sample < WHISPER_N_FFT; sample += 1) {
      const angle = 2 * Math.PI * frequencyBin * sample / WHISPER_N_FFT;
      const value = frame[sample]!;
      real += value * Math.cos(angle);
      imaginary -= value * Math.sin(angle);
    }
    spectrum[frequencyBin] = real * real + imaginary * imaginary;
  }
  return spectrum;
}

/** Compute the CPU log-mel layout expected by the Whisper VAD ONNX graph. */
export function computeWhisperLogMel(audio: Float32Array, frameCount = WHISPER_MAX_FRAMES): Float32Array {
  if (frameCount < 1 || !Number.isSafeInteger(frameCount)) throw new RangeError('Frame count must be a positive integer.');
  const sampleCount = WHISPER_CHUNK_LENGTH_SECONDS * WHISPER_SAMPLE_RATE;
  const source = audio.length > sampleCount ? audio.subarray(0, sampleCount) : audio;
  const mel = new Float32Array(WHISPER_FEATURE_SIZE * frameCount);
  const frame = new Float32Array(WHISPER_N_FFT);
  for (let time = 0; time < frameCount; time += 1) {
    const start = time * WHISPER_HOP_LENGTH - WHISPER_N_FFT / 2;
    frame.fill(0);
    for (let sample = 0; sample < WHISPER_N_FFT; sample += 1) {
      const sourceIndex = start + sample;
      frame[sample] = sourceIndex >= 0 && sourceIndex < source.length
        ? source[sourceIndex]!
        : source.length === 0 ? 0 : source[reflectIndex(sourceIndex, source.length)]!;
    }
    const spectrum = powerSpectrum(frame);
    for (let filter = 0; filter < WHISPER_FEATURE_SIZE; filter += 1) {
      let energy = 0;
      for (let bin = 0; bin < WHISPER_N_FFT / 2 + 1; bin += 1) energy += MEL_FILTERS[filter * (WHISPER_N_FFT / 2 + 1) + bin]! * spectrum[bin]!;
      mel[filter * frameCount + time] = Math.log10(Math.max(energy, 1e-10));
    }
  }
  let maximum = -Infinity;
  for (const value of mel) maximum = Math.max(maximum, value);
  for (let index = 0; index < mel.length; index += 1) mel[index] = (Math.max(mel[index]!, maximum - 8) + 4) / 4;
  return mel;
}
