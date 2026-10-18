import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import { showSystemNotification } from "@/utils/notification";
import i18n from "@/i18n";
import type { SubtitleTranslationRecovery } from "@/type/subtitle";
import type { SubtitleTranslationUsage } from "@/type/subtitleUsage";
import type { ModelErrorCategory } from "@/lib/model-error-category";

window.ipcRenderer.on(
  "update-progress",
  (
    _,
    progressData: {
      taskId: string;
      fileName: string;
      resolvedFragments: number;
      totalFragments: number;
      progress: number;
      recovery?: Pick<
        SubtitleTranslationRecovery,
        "checkpointRef" | "resumable" | "resolvedFragments" | "totalFragments"
      >;
      actualUsage?: SubtitleTranslationUsage;
    },
  ) => {
    const store = useSubtitleTranslatorStore.getState();
    store.updateProgress(
      progressData.taskId,
      progressData.fileName,
      progressData.resolvedFragments,
      progressData.totalFragments,
      progressData.progress,
      progressData.recovery,
      progressData.actualUsage,
    );
  },
);

window.ipcRenderer.on(
  "task-failed",
  (
    _,
    errorData: {
      taskId: string;
      fileName: string;
      error: string;
      message: string;
      errorLogs?: string[];
      timestamp?: string;
      stackTrace?: string;
      recovery?: SubtitleTranslationRecovery;
      actualUsage?: SubtitleTranslationUsage;
      /** Why the model request failed, when known. */
      errorCategory?: ModelErrorCategory;
    },
  ) => {
    const store = useSubtitleTranslatorStore.getState();
    store.addFailedTask(errorData);
    showSystemNotification(
      "FusionKit",
      i18n.t("setting:fields.notification.task_failed", {
        file: errorData.fileName,
      }),
    );
  },
);

window.ipcRenderer.on(
  "task-resolved",
  (_, data: {
    taskId: string;
    fileName: string;
    outputFileName: string;
    actualUsage?: SubtitleTranslationUsage;
  }) => {
    const store = useSubtitleTranslatorStore.getState();
    store.markTaskResolved(
      data.taskId,
      data.fileName,
      data.outputFileName,
      data.actualUsage,
    );
    showSystemNotification(
      "FusionKit",
      i18n.t("setting:fields.notification.task_resolved", {
        file: data.fileName,
      }),
    );
  },
);
