export type SubtitleEstimateOutputMode = "bilingual" | "target_only";

export type SubtitleTokenPricingLike = {
  inputTokensPerMillion?: number;
  outputTokensPerMillion?: number;
};

export type SubtitleTokenEstimateResult = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fragmentCount: number;
  loading?: boolean;
};

export type SubtitleTokenEstimateCoreOptions = {
  content: string;
  maxTokens: number;
  countTokens: (text: string) => number;
  tokenPricing?: SubtitleTokenPricingLike;
  loading?: boolean;
  fileName?: string;
  sourceLang?: string;
  targetLang?: string;
  translationOutputMode?: SubtitleEstimateOutputMode;
};

type SubtitleEstimateFormat = "LRC" | "SRT";

const LANGUAGE_NAMES: Record<string, string> = {
  JA: "Japanese",
  ZH: "Chinese",
  EN: "English",
  KO: "Korean",
  FR: "French",
  DE: "German",
  ES: "Spanish",
  RU: "Russian",
  PT: "Portuguese",
};

function getLanguageName(code?: string): string {
  if (!code) return "";
  return LANGUAGE_NAMES[code] || code;
}

function getFileExtension(fileName?: string): string {
  return fileName?.split(".").pop()?.toUpperCase() || "";
}

function detectSubtitleFormat(
  content: string,
  fileName?: string,
): SubtitleEstimateFormat {
  const extension = getFileExtension(fileName);
  if (extension === "SRT") return "SRT";
  if (extension === "LRC") return "LRC";

  return /^\s*\d+\s*\r?\n\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(
    content,
  )
    ? "SRT"
    : "LRC";
}

function splitLrcContent(
  content: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): string[] {
  const fragments: string[] = [];
  let currentPart: string[] = [];
  let currentTokenCount = 0;

  for (const line of content.split("\n")) {
    const lineTokens = countTokens(line);

    if (lineTokens > maxTokens) {
      if (currentPart.length > 0) {
        fragments.push(currentPart.join("\n"));
      }
      fragments.push(line);
      currentPart = [];
      currentTokenCount = 0;
      continue;
    }

    if (
      currentPart.length > 0 &&
      currentTokenCount + lineTokens > maxTokens
    ) {
      fragments.push(currentPart.join("\n"));
      currentPart = [line];
      currentTokenCount = lineTokens;
    } else {
      currentPart.push(line);
      currentTokenCount += lineTokens;
    }
  }

  if (currentPart.length > 0) {
    fragments.push(currentPart.join("\n"));
  }

  return fragments.length > 0 ? fragments : [content];
}

function splitSrtContent(
  content: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): string[] {
  const fragments: string[] = [];
  let currentFragment = "";
  const subtitleBlocks = content.trim().split(/\n\n+/);

  for (const block of subtitleBlocks) {
    if (!block.trim()) continue;

    const blockTokens = countTokens(block);

    if (blockTokens >= maxTokens) {
      if (currentFragment) {
        fragments.push(currentFragment);
        currentFragment = "";
      }
      fragments.push(block);
    } else {
      const potentialFragment = currentFragment
        ? `${currentFragment}\n\n${block}`
        : block;
      const potentialTokens = countTokens(potentialFragment);

      if (potentialTokens >= maxTokens) {
        if (currentFragment) {
          fragments.push(currentFragment);
          currentFragment = block;
        }
      } else {
        currentFragment = potentialFragment;
      }
    }
  }

  if (currentFragment) {
    fragments.push(currentFragment);
  }

  return fragments.length > 0 ? fragments : [content];
}

export function splitSubtitleContentForEstimate(
  content: string,
  maxTokens: number,
  countTokens: (text: string) => number,
  fileName?: string,
): string[] {
  const safeMaxTokens = Math.max(1, Math.floor(maxTokens));
  const format = detectSubtitleFormat(content, fileName);

  if (format === "SRT") {
    return splitSrtContent(content, safeMaxTokens, countTokens);
  }

  return splitLrcContent(content, safeMaxTokens, countTokens);
}

function buildLrcPrompt(
  partialContent: string,
  context: string,
  sourceLang?: string,
  targetLang?: string,
  translationOutputMode: SubtitleEstimateOutputMode = "bilingual",
): string {
  const srcName = getLanguageName(sourceLang || "JA");
  const tgtName = getLanguageName(targetLang || "ZH");
  const outputRules =
    "Output only valid LRC lines. Every output line must start with a timestamp or metadata tag in [] format. Do not add markdown formatting or explanations.\n";

  if (translationOutputMode === "bilingual") {
    return (
      `Translate the following ${srcName} subtitle content into bilingual format with ${srcName} and ${tgtName}. Each ${srcName} line should be immediately followed by the ${tgtName} translation with the same timestamp. Maintain coherence. Example format:\n` +
      `[00:00.05]<${srcName} text>\n` +
      `[00:00.05]<${tgtName} translation>\n` +
      outputRules +
      (context ? `Previous translated content:\n${context}\n` : "") +
      `Translate the following content:\n\n${partialContent}`
    );
  }

  return (
    `Translate the following ${srcName} subtitle content into ${tgtName}. Replace all ${srcName} text with ${tgtName} translation. Maintain the LRC format and timestamps. Maintain coherence.\n` +
    outputRules +
    (context ? `Previous translated content:\n${context}\n` : "") +
    `Translate the following content:\n\n${partialContent}`
  );
}

function buildSrtPrompt(
  partialContent: string,
  context: string,
  sourceLang?: string,
  targetLang?: string,
  translationOutputMode: SubtitleEstimateOutputMode = "bilingual",
): string {
  const srcName = getLanguageName(sourceLang || "JA");
  const tgtName = getLanguageName(targetLang || "ZH");

  if (translationOutputMode === "bilingual") {
    return (
      `You are a professional subtitle translator. Translate the following ${srcName} subtitles into bilingual format: keep each original ${srcName} line, then immediately follow it with the ${tgtName} translation on the next line. Maintain coherence and accuracy.\n\n` +
      (context
        ? `Previous translated content (for reference only, do NOT translate again):\n${context}\n\n`
        : "") +
      `Translate the following subtitle content (only this part, ensure coherence with context above, maintain SRT format):\n\n${partialContent}\n\n` +
      `Output format must match the original. Each ${srcName} text line must be immediately followed by its ${tgtName} translation. Do not add any extra explanations or markdown formatting.`
    );
  }

  return (
    `You are a professional subtitle translator. Translate the following ${srcName} subtitles into ${tgtName}. Replace all ${srcName} text with the ${tgtName} translation. Maintain coherence and accuracy.\n\n` +
    (context
      ? `Previous translated content (for reference only, do NOT translate again):\n${context}\n\n`
      : "") +
    `Translate the following subtitle content (only this part, ensure coherence with context above, maintain SRT format):\n\n${partialContent}\n\n` +
    `Output only the ${tgtName} translations in the original SRT format. Do not add any extra explanations or markdown formatting.`
  );
}

function buildPromptForEstimate(
  partialContent: string,
  context: string,
  options: Pick<
    SubtitleTokenEstimateCoreOptions,
    "content" | "fileName" | "sourceLang" | "targetLang" | "translationOutputMode"
  >,
): string {
  const format = detectSubtitleFormat(options.content, options.fileName);

  if (format === "SRT") {
    return buildSrtPrompt(
      partialContent,
      context,
      options.sourceLang,
      options.targetLang,
      options.translationOutputMode,
    );
  }

  return buildLrcPrompt(
    partialContent,
    context,
    options.sourceLang,
    options.targetLang,
    options.translationOutputMode,
  );
}

function estimateOutputTokens(
  sourceTokens: number,
  translationOutputMode: SubtitleEstimateOutputMode = "bilingual",
): number {
  const translatedTokens = Math.ceil(sourceTokens * 1.5);
  return translationOutputMode === "target_only"
    ? translatedTokens
    : sourceTokens + translatedTokens;
}

export function buildSubtitleTokenEstimate({
  content,
  maxTokens,
  countTokens,
  tokenPricing,
  loading,
  fileName,
  sourceLang,
  targetLang,
  translationOutputMode = "bilingual",
}: SubtitleTokenEstimateCoreOptions): SubtitleTokenEstimateResult {
  const fragments = splitSubtitleContentForEstimate(
    content,
    maxTokens,
    countTokens,
    fileName,
  );
  const sourceTokens = countTokens(content);
  const inputTokens = fragments.reduce((sum, fragment, index) => {
    const context = index > 0 ? fragments[index - 1] : "";
    const prompt = buildPromptForEstimate(fragment, context, {
      content,
      fileName,
      sourceLang,
      targetLang,
      translationOutputMode,
    });

    return sum + countTokens(prompt);
  }, 0);
  const outputTokens = estimateOutputTokens(sourceTokens, translationOutputMode);
  const totalTokens = inputTokens + outputTokens;

  const inputPrice = tokenPricing?.inputTokensPerMillion ?? 1.5;
  const outputPrice = tokenPricing?.outputTokensPerMillion ?? 2.0;
  const estimatedCost =
    (inputTokens / 1_000_000) * inputPrice +
    (outputTokens / 1_000_000) * outputPrice;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
    fragmentCount: fragments.length,
    loading,
  };
}
