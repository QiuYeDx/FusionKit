export interface RecordedWavChunk {
  requestId: string;
  bytes: Uint8Array;
  startedAtMs: number;
  endedAtMs: number;
  sampleRate: number;
}

export interface WavChunkRecorderOptions {
  chunkDurationMs?: number;
  minFinalChunkMs?: number;
  onChunk: (chunk: RecordedWavChunk) => void | Promise<void>;
  onError?: (error: Error) => void;
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
}

export class WavChunkRecorder {
  private readonly chunkDurationMs: number;
  private readonly minFinalChunkMs: number;
  private readonly onChunk: WavChunkRecorderOptions["onChunk"];
  private readonly onError?: WavChunkRecorderOptions["onError"];
  private readonly getUserMedia?: WavChunkRecorderOptions["getUserMedia"];
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private sampleQueue: Float32Array[] = [];
  private queuedSampleCount = 0;
  private chunkStartedAtMs = 0;
  private stopped = true;

  constructor(options: WavChunkRecorderOptions) {
    this.chunkDurationMs = options.chunkDurationMs ?? 5000;
    this.minFinalChunkMs = options.minFinalChunkMs ?? 800;
    this.onChunk = options.onChunk;
    this.onError = options.onError;
    this.getUserMedia = options.getUserMedia;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.sampleQueue = [];
    this.queuedSampleCount = 0;
    this.chunkStartedAtMs = 0;

    const AudioContextCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("Web Audio API is not available.");
    }

    this.stream = await (this.getUserMedia ?? navigator.mediaDevices.getUserMedia)({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.audioContext = new AudioContextCtor();
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      if (this.stopped || !this.audioContext) return;
      try {
        this.enqueueInputBuffer(event.inputBuffer);
        this.flushFullChunks();
      } catch (error) {
        this.onError?.(
          error instanceof Error
            ? error
            : new Error("Failed to process recorded audio chunk."),
        );
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.flushFinalChunk();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    await this.audioContext?.close();
    this.audioContext = null;
    this.sampleQueue = [];
    this.queuedSampleCount = 0;
  }

  private enqueueInputBuffer(buffer: AudioBuffer): void {
    const sampleCount = buffer.length;
    const mono = new Float32Array(sampleCount);
    const channelCount = Math.max(1, buffer.numberOfChannels);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = buffer.getChannelData(channel);
      for (let index = 0; index < sampleCount; index += 1) {
        mono[index] += channelData[index] / channelCount;
      }
    }
    this.sampleQueue.push(mono);
    this.queuedSampleCount += mono.length;
  }

  private flushFullChunks(): void {
    if (!this.audioContext) return;
    const targetSamples = Math.max(
      1,
      Math.floor(this.audioContext.sampleRate * (this.chunkDurationMs / 1000)),
    );
    while (this.queuedSampleCount >= targetSamples) {
      const startedAtMs = this.chunkStartedAtMs;
      const endedAtMs = startedAtMs + this.chunkDurationMs;
      const samples = this.drainSamples(targetSamples);
      this.chunkStartedAtMs = endedAtMs;
      void this.emitChunk(samples, startedAtMs, endedAtMs);
    }
  }

  private async flushFinalChunk(): Promise<void> {
    if (!this.audioContext || this.queuedSampleCount === 0) return;
    const minSamples = Math.floor(
      this.audioContext.sampleRate * (this.minFinalChunkMs / 1000),
    );
    if (this.queuedSampleCount < minSamples) {
      this.sampleQueue = [];
      this.queuedSampleCount = 0;
      return;
    }
    const startedAtMs = this.chunkStartedAtMs;
    const durationMs = Math.round(
      (this.queuedSampleCount / this.audioContext.sampleRate) * 1000,
    );
    const samples = this.drainSamples(this.queuedSampleCount);
    await this.emitChunk(samples, startedAtMs, startedAtMs + durationMs);
  }

  private drainSamples(count: number): Float32Array {
    const output = new Float32Array(count);
    let offset = 0;
    while (offset < count && this.sampleQueue.length > 0) {
      const first = this.sampleQueue[0];
      const remaining = count - offset;
      if (first.length <= remaining) {
        output.set(first, offset);
        offset += first.length;
        this.sampleQueue.shift();
      } else {
        output.set(first.subarray(0, remaining), offset);
        this.sampleQueue[0] = first.subarray(remaining);
        offset += remaining;
      }
    }
    this.queuedSampleCount -= count;
    return output;
  }

  private async emitChunk(
    samples: Float32Array,
    startedAtMs: number,
    endedAtMs: number,
  ): Promise<void> {
    if (!this.audioContext || samples.length === 0) return;
    await this.onChunk({
      requestId: createChunkRequestId(),
      bytes: encodeWavPcm16(samples, this.audioContext.sampleRate),
      startedAtMs,
      endedAtMs,
      sampleRate: this.audioContext.sampleRate,
    });
  }
}

function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function createChunkRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `caption_chunk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
