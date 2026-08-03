import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

describe("local subtitle transcriber page wiring", () => {
  it("uses shared tool controls and the fixed local subtitle bridge", () => {
    for (const component of [
      "ToolDetailLayout",
      "ToolConfigPanel",
      "ToolField",
      "ToolFileDropZone",
      "ToolRadioButtonGroup",
      "ToolOutputPathPicker",
    ]) {
      expect(source).toContain(component);
    }
    for (const method of [
      "authorizeInputFiles",
      "probeRuntime",
      "listManagedResources",
      "enqueue",
      "revealArtifact",
    ]) {
      expect(source).toContain(`window.localSubtitleApi.${method}`);
    }
    expect(source).not.toContain("window.ipcRenderer");
    expect(source).not.toContain('"audio:');
  });

  it("exposes stable hooks for the single-file start, progress, and result flow", () => {
    expect(source).toContain('inputTestId="local-subtitle-file-input"');
    expect(source).toContain('data-testid="local-subtitle-start"');
    expect(source).toContain('data-testid="local-subtitle-result"');
    expect(source).toContain("task.progress.overallProgress");
  });
});
