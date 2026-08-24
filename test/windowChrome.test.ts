import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const titleBarSource = readFileSync(
  new URL("../src/pages/components/AppTitleBar.tsx", import.meta.url),
  "utf8",
);

describe("window chrome", () => {
  it("centers the macOS traffic lights in the title bar capsule", () => {
    expect(titleBarSource).toContain("app-region-drag h-10");
    expect(mainSource).toContain(
      "trafficLightPosition: { x: 12, y: 12.5 }",
    );
    expect(mainSource).not.toContain("trafficLightPosition: { x: 15, y: 11.5 }");
    expect(mainSource).not.toContain("trafficLightPosition: { x: 15, y: 13 }");
  });
});
