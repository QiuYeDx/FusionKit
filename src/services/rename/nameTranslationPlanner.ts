import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { ModelProfile } from "@/type/model";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  NameTranslationPlannerError,
  type ClarificationRequired,
  type NameTranslationModelInputItem,
  type NameTranslationModelOutputItem,
  type NameTranslationOptions,
  type NameTranslationPlan,
  type NameTranslationPlanItem,
  type NameTranslationPlanSummary,
  type NameTranslationTarget,
  type ScanRenameTargetsResult,
} from "./nameTypes";
import {
  createPlanExpiry,
  rememberNameTranslationPlan,
  summarizeNameTranslationPlan,
} from "./namePlanStore";
import { joinPath, isRootLikePath } from "./namePath";
import { sanitizeTranslatedName } from "./nameSanitize";
import { validatePlanItems } from "./nameConflict";
import {
  checkRenameTargetExists,
  scanNameTranslationTargets,
} from "./nameTargetResolver";
import {
  buildNameTranslationSystemPrompt,
  buildNameTranslationUserPrompt,
} from "./nameTranslationPrompt";

const DEFAULT_PREVIEW_LIMIT = 30;
const DEFAULT_MAX_TARGETS = 5000;
const TRANSLATION_BATCH_SIZE = 25;
const MAX_TRANSLATION_WARNINGS = 200;

const modelOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      translatedStem: z.string(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
      note: z.string().optional(),
    })
  ),
});

export interface CreateNameTranslationPlanDeps {
  scanTargets?: (
    options: NameTranslationOptions,
    maxTargets?: number
  ) => Promise<ScanRenameTargetsResult>;
  translateBatch?: (
    items: NameTranslationModelInputItem[],
    options: NameTranslationOptions
  ) => Promise<NameTranslationModelOutputItem[]>;
  checkPathExists?: (filePath: string) => Promise<boolean>;
  now?: () => number;
  previewLimit?: number;
  maxTargets?: number;
  planIdFactory?: () => string;
}

export async function createNameTranslationPlan(
  options: NameTranslationOptions,
  deps: CreateNameTranslationPlanDeps = {}
): Promise<NameTranslationPlanSummary> {
  const normalizedOptions = normalizeNameTranslationOptions(options);
  const now = deps.now?.() ?? Date.now();
  const previewLimit = deps.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const planId = deps.planIdFactory?.() ?? createPlanId();

  const clarificationRequired =
    getPathSegmentClarification(normalizedOptions) ??
    getUnsafePathSegmentClarification(normalizedOptions);

  if (clarificationRequired) {
    const plan = buildPlan({
      planId,
      createdAt: now,
      previewLimit,
      options: normalizedOptions,
      items: [],
      warnings: [],
      clarificationRequired,
    });
    rememberNameTranslationPlan(plan);
    return summarizeNameTranslationPlan(plan);
  }

  if (normalizedOptions.scope === "path_segments") {
    const plan = buildPlan({
      planId,
      createdAt: now,
      previewLimit,
      options: normalizedOptions,
      items: [],
      warnings: [
        "path_segments planning is intentionally non-applyable until path-level rename ordering is implemented.",
      ],
      clarificationRequired: {
        code: "path_segments_deferred",
        message:
          "路径片段重命名需要额外确认和目录重写顺序，本阶段只生成不可应用预览。",
      },
    });
    rememberNameTranslationPlan(plan);
    return summarizeNameTranslationPlan(plan);
  }

  const scanTargets = deps.scanTargets ?? scanNameTranslationTargets;
  const scanResult = await scanTargets(normalizedOptions, deps.maxTargets ?? DEFAULT_MAX_TARGETS);
  const translationWarnings: string[] = [];
  const translationMap = await translateTargets(
    scanResult.targets,
    normalizedOptions,
    deps.translateBatch ?? translateBatchWithTaskModel,
    translationWarnings
  );

  const rawItems = scanResult.targets.map((target) =>
    createPlanItem(target, normalizedOptions, translationMap, translationWarnings)
  );
  const existingTargetPaths = await collectExistingTargetPaths(
    rawItems,
    deps.checkPathExists ?? checkRenameTargetExists
  );
  const validatedItems = validatePlanItems(rawItems, normalizedOptions, {
    existingTargetPaths,
  });
  const plan = buildPlan({
    planId,
    createdAt: now,
    previewLimit,
    options: normalizedOptions,
    items: validatedItems,
    warnings: [...scanResult.warnings, ...translationWarnings],
    totalTargets: scanResult.totalCount,
  });

  rememberNameTranslationPlan(plan);
  return summarizeNameTranslationPlan(plan);
}

function normalizeNameTranslationOptions(
  input: NameTranslationOptions
): NameTranslationOptions {
  const roots = Array.isArray(input?.roots)
    ? input.roots.filter((root) => typeof root === "string" && root.length > 0)
    : [];

  return {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    ...input,
    roots,
    maxDepth: Number.isFinite(input?.maxDepth)
      ? Math.max(0, Math.min(20, Math.floor(input.maxDepth)))
      : DEFAULT_NAME_TRANSLATION_OPTIONS.maxDepth,
  };
}

function getPathSegmentClarification(
  options: NameTranslationOptions
): ClarificationRequired | undefined {
  if (options.scope !== "path_segments") return undefined;
  if (options.pathSegmentRange?.startPath && options.pathSegmentRange?.endPath) {
    return undefined;
  }

  return {
    code: "path_segment_boundary_required",
    message:
      "需要指定路径翻译的起止层级，例如从哪个文件夹开始，到哪个文件或文件夹结束。",
    choices: [
      "只翻译所选文件或文件夹本身",
      "从某一级文件夹开始翻译路径片段",
      "改为翻译目录直接子项",
    ],
  };
}

function getUnsafePathSegmentClarification(
  options: NameTranslationOptions
): ClarificationRequired | undefined {
  if (options.scope !== "path_segments" || !options.pathSegmentRange) {
    return undefined;
  }
  if (!isRootLikePath(options.pathSegmentRange.startPath)) return undefined;

  return {
    code: "unsafe_path_segment_start",
    message: "路径片段起始层级不能是根目录、Home 根目录或系统保护目录。",
  };
}

async function translateTargets(
  targets: NameTranslationTarget[],
  options: NameTranslationOptions,
  translateBatch: NonNullable<CreateNameTranslationPlanDeps["translateBatch"]>,
  warnings: string[]
): Promise<Map<string, NameTranslationModelOutputItem>> {
  const translationMap = new Map<string, NameTranslationModelOutputItem>();

  for (let start = 0; start < targets.length; start += TRANSLATION_BATCH_SIZE) {
    const batchTargets = targets.slice(start, start + TRANSLATION_BATCH_SIZE);
    const batchInput = batchTargets.map(toModelInputItem);

    const outputs = await translateBatchWithRecovery(
      batchInput,
      options,
      translateBatch,
      warnings
    );
    const inputIds = new Set(batchInput.map((item) => item.id));

    for (const output of outputs) {
      if (!inputIds.has(output.id)) {
        pushTranslationWarning(warnings, `unknown_model_output:${output.id}`);
        continue;
      }
      if (translationMap.has(output.id)) {
        pushTranslationWarning(warnings, `duplicate_model_output:${output.id}`);
        continue;
      }
      translationMap.set(output.id, output);
    }
  }

  return translationMap;
}

async function translateBatchWithRecovery(
  items: NameTranslationModelInputItem[],
  options: NameTranslationOptions,
  translateBatch: NonNullable<CreateNameTranslationPlanDeps["translateBatch"]>,
  warnings: string[]
): Promise<NameTranslationModelOutputItem[]> {
  try {
    return await translateBatch(items, options);
  } catch (error) {
    if (error instanceof NameTranslationPlannerError) {
      throw error;
    }

    const message = formatModelError(error);
    pushTranslationWarning(warnings, `model_batch_failed:${items.length}:${message}`);

    if (isNonRecoverableModelError(message)) {
      throw new NameTranslationPlannerError(
        `名称翻译模型调用失败：${message}`,
        "model_request_failed"
      );
    }

    if (items.length <= 1) {
      return [];
    }

    const midpoint = Math.ceil(items.length / 2);
    pushTranslationWarning(
      warnings,
      `model_batch_retry_split:${items.length}:${midpoint}+${items.length - midpoint}`
    );

    const left = await translateBatchWithRecovery(
      items.slice(0, midpoint),
      options,
      translateBatch,
      warnings
    );
    const right = await translateBatchWithRecovery(
      items.slice(midpoint),
      options,
      translateBatch,
      warnings
    );

    return [...left, ...right];
  }
}

function createPlanItem(
  target: NameTranslationTarget,
  options: NameTranslationOptions,
  translationMap: Map<string, NameTranslationModelOutputItem>,
  warnings: string[]
): NameTranslationPlanItem {
  if (target.skipped) {
    return {
      id: createPlanItemId(target.id),
      targetId: target.id,
      kind: target.kind,
      sourcePath: target.absolutePath,
      sourceParentPath: target.parentPath,
      originalName: target.originalName,
      translatedStem: target.stem,
      newName: target.originalName,
      targetPath: target.absolutePath,
      status: "skipped",
      reason: target.skipReason ?? "skipped_by_scanner",
      warnings: target.skipReason ? [target.skipReason] : [],
    };
  }

  const translation = translationMap.get(target.id);
  if (!translation) {
    return {
      id: createPlanItemId(target.id),
      targetId: target.id,
      kind: target.kind,
      sourcePath: target.absolutePath,
      sourceParentPath: target.parentPath,
      originalName: target.originalName,
      translatedStem: target.stem,
      newName: target.originalName,
      targetPath: target.absolutePath,
      status: "blocked",
      reason: "missing_translation",
      warnings: ["missing_translation"],
    };
  }

  const sanitized = sanitizeTranslatedName(
    target,
    translation.translatedStem,
    options
  );
  const itemWarnings = [...sanitized.warnings];
  if (translation.note) itemWarnings.push(`model_note:${translation.note}`);

  if (!sanitized.valid) {
    return {
      id: createPlanItemId(target.id),
      targetId: target.id,
      kind: target.kind,
      sourcePath: target.absolutePath,
      sourceParentPath: target.parentPath,
      originalName: target.originalName,
      translatedStem: sanitized.translatedStem,
      newName: sanitized.newName,
      targetPath: target.absolutePath,
      status: "blocked",
      reason: sanitized.reason ?? "invalid_name",
      warnings: itemWarnings,
    };
  }

  if (warnings.length > MAX_TRANSLATION_WARNINGS) {
    warnings.splice(MAX_TRANSLATION_WARNINGS);
  }

  return {
    id: createPlanItemId(target.id),
    targetId: target.id,
    kind: target.kind,
    sourcePath: target.absolutePath,
    sourceParentPath: target.parentPath,
    originalName: target.originalName,
    translatedStem: sanitized.translatedStem,
    newName: sanitized.newName,
    targetPath: joinPath(target.parentPath, sanitized.newName),
    status: "ready",
    warnings: itemWarnings,
  };
}

async function collectExistingTargetPaths(
  items: NameTranslationPlanItem[],
  checkPathExists: NonNullable<CreateNameTranslationPlanDeps["checkPathExists"]>
): Promise<string[]> {
  const pathsToCheck = new Map<string, string>();

  for (const item of items) {
    if (item.status === "blocked" || item.status === "skipped") continue;
    if (item.sourcePath === item.targetPath) continue;
    pathsToCheck.set(item.targetPath, item.targetPath);
  }

  const existingPaths: string[] = [];
  await Promise.all(
    [...pathsToCheck.values()].map(async (targetPath) => {
      try {
        if (await checkPathExists(targetPath)) existingPaths.push(targetPath);
      } catch {
        // Permission and IPC failures are handled later by apply validation.
      }
    })
  );

  return existingPaths;
}

async function translateBatchWithTaskModel(
  items: NameTranslationModelInputItem[],
  options: NameTranslationOptions
): Promise<NameTranslationModelOutputItem[]> {
  const taskProfile = await getTaskProfile();
  if (!taskProfile?.apiKey || !taskProfile.modelKey || !taskProfile.baseUrl) {
    throw new NameTranslationPlannerError(
      "未配置任务执行模型，请在设置页面配置。",
      "missing_task_model"
    );
  }

  const model = createModel(taskProfile);
  const system = buildNameTranslationSystemPrompt(options);
  const prompt = buildNameTranslationUserPrompt(items);
  const maxOutputTokens = getModelOutputTokenBudget(items);

  try {
    const result = await generateObject({
      model,
      schema: modelOutputSchema,
      schemaName: "name_translation_result",
      schemaDescription:
        "Filename and folder basename translations keyed by the original input id.",
      system,
      prompt,
      temperature: 0.2,
      maxOutputTokens,
      maxRetries: 2,
      experimental_repairText: async ({ text }) =>
        repairNameTranslationModelJsonText(text),
    });

    return result.object.items;
  } catch (structuredError) {
    try {
      const result = await generateText({
        model,
        system: [
          system,
          "Return raw JSON only. The response must begin with { and end with }.",
        ].join("\n"),
        prompt,
        temperature: 0.2,
        maxOutputTokens,
        maxRetries: 2,
      });

      return parseNameTranslationModelOutputText(result.text);
    } catch (fallbackError) {
      throw new Error(
        `structured_output_failed:${formatModelError(structuredError)}; text_fallback_failed:${formatModelError(fallbackError)}`
      );
    }
  }
}

export function repairNameTranslationModelJsonText(text: string): string | null {
  const normalized = normalizeModelOutputText(text);
  const direct = coerceJsonCandidate(normalized);
  if (direct) return direct;

  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fencedCandidate = coerceJsonCandidate(fenced[1].trim());
    if (fencedCandidate) return fencedCandidate;
  }

  const objectCandidate = extractFirstBalancedJson(normalized, "{", "}");
  if (objectCandidate) {
    const repairedObject = coerceJsonCandidate(objectCandidate);
    if (repairedObject) return repairedObject;
  }

  const arrayCandidate = extractFirstBalancedJson(normalized, "[", "]");
  if (arrayCandidate) {
    const repairedArray = coerceJsonCandidate(arrayCandidate);
    if (repairedArray) return repairedArray;
  }

  return null;
}

export function parseNameTranslationModelOutputText(
  text: string
): NameTranslationModelOutputItem[] {
  const repaired = repairNameTranslationModelJsonText(text);
  if (!repaired) {
    throw new Error(`response_not_json:${createTextPreview(text)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(repaired);
  } catch (error) {
    throw new Error(`json_parse_failed:${formatModelError(error)}`);
  }

  const validation = modelOutputSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(`schema_validation_failed:${validation.error.message}`);
  }

  return validation.data.items;
}

function getModelOutputTokenBudget(
  items: NameTranslationModelInputItem[]
): number {
  const estimated = items.reduce((total, item) => {
    const stemBudget = Math.max(80, Math.ceil(item.stem.length * 1.8));
    return total + stemBudget;
  }, 512);

  return Math.max(2048, Math.min(4096, estimated));
}

function normalizeModelOutputText(text: string): string {
  let normalized = text.replace(/^\uFEFF/, "").trim();
  normalized = normalized.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const unclosedThinkEnd = normalized.toLowerCase().lastIndexOf("</think>");
  if (unclosedThinkEnd >= 0) {
    normalized = normalized.slice(unclosedThinkEnd + "</think>".length).trim();
  }

  const fullFence = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fullFence?.[1]) {
    normalized = fullFence[1].trim();
  }

  return normalized;
}

function coerceJsonCandidate(candidate: string): string | null {
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) {
      return JSON.stringify({ items: parsed });
    }
    return candidate;
  } catch {
    return null;
  }
}

function extractFirstBalancedJson(
  text: string,
  openChar: "{" | "[",
  closeChar: "}" | "]"
): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (start < 0) {
      if (char === openChar) {
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

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function isNonRecoverableModelError(message: string): boolean {
  return [
    /401|403|unauthorized|forbidden|invalid api key/i,
    /429|rate limit|too many requests/i,
    /insufficient_quota|quota exceeded|billing/i,
    /404|model .*not found|model_not_found/i,
    /ENOTFOUND|ECONNREFUSED|network|fetch failed/i,
  ].some((pattern) => pattern.test(message));
}

function formatModelError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? ` cause=${error.cause.message}`
        : error.cause
          ? ` cause=${String(error.cause)}`
          : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

function createTextPreview(value: unknown, maxLength = 240): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength)}...`
    : compact;
}

function pushTranslationWarning(warnings: string[], warning: string): void {
  if (warnings.length >= MAX_TRANSLATION_WARNINGS) return;
  warnings.push(warning);
}

async function getTaskProfile(): Promise<ModelProfile | null> {
  const module = await import("@/store/useModelStore");
  return module.default.getState().getTaskProfile();
}

function createModel(profile: ModelProfile) {
  const baseURL = profile.baseUrl.replace(/\/chat\/completions\/?$/, "");
  const provider = createOpenAICompatible({
    baseURL,
    apiKey: profile.apiKey,
    name: "fusionkit-name-translation",
  });
  return provider(profile.modelKey);
}

function toModelInputItem(
  target: NameTranslationTarget
): NameTranslationModelInputItem {
  return {
    id: target.id,
    kind: target.kind,
    originalName: target.originalName,
    stem: target.stem,
    extension: target.extension,
    contextPath: target.parentPath,
  };
}

function buildPlan(params: {
  planId: string;
  createdAt: number;
  previewLimit: number;
  options: NameTranslationOptions;
  items: NameTranslationPlanItem[];
  warnings: string[];
  clarificationRequired?: ClarificationRequired;
  totalTargets?: number;
}): NameTranslationPlan {
  const readyCount = params.items.filter((item) => item.status === "ready").length;
  const blockedCount = params.items.filter(
    (item) => item.status === "blocked"
  ).length;
  const skippedCount = params.items.filter(
    (item) => item.status === "skipped"
  ).length;
  const unchangedCount = params.items.filter(
    (item) => item.status === "unchanged"
  ).length;
  const totalTargets = params.totalTargets ?? params.items.length;

  return {
    planId: params.planId,
    createdAt: params.createdAt,
    expiresAt: createPlanExpiry(params.createdAt),
    options: params.options,
    roots: params.options.roots,
    totalTargets,
    previewLimit: params.previewLimit,
    items: params.items,
    itemsPreview: params.items.slice(0, params.previewLimit),
    itemsStored: params.items.length > params.previewLimit,
    readyCount,
    blockedCount,
    skippedCount,
    unchangedCount,
    warnings: dedupeWarnings(params.warnings),
    clarificationRequired: params.clarificationRequired,
    applyable:
      !params.clarificationRequired &&
      readyCount > 0 &&
      blockedCount === 0 &&
      params.items.length > 0,
  };
}

function createPlanId(): string {
  return `rename_plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function createPlanItemId(targetId: string): string {
  return `rename_item_${targetId.replace(/^rename_target_/, "")}`;
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)].slice(0, 200);
}
