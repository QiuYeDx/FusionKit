/**
 * 字幕翻译模块 - IPC 通道注册
 *
 * 注册 IPC 通道，供渲染进程调用：
 *   1. "translate-subtitle"                     (handle)  启动翻译任务，返回最终状态
 *   2. "estimate-subtitle-tokens"               (handle)  预估 token 消耗与费用（不执行翻译）
 *   3. "cancel-translation"                     (on)      通过 AbortController 取消进行中的任务
 *   4. "scan-translation-recovery-artifacts"    (handle)  扫描目录中的恢复产物
 *   5. "inspect-translation-recovery-artifact"  (handle)  检查单个恢复清单
 *   6. "create-recovered-subtitle-task-draft"   (handle)  生成恢复任务草稿
 *
 * 翻译过程中，主进程还会主动向渲染进程推送以下事件（见 base-translator.ts）：
 *   - "update-progress"  分片进度更新
 *   - "task-resolved"    任务成功完成
 *   - "task-failed"      任务失败（附带错误日志）
 */

import { ipcMain, dialog } from "electron";
import { TranslationService } from "./translation-service";
import {
  SubtitleSliceType,
  type SubtitleTranslatorTask,
  type TranslationLanguage,
  type TranslationOutputMode,
  type TranslationRecoveryScanRequest,
  type TranslationRecoveryImportRequest,
} from "./typing";
import {
  scanTranslationRecoveryArtifacts,
  inspectTranslationRecoveryArtifact,
  createRecoveredSubtitleTaskDraft,
} from "./recovery-discovery";

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

  // ─── Recovery Discovery IPC ──────────────────────────────────────────────

  ipcMain.handle(
    "scan-translation-recovery-artifacts",
    async (_, request: TranslationRecoveryScanRequest) => {
      return scanTranslationRecoveryArtifacts(request);
    }
  );

  ipcMain.handle(
    "inspect-translation-recovery-artifact",
    async (_, checkpointPath: string) => {
      return inspectTranslationRecoveryArtifact(checkpointPath);
    }
  );

  ipcMain.handle(
    "create-recovered-subtitle-task-draft",
    async (_, request: TranslationRecoveryImportRequest) => {
      return createRecoveredSubtitleTaskDraft(request);
    }
  );

  ipcMain.handle(
    "select-recovery-manifest-file",
    async () => {
      const result = await dialog.showOpenDialog({
        title: "Import Recovery Manifest",
        filters: [{ name: "Recovery Manifest", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    }
  );
}
