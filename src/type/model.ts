export enum Model {
  DeepSeek = "DeepSeek",
  OpenAI = "OpenAI",
  Other = "Other",
}

export type ModelUrlMap = Record<Model, string>;

export type ModelKeyMap = Record<Model, string>;

export type ApiKeyMap = Record<Model, string>;
