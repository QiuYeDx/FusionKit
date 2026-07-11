import { afterEach, describe, expect, it, vi } from "vitest";
import { Pcm16StreamPlayer } from "./pcm16StreamPlayer";

describe("Pcm16StreamPlayer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queues the first chunk until a suspended audio context is ready", async () => {
    let resume!: () => void;
    const resumePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const context = createFakeAudioContext({
      state: "suspended",
      resume: () => resumePromise,
    });
    vi.stubGlobal("window", {
      AudioContext: vi.fn(() => context),
    });

    const player = new Pcm16StreamPlayer();
    const started = player.start();
    player.push(new Uint8Array([0, 0, 1, 0]));

    expect(context.createBuffer).not.toHaveBeenCalled();
    resume();
    await started;
    expect(context.createBuffer).toHaveBeenCalledTimes(1);
  });

  it("drains scheduled tail audio instead of stopping it", async () => {
    const context = createFakeAudioContext();
    vi.stubGlobal("window", {
      AudioContext: vi.fn(() => context),
    });

    const player = new Pcm16StreamPlayer();
    await player.start();
    player.push(new Uint8Array([0, 0, 1, 0]));
    const source = context.sources[0];
    const drained = player.drain();

    expect(source.stop).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    source.onended?.();
    await drained;

    expect(source.stop).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

function createFakeAudioContext(options: {
  state?: AudioContextState;
  resume?: () => Promise<void>;
} = {}) {
  const sources: Array<{
    buffer: AudioBuffer | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }> = [];
  const context = {
    state: options.state ?? "running",
    currentTime: 0,
    destination: {},
    sources,
    resume: vi.fn(options.resume ?? (async () => undefined)),
    close: vi.fn(async () => undefined),
    createBuffer: vi.fn((_channels: number, frames: number, sampleRate: number) => ({
      duration: frames / sampleRate,
      getChannelData: () => new Float32Array(frames),
    })),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    }),
  };
  return context as unknown as AudioContext & { sources: typeof sources };
}
