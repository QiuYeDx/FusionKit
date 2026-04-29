import { encode } from "gpt-tokenizer";
import {
  buildSubtitleTokenEstimate,
  type SubtitleTokenEstimateResult,
} from "@/utils/subtitleTokenEstimateCore";

function countTokens(text: string): number {
  return encode(text).length;
}

export type TokenEstimateWorkerRequest = {
  jobId: string;
  fileName: string;
  content: string;
  maxTokens: number;
  tokenPricing?: {
    inputTokensPerMillion?: number;
    outputTokensPerMillion?: number;
  };
  sourceLang?: string;
  targetLang?: string;
  translationOutputMode?: "bilingual" | "target_only";
};

export type TokenEstimateWorkerResponse =
  | {
      jobId: string;
      fileName: string;
      estimate: SubtitleTokenEstimateResult;
      error?: undefined;
    }
  | {
      jobId: string;
      fileName: string;
      estimate?: undefined;
      error: string;
    };

self.onmessage = (e: MessageEvent<TokenEstimateWorkerRequest>) => {
  const {
    jobId,
    fileName,
    content,
    maxTokens,
    tokenPricing,
    sourceLang,
    targetLang,
    translationOutputMode,
  } = e.data;

  try {
    const estimate = buildSubtitleTokenEstimate({
      content,
      maxTokens,
      countTokens,
      tokenPricing,
      loading: false,
      fileName,
      sourceLang,
      targetLang,
      translationOutputMode,
    });

    const response: TokenEstimateWorkerResponse = {
      jobId,
      fileName,
      estimate,
    };
    self.postMessage(response);
  } catch (err) {
    const response: TokenEstimateWorkerResponse = {
      jobId,
      fileName,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
