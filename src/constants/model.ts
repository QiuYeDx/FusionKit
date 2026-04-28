import { Model, TokenPricing, TokenPricingMap } from "@/type/model";

export const DEFAULT_MODEL = Model.DeepSeek;

// ---------------------------------------------------------------------------
// DeepSeek Model Options
// ---------------------------------------------------------------------------

export const DEEPSEEK_MODEL_OPTIONS: Array<{
  label: string;
  value: string;
  pricing: TokenPricing;
  badge?: "recommended" | "flagship" | "legacy";
}> = [
  {
    label: "DeepSeek V4 Flash",
    value: "deepseek-v4-flash",
    badge: "recommended",
    pricing: {
      inputTokensPerMillion: 0.14,
      outputTokensPerMillion: 0.28,
    },
  },
  {
    label: "DeepSeek V4 Pro",
    value: "deepseek-v4-pro",
    badge: "flagship",
    pricing: {
      inputTokensPerMillion: 0.56,
      outputTokensPerMillion: 1.10,
    },
  },
  {
    label: "DeepSeek Chat",
    value: "deepseek-chat",
    badge: "legacy",
    pricing: {
      inputTokensPerMillion: 0.28,
      outputTokensPerMillion: 0.42,
    },
  },
  {
    label: "DeepSeek Reasoner",
    value: "deepseek-reasoner",
    badge: "legacy",
    pricing: {
      inputTokensPerMillion: 0.56,
      outputTokensPerMillion: 2.19,
    },
  },
];

export const DEFAULT_DEEPSEEK_MODEL_KEY = DEEPSEEK_MODEL_OPTIONS[0].value;

// ---------------------------------------------------------------------------
// OpenAI Model Options
// ---------------------------------------------------------------------------

export const OPENAI_MODEL_OPTIONS: Array<{
  label: string;
  value: string;
  pricing: TokenPricing;
}> = [
  {
    label: "GPT-5.2",
    value: "gpt-5.2",
    pricing: {
      inputTokensPerMillion: 1.75,
      outputTokensPerMillion: 14.0,
    },
  },
  {
    label: "GPT-5",
    value: "gpt-5",
    pricing: {
      inputTokensPerMillion: 1.25,
      outputTokensPerMillion: 10.0,
    },
  },
  {
    label: "GPT-5 mini",
    value: "gpt-5-mini",
    pricing: {
      inputTokensPerMillion: 0.25,
      outputTokensPerMillion: 2.0,
    },
  },
  {
    label: "GPT-5 nano",
    value: "gpt-5-nano",
    pricing: {
      inputTokensPerMillion: 0.05,
      outputTokensPerMillion: 0.4,
    },
  },
];

export const DEFAULT_OPENAI_MODEL_KEY = OPENAI_MODEL_OPTIONS[0].value;

export const DEEPSEEK_DEFAULT_TOKEN_PRICING: TokenPricing = {
  ...DEEPSEEK_MODEL_OPTIONS[0].pricing,
};

export const DEFAULT_MODEL_URL_MAP = {
  [Model.DeepSeek]: "https://api.deepseek.com/v1/chat/completions",
  [Model.OpenAI]: "https://api.openai.com/v1/chat/completions",
  [Model.Other]: "",
};

export const DEFAULT_MODEL_KEY_MAP = {
  [Model.DeepSeek]: DEFAULT_DEEPSEEK_MODEL_KEY,
  [Model.OpenAI]: DEFAULT_OPENAI_MODEL_KEY,
  [Model.Other]: "",
};

export const DEFAULT_APIKEY_MAP = {
  [Model.DeepSeek]: "",
  [Model.OpenAI]: "",
  [Model.Other]: "",
};

/**
 * 根据 modelKey 推断模型的上下文窗口大小（tokens）。
 * 当 ModelProfile 没有显式设置 contextWindow 时作为默认值使用。
 */
export function inferContextWindowSize(modelKey: string): number {
  const key = modelKey.toLowerCase();
  // DeepSeek V4 系列支持 1M 上下文窗口
  if (key.includes("deepseek-v4")) return 1_000_000;
  // DeepSeek 旧版模型
  if (key.includes("deepseek")) return 128_000;
  if (key.includes("gpt")) return 272_000;
  if (key.includes("gpt-5")) return 272_000;
  if (key.includes("gpt-4o") || key.includes("gpt-4-turbo")) return 128_000;
  if (key.includes("gpt-4")) return 128_000;
  if (key.includes("gpt-3.5")) return 16_385;
  if (key.includes("claude")) return 200_000;
  if (key.includes("gemini")) return 1_048_576;
  if (key.includes("qwen")) return 128_000;
  if (key.includes("glm") || key.includes("chatglm")) return 128_000;
  if (key.includes("mistral")) return 32_000;
  if (key.includes("llama")) return 128_000;
  return 128_000;
}

// 各模型的默认token价格 (美元/1M tokens)
export const DEFAULT_TOKEN_PRICING_MAP: TokenPricingMap = {
  [Model.DeepSeek]: {
    ...DEEPSEEK_DEFAULT_TOKEN_PRICING,
  },
  [Model.OpenAI]: {
    ...OPENAI_MODEL_OPTIONS[0].pricing,
  },
  [Model.Other]: {
    inputTokensPerMillion: 1.0, // 自定义模型的默认价格
    outputTokensPerMillion: 2.0,
  },
};
