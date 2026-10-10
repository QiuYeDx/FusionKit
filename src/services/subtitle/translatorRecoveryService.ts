import type {
  SubtitleTranslationPreparedRecoveryBatch,
  SubtitleTranslationRecoveryScanSelection,
} from "@/type/subtitleTranslationIpc";

export async function selectTranslationRecoveryDirectory(
  includeCompleted = false,
): Promise<SubtitleTranslationRecoveryScanSelection> {
  const result = await window.subtitleTranslationApi.selectRecoveryDirectory({
    includeCompleted,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

/** A recovery directory or manifest the user typed to the assistant, scanned like a picked one. */
export async function scanTranslationRecoveryPath(
  path: string,
  includeCompleted = false,
): Promise<SubtitleTranslationRecoveryScanSelection> {
  const result = await window.subtitleTranslationApi.scanRecoveryPath({ path, includeCompleted });
  if (!result.ok) throw new Error(result.error.code === "invalid_ipc_request" ? "recovery_path_unavailable" : result.error.message);
  return result.data;
}

export async function selectTranslationRecoveryManifest(): Promise<
  SubtitleTranslationRecoveryScanSelection
> {
  const result = await window.subtitleTranslationApi.selectRecoveryManifest();
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function prepareRecoveredSubtitleTasks(request: {
  readonly recoveryScanId: string;
  readonly directoryToken: string;
  readonly candidateIds?: readonly string[];
  readonly batchStart?: number;
  readonly batchSize?: number;
}): Promise<SubtitleTranslationPreparedRecoveryBatch> {
  const result = await window.subtitleTranslationApi.prepareRecoveredTasks(
    request,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function revokeTranslationRecoveryScan(
  recoveryScanId: string,
): Promise<void> {
  await window.subtitleTranslationApi.revokeRecoveryScan(recoveryScanId);
}
