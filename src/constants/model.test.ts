import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_MODEL_KEY,
  DEEPSEEK_MODEL_OPTIONS,
  OPENAI_MODEL_OPTIONS,
  inferContextWindowSize,
} from "@/constants/model";

describe("model presets and context windows", () => {
  it("uses the newest OpenAI preset as the default", () => {
    expect(DEFAULT_OPENAI_MODEL_KEY).toBe("gpt-5.5");
    expect(OPENAI_MODEL_OPTIONS[0]).toMatchObject({
      value: "gpt-5.5",
      contextWindow: 1_050_000,
    });
  });

  it("keeps OpenAI preset context windows aligned with official defaults", () => {
    expect(inferContextWindowSize("gpt-5.5")).toBe(1_050_000);
    expect(inferContextWindowSize("gpt-5.5-pro")).toBe(1_050_000);
    expect(inferContextWindowSize("gpt-5.4")).toBe(1_050_000);
    expect(inferContextWindowSize("gpt-5.4-pro")).toBe(1_050_000);
    expect(inferContextWindowSize("gpt-5.4-mini")).toBe(400_000);
    expect(inferContextWindowSize("gpt-5.4-nano")).toBe(400_000);
    expect(inferContextWindowSize("gpt-5.2")).toBe(400_000);
    expect(inferContextWindowSize("gpt-5")).toBe(400_000);
    expect(inferContextWindowSize("gpt-5-mini")).toBe(400_000);
    expect(inferContextWindowSize("gpt-5-nano")).toBe(400_000);
  });

  it("keeps DeepSeek V4 and compatibility aliases at the default 1M window", () => {
    expect(inferContextWindowSize("deepseek-v4-flash")).toBe(1_000_000);
    expect(inferContextWindowSize("deepseek-v4-pro")).toBe(1_000_000);
    expect(inferContextWindowSize("deepseek-chat")).toBe(1_000_000);
    expect(inferContextWindowSize("deepseek-reasoner")).toBe(1_000_000);
    expect(
      DEEPSEEK_MODEL_OPTIONS.every((option) => option.contextWindow === 1_000_000),
    ).toBe(true);
  });

  it("keeps official token pricing for refreshed presets", () => {
    expect(findOpenAiPricing("gpt-5.5")).toEqual({
      inputTokensPerMillion: 5,
      outputTokensPerMillion: 30,
    });
    expect(findOpenAiPricing("gpt-5.4-pro")).toEqual({
      inputTokensPerMillion: 30,
      outputTokensPerMillion: 180,
    });
    expect(findOpenAiPricing("gpt-5.4-mini")).toEqual({
      inputTokensPerMillion: 0.75,
      outputTokensPerMillion: 4.5,
    });
    expect(
      DEEPSEEK_MODEL_OPTIONS.find((option) => option.value === "deepseek-v4-pro")
        ?.pricing,
    ).toEqual({
      inputTokensPerMillion: 0.435,
      outputTokensPerMillion: 0.87,
    });
  });

  it("falls back conservatively for unknown model keys", () => {
    expect(inferContextWindowSize("custom-model")).toBe(128_000);
  });
});

function findOpenAiPricing(modelKey: string) {
  return OPENAI_MODEL_OPTIONS.find((option) => option.value === modelKey)?.pricing;
}
