import type { PreparedAction, PreparedActionReceipt } from "@/agent/prepared-actions";
import { studioNavigationPath } from "@/pages/Tools/Subtitle/SubtitleStudio/navigation";

export const taskStatusKeys = {
  ready: "home:receipt_ready", queued: "home:result_submitted", running: "home:action_running",
  preparing_media: "home:task_preparing_media", loading_model: "home:task_loading_model", transcribing: "home:task_transcribing",
  post_processing: "home:task_post_processing", exporting: "home:task_exporting", cancelling: "home:task_cancelling",
  interrupted: "home:task_interrupted", needs_configuration: "home:task_needs_configuration", no_content: "home:task_no_content",
  completed: "home:action_completed", failed: "home:action_failed", cancelled: "home:action_dismissed",
} as const;
const progressing = new Set(["running", "preparing_media", "loading_model", "transcribing", "post_processing", "exporting"]);
export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readReceipt(value: unknown): PreparedActionReceipt | undefined {
  const receipt = objectValue(value);
  if (receipt.phase !== "preparation" && receipt.phase !== "submission") return;
  if (![receipt.total, receipt.successCount, receipt.failureCount].every(count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return;
  if (!Array.isArray(receipt.items) || receipt.items.length > 50) return;
  const valid = receipt.items.every(item => {
    const entry = objectValue(item);
    return typeof entry.id === "string" && typeof entry.name === "string" && ["ready", "queued", "failed"].includes(String(entry.status))
      && (entry.error === undefined || typeof entry.error === "string");
  });
  return valid ? value as PreparedActionReceipt : undefined;
}

export function actionReceipt(action: PreparedAction): PreparedActionReceipt | undefined {
  return readReceipt(objectValue(action.result).receipt) ?? action.preparationReceipt;
}
export function actionFailureReceipt(action: PreparedAction): PreparedActionReceipt | undefined {
  const latest = actionReceipt(action);
  return latest && latest.failureCount > 0 ? latest : action.preparationReceipt?.failureCount ? action.preparationReceipt : undefined;
}
export function groupPreparedActions(actions: PreparedAction[], sessionId: string) {
  const current = actions.filter(action => action.sessionId === sessionId);
  const active = current.filter(action => action.status === "ready" || action.status === "running");
  const history = current.filter(action => action.status !== "ready" && action.status !== "running").reverse()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const failed = history.filter(action => action.status === "failed" || !!actionFailureReceipt(action));
  return { active, history, failedCount: failed.length, latestFailure: failed[0] };
}
export function hasPreparedAction(actions: PreparedAction[], sessionId: string, actionId: unknown): boolean {
  return typeof actionId === "string" && actions.some(action => action.id === actionId && action.sessionId === sessionId);
}

export function taskRows(data: Record<string, unknown>) {
  const source = Array.isArray(data.items) ? data.items : Array.isArray(data.tasks) ? data.tasks : Array.isArray(data.entries) ? data.entries : [];
  return source.slice(0, 50).flatMap((item, index) => {
    const value = objectValue(item);
    const name = [value.name, value.fileName, value.title].find(text => typeof text === "string");
    if (typeof name !== "string") return [];
    const status = typeof value.status === "string" && Object.prototype.hasOwnProperty.call(taskStatusKeys, value.status) ? value.status as keyof typeof taskStatusKeys : undefined;
    const rawProgress = typeof value.progress === "number" ? value.progress : objectValue(value.progress).overallProgress;
    const progress = status && progressing.has(status) && typeof rawProgress === "number" && Number.isFinite(rawProgress)
      ? Math.round(Math.max(0, Math.min(100, rawProgress))) : undefined;
    const error = typeof value.error === "string" ? value.error : typeof objectValue(value.error).code === "string" ? objectValue(value.error).code as string : undefined;
    return [{ id: typeof value.taskId === "string" ? value.taskId : String(index), name, status, progress, error }];
  });
}

export function agentToolPath(toolKey: string, route: string, operation?: string, kind?: unknown): string {
  if (toolKey !== "subtitleStudio") return route;
  return studioNavigationPath(operation === "prepare_studio_transcription" || operation === "home:prepared_transcription_summary" || kind === "transcription" ? "transcription" : "documents");
}

export function appendProgressPrompt(draft: string, suggestion: string): string {
  if (draft.includes(suggestion)) return draft;
  return draft.trim() ? `${draft}\n\n${suggestion}` : suggestion;
}
