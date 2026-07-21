import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
} from "@/type/localSubtitleIpc";
import {
  assertLegacyLocalSubtitleChannelAllowed,
  isLocalSubtitleEventChannel,
  isProtectedLocalSubtitleChannel,
  isPublicLocalSubtitleIpcChannel,
} from "../../electron/preload/local-subtitle-channel-policy";

describe("local subtitle preload channel policy", () => {
  it("allows every fixed public invoke channel and only those channels", () => {
    for (const channel of Object.values(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
    )) {
      expect(isPublicLocalSubtitleIpcChannel(channel)).toBe(true);
      expect(isProtectedLocalSubtitleChannel(channel)).toBe(true);
    }

    for (const channel of Object.values(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
    )) {
      expect(isPublicLocalSubtitleIpcChannel(channel)).toBe(false);
      expect(isProtectedLocalSubtitleChannel(channel)).toBe(true);
    }

    for (const channel of Object.values(LOCAL_SUBTITLE_EVENT_CHANNELS)) {
      expect(isPublicLocalSubtitleIpcChannel(channel)).toBe(false);
      expect(isProtectedLocalSubtitleChannel(channel)).toBe(true);
    }
  });

  it("keeps event subscription on its exact fixed allowlist", () => {
    for (const channel of Object.values(LOCAL_SUBTITLE_EVENT_CHANNELS)) {
      expect(isLocalSubtitleEventChannel(channel)).toBe(true);
    }

    expect(isLocalSubtitleEventChannel("local-subtitle:task-event:extra"))
      .toBe(false);
    expect(isLocalSubtitleEventChannel("local-subtitle:internal:task-event"))
      .toBe(false);
  });

  it("rejects internal, suffix-confusable, and foreign invoke channels", () => {
    expect(isPublicLocalSubtitleIpcChannel("local-subtitle:enqueue:extra"))
      .toBe(false);
    expect(isPublicLocalSubtitleIpcChannel("local-subtitlex:enqueue"))
      .toBe(false);
    expect(isPublicLocalSubtitleIpcChannel("audio:transcribe")).toBe(false);
    expect(isPublicLocalSubtitleIpcChannel("local-subtitle:")).toBe(false);

    expect(isProtectedLocalSubtitleChannel("local-subtitle:unknown"))
      .toBe(true);
    expect(isProtectedLocalSubtitleChannel("local-subtitlex:unknown"))
      .toBe(false);
  });

  it("blocks the complete namespace from the legacy generic bridge", () => {
    const protectedChannels = [
      ...Object.values(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS),
      ...Object.values(LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS),
      ...Object.values(LOCAL_SUBTITLE_EVENT_CHANNELS),
      "local-subtitle:future-channel",
    ];

    for (const channel of protectedChannels) {
      expect(() => assertLegacyLocalSubtitleChannelAllowed(channel)).toThrow(
        /fixed localSubtitleApi/,
      );
    }

    expect(() => assertLegacyLocalSubtitleChannelAllowed("audio:transcribe"))
      .not.toThrow();
    expect(() => assertLegacyLocalSubtitleChannelAllowed("local-subtitlex:test"))
      .not.toThrow();
  });
});
