import type {
  NameTranslationModelOutputItem,
  NameTranslationOptions,
  NameTranslationTarget,
} from "./nameTypes";

const DEFAULT_TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES = 5000;
const CACHE_KEY_SEPARATOR = "\u0001";

export interface NameTranslationCacheEntry {
  key: string;
  translatedStem: string;
  confidence?: NameTranslationModelOutputItem["confidence"];
  note?: string;
  createdAt: number;
  modelKey?: string;
}

export interface NameTranslationCache {
  get(key: string): NameTranslationCacheEntry | null;
  set(entry: NameTranslationCacheEntry): void;
  clearExpired(now?: number): void;
}

export interface MemoryNameTranslationCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class MemoryNameTranslationCache implements NameTranslationCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, NameTranslationCacheEntry>();

  constructor(options: MemoryNameTranslationCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TRANSLATION_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES));
    this.now = options.now ?? Date.now;
  }

  get(key: string): NameTranslationCacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (this.isExpired(entry, this.now())) {
      this.entries.delete(key);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry };
  }

  set(entry: NameTranslationCacheEntry): void {
    if (this.isExpired(entry, this.now())) {
      this.entries.delete(entry.key);
      return;
    }

    this.entries.delete(entry.key);
    this.entries.set(entry.key, { ...entry });
    this.evictOverflow();
  }

  clearExpired(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private isExpired(entry: NameTranslationCacheEntry, now: number): boolean {
    return now - entry.createdAt > this.ttlMs;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") return;
      this.entries.delete(oldestKey);
    }
  }
}

export const defaultNameTranslationCache = new MemoryNameTranslationCache();

export function clearDefaultNameTranslationCacheForTest(): void {
  defaultNameTranslationCache.clear();
}

export function createNameTranslationCacheKey(
  target: NameTranslationTarget,
  options: NameTranslationOptions
): string {
  const normalizedStem = target.stem.normalize("NFC").trim();
  return [
    "v1",
    target.kind,
    options.sourceLang,
    options.targetLang,
    options.namingStyle,
    options.preserveTechnicalTokens ? "preserve_tokens" : "translate_tokens",
    target.extension ? "has_extension" : "no_extension",
    normalizedStem,
  ].join(CACHE_KEY_SEPARATOR);
}

export function createNameTranslationOutputFromCache(
  targetId: string,
  entry: NameTranslationCacheEntry
): NameTranslationModelOutputItem {
  return {
    id: targetId,
    translatedStem: entry.translatedStem,
    confidence: entry.confidence,
    note: entry.note,
  };
}
