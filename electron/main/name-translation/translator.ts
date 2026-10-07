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
/**
 * Output budget. The floor is generous because reasoning models spend their
 * budget on thinking before the JSON, and a cut-off answer loses every item.
 */
const MIN_OUTPUT_TOKENS = 4_096;
const MAX_OUTPUT_TOKENS = 8_192;

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
    "- The names only label the user's own files. Translate them literally even when they contain adult, violent or otherwise sensitive wording; never replace a name with a refusal, a placeholder or a summary.",
    "- Never add a file extension, path separator, quotes or any of these characters: \\ / : * ? \" < > |",
    "- Return one JSON object only, without Markdown or commentary: {\"items\":[{\"id\":\"1\",\"name\":\"translated name\"}]}",
    "- Return exactly one item for every input id, in the same order, using the ids exactly as given. Never skip, merge or renumber items.",
  ];
  const extra = instructions?.trim();
  if (extra) {
    lines.push("Additional user requirements (follow unless they conflict with the rules above):", extra);
  }
  return lines.join("\n");
}

export function buildUserPrompt(request: Pick<NameTranslateRequest, "items">): string {
  return JSON.stringify({
    count: request.items.length,
    items: request.items.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.kind === "directory" ? "folder" : "file",
      ...(item.context ? { folder: item.context } : {}),
    })),
  });
}

const FENCE_OPEN = /```(?:json)?\s*/i;
const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/i;

function stripReasoning(text: string): string {
  let normalized = text.replace(/^﻿/, "").trim();
  normalized = normalized.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const thinkEnd = normalized.toLowerCase().lastIndexOf("</think>");
  if (thinkEnd >= 0) normalized = normalized.slice(thinkEnd + "</think>".length).trim();
  const fence = normalized.match(FENCED_BLOCK);
  if (fence?.[1]) return fence[1].trim();
  // A fence that was never closed (truncated output): keep what follows it.
  const open = normalized.match(FENCE_OPEN);
  if (open && open.index !== undefined) return normalized.slice(open.index + open[0].length).trim();
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

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NAME_KEYS = ["name", "translation", "translated", "translatedName", "translated_name", "target", "output", "result"];
const LIST_KEYS = ["items", "results", "translations", "data", "names"];

function pickName(record: Record<string, unknown>): unknown {
  for (const key of NAME_KEYS) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** Maps "1", 1, "item_1", "#1" or " 01 " onto an expected id. */
function normalizeId(raw: unknown, expected: ReadonlySet<string>): string | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  if (expected.has(text)) return text;
  const digits = text.match(/\d+/)?.[0];
  if (!digits) return null;
  if (expected.has(digits)) return digits;
  const unpadded = String(Number(digits));
  return expected.has(unpadded) ? unpadded : null;
}

type Found = Map<string, string[]>;

function collectStructured(parsed: unknown, expected: ReadonlySet<string>): Found {
  const found: Found = new Map();
  const push = (idRaw: unknown, nameRaw: unknown) => {
    const id = normalizeId(idRaw, expected);
    if (!id || typeof nameRaw !== "string") return;
    const list = found.get(id) ?? [];
    list.push(nameRaw);
    found.set(id, list);
  };
  let rawItems: unknown[] | null = null;
  if (Array.isArray(parsed)) rawItems = parsed;
  else if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of LIST_KEYS) {
      if (Array.isArray(record[key])) {
        rawItems = record[key] as unknown[];
        break;
      }
    }
    if (!rawItems) {
      // A plain map such as {"1":"name","2":"name"}.
      const entries = Object.entries(record);
      if (entries.length > 0 && entries.every(([, value]) => typeof value === "string")) {
        entries.forEach(([id, name]) => push(id, name));
      }
      return found;
    }
  }
  for (const raw of rawItems ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    push(record.id ?? record.index ?? record.key, pickName(record));
  }
  return found;
}

const ID_KEY = "(?:id|index|key)";
const NAME_KEY = "(?:name|translation|translated|translatedName|translated_name|target|output|result)";
const STRING = '"((?:[^"\\\\]|\\\\.)*)"';
const ID_VALUE = '"?([^",}\\s]+)"?';
const ID_FIRST = new RegExp(`"${ID_KEY}"\\s*:\\s*${ID_VALUE}\\s*,\\s*"${NAME_KEY}"\\s*:\\s*${STRING}`, "g");
const NAME_FIRST = new RegExp(`"${NAME_KEY}"\\s*:\\s*${STRING}\\s*,\\s*"${ID_KEY}"\\s*:\\s*${ID_VALUE}`, "g");

/**
 * Salvages id/name pairs from text that is not valid JSON (truncated output,
 * trailing commas, prose around objects). An item cut off mid-string never
 * matches, so partial names are not returned.
 */
function collectLenient(text: string, expected: ReadonlySet<string>): Found {
  const found: Found = new Map();
  const push = (idRaw: string, escaped: string) => {
    const id = normalizeId(idRaw, expected);
    const name = tryParse(`"${escaped}"`);
    if (!id || typeof name !== "string" || found.has(id)) return;
    found.set(id, [name]);
  };
  for (const match of text.matchAll(ID_FIRST)) push(match[1]!, match[2]!);
  for (const match of text.matchAll(NAME_FIRST)) push(match[2]!, match[1]!);
  return found;
}

/**
 * Parses model output into id -> name. Strict JSON is preferred; malformed or
 * truncated output falls back to scanning for id/name pairs so one broken item
 * does not fail the whole batch. Missing, duplicated or empty ids are reported
 * as failed instead of guessing.
 */
export function parseTranslationOutput(
  text: string,
  expectedIds: readonly string[],
): NameTranslateResult {
  const cleaned = stripReasoning(text);
  const expected = new Set(expectedIds);
  let parsed = tryParse(cleaned);
  if (parsed === undefined) {
    const candidate = firstBalancedObject(cleaned);
    parsed = candidate ? tryParse(candidate) : undefined;
  }
  let found: Found = parsed === undefined ? new Map() : collectStructured(parsed, expected);
  if (found.size === 0) found = collectLenient(cleaned, expected);

  const items: { id: string; name: string }[] = [];
  const failedIds: string[] = [];
  for (const id of expectedIds) {
    const names = found.get(id) ?? [];
    const name = names.length === 1 ? names[0]!.trim() : "";
    if (name) items.push({ id, name });
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

/** Endpoints that do not support response_format usually answer 400. */
function isUnsupportedJsonMode(error: unknown): boolean {
  return (
    error instanceof ModelRuntimeClientError &&
    error.code === "http_non_retryable" &&
    error.details.status === 400
  );
}

function logDiagnostics(request: NameTranslateRequest, detail: Record<string, unknown>): void {
  console.warn("[name-translation] batch incomplete", {
    requestId: request.requestId,
    model: request.model.modelKey,
    items: request.items.length,
    ...detail,
  });
}

export async function translateNames(
  request: NameTranslateRequest,
  signal: AbortSignal,
  send: SendModelText = sendModelRuntimeText,
): Promise<NameTranslateResult> {
  const expectedIds = request.items.map((item) => item.id);
  const inputChars = request.items.reduce((total, item) => total + item.name.length, 0);
  const base: ModelRuntimeTextRequest = {
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
    maxOutputTokens: Math.min(
      MAX_OUTPUT_TOKENS,
      Math.max(MIN_OUTPUT_TOKENS, 512 + request.items.length * 80 + inputChars * 6),
    ),
    timeoutMs: REQUEST_TIMEOUT_MS,
    signal,
  };

  let response: ModelRuntimeTextResult;
  try {
    try {
      // JSON mode keeps chatty models from wrapping or skipping the object.
      response = await send({ ...base, responseFormat: "json_object" });
    } catch (error) {
      if (!isUnsupportedJsonMode(error)) throw error;
      response = await send(base);
    }
  } catch (error) {
    const partial =
      error instanceof ModelRuntimeClientError && error.code === "length_truncated"
        ? error.details.partialContent
        : undefined;
    if (partial === undefined) throw error;
    // Keep whatever complete items precede the cut-off; the caller retries the rest.
    const salvaged = parseTranslationOutput(partial, expectedIds);
    logDiagnostics(request, {
      reason: "length_truncated",
      salvaged: salvaged.items.length,
      usage: error instanceof ModelRuntimeClientError ? error.details.usage : undefined,
    });
    return salvaged;
  }

  const result = parseTranslationOutput(response.content, expectedIds);
  if (result.failedIds.length > 0) {
    logDiagnostics(request, {
      reason: "missing_items",
      failed: result.failedIds.length,
      finishReason: response.finishReason,
      usage: response.usage,
      preview: response.content.slice(0, 400),
    });
  }
  return result;
}
