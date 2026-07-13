import { describe, expect, it } from "vitest";
import {
  AUDIO_TOOL_RETURN_PATHS,
  createSettingSearchParams,
  resolveAudioSettingsReturnTo,
  resolveSettingTab,
} from "./settingNavigation";

describe("setting navigation", () => {
  it("accepts known tabs and falls back to general", () => {
    expect(resolveSettingTab("audio")).toBe("audio");
    expect(resolveSettingTab("proxy")).toBe("proxy");
    expect(resolveSettingTab("unknown")).toBe("general");
    expect(resolveSettingTab(null)).toBe("general");
  });

  it("allows only exact audio tool return paths", () => {
    for (const path of AUDIO_TOOL_RETURN_PATHS) {
      expect(resolveAudioSettingsReturnTo(path)).toBe(path);
    }
    expect(resolveAudioSettingsReturnTo("/tools/audio/transcriber/extra"))
      .toBeNull();
    expect(resolveAudioSettingsReturnTo("/tools/audio/transcriber?unsafe=1"))
      .toBeNull();
    expect(resolveAudioSettingsReturnTo("//example.test/tools/audio/transcriber"))
      .toBeNull();
    expect(resolveAudioSettingsReturnTo("https://example.test"))
      .toBeNull();
  });

  it("preserves a safe return path and drops an unsafe one", () => {
    const safe = createSettingSearchParams(
      new URLSearchParams(
        "returnTo=%2Ftools%2Faudio%2Fspeech-synthesis&source=tool",
      ),
      "audio",
    );
    expect(safe.get("tab")).toBe("audio");
    expect(safe.get("returnTo")).toBe("/tools/audio/speech-synthesis");
    expect(safe.get("source")).toBe("tool");

    const unsafe = createSettingSearchParams(
      new URLSearchParams("returnTo=https%3A%2F%2Fexample.test"),
      "model",
    );
    expect(unsafe.get("tab")).toBe("model");
    expect(unsafe.has("returnTo")).toBe(false);
  });
});
