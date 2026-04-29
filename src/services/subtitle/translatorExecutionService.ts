import type { SubtitleTranslatorTask } from "@/type/subtitle";

export function startSubtitleTranslation(task: SubtitleTranslatorTask) {
  return window.ipcRenderer.invoke("translate-subtitle", task);
}

export function cancelSubtitleTranslation(fileName: string) {
  window.ipcRenderer.send("cancel-translation", fileName);
}
