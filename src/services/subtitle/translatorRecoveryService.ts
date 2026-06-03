/**
 * 字幕翻译 - 恢复发现 Service
 *
 * 集中管理恢复相关 IPC 调用，页面和 store 不直接引用 IPC channel 字符串。
 */

import type {
  TranslationRecoveryScanRequest,
  TranslationRecoveryScanResult,
  TranslationRecoveryCandidate,
  TranslationRecoveryImportRequest,
  RecoveredSubtitleTaskDraft,
} from "@/type/subtitle";

export function scanTranslationRecoveryArtifacts(
  request: TranslationRecoveryScanRequest,
): Promise<TranslationRecoveryScanResult> {
  return window.ipcRenderer.invoke(
    "scan-translation-recovery-artifacts",
    request,
  );
}

export function inspectTranslationRecoveryArtifact(
  checkpointPath: string,
): Promise<TranslationRecoveryCandidate> {
  return window.ipcRenderer.invoke(
    "inspect-translation-recovery-artifact",
    checkpointPath,
  );
}

export function createRecoveredSubtitleTaskDraft(
  request: TranslationRecoveryImportRequest,
): Promise<RecoveredSubtitleTaskDraft> {
  return window.ipcRenderer.invoke(
    "create-recovered-subtitle-task-draft",
    request,
  );
}
