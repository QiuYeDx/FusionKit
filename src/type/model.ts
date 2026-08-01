export enum Model {
  DeepSeek = "DeepSeek",
  OpenAI = "OpenAI",
  Other = "Other",
}

export type ModelUrlMap = Record<Model, string>;

export type ModelKeyMap = Record<Model, string>;

export type ApiKeyMap = Record<Model, string>;

export interface TokenPricing {
  inputTokensPerMillion: number;
  outputTokensPerMillion: number;
}

export type TokenPricingMap = Record<Model, TokenPricing>;

export type ModelApiFormat = "chat_completions" | "responses";

export type OutputTokenParameter = "max_tokens" | "max_completion_tokens";

// ---------------------------------------------------------------------------
// Profile-based model config (v3)
// ---------------------------------------------------------------------------

export interface ModelProfile {
  id: string;
  name: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
  modelKey: string;
  tokenPricing: TokenPricing;
  apiFormat: ModelApiFormat;
  outputTokenParameter?: OutputTokenParameter;
  /** 模型支持的最大输出 token 数；未设置时由 inferMaxOutputTokens 根据 modelKey 推断 */
  maxOutputTokens?: number;
}

export interface ModelAssignment {
  agent: string | null;
  taskExecution: string | null;
}
