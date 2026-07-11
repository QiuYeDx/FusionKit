import { afterEach, describe, expect, it, vi } from "vitest";
import { WavChunkRecorder } from "./wavChunkRecorder";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WavChunkRecorder lifecycle", () => {
  it("releases microphone tracks when initialization fails after permission", async () => {
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    class FailingAudioContext {
      constructor() {
        throw new Error("audio context failed");
      }
    }
    vi.stubGlobal("window", {
      AudioContext: FailingAudioContext as unknown as typeof AudioContext,
    });
    const recorder = new WavChunkRecorder({
      getUserMedia: async () => stream,
      onChunk: vi.fn(),
    });

    await expect(recorder.start()).rejects.toThrow("audio context failed");
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("stops recording when an emitted chunk is rejected", async () => {
    const trackStop = vi.fn();
    const contextClose = vi.fn(async () => undefined);
    const processor = {
      onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      sampleRate: 1000,
      destination: {},
      createMediaStreamSource: vi.fn(() => source),
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => gain),
      close: contextClose,
    };
    vi.stubGlobal("window", {
      AudioContext: vi.fn(() => context),
    });
    const onError = vi.fn();
    const recorder = new WavChunkRecorder({
      chunkDurationMs: 1,
      getUserMedia: async () => ({
        getTracks: () => [{ stop: trackStop }],
      } as unknown as MediaStream),
      onChunk: async () => {
        throw new Error("queue rejected chunk");
      },
      onError,
    });
    await recorder.start();

    processor.onaudioprocess?.({
      inputBuffer: {
        length: 1,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0.25]),
      },
    } as unknown as AudioProcessingEvent);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "queue rejected chunk" }),
      );
      expect(trackStop).toHaveBeenCalledTimes(1);
      expect(contextClose).toHaveBeenCalledTimes(1);
    });
  });
});
