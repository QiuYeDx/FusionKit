import { describe, expect, it } from "vitest";
import {
  detectCustomSliceLengthIntent,
  resolveTranslationSliceConfig,
} from "./translation-slice-config";

describe("translation slice config", () => {
  it("promotes explicit custom lengths to CUSTOM mode", () => {
    expect(
      resolveTranslationSliceConfig({
        sliceType: "NORMAL",
        customSliceLength: 1200,
      }),
    ).toEqual({
      sliceType: "CUSTOM",
      customSliceLength: 1200,
    });
  });

  it("keeps the requested preset mode when no custom length is present", () => {
    expect(resolveTranslationSliceConfig({ sliceType: "SENSITIVE" })).toEqual({
      sliceType: "SENSITIVE",
      customSliceLength: undefined,
    });
  });

  it("normalizes decimal custom lengths", () => {
    expect(
      resolveTranslationSliceConfig({
        sliceType: "NORMAL",
        customSliceLength: 1200.8,
      }),
    ).toEqual({
      sliceType: "CUSTOM",
      customSliceLength: 1200,
    });
  });

  it("detects Chinese custom slice phrasing from the user message", () => {
    expect(
      resolveTranslationSliceConfig(
        { sliceType: "NORMAL" },
        "/Users/qiuyedx/Documents/字幕/largeTest\n按照1200分词翻译，同路径输出，重名覆盖",
      ),
    ).toEqual({
      sliceType: "CUSTOM",
      customSliceLength: 1200,
    });
  });

  it("detects English token limit phrasing from the user message", () => {
    expect(detectCustomSliceLengthIntent("translate every 1,200 tokens")).toBe(
      1200,
    );
  });
});
