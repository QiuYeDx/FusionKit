import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  let failTargetWrites = false;
  const localStorage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (
        failTargetWrites &&
        key === "fusionkit-subtitle-translator-config"
      ) {
        throw new Error("target write failed");
      }
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  return {
    localStorage,
    values,
    failTargetWrites(value: boolean) {
      failTargetWrites = value;
    },
  };
});

describe("subtitle translator config bootstrap import ordering", () => {
  beforeEach(() => {
    storage.values.clear();
    storage.failTargetWrites(false);
    vi.resetModules();
  });

  it("produces the same verified target for source-first and target-first imports", async () => {
    seedLegacyConfig();
    await import("./useSubtitleTranslatorStore");
    const sourceFirst = storage.values.get(
      "fusionkit-subtitle-translator-config",
    );
    expect(sourceFirst).toBeDefined();

    storage.values.clear();
    seedLegacyConfig();
    vi.resetModules();
    const { default: targetStore } = await import(
      "./useSubtitleTranslatorConfigStore"
    );
    const targetFirst = storage.values.get(
      "fusionkit-subtitle-translator-config",
    );

    expect(targetFirst).toBe(sourceFirst);
    expect(targetStore.getState()).toMatchObject({
      migrationStatus: "ready",
      preferences: {
        sourceLang: "EN",
        targetLang: "JA",
        outputMode: "source",
        conflictPolicy: "overwrite",
      },
    });
    expect(storage.values.get("subtitle-translator-source-lang")).toBe("EN");
    expect(storage.values.get("fusionkit-subtitle-translator")).toContain(
      "private-output-path",
    );
  });

  it("keeps a failed live Store blocked until a clean reload hydrates verified data", async () => {
    seedLegacyConfig();
    storage.failTargetWrites(true);
    const failedModule = await import("./useSubtitleTranslatorConfigStore");
    expect(failedModule.default.getState().migrationStatus).toBe("failed");
    expect(
      storage.values.has("fusionkit-subtitle-translator-config"),
    ).toBe(false);
    expect(storage.values.get("fusionkit-subtitle-translator")).toContain(
      "private-output-path",
    );

    storage.failTargetWrites(false);
    expect(
      failedModule.bootstrapLegacySubtitleTranslatorConfig(storage.localStorage),
    ).toBe("migrated");
    expect(failedModule.default.getState().migrationStatus).toBe("failed");

    vi.resetModules();
    const { default: reloadedStore } = await import(
      "./useSubtitleTranslatorConfigStore"
    );
    expect(reloadedStore.getState()).toMatchObject({
      migrationStatus: "ready",
      preferences: { sourceLang: "EN", targetLang: "JA" },
    });
  });
});

function seedLegacyConfig(): void {
  storage.values.set("subtitle-translator-source-lang", "EN");
  storage.values.set("subtitle-translator-target-lang", "JA");
  storage.values.set("subtitle-translator-output-mode", "source");
  storage.values.set("subtitle-translator-conflict-policy", "overwrite");
  storage.values.set(
    "fusionkit-subtitle-translator",
    JSON.stringify({
      state: { outputURL: "/private-output-path", sliceType: "NORMAL" },
      version: 0,
    }),
  );
}
