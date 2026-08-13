import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const subtitleTranslatorSource = readFileSync(
  new URL("../../Subtitle/SubtitleTranslator/index.tsx", import.meta.url),
  "utf8",
);
const audioToolShellSource = readFileSync(
  new URL("../../Audio/shared/AudioToolShell.tsx", import.meta.url),
  "utf8",
);

describe("tool configuration disclosure consumers", () => {
  it("uses the shared disclosure for scheduled subtitle translation", () => {
    expect(subtitleTranslatorSource).toContain("<ToolConfigDisclosure");
    expect(subtitleTranslatorSource).toContain(
      'testId="subtitle-translator-schedule-settings"',
    );
    expect(subtitleTranslatorSource).toContain(
      'id="tour-schedule" className="-mb-4"',
    );
    expect(subtitleTranslatorSource).toMatch(
      /testId="subtitle-translator-schedule-settings"[\s\S]*?className="border-b-0"/,
    );
    expect(subtitleTranslatorSource).toContain("open={isScheduleOpen}");
    expect(subtitleTranslatorSource).toContain(
      "onOpenChange={handleScheduleOpenChange}",
    );
    expect(subtitleTranslatorSource).toContain("setDatePopoverOpen(false)");
    expect(subtitleTranslatorSource).not.toContain(
      "border border-dashed p-3 cursor-pointer",
    );
  });

  it("uses the shared disclosure for audio tool configuration details", () => {
    expect(audioToolShellSource).toContain("<ToolConfigDisclosure");
    expect(audioToolShellSource).toContain(
      "`${testIdPrefix}-technical-details`",
    );
    expect(audioToolShellSource).not.toContain("<details");
    expect(audioToolShellSource).not.toContain("<summary");
  });
});
