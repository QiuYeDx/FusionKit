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
