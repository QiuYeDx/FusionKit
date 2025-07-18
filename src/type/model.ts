export enum Model {
  DeepSeek = "DeepSeek",
  OpenAI = "OpenAI",
  Other = "Other",
}

export type ModelUrlMap = Record<Model, string>;

export type ModelKeyMap = Record<Model, string>;

export type ApiKeyMap = Record<Model, string>;

export interface TokenPricing {
  inputTokensPerMillion: number; // 每1M输入token的价格（美元）
  outputTokensPerMillion: number; // 每1M输出token的价格（美元）
}

export type TokenPricingMap = Record<Model, TokenPricing>;
