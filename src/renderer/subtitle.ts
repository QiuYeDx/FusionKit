import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import { showSystemNotification } from "@/utils/notification";
import i18n from "@/i18n";
import type { SubtitleTranslationRecovery } from "@/type/subtitle";

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
        "checkpointPath" | "completedOutputPath" | "remainingOutputPath"
      >;
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
  (_, data: { taskId: string; fileName: string; outputFilePath: string }) => {
    const store = useSubtitleTranslatorStore.getState();
    store.markTaskResolved(data.taskId, data.fileName, data.outputFilePath);
    showSystemNotification(
      "FusionKit",
      i18n.t("setting:fields.notification.task_resolved", {
        file: data.fileName,
      }),
    );
  },
);
