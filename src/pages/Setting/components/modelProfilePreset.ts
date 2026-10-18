import {
  DEEPSEEK_MODEL_OPTIONS,
  DEFAULT_MODEL_API_FORMAT_MAP,
  DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
  OPENAI_MODEL_OPTIONS,
} from "@/constants/model";
import type { Model, ModelProfile, TokenPricing } from "@/type/model";

/** The price a preset model comes with, or the provider's default for other model names. */
export function presetPricing(provider: Model, modelKey: string): TokenPricing {
  const option = [...DEEPSEEK_MODEL_OPTIONS, ...OPENAI_MODEL_OPTIONS].find((item) => item.value === modelKey);
  return option?.pricing ?? DEFAULT_TOKEN_PRICING_MAP[provider];
}

/**
 * True when the settings kept under "advanced" (API format, output token parameter, prices) are
 * not what the preset would give, so the dialog opens that section instead of hiding them.
 */
export function profileDiffersFromPreset(
  profile: Pick<ModelProfile, "provider" | "apiFormat" | "outputTokenParameter" | "modelKey" | "tokenPricing">,
): boolean {
  const { provider } = profile;
  if (profile.apiFormat !== DEFAULT_MODEL_API_FORMAT_MAP[provider]) return true;
  if (
    profile.apiFormat === "chat_completions" &&
    (profile.outputTokenParameter ?? DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[provider]) !== DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[provider]
  ) return true;
  const pricing = presetPricing(provider, profile.modelKey);
  return pricing.inputTokensPerMillion !== profile.tokenPricing.inputTokensPerMillion
    || pricing.outputTokensPerMillion !== profile.tokenPricing.outputTokensPerMillion;
}
