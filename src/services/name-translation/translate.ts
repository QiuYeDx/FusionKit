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
 * runs a few batches at a time and reports each entry as soon as its batch
 * settles. Entries the model drops or that fail are retried in ever smaller
 * batches (halves, then one name per request) before they are reported as
 * failed, because a single-name request is far more reliable than a long list.
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
  /** Called with the reason whenever a batch fails after its last retry. */
  readonly onBatchError?: (error: NameTranslationError) => void;
  readonly maxBatchItems?: number;
  readonly maxBatchChars?: number;
  readonly concurrency?: number;
}

export interface TranslateTargetsOutcome {
  readonly fatal?: NameTranslationError;
  readonly cancelled: boolean;
}

const FATAL_CODES = new Set(["model_auth", "model_quota", "model_not_found", "invalid_request"]);

/** Attempt 0 is the full batch; later attempts shrink the batch. */
const MAX_ATTEMPTS = 3;
const RETRY_BATCH_ITEMS = [Number.POSITIVE_INFINITY, 6, 1] as const;
const DEFAULT_BATCH_ITEMS = 24;
const DEFAULT_BATCH_CHARS = 2_000;

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

function chunk(targets: readonly TranslationTarget[], size: number): TranslationTarget[][] {
  if (!Number.isFinite(size) || targets.length <= size) return [[...targets]];
  const chunks: TranslationTarget[][] = [];
  for (let index = 0; index < targets.length; index += size) {
    chunks.push(targets.slice(index, index + size));
  }
  return chunks;
}

interface QueuedBatch {
  readonly batch: TranslationTarget[];
  readonly attempt: number;
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

  const queue: QueuedBatch[] = createBatches(
    modelTargets,
    options.maxBatchItems ?? DEFAULT_BATCH_ITEMS,
    options.maxBatchChars ?? DEFAULT_BATCH_CHARS,
  ).map((batch) => ({ batch, attempt: 0 }));
  let fatal: NameTranslationError | undefined;
  let cancelled = false;

  /** Re-queues the entries with a smaller batch size, or reports them failed. */
  const retryOrFail = (
    targets: readonly TranslationTarget[],
    attempt: number,
    error: NameTranslationError,
  ) => {
    if (targets.length === 0) return;
    const next = attempt + 1;
    if (next < MAX_ATTEMPTS) {
      queue.push(...chunk(targets, RETRY_BATCH_ITEMS[next]!).map((batch) => ({ batch, attempt: next })));
      return;
    }
    options.onBatchError?.(error);
    targets.forEach((target) => onResult(target.key, null));
  };

  const runBatch = async ({ batch, attempt }: QueuedBatch) => {
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
      retryOrFail(batch, attempt, result.error);
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
    retryOrFail(missing, attempt, {
      code: "model_incomplete",
      message: `The model returned no translation for ${missing.length} of ${batch.length} names.`,
    });
  };

  const worker = async () => {
    while (queue.length > 0 && !fatal && !cancelled && !options.isCancelled()) {
      const next = queue.shift()!;
      try {
        await runBatch(next);
      } catch (error) {
        // An IPC failure is treated like a failed batch: shrink and retry.
        retryOrFail(next.batch, next.attempt, {
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
        });
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
