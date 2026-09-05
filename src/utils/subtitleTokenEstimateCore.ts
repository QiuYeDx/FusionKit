import { coalesceEmptyLrcFragments, parseSubtitleCueDocument } from "./subtitleCueProtocol";
import {
  boundSubtitleContext,
  buildSubtitleTranslationPrompt,
  formatSubtitleReferences,
  SUBTITLE_CONTEXT_TOKEN_LIMIT,
} from "./subtitleTranslationPrompt";

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
  const subtitleBlocks = content.trim().split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/);

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

  return coalesceEmptyLrcFragments(splitLrcContent(content, safeMaxTokens, countTokens));
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
  let outputTokens = 0;
  const inputTokens = fragments.reduce((sum, fragment, index) => {
    const format = detectSubtitleFormat(content, fileName);
    let document;
    try { document = parseSubtitleCueDocument(fragment, format); } catch {
      // The UI can estimate a not-yet-valid file; execution rejects malformed source before a model call.
      outputTokens += Math.ceil(countTokens(fragment) * 1.5);
      return sum + countTokens(fragment) + 300;
    }
    if (document.cues.length === 0) return sum;
    const wireScaffold = JSON.stringify({cues: document.cues.map(cue => ({id: cue.id, lines: cue.lines.map(() => "")}))});
    outputTokens += countTokens(wireScaffold) + document.cues.reduce((tokens, cue) => tokens + cue.lines.reduce((lineTokens, line) => lineTokens + Math.ceil(countTokens(line) * 1.5), 0), 0);
    const previousSource = boundSubtitleContext(index > 0 ? fragments[index - 1] : "", format, countTokens);
    const prompt = buildSubtitleTranslationPrompt({
      format,
      content: fragment,
      context: { previousSource, previousTranslation: "" },
      sourceLang,
      targetLang,
      translationOutputMode,
    });
    // Future model output is unknown. Reserve its full context budget and reference labels.
    // This is deliberately conservative for concurrent mode, which uses source context only.
    const translationReserve = index > 0
      ? SUBTITLE_CONTEXT_TOKEN_LIMIT + countTokens(formatSubtitleReferences({previousSource: "", previousTranslation: " "}))
      : 0;
    return sum + countTokens(prompt) + translationReserve;
  }, 0);
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
