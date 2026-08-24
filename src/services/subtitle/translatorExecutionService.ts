import type { SubtitleTranslatorTask } from "@/type/subtitle";

export function startSubtitleTranslation(task: SubtitleTranslatorTask) {
  if (task.taskReference) {
    const {
      taskReference: reference,
      ...pathFreeTask
    } = task;
    return window.ipcRenderer.invoke("translate-subtitle", {
      task: pathFreeTask,
      reference,
    });
  }
  return window.ipcRenderer.invoke("translate-subtitle", task);
}

export function cancelSubtitleTranslation(taskId: string) {
  window.ipcRenderer.send("cancel-translation", taskId);
}

const pendingGeneratedTaskReleases = new Set<string>();
const generatedTaskReleaseAttempts = new Map<string, number>();
let generatedTaskReleaseTimer: ReturnType<typeof setTimeout> | undefined;
let generatedTaskReleaseOperation: Promise<void> | undefined;

export function releaseSubtitleTranslationTaskAuthority(taskId: string): void {
  pendingGeneratedTaskReleases.add(taskId);
  generatedTaskReleaseAttempts.set(taskId, 0);
  void requestGeneratedSubtitleTaskReleaseFlush();
}

export const releaseGeneratedSubtitleTask =
  releaseSubtitleTranslationTaskAuthority;

function requestGeneratedSubtitleTaskReleaseFlush(): Promise<void> {
  if (generatedTaskReleaseOperation) return generatedTaskReleaseOperation;
  const operation = flushGeneratedSubtitleTaskReleases().finally(() => {
    if (generatedTaskReleaseOperation === operation) {
      generatedTaskReleaseOperation = undefined;
    }
  });
  generatedTaskReleaseOperation = operation;
  return operation;
}

async function flushGeneratedSubtitleTaskReleases(): Promise<void> {
  for (const taskId of [...pendingGeneratedTaskReleases]) {
    try {
      const result = await window.subtitleTranslationApi
        .releaseGeneratedTask(taskId);
      if (result.ok) {
        pendingGeneratedTaskReleases.delete(taskId);
        generatedTaskReleaseAttempts.delete(taskId);
      } else {
        retainGeneratedTaskRelease(taskId);
      }
    } catch {
      retainGeneratedTaskRelease(taskId);
    }
  }
  if (pendingGeneratedTaskReleases.size > 0 && !generatedTaskReleaseTimer) {
    generatedTaskReleaseTimer = setTimeout(() => {
      generatedTaskReleaseTimer = undefined;
      void requestGeneratedSubtitleTaskReleaseFlush();
    }, 500);
  }
}

function retainGeneratedTaskRelease(taskId: string): void {
  const attempts = (generatedTaskReleaseAttempts.get(taskId) ?? 0) + 1;
  if (attempts >= 5) {
    pendingGeneratedTaskReleases.delete(taskId);
    generatedTaskReleaseAttempts.delete(taskId);
    return;
  }
  generatedTaskReleaseAttempts.set(taskId, attempts);
}
