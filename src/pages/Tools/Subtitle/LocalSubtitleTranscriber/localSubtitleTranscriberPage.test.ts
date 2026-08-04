import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const environmentSource = readFileSync(
  new URL("./LocalSubtitleEnvironmentManager.tsx", import.meta.url),
  "utf8",
);
const errorSource = readFileSync(
  new URL("./LocalSubtitleErrorNotice.tsx", import.meta.url),
  "utf8",
);
const queueSource = readFileSync(
  new URL("./LocalSubtitleTaskQueue.tsx", import.meta.url),
  "utf8",
);
const source = `${pageSource}\n${environmentSource}\n${errorSource}\n${queueSource}`;

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
      "previewBackend",
      "listManagedResources",
      "startResourceInstall",
      "cancelResourceJob",
      "importModel",
      "deleteManagedResource",
      "enqueue",
      "cancelTask",
      "retryTask",
      "retryTaskOnCpu",
      "removeTask",
      "revealArtifact",
    ]) {
      expect(source).toContain(`window.localSubtitleApi.${method}`);
    }
    expect(source).not.toContain("window.ipcRenderer");
    expect(source).not.toContain('"audio:');
    expect(pageSource).toContain("backendPreviewGenerationRef");
    expect(environmentSource).not.toContain("cpuAvailable");
  });

  it("renders resource progress from the shared session snapshot", () => {
    expect(pageSource).toContain("runtimeState.resourceJobs");
    expect(environmentSource).toContain("getLatestLocalSubtitleResourceJobs(resourceJobs)");
    expect(environmentSource).toContain("job.progress");
    expect(environmentSource).toContain("job.bytesCompleted");
    expect(environmentSource).toContain("job.error");
    expect(environmentSource).not.toContain("http://");
    expect(environmentSource).not.toContain("https://");
  });

  it("contains long resource diagnostics inside block wrapping surfaces", () => {
    expect(errorSource).toContain("whitespace-pre-wrap");
    expect(errorSource).toContain("[overflow-wrap:anywhere]");
    expect(environmentSource).toContain("break-words");
  });

  it("exposes stable hooks for batch drafts, task progress, and task actions", () => {
    expect(source).toContain('inputTestId="local-subtitle-file-input"');
    expect(pageSource).toContain("multiple");
    expect(pageSource).toContain("LOCAL_SUBTITLE_LIMITS.maxBatchFiles");
    expect(pageSource).toContain('data-testid="local-subtitle-draft-files"');
    expect(source).toContain('data-testid="local-subtitle-start"');
    expect(source).toContain('data-testid="local-subtitle-task-queue"');
    expect(queueSource).toContain('data-testid="local-subtitle-task"');
    expect(source).toContain("task.progress.overallProgress");
    expect(queueSource).toContain('"cancel"');
    expect(queueSource).toContain('"retry"');
    expect(queueSource).toContain('"remove"');
    expect(queueSource).toContain('"reveal"');
    expect(pageSource).toContain("candidate.generation");
    expect(pageSource).not.toContain("taskActive");
  });
});
