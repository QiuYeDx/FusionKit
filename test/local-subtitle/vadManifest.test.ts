import { describe, expect, it } from "vitest";
import rawVadManifest from "../../resources/local-subtitle/manifests/local-subtitle-vad.v1.json";
import {
  LOCAL_SUBTITLE_VAD_MANIFEST,
  LocalSubtitleVadManifestError,
  parseLocalSubtitleVadManifest,
} from "../../electron/main/local-subtitle/vad-manifest";

describe("local subtitle VAD manifest", () => {
  it("loads the exact frozen PRE-006 Silero resource", () => {
    expect(LOCAL_SUBTITLE_VAD_MANIFEST).toEqual(rawVadManifest);
    expect(LOCAL_SUBTITLE_VAD_MANIFEST.vad).toMatchObject({
      id: "silero-vad-v6.2.0-ggml",
      byteSize: 885_098,
      sha256:
        "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
      allowedDownloadHosts: ["raw.githubusercontent.com"],
      tokenTimestampsAllowed: false,
      timelinePolicy: "mapped_segment_timestamps_only",
    });
    expect(Object.isFrozen(LOCAL_SUBTITLE_VAD_MANIFEST)).toBe(true);
    expect(Object.isFrozen(LOCAL_SUBTITLE_VAD_MANIFEST.vad)).toBe(true);
    expect(
      Object.isFrozen(LOCAL_SUBTITLE_VAD_MANIFEST.vad.allowedDownloadHosts),
    ).toBe(true);
  });

  it("rejects unknown fields at every manifest level", () => {
    const top = fixture();
    (top as Record<string, unknown>).unexpected = true;
    expectFailure(top);

    const engine = fixture();
    (engine.engine as Record<string, unknown>).unexpected = true;
    expectFailure(engine);

    const vad = fixture();
    (vad.vad as Record<string, unknown>).unexpected = true;
    expectFailure(vad);
  });

  it("rejects source, identity, integrity and timeline drift", () => {
    const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
      (value) => {
        value.engine.commit = "a".repeat(40);
      },
      (value) => {
        value.vad.id = "other-vad";
      },
      (value) => {
        value.vad.downloadUrl = "https://example.com/vad.bin";
      },
      (value) => {
        value.vad.allowedDownloadHosts = ["example.com"];
      },
      (value) => {
        value.vad.byteSize += 1;
      },
      (value) => {
        value.vad.sha256 = "a".repeat(64);
      },
      (value) => {
        value.vad.defaultEnabled = false;
      },
      (value) => {
        value.vad.timelinePolicy = "mapped-segment-timestamps-only" as never;
      },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      expectFailure(value);
    }
  });
});

function fixture(): typeof rawVadManifest {
  return structuredClone(rawVadManifest);
}

function expectFailure(value: unknown): void {
  expect(() => parseLocalSubtitleVadManifest(value)).toThrowError(
    LocalSubtitleVadManifestError,
  );
}
