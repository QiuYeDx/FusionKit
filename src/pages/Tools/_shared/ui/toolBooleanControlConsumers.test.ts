import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const toolsRoot = fileURLToPath(new URL("../..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(toolsRoot, relativePath), "utf8");
}

function collectCheckboxConsumers(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectCheckboxConsumers(absolutePath);
    if (!entry.name.endsWith(".tsx")) return [];
    return readFileSync(absolutePath, "utf8").includes("<Checkbox")
      ? [path.relative(toolsRoot, absolutePath)]
      : [];
  });
}

describe("tool boolean controls", () => {
  it("uses the shared switch row for boolean configuration", () => {
    const expectedCounts = new Map([
      ["Rename/NameTranslator/components/OptionsPanel.tsx", 3],
      ["Subtitle/SubtitleConverter/index.tsx", 1],
      ["Subtitle/SubtitleTranslator/index.tsx", 3],
      ["Audio/SpeechSynthesizer/index.tsx", 1],
    ]);

    for (const [relativePath, expectedCount] of expectedCounts) {
      expect(read(relativePath).match(/<ToolSwitchRow/g)).toHaveLength(
        expectedCount,
      );
    }
  });

  it("keeps checkboxes only for multi-selection semantics", () => {
    expect(collectCheckboxConsumers(toolsRoot).sort()).toEqual([
      "Audio/AudioTranscriber/index.tsx",
      "Subtitle/LocalSubtitleTranscriber/index.tsx",
      "Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx",
    ]);

    expect(read("Audio/AudioTranscriber/index.tsx")).toContain(
      "TIMESTAMP_GRANULARITIES.map",
    );
    expect(read("Subtitle/LocalSubtitleTranscriber/index.tsx")).toContain(
      "preferences.outputFormats.includes(format)",
    );
    expect(
      read("Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx"),
    ).toContain("isSelected");
  });
});
