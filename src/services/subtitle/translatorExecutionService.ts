import type { SubtitleTranslatorTask } from "@/type/subtitle";

export function startSubtitleTranslation(task: SubtitleTranslatorTask) {
  return window.ipcRenderer.invoke("translate-subtitle", task);
}

export function cancelSubtitleTranslation(taskId: string) {
  window.ipcRenderer.send("cancel-translation", taskId);
}
