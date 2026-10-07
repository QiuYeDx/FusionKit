import type {
  NameEntryKind,
  NameLanguage,
  NameSourceLanguage,
  NameTranslateItem,
  NameTranslateResult,
  NameTranslationError,
  NameTranslationIpcResult,
  NameTranslationRuntimeModel,
} from "@/name-translation/contract";
import {
  cleanTranslatedStem,
  hasTranslatableText,
  translatableStem,
} from "@/name-translation/naming-rules";

/**
 * Renderer-side translation orchestration: groups siblings into batches,
 * runs a few batches at a time, retries failed ids once and reports each
 * entry as soon as its batch settles.
 */

export interface TranslationTarget {
  readonly key: string;
  readonly name: string;
  readonly kind: NameEntryKind;
  readonly parentPath: string;
}

export interface TranslationSettings {
  readonly model: NameTranslationRuntimeModel;
  readonly sourceLang: NameSourceLanguage;
  readonly targetLang: NameLanguage;
  readonly instructions?: string;
}

export type TranslateBatch = (request: {
  requestId: string;
  model: NameTranslationRuntimeModel;
  sourceLang: NameSourceLanguage;
  targetLang: NameLanguage;
  instructions?: string;
  items: NameTranslateItem[];
}) => Promise<NameTranslationIpcResult<NameTranslateResult>>;

export interface TranslateTargetsOptions {
  readonly targets: readonly TranslationTarget[];
  readonly settings: TranslationSettings;
  readonly requestId: string;
  readonly translateBatch: TranslateBatch;
  readonly isCancelled: () => boolean;
  /** stem is the cleaned translated stem, or null when the entry failed. */
  readonly onResult: (key: string, stem: string | null) => void;
  readonly maxBatchItems?: number;
  readonly maxBatchChars?: number;
  readonly concurrency?: number;
}

export interface TranslateTargetsOutcome {
  readonly fatal?: NameTranslationError;
  readonly cancelled: boolean;
}

const FATAL_CODES = new Set(["model_auth", "model_quota", "model_not_found", "invalid_request"]);

export function folderContext(parentPath: string): string {
  const segments = parentPath.split(/[\\/]+/).filter(Boolean);
  return segments.slice(-2).join("/");
}

export function createBatches(
  targets: readonly TranslationTarget[],
  maxItems: number,
  maxChars: number,
): TranslationTarget[][] {
  const byParent = new Map<string, TranslationTarget[]>();
  for (const target of targets) {
    const group = byParent.get(target.parentPath) ?? [];
    group.push(target);
    byParent.set(target.parentPath, group);
  }
  const batches: TranslationTarget[][] = [];
  for (const group of byParent.values()) {
    let current: TranslationTarget[] = [];
    let chars = 0;
    for (const target of group) {
      const length = target.name.length;
      if (current.length > 0 && (current.length >= maxItems || chars + length > maxChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(target);
      chars += length;
    }
    if (current.length > 0) batches.push(current);
  }
  return batches;
}

export async function translateTargets(
  options: TranslateTargetsOptions,
): Promise<TranslateTargetsOutcome> {
  const { settings, onResult } = options;
  const modelTargets: TranslationTarget[] = [];
  for (const target of options.targets) {
    const stem = translatableStem(target.name, target.kind);
    // Names without letters (numbers, dates, symbols) keep their stem.
    if (!hasTranslatableText(stem)) onResult(target.key, stem);
    else modelTargets.push(target);
  }

  const queue = createBatches(
    modelTargets,
    options.maxBatchItems ?? 40,
    options.maxBatchChars ?? 3_000,
  ).map((batch) => ({ batch, retried: false }));
  let fatal: NameTranslationError | undefined;
  let cancelled = false;

  const runBatch = async (batch: TranslationTarget[], retried: boolean) => {
    const items = batch.map((target, index) => ({
      id: String(index + 1),
      name: translatableStem(target.name, target.kind),
      kind: target.kind,
      context: folderContext(target.parentPath) || undefined,
    }));
    const result = await options.translateBatch({
      requestId: options.requestId,
      model: settings.model,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      ...(settings.instructions?.trim() ? { instructions: settings.instructions.trim() } : {}),
      items,
    });
    if (options.isCancelled() || fatal) return;
    if (!result.ok) {
      if (result.error.code === "cancelled") {
        cancelled = true;
        return;
      }
      if (FATAL_CODES.has(result.error.code)) {
        fatal = result.error;
        return;
      }
      if (!retried) {
        queue.push(...splitForRetry(batch));
        return;
      }
      batch.forEach((target) => onResult(target.key, null));
      return;
    }
    const translated = new Map(result.data.items.map((item) => [item.id, item.name]));
    const missing: TranslationTarget[] = [];
    batch.forEach((target, index) => {
      const raw = translated.get(String(index + 1));
      const cleaned = raw === undefined ? "" : cleanTranslatedStem(raw, settings.targetLang);
      if (cleaned) onResult(target.key, cleaned);
      else missing.push(target);
    });
    if (missing.length === 0) return;
    if (!retried) queue.push(...splitForRetry(missing));
    else missing.forEach((target) => onResult(target.key, null));
  };

  const splitForRetry = (batch: TranslationTarget[]) => {
    if (batch.length <= 4) return [{ batch, retried: true }];
    const middle = Math.ceil(batch.length / 2);
    return [
      { batch: batch.slice(0, middle), retried: true },
      { batch: batch.slice(middle), retried: true },
    ];
  };

  const worker = async () => {
    while (queue.length > 0 && !fatal && !cancelled && !options.isCancelled()) {
      const next = queue.shift()!;
      try {
        await runBatch(next.batch, next.retried);
      } catch {
        // An IPC failure is treated like a failed batch: retry once, then fail.
        if (!next.retried) queue.push(...splitForRetry(next.batch));
        else next.batch.forEach((target) => onResult(target.key, null));
      }
    }
  };

  const concurrency = Math.max(1, options.concurrency ?? 3);
  // Workers pick up retry batches pushed while others are still running.
  let active: Promise<void>[] = [];
  do {
    active = Array.from({ length: Math.min(concurrency, queue.length) }, worker);
    await Promise.all(active);
  } while (queue.length > 0 && !fatal && !cancelled && !options.isCancelled());

  return { ...(fatal ? { fatal } : {}), cancelled: cancelled || options.isCancelled() };
}
