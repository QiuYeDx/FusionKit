export const WHISPER_SAMPLE_RATE = 16_000;
export const WHISPER_N_FFT = 400;
export const WHISPER_HOP_LENGTH = 160;
export const WHISPER_FEATURE_SIZE = 80;
export const WHISPER_CHUNK_LENGTH_SECONDS = 30;
export const WHISPER_MAX_FRAMES = WHISPER_CHUNK_LENGTH_SECONDS * WHISPER_SAMPLE_RATE / WHISPER_HOP_LENGTH;

const SAMPLE_COUNT = WHISPER_CHUNK_LENGTH_SECONDS * WHISPER_SAMPLE_RATE;
const FFT_BINS = WHISPER_N_FFT / 2 + 1;
const MEL_LINEAR_STEP_HZ = 200 / 3;
const MEL_LOG_START_HZ = 1000;
const MEL_LOG_START = MEL_LOG_START_HZ / MEL_LINEAR_STEP_HZ;
const MEL_LOG_STEP = Math.log(6.4) / 27;

function frequencyToMel(frequency: number): number {
  return frequency < MEL_LOG_START_HZ ? frequency / MEL_LINEAR_STEP_HZ
    : MEL_LOG_START + Math.log(frequency / MEL_LOG_START_HZ) / MEL_LOG_STEP;
}

function melToFrequency(mel: number): number {
  return mel < MEL_LOG_START ? MEL_LINEAR_STEP_HZ * mel
    : MEL_LOG_START_HZ * Math.exp(MEL_LOG_STEP * (mel - MEL_LOG_START));
}

function createMelFilters() {
  const maxMel = frequencyToMel(WHISPER_SAMPLE_RATE / 2);
  const melPoints = Array.from({ length: WHISPER_FEATURE_SIZE + 2 }, (_, index) =>
    melToFrequency(maxMel * index / (WHISPER_FEATURE_SIZE + 1)));
  return Array.from({ length: WHISPER_FEATURE_SIZE }, (_, filter) => {
    const left = melPoints[filter]!;
    const center = melPoints[filter + 1]!;
    const right = melPoints[filter + 2]!;
    const binWidth = WHISPER_SAMPLE_RATE / WHISPER_N_FFT;
    const firstBin = Math.ceil(left / binWidth);
    const lastBin = Math.min(FFT_BINS - 1, Math.floor(right / binWidth));
    const areaScale = 2 / (right - left);
    const weights = Float32Array.from({ length: lastBin - firstBin + 1 }, (_, index) => {
      const frequency = (firstBin + index) * binWidth;
      const rising = (frequency - left) / (center - left);
      const falling = (right - frequency) / (right - center);
      return Math.max(0, Math.min(rising, falling)) * areaScale;
    });
    return { firstBin, weights };
  });
}

const MEL_FILTERS = createMelFilters();
const WINDOW = Float32Array.from({ length: WHISPER_N_FFT }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / WHISPER_N_FFT));
const COSINES = new Float64Array(FFT_BINS * WHISPER_N_FFT);
const SINES = new Float64Array(COSINES.length);
for (let bin = 0; bin < FFT_BINS; bin += 1) {
  for (let sample = 0; sample < WHISPER_N_FFT; sample += 1) {
    const angle = 2 * Math.PI * bin * sample / WHISPER_N_FFT;
    const index = bin * WHISPER_N_FFT + sample;
    COSINES[index] = Math.cos(angle);
    SINES[index] = Math.sin(angle);
  }
}

function powerSpectrum(frame: Float32Array, spectrum: Float32Array): void {
  for (let bin = 0; bin < FFT_BINS; bin += 1) {
    let real = 0;
    let imaginary = 0;
    const offset = bin * WHISPER_N_FFT;
    for (let sample = 0; sample < WHISPER_N_FFT; sample += 1) {
      const value = frame[sample]!;
      real += value * COSINES[offset + sample]!;
      imaginary -= value * SINES[offset + sample]!;
    }
    spectrum[bin] = real * real + imaginary * imaginary;
  }
}

/** Compute the CPU log-mel layout expected by the Whisper VAD ONNX graph. */
export function computeWhisperLogMel(audio: Float32Array, frameCount = WHISPER_MAX_FRAMES): Float32Array {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > WHISPER_MAX_FRAMES)
    throw new RangeError('Frame count must be in the Whisper window.');
  const mel = new Float32Array(WHISPER_FEATURE_SIZE * frameCount);
  const frame = new Float32Array(WHISPER_N_FFT);
  const spectrum = new Float32Array(FFT_BINS);
  const source = audio.subarray(0, SAMPLE_COUNT);
  for (let time = 0; time < frameCount; time += 1) {
    const start = time * WHISPER_HOP_LENGTH - WHISPER_N_FFT / 2;
    if (start >= source.length || source.length === 0) {
      for (let filter = 0; filter < WHISPER_FEATURE_SIZE; filter += 1) mel[filter * frameCount + time] = -10;
      continue;
    }
    for (let sample = 0; sample < WHISPER_N_FFT; sample += 1) {
      // Whisper zero-pads the PCM to 30 s before the centered STFT reflects its edges.
      const index = start + sample;
      const reflected = index < 0 ? -index : index >= SAMPLE_COUNT ? 2 * SAMPLE_COUNT - index - 2 : index;
      frame[sample] = (source[reflected] ?? 0) * WINDOW[sample]!;
    }
    powerSpectrum(frame, spectrum);
    for (let filter = 0; filter < WHISPER_FEATURE_SIZE; filter += 1) {
      const { firstBin, weights } = MEL_FILTERS[filter]!;
      let energy = 0;
      for (let index = 0; index < weights.length; index += 1) energy += weights[index]! * spectrum[firstBin + index]!;
      mel[filter * frameCount + time] = Math.log10(Math.max(energy, 1e-10));
    }
  }
  let maximum = -Infinity;
  for (const value of mel) maximum = Math.max(maximum, value);
  for (let index = 0; index < mel.length; index += 1) mel[index] = (Math.max(mel[index]!, maximum - 8) + 4) / 4;
  return mel;
}
