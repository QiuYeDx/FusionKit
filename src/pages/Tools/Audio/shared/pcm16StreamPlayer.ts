export class Pcm16StreamPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private pendingChunks: Uint8Array[] = [];
  private startPromise: Promise<void> | null = null;
  private drainResolvers: Array<() => void> = [];
  private sampleRate = 24000;
  private channels = 1;

  async start(sampleRate = 24000, channels = 1): Promise<void> {
    const pendingChunks = this.pendingChunks;
    this.stop();
    this.pendingChunks = pendingChunks;
    this.sampleRate = sampleRate;
    this.channels = channels;
    const AudioContextCtor =
      window.AudioContext ?? (window as any).webkitAudioContext;
    const context = new AudioContextCtor({ sampleRate });
    this.context = context;
    this.nextStartTime = context.currentTime;

    const startPromise = (async () => {
      if (context.state === "suspended") {
        await context.resume();
      }
      if (this.context !== context) return;

      const queued = this.pendingChunks;
      this.pendingChunks = [];
      for (const chunk of queued) {
        this.schedule(chunk, context);
      }
    })();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } catch (error) {
      if (this.context === context) {
        this.stop();
      }
      throw error;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  push(pcmBytes: Uint8Array): void {
    if (pcmBytes.byteLength === 0) return;
    const context = this.context;
    if (!context || this.startPromise) {
      // Copy the view because IPC-backed buffers may be reused after the event.
      this.pendingChunks.push(pcmBytes.slice());
      return;
    }
    this.schedule(pcmBytes, context);
  }

  /** Waits for already scheduled audio to finish without cutting off its tail. */
  async drain(): Promise<void> {
    await this.startPromise;
    const context = this.context;
    if (!context) {
      if (this.pendingChunks.length > 0) {
        throw new Error("PCM audio arrived before the stream player started.");
      }
      return;
    }

    if (this.pendingChunks.length > 0) {
      const queued = this.pendingChunks;
      this.pendingChunks = [];
      for (const chunk of queued) {
        this.schedule(chunk, context);
      }
    }

    if (this.sources.length > 0) {
      await new Promise<void>((resolve) => {
        this.drainResolvers.push(resolve);
      });
    }
    if (this.context === context) {
      this.context = null;
      this.nextStartTime = 0;
      await safeCloseAudioContext(context);
    }
  }

  private schedule(pcmBytes: Uint8Array, context: AudioContext): void {
    if (this.context !== context) return;
    const samples = pcmBytes.byteLength / 2;
    const frames = Math.floor(samples / this.channels);
    if (frames <= 0) return;

    const buffer = context.createBuffer(
      this.channels,
      frames,
      this.sampleRate,
    );
    const view = new DataView(
      pcmBytes.buffer,
      pcmBytes.byteOffset,
      pcmBytes.byteLength,
    );

    for (let channel = 0; channel < this.channels; channel += 1) {
      const channelData = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame += 1) {
        const sampleIndex = frame * this.channels + channel;
        channelData[frame] = view.getInt16(sampleIndex * 2, true) / 32768;
      }
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
      source.disconnect();
      if (this.sources.length === 0) {
        this.resolveDrainWaiters();
      }
    };
  }

  stop(): void {
    this.pendingChunks = [];
    this.startPromise = null;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended.
      }
      source.disconnect();
    }
    this.sources = [];
    const context = this.context;
    this.context = null;
    if (context) {
      void safeCloseAudioContext(context);
    }
    this.nextStartTime = 0;
    this.resolveDrainWaiters();
  }

  private resolveDrainWaiters(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

async function safeCloseAudioContext(context: AudioContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // Teardown is best-effort; a browser may already have closed the context.
  }
}
