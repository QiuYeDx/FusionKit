import { describe, expect, it } from "vitest";
import {
  createNameTranslationCacheKey,
  MemoryNameTranslationCache,
} from "./nameTranslationCache";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationOptions,
  type NameTranslationTarget,
} from "./nameTypes";

describe("MemoryNameTranslationCache", () => {
  it("expires entries by ttl", () => {
    let now = 1_000;
    const cache = new MemoryNameTranslationCache({
      ttlMs: 50,
      now: () => now,
    });

    cache.set({
      key: "translation:key",
      translatedStem: "Episode 1",
      createdAt: now,
    });

    expect(cache.get("translation:key")?.translatedStem).toBe("Episode 1");

    now = 1_051;

    expect(cache.get("translation:key")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entries when capacity is exceeded", () => {
    let now = 1_000;
    const cache = new MemoryNameTranslationCache({
      maxEntries: 2,
      now: () => now,
    });

    cache.set({ key: "a", translatedStem: "A", createdAt: now++ });
    cache.set({ key: "b", translatedStem: "B", createdAt: now++ });
    cache.set({ key: "c", translatedStem: "C", createdAt: now++ });

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")?.translatedStem).toBe("B");
    expect(cache.get("c")?.translatedStem).toBe("C");
    expect(cache.size).toBe(2);
  });
});

describe("createNameTranslationCacheKey", () => {
  it("excludes local output composition options", () => {
    const target = createTarget("target_a", "第01話.srt", "第01話");
    const baseOptions: NameTranslationOptions = {
      ...DEFAULT_NAME_TRANSLATION_OPTIONS,
      roots: ["/tmp/rename"],
    };

    expect(
      createNameTranslationCacheKey(target, {
        ...baseOptions,
        outputMode: "target_only",
        bilingualSeparator: " - ",
      })
    ).toBe(
      createNameTranslationCacheKey(target, {
        ...baseOptions,
        outputMode: "bilingual_target_first",
        bilingualSeparator: " + ",
      })
    );
  });
});

function createTarget(
  id: string,
  originalName: string,
  stem: string
): NameTranslationTarget {
  const dotIndex = originalName.lastIndexOf(".");
  const extension = dotIndex > 0 ? originalName.slice(dotIndex) : "";
  return {
    id,
    kind: "file",
    absolutePath: `/tmp/rename/${originalName}`,
    parentPath: "/tmp/rename",
    originalName,
    stem,
    extension,
    depthFromRoot: 1,
    anchorRoot: "/tmp/rename",
  };
}
