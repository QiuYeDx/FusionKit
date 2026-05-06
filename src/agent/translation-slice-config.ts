import type { QueueTranslateArgs } from "./tool-schemas";

export type TranslationSliceConfig = {
  sliceType: QueueTranslateArgs["sliceType"];
  customSliceLength?: number;
};

const CUSTOM_SLICE_LENGTH_MIN = 100;
const CUSTOM_SLICE_LENGTH_MAX = 2000;

const CUSTOM_SLICE_PATTERNS = [
  /(?:按照|按|每(?:片|段|个分片)?|分片(?:长度|大小|上限)?|切片(?:长度|大小|上限)?|token(?:上限|数量|数)?|tokens?|自定义|custom)[^\d]{0,12}(\d{2,5})/iu,
  /(?:every|per|each|chunk|slice|segment|limit|max)[^\d]{0,12}(\d{2,5})/iu,
  /(\d{2,5})\s*(?:分词|词|tokens?|token|字符|字|每片|每段)/iu,
];

export function detectCustomSliceLengthIntent(text: string): number | undefined {
  const normalized = text.replace(/[,，]/g, "");

  for (const pattern of CUSTOM_SLICE_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const value = Number(match[1]);
    if (
      Number.isFinite(value) &&
      value >= CUSTOM_SLICE_LENGTH_MIN &&
      value <= CUSTOM_SLICE_LENGTH_MAX
    ) {
      return Math.floor(value);
    }
  }

  return undefined;
}

export function resolveTranslationSliceConfig(
  args: Pick<QueueTranslateArgs, "sliceType" | "customSliceLength">,
  userMessage = "",
): TranslationSliceConfig {
  const customSliceLength =
    typeof args.customSliceLength === "number" &&
    Number.isFinite(args.customSliceLength) &&
    args.customSliceLength > 0
      ? Math.floor(args.customSliceLength)
      : detectCustomSliceLengthIntent(userMessage);

  return {
    sliceType: customSliceLength ? "CUSTOM" : args.sliceType ?? "NORMAL",
    customSliceLength,
  };
}
