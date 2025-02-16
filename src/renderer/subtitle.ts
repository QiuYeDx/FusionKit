// 在渲染进程中接收进度更新并调用 `updateProgress`
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";

// 在渲染进程中接收到进度更新后更新状态
window.ipcRenderer.on("update-progress", (_, progressData) => {
  console.info('>>> 收到 updateProgress', progressData);
  const store = useSubtitleTranslatorStore.getState();
  store.updateProgress(
    progressData.fileName,
    progressData.resolvedFragments,
    progressData.totalFragments,
    progressData.progress
  );
});

window.ipcRenderer.on("task-failed", (_, errorData) => {
  console.info('>>> 收到 task-failed', errorData);
  const store = useSubtitleTranslatorStore.getState();
  store.addFailedTask(errorData);
});
