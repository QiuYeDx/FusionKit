import { describe, expect, it } from "vitest";
import { REMOVED_TOOL_STORAGE_KEYS, removeRemovedToolSettings } from "./legacy-storage-cleanup";

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("removed tool settings cleanup", () => {
  it("removes the audio tools' settings and keeps every other key", () => {
    const storage = memoryStorage({
      ...Object.fromEntries(REMOVED_TOOL_STORAGE_KEYS.map((key) => [key, '{"state":{"apiKey":"sk-old"}}'])),
      "fusionkit-model": "{}",
      lang: "zh",
    });
    removeRemovedToolSettings(storage);
    expect([...storage.values.keys()].sort()).toEqual(["fusionkit-model", "lang"]);
    // Running it again on every start changes nothing.
    removeRemovedToolSettings(storage);
    expect([...storage.values.keys()].sort()).toEqual(["fusionkit-model", "lang"]);
  });

  it("does nothing when the keys are missing", () => {
    const storage = memoryStorage({ lang: "en" });
    removeRemovedToolSettings(storage);
    expect([...storage.values.keys()]).toEqual(["lang"]);
  });

  it("never throws when storage is unavailable", () => {
    expect(() => removeRemovedToolSettings({ removeItem: () => { throw new Error("denied"); } })).not.toThrow();
    expect(() => removeRemovedToolSettings(undefined)).not.toThrow();
  });
});
