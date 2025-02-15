import { ipcMain } from "electron";
import { TranslationService } from "./translation-service";
import { SubtitleTranslatorTask } from "./typing";

export function setupTranslationIPC(translationService: TranslationService) {
  ipcMain.handle(
    "translate-subtitle",
    async (_, task: SubtitleTranslatorTask) => {
      return translationService.processTask(task);
    }
  );

  ipcMain.on("cancel-translation", (_, fileName: string) => {
    translationService.cancelTask(fileName);
  });
}
