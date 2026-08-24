import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const toolsRoot = fileURLToPath(new URL("../..", import.meta.url));
const settingRoot = fileURLToPath(new URL("../../../Setting", import.meta.url));

function collectTsxSources(directory: string): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxSources(absolutePath);
    if (!entry.name.endsWith(".tsx")) return [];
    return [[absolutePath, readFileSync(absolutePath, "utf8")]];
  });
}

describe("segmented control consumers", () => {
  it("routes tool configuration radio groups through the shared wrapper", () => {
    const wrapperSource = readFileSync(
      path.join(toolsRoot, "_shared/ui/ToolRadioButtonGroup.tsx"),
      "utf8",
    );
    expect(wrapperSource).toContain('from "@/components/qiuye-ui/segmented-control"');
    expect(wrapperSource).toContain('size="sm"');

    const legacySelectedButtons = collectTsxSources(toolsRoot).filter(
      ([, source]) =>
        /variant=\{[\s\S]{0,180}\?\s*["']default["']\s*:\s*["']outline["']/.test(
          source,
        ),
    );
    expect(legacySelectedButtons.map(([file]) => path.relative(toolsRoot, file))).toEqual([
      "Audio/SpeechSynthesizer/index.tsx",
    ]);
    expect(legacySelectedButtons[0]?.[1]).toContain("OPENAI_VOICE_HINTS.map");
  });

  it("uses SegmentedControl for settings-page radio groups", () => {
    const expectedConsumers = [
      "components/AudioApiConfig.tsx",
      "components/GeneralConfig.tsx",
      "components/ModelConfig.tsx",
      "components/ProxyConfig.tsx",
    ];

    const consumers = collectTsxSources(settingRoot)
      .filter(([, source]) => source.includes("<SegmentedControl"))
      .map(([file]) => path.relative(settingRoot, file))
      .sort();
    expect(consumers).toEqual(expectedConsumers);

    for (const [file, source] of collectTsxSources(settingRoot)) {
      expect(source, path.relative(settingRoot, file)).not.toMatch(
        /variant=\{[\s\S]{0,180}\?\s*["']default["']\s*:\s*["']outline["']/,
      );
    }
  });
});
