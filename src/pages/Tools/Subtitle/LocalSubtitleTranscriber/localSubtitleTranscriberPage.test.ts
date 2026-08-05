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
const draftMediaSource = readFileSync(
  new URL("./LocalSubtitleDraftMediaList.tsx", import.meta.url),
  "utf8",
);
const detailsDialogSource = readFileSync(
  new URL("./LocalSubtitleTaskDetailsDialogs.tsx", import.meta.url),
  "utf8",
);
const postActionServiceSource = readFileSync(
  new URL("../../../../services/local-subtitle/localSubtitlePostActionService.ts", import.meta.url),
  "utf8",
);
const source = `${pageSource}\n${environmentSource}\n${errorSource}\n${queueSource}\n${draftMediaSource}\n${detailsDialogSource}\n${postActionServiceSource}`;

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
      "probeMedia",
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
      "readArtifactText",
      "revealArtifact",
    ]) {
      expect(source).toContain(`window.localSubtitleApi.${method}`);
    }
    expect(postActionServiceSource).toContain(".handoffArtifact");
    expect(postActionServiceSource).toContain(".completePostAction");
    expect(source).not.toContain("window.ipcRenderer");
    expect(source).not.toContain('"audio:');
    expect(pageSource).toContain("backendPreviewGenerationRef");
    expect(pageSource).toContain("preferences.devicePreference");
    expect(pageSource).toContain("result.data.devicePreference !== devicePreference");
    expect(pageSource).toContain("preferences.vadEnabled");
    expect(pageSource).toContain("draftInitialPrompt");
    expect(pageSource).toContain("draftTaskMode");
    expect(pageSource).toContain('data-testid="local-subtitle-advanced-settings"');
    expect(pageSource).toContain('data-testid="local-subtitle-model-description"');
    expect(pageSource).not.toContain('devicePreference: "auto"');
    expect(pageSource).not.toContain('vadEnabled: false');
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
    expect(draftMediaSource).toContain('data-testid="local-subtitle-draft-files"');
    expect(source).toContain('data-testid="local-subtitle-start"');
    expect(source).toContain('data-testid="local-subtitle-task-queue"');
    expect(queueSource).toContain('data-testid="local-subtitle-task"');
    expect(source).toContain("task.progress.overallProgress");
    expect(queueSource).toContain('"cancel"');
    expect(queueSource).toContain('"retry"');
    expect(queueSource).toContain('"remove"');
    expect(queueSource).toContain('"reveal"');
    expect(queueSource).toContain("completion.artifacts.map");
    expect(pageSource).toContain("candidate.generation");
    expect(pageSource).toContain("mediaProbeQueueRef");
    expect(pageSource).toContain("explicitAudioStreamIds");
    expect(draftMediaSource).toContain('orientation="vertical"');
    expect(pageSource).not.toContain("taskActive");
    expect(pageSource).toContain("draftPostActionMode");
    expect(pageSource).toContain("draftPreferredHandoffFormat");
    expect(pageSource).toContain("preparedTranslationBatch");
    expect(postActionServiceSource).toContain("addedTaskIds");
    expect(postActionServiceSource).not.toContain("startAllTasks");
  });

  it("uses bounded ScrollableDialog surfaces for artifact and error details", () => {
    expect(detailsDialogSource).toContain("ScrollableDialog");
    expect(detailsDialogSource).toContain("createLocalSubtitleArtifactPreviewPage");
    expect(detailsDialogSource).toContain("navigator.clipboard.writeText");
    expect(detailsDialogSource).toContain("[overflow-wrap:anywhere]");
    expect(detailsDialogSource).toContain("[data-slot=scroll-area-viewport]>div");
    expect(detailsDialogSource).not.toContain('from "@/components/ui/dialog"');
  });
});
