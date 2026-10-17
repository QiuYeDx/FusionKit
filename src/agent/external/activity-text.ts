import type { ActivityRecord } from "./activity";
import { isExternalToolName } from "./catalog";

/** A translate function from the setting namespace. */
type T = (key: string, options?: Record<string, unknown>) => string;

export const ACTIVITY_RESULT_KEYS = ["written", "unchanged", "imported", "total", "queued", "files", "skipped", "failed", "renamed", "restored"] as const;
type ResultKey = (typeof ACTIVITY_RESULT_KEYS)[number];
const KNOWN_ERRORS = ["read_only", "not_permitted", "declined_by_user", "confirmation_expired", "cancelled", "tool_timeout", "fusionkit_window_unavailable",
  "revision_conflict", "invalid_arguments", "tool_failed"] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];
const isKnownError = (code: string): code is KnownError => (KNOWN_ERRORS as readonly string[]).includes(code);

/** The tool's readable name; an unknown tool shows its own name. */
export function toolLabel(t: T, tool: string): string {
  return isExternalToolName(tool) ? t(`setting:external_agent.activity.tools.${tool}`) : tool;
}

/** One sentence saying what the call did (or was asked to do). */
export function activitySentence(t: T, record: ActivityRecord): string {
  const summary = record.note?.summary;
  if (summary) {
    const content = summary.content ? t(`setting:external_agent.confirm.content.${summary.content}`) : "";
    return t(`setting:external_agent.activity.done.${summary.key}`, { ...summary.values, content });
  }
  const document = record.note?.target?.documentName;
  const action = toolLabel(t, record.tool);
  return document ? t("setting:external_agent.activity.with_document", { action, document }) : action;
}

export type ActivityTone = "neutral" | "info" | "warning" | "danger";
export interface ActivityBadge { label: string; tone: ActivityTone }

/** How it was allowed and how it ended, as the badges on a row. */
export function activityBadges(t: T, record: ActivityRecord): ActivityBadge[] {
  const badges: ActivityBadge[] = [];
  if (record.status === "pending") return [{ label: t("setting:external_agent.activity.status.pending"), tone: "warning" }];
  const approval = record.approval;
  if (approval === "confirmed") badges.push({ label: t("setting:external_agent.activity.approval.confirmed"), tone: "neutral" });
  else if (approval === "session") badges.push({ label: t("setting:external_agent.activity.approval.session"), tone: "info" });
  else if (approval === "auto" || approval === "full" || approval === "permitted") badges.push({ label: t(`setting:external_agent.activity.approval.${approval}`), tone: "info" });
  else if (approval === "declined") badges.push({ label: t("setting:external_agent.activity.approval.declined"), tone: "danger" });
  else if (approval === "expired") badges.push({ label: t("setting:external_agent.activity.approval.expired"), tone: "warning" });
  else if (approval === "read_only" || approval === "not_permitted") badges.push({ label: t(`setting:external_agent.activity.approval.${approval}`), tone: "danger" });
  if (record.status === "failed" && approval !== "read_only" && approval !== "not_permitted") badges.push({ label: t("setting:external_agent.activity.status.failed"), tone: "danger" });
  if (record.status === "cancelled") badges.push({ label: t("setting:external_agent.activity.status.cancelled"), tone: "warning" });
  if (record.undone) badges.push({ label: t("setting:external_agent.activity.status.undone"), tone: "neutral" });
  return badges;
}

/** The result numbers, in a fixed order. */
export function activityResults(t: T, record: ActivityRecord): string[] {
  const result = record.note?.result;
  if (!result) return [];
  return ACTIVITY_RESULT_KEYS.filter((key: ResultKey) => typeof result[key] === "number" && (key !== "skipped" && key !== "failed" && key !== "unchanged" || result[key] > 0))
    .map((key: ResultKey) => t(`setting:external_agent.activity.result.${key}`, { count: result[key] }));
}

/** Why a call did not do what it was asked. */
export function activityError(t: T, record: ActivityRecord): string | null {
  const code = record.error ?? (record.status === "declined" ? "declined_by_user" : record.status === "expired" ? "confirmation_expired" : undefined);
  if (!code) return null;
  return isKnownError(code) ? t(`setting:external_agent.activity.error.${code}`) : t("setting:external_agent.activity.error.unknown", { code });
}

export function activityDuration(t: T, record: ActivityRecord): string | null {
  if (record.endedAt === undefined) return null;
  const ms = Math.max(0, record.endedAt - record.startedAt);
  return ms < 1000 ? t("setting:external_agent.activity.duration_ms", { value: ms }) : t("setting:external_agent.activity.duration_s", { value: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
}
