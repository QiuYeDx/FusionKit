import { describe, expect, it } from "vitest";
import {
  AUDIO_IPC_CHANNELS,
  AUDIO_PRELOAD_INTERNAL_CHANNELS,
} from "@/type/audioIpc";
import { isPublicAudioIpcChannel } from "../../electron/preload/audio-channel-policy";

describe("audio preload channel policy", () => {
  it("allows every public audio channel", () => {
    for (const channel of Object.values(AUDIO_IPC_CHANNELS)) {
      expect(isPublicAudioIpcChannel(channel)).toBe(true);
    }
  });

  it("rejects internal and prefix-confusable channels", () => {
    for (const channel of Object.values(AUDIO_PRELOAD_INTERNAL_CHANNELS)) {
      expect(isPublicAudioIpcChannel(channel)).toBe(false);
    }
    expect(isPublicAudioIpcChannel("audio:internal:authorize-input-file"))
      .toBe(false);
    expect(isPublicAudioIpcChannel("audio:internal:revoke-input-file"))
      .toBe(false);
    expect(isPublicAudioIpcChannel("audio:transcribe:unexpected"))
      .toBe(false);
    expect(isPublicAudioIpcChannel("not-audio:transcribe"))
      .toBe(false);
  });
});
