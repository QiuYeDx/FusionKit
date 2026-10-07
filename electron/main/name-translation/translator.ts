import type {
  NameLanguage,
  NameSourceLanguage,
  NameTranslateRequest,
  NameTranslateResult,
  NameTranslationError,
} from "@/name-translation/contract";
import {
  sendModelRuntimeText,
  type ModelRuntimeTextRequest,
  type ModelRuntimeTextResult,
} from "../ai/model-runtime-client";
import { ModelRuntimeClientError } from "../ai/model-runtime-errors";

const LANGUAGE_LABELS: Record<NameSourceLanguage, string> = {
  auto: "auto-detected language",
  ZH: "Simplified Chinese",
  ZH_HANT: "Traditional Chinese",
  JA: "Japanese",
  EN: "English",
  KO: "Korean",
  FR: "French",
  DE: "German",
  ES: "Spanish",
  RU: "Russian",
  PT: "Portuguese",
};

const REQUEST_TIMEOUT_MS = 120_000;

export function buildSystemPrompt(
  sourceLang: NameSourceLanguage,
  targetLang: NameLanguage,
  instructions?: string,
): string {
  const lines = [
    "You translate file and folder names for a batch rename tool.",
    `Translate each name from ${LANGUAGE_LABELS[sourceLang]} into ${LANGUAGE_LABELS[targetLang]}.`,
    "Rules:",
    "- Translate only the natural-language words. Keep numbers, dates, version numbers, season/episode codes (S01E02), resolutions (1080p), codecs, release tags and bracketed group tags exactly as they are.",
    "- Keep the original order and separators (spaces, underscores, hyphens, brackets) where they still make sense.",
    "- Names in the same request usually belong to the same folder; translate recurring words consistently.",
    "- If a name is already in the target language, return it unchanged.",
    "- Never add a file extension, path separator, quotes or any of these characters: \\ / : * ? \" < > |",
    "- Return one JSON object only, without Markdown: {\"items\":[{\"id\":\"1\",\"name\":\"translated name\"}]}",
    "- Return exactly one item for every input id.",
  ];
  const extra = instructions?.trim();
  if (extra) {
    lines.push("Additional user requirements (follow unless they conflict with the rules above):", extra);
  }
  return lines.join("\n");
}

export function buildUserPrompt(request: Pick<NameTranslateRequest, "items">): string {
  return JSON.stringify({
    items: request.items.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.kind === "directory" ? "folder" : "file",
      ...(item.context ? { folder: item.context } : {}),
    })),
  });
}

function stripReasoning(text: string): string {
  let normalized = text.replace(/^﻿/, "").trim();
  normalized = normalized.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const thinkEnd = normalized.toLowerCase().lastIndexOf("</think>");
  if (thinkEnd >= 0) normalized = normalized.slice(thinkEnd + "</think>".length).trim();
  const fence = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) normalized = fence[1].trim();
  return normalized;
}

function firstBalancedObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parses model output into id -> name. Missing, duplicated or empty ids are
 * reported as failed instead of guessing.
 */
export function parseTranslationOutput(
  text: string,
  expectedIds: readonly string[],
): NameTranslateResult {
  const cleaned = stripReasoning(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const candidate = firstBalancedObject(cleaned);
    try {
      parsed = candidate ? JSON.parse(candidate) : undefined;
    } catch {
      parsed = undefined;
    }
  }
  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [];

  const expected = new Set(expectedIds);
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "number" ? String(record.id) : record.id;
    const name = record.name ?? record.translation ?? record.translatedName;
    if (typeof id !== "string" || !expected.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (typeof name === "string" && name.trim()) names.set(id, name);
  }

  const items: { id: string; name: string }[] = [];
  const failedIds: string[] = [];
  for (const id of expectedIds) {
    const name = names.get(id);
    if (name !== undefined && counts.get(id) === 1) items.push({ id, name });
    else failedIds.push(id);
  }
  return { items, failedIds };
}

export function classifyTranslationError(error: unknown): NameTranslationError {
  if (error instanceof ModelRuntimeClientError) {
    switch (error.code) {
      case "aborted":
        return { code: "cancelled", message: "Translation was cancelled." };
      case "http_unauthorized":
      case "http_forbidden":
        return { code: "model_auth", message: error.message };
      case "http_non_retryable":
        if (error.details.status === 404) return { code: "model_not_found", message: error.message };
        if (error.details.status === 402 || /quota|balance|billing/i.test(error.message)) {
          return { code: "model_quota", message: error.message };
        }
        return { code: "model_failed", message: error.message };
      default:
        return { code: "model_failed", message: error.message };
    }
  }
  if ((error as Error)?.name === "AbortError") {
    return { code: "cancelled", message: "Translation was cancelled." };
  }
  return { code: "model_failed", message: error instanceof Error ? error.message : String(error) };
}

export type SendModelText = (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>;

export async function translateNames(
  request: NameTranslateRequest,
  signal: AbortSignal,
  send: SendModelText = sendModelRuntimeText,
): Promise<NameTranslateResult> {
  const expectedIds = request.items.map((item) => item.id);
  const inputChars = request.items.reduce((total, item) => total + item.name.length, 0);
  const response = await send({
    model: {
      ...(request.model.profileId ? { profileId: request.model.profileId } : {}),
      apiKey: request.model.apiKey,
      modelKey: request.model.modelKey,
      endpoint: request.model.endpoint,
      apiFormat: request.model.apiFormat ?? "chat_completions",
      ...(request.model.outputTokenParameter
        ? { outputTokenParameter: request.model.outputTokenParameter }
        : {}),
    },
    messages: [
      { role: "system", content: buildSystemPrompt(request.sourceLang, request.targetLang, request.instructions) },
      { role: "user", content: buildUserPrompt(request) },
    ],
    temperature: 0.2,
    maxOutputTokens: Math.min(8_192, Math.max(1_024, 256 + request.items.length * 40 + inputChars * 4)),
    timeoutMs: REQUEST_TIMEOUT_MS,
    signal,
  });
  return parseTranslationOutput(response.content, expectedIds);
}
