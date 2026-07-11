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
  onVolume?: (level: number) => void;
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
}

export interface StopWavChunkRecorderOptions {
  flushFinalChunk?: boolean;
}

export class WavChunkRecorder {
  private readonly chunkDurationMs: number;
  private readonly minFinalChunkMs: number;
  private readonly onChunk: WavChunkRecorderOptions["onChunk"];
  private readonly onError?: WavChunkRecorderOptions["onError"];
  private readonly onVolume?: WavChunkRecorderOptions["onVolume"];
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
  private lifecycleGeneration = 0;
  private stopPromise: Promise<void> | null = null;
  private fatalErrorReported = false;
  private paused = false;

  constructor(options: WavChunkRecorderOptions) {
    this.chunkDurationMs = options.chunkDurationMs ?? 5000;
    this.minFinalChunkMs = options.minFinalChunkMs ?? 800;
    this.onChunk = options.onChunk;
    this.onError = options.onError;
    this.onVolume = options.onVolume;
    this.getUserMedia = options.getUserMedia;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    if (this.stopPromise) {
      await this.stopPromise;
    }
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    this.fatalErrorReported = false;
    this.sampleQueue = [];
    this.queuedSampleCount = 0;
    this.chunkStartedAtMs = 0;
    this.paused = false;

    const AudioContextCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      this.stopped = true;
      throw new Error("Web Audio API is not available.");
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      };
      const stream = this.getUserMedia
        ? await this.getUserMedia(constraints)
        : await navigator.mediaDevices.getUserMedia(constraints);
      if (generation !== this.lifecycleGeneration || this.stopped) {
        stopTracks(stream);
        throw createRecorderAbortError();
      }
      this.stream = stream;
      this.audioContext = new AudioContextCtor();
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;

      this.processor.onaudioprocess = (event) => {
        if (this.stopped || !this.audioContext) return;
        try {
          this.onVolume?.(calculateInputLevel(event.inputBuffer));
          if (this.paused) return;
          this.enqueueInputBuffer(event.inputBuffer);
          this.flushFullChunks();
        } catch (error) {
          this.handleFatalError(error);
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
    } catch (error) {
      this.stopped = true;
      await this.releaseResources();
      throw error;
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async stop(options: StopWavChunkRecorderOptions = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped && !this.hasResources()) return;
    this.lifecycleGeneration += 1;
    this.stopped = true;
    const flushFinalChunk = options.flushFinalChunk ?? true;
    const stopPromise = (async () => {
      try {
        if (flushFinalChunk) {
          await this.flushFinalChunk();
        }
      } finally {
        await this.releaseResources();
      }
    })();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    }
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
      void this.emitChunk(samples, startedAtMs, endedAtMs).catch((error) => {
        this.handleFatalError(error);
      });
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

  private handleFatalError(error: unknown): void {
    if (this.fatalErrorReported || this.stopped) return;
    this.fatalErrorReported = true;
    const normalizedError = error instanceof Error
      ? error
      : new Error("Failed to process recorded audio chunk.");
    try {
      this.onError?.(normalizedError);
    } catch {
      // Error reporting must not prevent media teardown.
    }
    void this.stop({ flushFinalChunk: false }).catch(() => undefined);
  }

  private hasResources(): boolean {
    return Boolean(
      this.audioContext
      || this.stream
      || this.source
      || this.processor
      || this.silentGain,
    );
  }

  private async releaseResources(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
    }
    safeDisconnect(this.processor);
    safeDisconnect(this.source);
    safeDisconnect(this.silentGain);
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    stopTracks(this.stream);
    this.stream = null;
    const context = this.audioContext;
    this.audioContext = null;
    if (context) {
      try {
        await context.close();
      } catch {
        // The browser may already have closed the context.
      }
    }
    this.sampleQueue = [];
    this.queuedSampleCount = 0;
  }
}

function calculateInputLevel(buffer: AudioBuffer): number {
  if (buffer.length === 0 || buffer.numberOfChannels === 0) return 0;
  const samples = buffer.getChannelData(0);
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.min(1, Math.sqrt(sumSquares / samples.length) * 3);
}

function safeDisconnect(node: { disconnect: () => void } | null): void {
  try {
    node?.disconnect();
  } catch {
    // Nodes may already be disconnected by the browser.
  }
}

function stopTracks(stream: Pick<MediaStream, "getTracks"> | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // Tracks may already be stopped by another teardown path.
    }
  }
}

function createRecorderAbortError(): Error {
  const error = new Error("Audio recording start was cancelled.");
  error.name = "AbortError";
  return error;
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
