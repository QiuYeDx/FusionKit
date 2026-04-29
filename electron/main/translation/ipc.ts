/**
 * 字幕翻译模块 - IPC 通道注册
 *
 * 注册三个 IPC 通道，供渲染进程调用：
 *   1. "translate-subtitle"       (handle)  启动翻译任务，返回最终状态
 *   2. "estimate-subtitle-tokens" (handle)  预估 token 消耗与费用（不执行翻译）
 *   3. "cancel-translation"       (on)      通过 AbortController 取消进行中的任务
 *
 * 翻译过程中，主进程还会主动向渲染进程推送以下事件（见 base-translator.ts）：
 *   - "update-progress"  分片进度更新
 *   - "task-resolved"    任务成功完成
 *   - "task-failed"      任务失败（附带错误日志）
 */

import { ipcMain } from "electron";
import { TranslationService } from "./translation-service";
import {
  SubtitleSliceType,
  type SubtitleTranslatorTask,
  type TranslationLanguage,
  type TranslationOutputMode,
} from "./typing";

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
      fileName?: string;
      sourceLang?: TranslationLanguage;
      targetLang?: TranslationLanguage;
      translationOutputMode?: TranslationOutputMode;
    }) => {
      return translationService.estimateTokens(
        data.content, 
        data.sliceType, 
        data.customSliceLength,
        data.inputTokenPrice,
        data.outputTokenPrice,
        data.fileName,
        data.sourceLang,
        data.targetLang,
        data.translationOutputMode,
      );
    }
  );

  ipcMain.on("cancel-translation", (_, fileName: string) => {
    translationService.cancelTask(fileName);
  });
}
