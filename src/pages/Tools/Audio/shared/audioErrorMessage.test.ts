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

  it("keeps already-localized renderer errors", () => {
    const t = (key: string) => key;
    expect(getAudioErrorMessage(t, { code: "renderer_error" }, "本地校验失败"))
      .toBe("本地校验失败");
  });
});
