import { describe, expect, it } from "vitest";
import { getAudioErrorMessage } from "./audioErrorMessage";

describe("getAudioErrorMessage", () => {
  it("maps stable IPC codes to localized keys without exposing raw details", () => {
    const t = (key: string) => `translated:${key}`;

    expect(getAudioErrorMessage(t, {
      code: "http_unauthorized",
      field: "apiKey",
    }, "raw provider message")).toBe(
      "translated:audio:runtime_error.unauthorized",
    );
  });

  it.each([
    ["stale_audio_config", "stale_config"],
    ["audio_api_not_configured", "api_not_configured"],
    ["audio_route_not_configured", "route_not_configured"],
    ["audio_route_unverified", "route_unverified"],
    ["invalid_task_parameters", "invalid_parameters"],
  ] as const)("maps %s to its user-facing message", (code, key) => {
    const t = (translationKey: string) => translationKey;

    expect(getAudioErrorMessage(t, { code })).toBe(
      `audio:runtime_error.${key}`,
    );
  });

  it("keeps already-localized renderer errors", () => {
    const t = (key: string) => key;
    expect(getAudioErrorMessage(t, { code: "renderer_error" }, "本地校验失败"))
      .toBe("本地校验失败");
  });
});
