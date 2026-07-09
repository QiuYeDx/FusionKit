export class Pcm16StreamPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private sampleRate = 24000;
  private channels = 1;

  async start(sampleRate = 24000, channels = 1): Promise<void> {
    this.stop();
    this.sampleRate = sampleRate;
    this.channels = channels;
    const AudioContextCtor =
      window.AudioContext ?? (window as any).webkitAudioContext;
    this.context = new AudioContextCtor({ sampleRate });
    this.nextStartTime = this.context.currentTime;
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  push(pcmBytes: Uint8Array): void {
    if (!this.context || pcmBytes.byteLength === 0) return;
    const samples = pcmBytes.byteLength / 2;
    const frames = Math.floor(samples / this.channels);
    if (frames <= 0) return;

    const buffer = this.context.createBuffer(
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

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
      source.disconnect();
    };
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended.
      }
      source.disconnect();
    }
    this.sources = [];
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
    this.nextStartTime = 0;
  }
}
