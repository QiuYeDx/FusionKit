import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./index.tsx", import.meta.url),
  "utf8",
);

describe("subtitle translator configuration ownership", () => {
  it("uses the persisted config store instead of page-local legacy keys", () => {
    expect(source).toContain(
      "const translatorConfig = useSubtitleTranslatorConfigStore",
    );
    for (const legacyKey of [
      "subtitle-translator-output-mode",
      "subtitle-translator-conflict-policy",
      "subtitle-translator-concurrent-slices",
      "subtitle-translator-source-lang",
      "subtitle-translator-target-lang",
      "subtitle-translator-translation-output-mode",
    ]) {
      expect(source).not.toContain(`localStorage.getItem(\"${legacyKey}\")`);
      expect(source).not.toContain(`localStorage.setItem(\"${legacyKey}\"`);
    }
  });
});
