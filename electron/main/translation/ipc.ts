import { ipcMain } from "electron";
import { TranslationService } from "./translation-service";
import { SubtitleTranslatorTask, SubtitleSliceType } from "./typing";

export function setupTranslationIPC(translationService: TranslationService) {
  ipcMain.handle(
    "translate-subtitle",
    async (_, task: SubtitleTranslatorTask) => {
      return translationService.processTask(task);
    }
  );

  ipcMain.handle(
    "estimate-subtitle-tokens",
    async (_, data: {
      content: string;
      sliceType: SubtitleSliceType;
      customSliceLength?: number;
      inputTokenPrice?: number;
      outputTokenPrice?: number;
    }) => {
      return translationService.estimateTokens(
        data.content, 
        data.sliceType, 
        data.customSliceLength,
        data.inputTokenPrice,
        data.outputTokenPrice
      );
    }
  );

  ipcMain.on("cancel-translation", (_, fileName: string) => {
    translationService.cancelTask(fileName);
  });
}
