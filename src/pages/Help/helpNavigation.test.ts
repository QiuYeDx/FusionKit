import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP_ROUTE, HELP_SECTION_IDS, helpAnchorId, helpPath, resolveHelpSection } from "./helpNavigation";

const pageSource = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

describe("help navigation", () => {
  it("links to a section with a stable query and anchor", () => {
    expect(HELP_ROUTE).toBe("/help");
    expect(helpPath()).toBe("/help");
    expect(helpPath("cannot-open")).toBe("/help?section=cannot-open");
    expect(helpAnchorId("download-failed")).toBe("help-download-failed");
    expect(HELP_SECTION_IDS).toEqual([
      "quick-start", "cannot-open", "models-and-cost", "download-failed",
      "transcription-failed", "proxy", "external-agent", "system-requirements",
    ]);
  });

  it("only accepts known sections from the address", () => {
    for (const id of HELP_SECTION_IDS) expect(resolveHelpSection(id)).toBe(id);
    for (const value of [null, undefined, "", "Cannot-Open", "help-proxy", "../setting"]) expect(resolveHelpSection(value)).toBeUndefined();
  });

  it("renders every section on the page", () => {
    for (const id of HELP_SECTION_IDS) {
      // Listed in the contents, and rendered either on its own or from the page's topics.
      expect(pageSource).toContain(`{ id: "${id}",`);
      expect(pageSource).toMatch(new RegExp(`sectionProps\\("${id}"\\)|"?${id}"?: \\{`));
    }
  });
});
