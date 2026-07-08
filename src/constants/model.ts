import {
  Model,
  type ModelApiFormat,
  type OutputTokenParameter,
  type TokenPricing,
  type TokenPricingMap,
} from "@/type/model";

export const DEFAULT_MODEL = Model.DeepSeek;

type ModelOption = {
  label: string;
  value: string;
  pricing: TokenPricing;
  contextWindow: number;
  badge?: "recommended" | "flagship" | "legacy";
};

// ---------------------------------------------------------------------------
// DeepSeek Model Options
// ---------------------------------------------------------------------------

export const DEEPSEEK_MODEL_OPTIONS: ModelOption[] = [
  {
    label: "DeepSeek V4 Flash",
    value: "deepseek-v4-flash",
    badge: "recommended",
    contextWindow: 1_000_000,
    pricing: {
      inputTokensPerMillion: 0.14,
      outputTokensPerMillion: 0.28,
    },
  },
  {
    label: "DeepSeek V4 Pro",
    value: "deepseek-v4-pro",
    badge: "flagship",
    contextWindow: 1_000_000,
    pricing: {
      inputTokensPerMillion: 0.435,
      outputTokensPerMillion: 0.87,
    },
  },
  {
    label: "DeepSeek Chat",
    value: "deepseek-chat",
    badge: "legacy",
    contextWindow: 1_000_000,
    pricing: {
      inputTokensPerMillion: 0.14,
      outputTokensPerMillion: 0.28,
    },
  },
  {
    label: "DeepSeek Reasoner",
    value: "deepseek-reasoner",
    badge: "legacy",
    contextWindow: 1_000_000,
    pricing: {
      inputTokensPerMillion: 0.14,
      outputTokensPerMillion: 0.28,
    },
  },
];

export const DEFAULT_DEEPSEEK_MODEL_KEY = DEEPSEEK_MODEL_OPTIONS[0].value;

// ---------------------------------------------------------------------------
// OpenAI Model Options
// ---------------------------------------------------------------------------

export const OPENAI_MODEL_OPTIONS: ModelOption[] = [
  {
    label: "GPT-5.5",
    value: "gpt-5.5",
    contextWindow: 1_050_000,
    pricing: {
      inputTokensPerMillion: 5.0,
      outputTokensPerMillion: 30.0,
    },
  },
  {
    label: "GPT-5.5 Pro",
    value: "gpt-5.5-pro",
    contextWindow: 1_050_000,
    pricing: {
      inputTokensPerMillion: 30.0,
      outputTokensPerMillion: 180.0,
    },
  },
  {
    label: "GPT-5.4",
    value: "gpt-5.4",
    contextWindow: 1_050_000,
    pricing: {
      inputTokensPerMillion: 2.5,
      outputTokensPerMillion: 15.0,
    },
  },
  {
    label: "GPT-5.4 Pro",
    value: "gpt-5.4-pro",
    contextWindow: 1_050_000,
    pricing: {
      inputTokensPerMillion: 30.0,
      outputTokensPerMillion: 180.0,
    },
  },
  {
    label: "GPT-5.4 mini",
    value: "gpt-5.4-mini",
    contextWindow: 400_000,
    pricing: {
      inputTokensPerMillion: 0.75,
      outputTokensPerMillion: 4.5,
    },
  },
  {
    label: "GPT-5.4 nano",
    value: "gpt-5.4-nano",
    contextWindow: 400_000,
    pricing: {
      inputTokensPerMillion: 0.2,
      outputTokensPerMillion: 1.25,
    },
  },
  {
    label: "GPT-5.2",
    value: "gpt-5.2",
    contextWindow: 400_000,
    pricing: {
      inputTokensPerMillion: 1.75,
      outputTokensPerMillion: 14.0,
    },
  },
  {
    label: "GPT-5",
    value: "gpt-5",
    contextWindow: 400_000,
    pricing: {
      inputTokensPerMillion: 1.25,
      outputTokensPerMillion: 10.0,
    },
  },
  {
    label: "GPT-5 mini",
    value: "gpt-5-mini",
    contextWindow: 400_000,
    pricing: {
      inputTokensPerMillion: 0.25,
      outputTokensPerMillion: 2.0,
    },
  },
  {
    label: "GPT-5 nano",
    value: "gpt-5-nano",
    contextWindow: 400_000,
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

export const DEFAULT_MODEL_BASE_URL_MAP: Record<Model, string> = {
  [Model.DeepSeek]: "https://api.deepseek.com/v1",
  [Model.OpenAI]: "https://api.openai.com/v1",
  [Model.Other]: "",
};

export const DEFAULT_MODEL_API_FORMAT_MAP: Record<Model, ModelApiFormat> = {
  [Model.DeepSeek]: "chat_completions",
  [Model.OpenAI]: "responses",
  [Model.Other]: "chat_completions",
};

export const DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP: Record<
  Model,
  OutputTokenParameter
> = {
  [Model.DeepSeek]: "max_tokens",
  [Model.OpenAI]: "max_completion_tokens",
  [Model.Other]: "max_tokens",
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

const MODEL_CONTEXT_WINDOW_BY_KEY = new Map(
  [...DEEPSEEK_MODEL_OPTIONS, ...OPENAI_MODEL_OPTIONS].map((option) => [
    option.value,
    option.contextWindow,
  ]),
);

/**
 * 根据 modelKey 推断模型的上下文窗口大小（tokens）。
 * 当 ModelProfile 没有显式设置 contextWindow 时作为默认值使用。
 */
export function inferContextWindowSize(modelKey: string): number {
  const key = modelKey.trim().toLowerCase();
  const exactContextWindow = MODEL_CONTEXT_WINDOW_BY_KEY.get(key);
  if (exactContextWindow) return exactContextWindow;

  // DeepSeek V4 系列及当前兼容别名支持默认 1M 上下文窗口
  if (key.includes("deepseek-v4")) return 1_000_000;
  if (key === "deepseek-chat" || key === "deepseek-reasoner") return 1_000_000;
  // OpenAI 官方当前预设模型的默认上下文窗口
  if (key.startsWith("gpt-5.5")) return 1_050_000;
  if (key === "gpt-5.4" || key.startsWith("gpt-5.4-pro")) return 1_050_000;
  if (key.startsWith("gpt-5.4-mini") || key.startsWith("gpt-5.4-nano")) {
    return 400_000;
  }
  if (
    key === "gpt-5" ||
    key.startsWith("gpt-5-") ||
    key.startsWith("gpt-5.2")
  ) {
    return 400_000;
  }
  if (key.includes("deepseek")) return 128_000;
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
