import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_API_FORMAT_MAP,
  DEFAULT_MODEL_BASE_URL_MAP,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
  DEEPSEEK_MODEL_OPTIONS,
  OPENAI_MODEL_OPTIONS,
  RECOMMENDED_MODEL_PROVIDER,
} from "@/constants/model";
import { isAgentProfileApiFormatSupported } from "@/agent/api-format-capability";
import { Model } from "@/type/model";
import { presetPricing, profileDiffersFromPreset } from "./modelProfilePreset";

const preset = (provider: Model) => ({
  provider,
  apiFormat: DEFAULT_MODEL_API_FORMAT_MAP[provider],
  outputTokenParameter: DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[provider],
  modelKey: DEFAULT_MODEL_KEY_MAP[provider],
  tokenPricing: { ...presetPricing(provider, DEFAULT_MODEL_KEY_MAP[provider]) },
});

describe("model presets", () => {
  it("recommends DeepSeek with the official address and its recommended model", () => {
    expect(RECOMMENDED_MODEL_PROVIDER).toBe(Model.DeepSeek);
    expect(DEFAULT_MODEL_BASE_URL_MAP[Model.DeepSeek]).toBe("https://api.deepseek.com/v1");
    expect(DEFAULT_MODEL_KEY_MAP[Model.DeepSeek]).toBe("deepseek-v4-flash");
    expect(DEEPSEEK_MODEL_OPTIONS.find((option) => option.value === "deepseek-v4-flash")?.badge).toBe("recommended");
    expect(DEFAULT_MODEL_API_FORMAT_MAP[Model.DeepSeek]).toBe("chat_completions");
    expect(DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[Model.DeepSeek]).toBe("max_tokens");
  });

  it("keeps every preset usable by the Agent", () => {
    // The Agent supports both formats, so the OpenAI preset keeps the Responses API its Pro models need.
    for (const provider of Object.values(Model)) {
      expect(isAgentProfileApiFormatSupported({ apiFormat: DEFAULT_MODEL_API_FORMAT_MAP[provider] })).toBe(true);
    }
    expect(DEFAULT_MODEL_API_FORMAT_MAP[Model.OpenAI]).toBe("responses");
    expect(DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[Model.OpenAI]).toBe("max_completion_tokens");
  });

  it("opens the advanced settings only for profiles that differ from their preset", () => {
    for (const provider of Object.values(Model)) expect(profileDiffersFromPreset(preset(provider))).toBe(false);
    // Another preset model brings its own price.
    const pro = DEEPSEEK_MODEL_OPTIONS.find((option) => option.value === "deepseek-v4-pro")!;
    expect(profileDiffersFromPreset({ ...preset(Model.DeepSeek), modelKey: pro.value, tokenPricing: { ...pro.pricing } })).toBe(false);
    expect(profileDiffersFromPreset({ ...preset(Model.DeepSeek), apiFormat: "responses" })).toBe(true);
    expect(profileDiffersFromPreset({ ...preset(Model.DeepSeek), outputTokenParameter: "max_completion_tokens" })).toBe(true);
    expect(profileDiffersFromPreset({ ...preset(Model.DeepSeek), tokenPricing: { inputTokensPerMillion: 9, outputTokensPerMillion: 9 } })).toBe(true);
    // Older OpenAI profiles were migrated to Chat Completions; their settings stay in view.
    expect(profileDiffersFromPreset({ ...preset(Model.OpenAI), apiFormat: "chat_completions" })).toBe(true);
    // The token parameter only matters for Chat Completions.
    expect(profileDiffersFromPreset({ ...preset(Model.OpenAI), outputTokenParameter: "max_tokens" })).toBe(false);
    expect(presetPricing(Model.Other, "custom-model")).toEqual(DEFAULT_TOKEN_PRICING_MAP[Model.Other]);
    expect(presetPricing(Model.OpenAI, OPENAI_MODEL_OPTIONS[2].value)).toEqual(OPENAI_MODEL_OPTIONS[2].pricing);
  });
});
