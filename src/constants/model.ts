import { Model, TokenPricing, TokenPricingMap } from "@/type/model";

export const DEFAULT_MODEL = Model.DeepSeek;

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
  inputTokensPerMillion: 0.28, // DeepSeek: 官方价格（缓存未命中）
  outputTokensPerMillion: 0.42,
};

export const DEFAULT_MODEL_URL_MAP = {
  [Model.DeepSeek]: "https://api.deepseek.com/v1/chat/completions",
  [Model.OpenAI]: "https://api.openai.com/v1/chat/completions",
  [Model.Other]: "",
};

export const DEFAULT_MODEL_KEY_MAP = {
  [Model.DeepSeek]: "deepseek-chat",
  [Model.OpenAI]: DEFAULT_OPENAI_MODEL_KEY,
  [Model.Other]: "",
};

export const DEFAULT_APIKEY_MAP = {
  [Model.DeepSeek]: "",
  [Model.OpenAI]: "",
  [Model.Other]: "",
};

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
