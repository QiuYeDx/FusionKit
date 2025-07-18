import { Model, TokenPricingMap } from "@/type/model";

export const DEFAULT_MODEL = Model.DeepSeek;

export const DEFAULT_MODEL_URL_MAP = {
  [Model.DeepSeek]: "https://api.deepseek.com/v1/chat/completions",
  [Model.OpenAI]: "https://api.openai.com/v1/chat/completions",
  [Model.Other]: "",
};

export const DEFAULT_MODEL_KEY_MAP = {
  [Model.DeepSeek]: "deepseek-chat",
  [Model.OpenAI]: "gpt-4o",
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
    inputTokensPerMillion: 0.278, // DeepSeek: 2元人民币/1M tokens ≈ 0.278美元
    outputTokensPerMillion: 1.111, // DeepSeek: 8元人民币/1M tokens ≈ 1.111美元
  },
  [Model.OpenAI]: {
    inputTokensPerMillion: 5.0, // OpenAI: $5.00/1M tokens
    outputTokensPerMillion: 20.0, // OpenAI: $20.00/1M tokens
  },
  [Model.Other]: {
    inputTokensPerMillion: 1.0, // 自定义模型的默认价格
    outputTokensPerMillion: 2.0,
  },
};
