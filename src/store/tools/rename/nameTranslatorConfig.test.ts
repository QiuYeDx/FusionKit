import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NAME_TRANSLATION_OPTIONS } from "@/services/rename/nameTypes";
import {
  NAME_TRANSLATOR_STORAGE_KEY,
  NAME_TRANSLATOR_STORE_VERSION,
  sanitizeNameTranslatorPreferences,
} from "./nameTranslatorConfig";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
  return values;
});

vi.mock("@/utils/toast", () => ({ showToast: vi.fn() }));

beforeEach(() => {
  storage.clear();
  vi.resetModules();
});

describe("name translator configuration persistence", () => {
  it("sanitizes persisted options without retaining roots or path ranges", () => {
    expect(
      sanitizeNameTranslatorPreferences({
        roots: ["C:\\private\\input"],
        scope: "descendants",
        targetKind: "both",
        maxDepth: 8,
        includeHidden: true,
        sourceLang: "JA",
        targetLang: "ZH",
        namingStyle: "snake",
        outputMode: "bilingual_target_first",
        bilingualSeparator: "__",
        preserveExtension: false,
        preserveLeadingDot: false,
        preserveTechnicalTokens: false,
        collisionPolicy: "append_index",
        pathSegmentRange: {
          startPath: "C:\\private",
          endPath: "C:\\private\\input",
        },
      }),
    ).toEqual({
      ...DEFAULT_NAME_TRANSLATION_OPTIONS,
      roots: [],
      scope: "descendants",
      targetKind: "both",
      recursive: true,
      maxDepth: 8,
      includeHidden: true,
      includeRoot: false,
      sourceLang: "JA",
      targetLang: "ZH",
      namingStyle: "snake",
      outputMode: "bilingual_target_first",
      bilingualSeparator: "__",
      preserveExtension: false,
      preserveLeadingDot: false,
      preserveTechnicalTokens: false,
      collisionPolicy: "append_index",
    });
  });

  it("restores preferences but never selected paths, plans, or errors", async () => {
    localStorage.setItem(
      NAME_TRANSLATOR_STORAGE_KEY,
      JSON.stringify({
        version: NAME_TRANSLATOR_STORE_VERSION,
        state: {
          options: {
            ...DEFAULT_NAME_TRANSLATION_OPTIONS,
            roots: ["C:\\private\\input"],
            sourceLang: "EN",
            targetLang: "JA",
            namingStyle: "kebab",
          },
          selectedPaths: [{ path: "C:\\private\\input" }],
          currentPlan: { planId: "private-plan" },
          lastError: "private-error",
        },
      }),
    );

    const { default: store } = await import("./useNameTranslatorStore");
    expect(store.getState()).toMatchObject({
      options: {
        roots: [],
        sourceLang: "EN",
        targetLang: "JA",
        namingStyle: "kebab",
      },
      selectedPaths: [],
      currentPlan: null,
      lastError: null,
    });

    store.getState().updateOptions({ outputMode: "bilingual_original_first" });
    const persisted = storage.get(NAME_TRANSLATOR_STORAGE_KEY) ?? "";
    expect(persisted).toContain('"outputMode":"bilingual_original_first"');
    expect(persisted).not.toMatch(/private\\input|private-plan|private-error/u);
  });
});
