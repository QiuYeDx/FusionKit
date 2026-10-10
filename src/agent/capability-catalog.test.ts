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
    expect(AGENT_CAPABILITIES).toHaveLength(7);
    for (const item of AGENT_CAPABILITIES) {
      expect(item.route).toMatch(/^\/tools\//);
      expect(item.operations.length).toBeGreaterThan(0);
    }
  });
});

describe("translation materials capability", () => {
  it("lists the knowledge tools the agent can call", async () => {
    const { AGENT_CAPABILITIES } = await import("./capability-catalog");
    const { knowledgeAgentTools } = await import("./knowledge-tools");
    const operations = AGENT_CAPABILITIES.find(item => item.toolKey === "translationKnowledge")!.operations;
    expect(operations).toEqual(["search_translation_knowledge", "list_translation_knowledge_catalog", "prepare_knowledge_changes"]);
    for (const name of operations) expect(knowledgeAgentTools).toHaveProperty(name);
  });
});
