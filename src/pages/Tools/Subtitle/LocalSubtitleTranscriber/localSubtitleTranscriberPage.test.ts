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
const disclosureSource = readFileSync(
  new URL("../../_shared/ui/ToolConfigDisclosure.tsx", import.meta.url),
  "utf8",
);
const postActionServiceSource = readFileSync(
  new URL("../../../../services/local-subtitle/localSubtitlePostActionService.ts", import.meta.url),
  "utf8",
);
const environmentServiceSource = readFileSync(
  new URL("../../../../services/local-subtitle/localSubtitleEnvironmentService.ts", import.meta.url),
  "utf8",
);
const mainSource = readFileSync(
  new URL("../../../../main.tsx", import.meta.url),
  "utf8",
);
const source = `${pageSource}\n${environmentSource}\n${errorSource}\n${queueSource}\n${draftMediaSource}\n${detailsDialogSource}\n${postActionServiceSource}\n${environmentServiceSource}\n${mainSource}`;

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
      "captureInputFile",
      "authorizeCapturedInputFiles",
      "probeMedia",
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
    for (const method of ["probeRuntime", "previewBackend", "listManagedResources"]) {
      expect(environmentServiceSource).toContain(`.${method}(`);
    }
    expect(pageSource).not.toContain("window.localSubtitleApi.probeRuntime");
    expect(pageSource).not.toContain("window.localSubtitleApi.previewBackend");
    expect(pageSource).not.toContain("window.localSubtitleApi.listManagedResources");
    expect(pageSource).toContain("LOCAL_SUBTITLE_IPC_BRIDGE_VERSION");
    expect(pageSource).toContain("window.localSubtitleApi.bridgeVersion");
    expect(pageSource).toContain("window.location.reload()");
    expect(pageSource).toContain("!bridgeCompatible");
    expect(pageSource.indexOf("captureInputFile(")).toBeLessThan(
      pageSource.indexOf("authorizeCapturedInputFiles("),
    );
    expect(pageSource).toContain("files.item(index)");
    expect(pageSource).not.toContain("Array.from(files)");
    expect(mainSource).toContain(
      "getLocalSubtitleEnvironmentService().ensureInitialized()",
    );
    expect(mainSource).toContain("getLocalSubtitleRuntimeService().start()");
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
    expect(pageSource).toContain('testId="local-subtitle-advanced-settings"');
    expect(pageSource).toContain('data-testid="local-subtitle-model-description"');
    expect(pageSource).toContain("window.localSubtitleApi.importModel(file, { mode, modelId })");
    expect(environmentSource).toContain("getLocalSubtitleModelImportTarget");
    expect(environmentSource).toContain("importTarget.resourceId");
    expect(pageSource).not.toContain('vadEnabled: false');
    expect(environmentSource).not.toContain("cpuAvailable");
  });

  it("disables unavailable execution devices and falls back to automatic selection", () => {
    expect(pageSource).toContain("isLocalSubtitleDevicePreferenceAvailable");
    expect(pageSource).toContain("disabled={!deviceAvailability[backend]}");
    expect(pageSource).toContain('updatePreferences({ devicePreference: "auto" })');
    expect(pageSource).toContain("if (!deviceAvailability[nextPreference]) return");
  });

  it("uses a clear disclosure row for advanced settings", () => {
    expect(pageSource.match(/<ToolConfigDisclosure/g)).toHaveLength(1);
    expect(pageSource).toContain("icon={SlidersHorizontal}");
    expect(disclosureSource).toContain("aria-expanded={isOpen}");
    expect(disclosureSource).toContain("aria-controls={contentId}");
    expect(disclosureSource).toContain("inert={!isOpen}");
    expect(disclosureSource).toContain("cursor-pointer");
    expect(disclosureSource).toContain('className={cn("-mx-4 border-y"');
    expect(disclosureSource).not.toContain("border-dashed");
    expect(disclosureSource).not.toContain("group-hover:bg-background");
    expect(environmentSource).toMatch(
      /data-testid="local-subtitle-runtime-toggle"[\s\S]*?className="[^"]*cursor-pointer/,
    );
  });

  it("combines environment readiness and resource availability in one badge", () => {
    expect(environmentSource).toContain("status_summary");
    expect(environmentSource).not.toContain("resources.ready_count");
  });

  it("does not expose an inert quality preset", () => {
    expect(pageSource).not.toContain("local-subtitle-quality-select");
    expect(pageSource).not.toContain("qualityPreset");
    expect(pageSource).not.toContain("quality_option");
  });

  it("renders the post-transcription action as a select below output settings", () => {
    expect(pageSource).toContain('data-testid="local-subtitle-post-action-select"');
    expect(pageSource).not.toContain('testId="local-subtitle-post-action-settings"');
    expect(pageSource.indexOf('data-testid="local-subtitle-post-action-select"')).toBeGreaterThan(
      pageSource.indexOf("subtitle:local_transcriber.config.output_mode"),
    );
    expect(pageSource).toContain('value="export_only"');
    expect(pageSource).toContain('value="enqueue_translation"');
    expect(pageSource).toContain('value="enqueue_and_start_translation"');
    expect(pageSource).toContain('data-testid="local-subtitle-handoff-format"');
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

  it("keeps each queue task in one flat translator-style row", () => {
    expect(queueSource).toContain("ToolPanel");
    expect(queueSource).toContain("ButtonGroup");
    expect(queueSource).toContain('bodyClassName="divide-y"');
    expect(queueSource).toContain("completion.artifacts.map");
    expect(queueSource).not.toContain("TaskArtifactResults");
    expect(queueSource).not.toContain("TaskPostActionResult");
    expect(queueSource).not.toContain("data-batch-id");
    expect(queueSource).not.toContain("createLocalSubtitleBatchNumberMap");
    expect(queueSource).not.toMatch(/bg-(?:blue|sky)/);
    expect(source).not.toContain("border-l-");
  });

  it("adds files directly to the same flat task queue with queue-level actions", () => {
    expect(pageSource).not.toContain("actions={startTranscriptionAction}");
    expect(queueSource).toContain("draftFiles.map");
    expect(queueSource).toContain("tasks.map");
    expect(queueSource).toContain("actions.start_all");
    expect(queueSource).toContain("actions.clear_completed");
    expect(queueSource).toContain("actions.clear_all");
    expect(queueSource).toContain("getLocalSubtitleFileFormatLabel");
    expect(queueSource).toContain("getLocalSubtitleTrackLanguageLabel");
    expect(pageSource).toContain("reconcileLocalSubtitleDraftMediaProbes");
    expect(pageSource).toContain("addedFiles");
    expect(pageSource).not.toContain("setDraftMediaProbes(new Map(");
    expect(pageSource).not.toContain("setExplicitAudioStreamIds(new Map())");
  });

  it("removes the environment header divider while its body is collapsed", () => {
    expect(environmentSource).toContain(
      'headerClassName={managerOpen ? undefined : "border-b-0"}',
    );
  });

  it("keeps runtime failures actionable without asking for system dependencies", () => {
    expect(environmentSource).toContain("runtimeSummaryError(runtime)");
    expect(environmentSource).toContain("environment.error.recovery");
    expect(environmentSource).toContain("environment.error.runtime_missing");
    expect(pageSource).toContain("environmentError={environment.error}");
    expect(pageSource).toContain("resourceActionError={resourceActionError}");
  });

  it("exposes stable hooks for draft tasks, task progress, and task actions", () => {
    expect(source).toContain('inputTestId="local-subtitle-file-input"');
    expect(pageSource).toContain("multiple");
    expect(pageSource).toContain("LOCAL_SUBTITLE_LIMITS.maxBatchFiles");
    expect(pageSource).toContain("addDraftInputFiles(accepted)");
    expect(queueSource).toContain('data-testid="local-subtitle-draft-file"');
    expect(source).toContain('data-testid="local-subtitle-start"');
    expect(source).toContain('data-testid="local-subtitle-task-queue"');
    expect(queueSource).toContain('data-testid="local-subtitle-task"');
    expect(queueSource).toContain("deriveLocalSubtitleTaskProgressDisplay(task)");
    expect(queueSource).toContain("progressDisplay.stagePercent");
    expect(queueSource).toContain("progressDisplay.overallPercent");
    expect(queueSource).toContain('"cancel"');
    expect(queueSource).toContain('"retry"');
    expect(queueSource).toContain('"remove"');
    expect(queueSource).toContain('"reveal"');
    expect(queueSource).toContain("completion.artifacts.map");
    expect(pageSource).toContain("candidate.generation");
    expect(pageSource).toContain("mediaProbeQueueRef");
    expect(pageSource).toContain("explicitAudioStreamIds");
    expect(queueSource).toContain("<Select");
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
