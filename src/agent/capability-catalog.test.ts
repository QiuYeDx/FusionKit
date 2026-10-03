import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AGENT_CAPABILITIES } from "./capability-catalog";

describe("official Agent capability catalog", () => {
  it("matches the actual featured/classic product sections and excludes experimental tools", () => {
    const source = readFileSync(new URL("../pages/Tools/index.tsx", import.meta.url), "utf8");
    const classic = source.split("const CLASSIC_TOOLS:")[1].split("const EXPERIMENTAL_TOOLS:")[0];
    const featured = source.split("const FEATURED_TOOLS =")[1].split("const Tools:")[0];
    const official = [...`${classic}\n${featured}`.matchAll(/id: "([A-Za-z]+)"/g)].map(match => match[1]);
    expect(AGENT_CAPABILITIES.map(item => item.toolKey).sort()).toEqual(official.sort());
    expect(AGENT_CAPABILITIES).toHaveLength(6);
    for (const item of AGENT_CAPABILITIES) {
      expect(item.route).toMatch(/^\/tools\//);
      expect(item.operations.length).toBeGreaterThan(0);
    }
  });
});
