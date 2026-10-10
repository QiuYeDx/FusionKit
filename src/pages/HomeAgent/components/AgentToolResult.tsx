import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import type { AgentToolResult as ToolResult } from "@/agent/types";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Button } from "@/components/ui/button";
import { actionErrorMessage } from "./action-error";
import AgentActionReceipt from "./AgentActionReceipt";
import { agentToolPath, hasPreparedAction, objectValue, readReceipt, taskRows, taskStatusKeys } from "../presentation";
import useAgentStore from "@/store/agent/useAgentStore";
import { usePreparedActionsStore } from "@/agent/prepared-actions";

/** Tools a page lends to the assistant while it is open (see src/agent/page-context.ts). */
const PAGE_TOOLS = ["open_app_page", "studio_read_cues", "studio_find_cues", "studio_prepare_revision", "studio_check_consistency",
  "subtitle_translator_update_settings", "subtitle_converter_update_settings", "subtitle_extractor_update_settings", "name_translator_update_settings"];
const WEB_TOOLS = ["web_search", "web_read"];
const webSourceKeys = { wikipedia: "home:web_source_wikipedia", moegirl: "home:web_source_moegirl", baidu_baike: "home:web_source_baidu_baike",
  biligame: "home:web_source_biligame", bing: "home:web_source_bing" } as const;
const hostOf = (url: unknown) => { try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function isModernToolResult(toolName: string) {
  return PAGE_TOOLS.includes(toolName) || WEB_TOOLS.includes(toolName) || toolName === "list_agent_capabilities" || toolName === "update_agent_plan" || toolName === "get_classic_subtitle_tasks" || AGENT_CAPABILITIES.some(capability => (capability.operations as readonly string[]).includes(toolName) && !["translator", "converter", "extractor"].includes(capability.toolKey));
}

const classicLabels = { translate: "home:capability_translator", convert: "home:capability_converter", extract: "home:capability_extractor" } as const;
const classicPaths = { translate: "/tools/subtitle/translator", convert: "/tools/subtitle/converter", extract: "/tools/subtitle/extractor" } as const;
const TASK_QUERIES = ["get_studio_tasks", "get_local_transcription_status", "get_classic_subtitle_tasks"];

const dataOf = (result: ToolResult) => result.data && typeof result.data === "object" ? result.data as Record<string, any> : {};

function capabilityOf(toolName: string) {
  return toolName === "get_classic_subtitle_tasks" ? undefined : AGENT_CAPABILITIES.find(item => (item.operations as readonly string[]).includes(toolName));
}

/** One line on what a successful tool call did, shown in its row; undefined when there is nothing worth saying. */
export function toolResultSummary(result: ToolResult, t: TFunction): string | undefined {
  if (!result.success) return undefined;
  const data = dataOf(result);
  if (result.toolName === "create_name_translation_plan") return t("home:rename_inline_summary", { total: Number(data.totalTargets ?? 0), ready: Number(data.readyCount ?? 0) });
  if (result.toolName === "apply_name_translation_plan") return t("home:rename_result_summary", { success: Number(data.successCount ?? 0), failed: Number(data.failedCount ?? 0) });
  if (!isModernToolResult(result.toolName)) {
    if (Array.isArray(data.files)) return t("home:tool_result_files_found", { count: Number(data.totalCount ?? data.files.length) });
    if (data.queuedCount !== undefined) return data.batch
      ? t("home:tool_result_queued_progress", { queuedCount: data.batch.queuedThrough, totalFiles: data.totalFiles })
      : t("home:tool_result_queued_progress", { queuedCount: data.queuedCount, totalFiles: data.totalFiles });
    return undefined;
  }
  if (result.toolName === "update_agent_plan") return t("home:result_plan_updated");
  if (result.toolName === "web_search") return t("home:result_web_search", { source: Object.prototype.hasOwnProperty.call(webSourceKeys, data.source)
    ? t(webSourceKeys[data.source as keyof typeof webSourceKeys]) : String(data.source ?? ""),
    count: Array.isArray(data.results) ? data.results.length : 0 });
  if (result.toolName === "web_read") return t("home:result_web_read", { title: typeof data.title === "string" ? data.title : hostOf(data.url), site: String(data.site ?? hostOf(data.url)) });
  if (result.toolName === "studio_check_consistency" && data.status === "awaiting_user_review") return Number(data.groups) > 0
    ? t("home:result_consistency", { count: Number(data.groups), checked: Number(data.checkedLines ?? 0) }) : t("home:result_consistency_none", { checked: Number(data.checkedLines ?? 0) });
  if (data.status === "awaiting_user_review") return Number(data.proposedRevisions) > 0
    ? t("home:result_revision_ready", { count: Number(data.proposedRevisions), checked: Number(data.checkedCues ?? 0) })
    : t("home:result_revision_none", { checked: Number(data.checkedCues ?? 0) });
  if (data.status === "awaiting_scan_confirmation") return t("home:result_revision_confirm", { count: Number(data.cueCount ?? 0) });
  if (result.toolName.endsWith("_update_settings")) return t("home:result_settings_updated", { count: Object.keys(objectValue(data.changed)).length });
  if (result.toolName === "open_app_page") return t("home:result_page_opened", { page: typeof data.title === "string" ? data.title : String(data.route ?? "") });
  if (result.toolName === "studio_read_cues") return t("home:result_read_cues", { count: Array.isArray(data.items) ? data.items.length : 0 });
  if (data.cancelled) return t("home:action_dismissed");
  if (data.executionStatus === "prepared") return t("home:result_preparation_created");
  if (data.executionStatus === "submitted" || data.executionStatus === "queued") return t("home:result_submitted");
  if (data.executionStatus === "configured") return t("home:result_configured");
  if (data.executionStatus === "unchanged") return t("home:result_knowledge_unchanged");
  if (typeof data.importedCount === "number") return t("home:result_imported", { count: data.importedCount, total: Number(data.total ?? data.importedCount) });
  if (TASK_QUERIES.includes(result.toolName) && typeof data.total === "number") return t("home:result_tasks", { count: data.total });
  if (result.toolName === "search_translation_knowledge") return t("home:result_knowledge", { entries: Number(data.pagination?.entries?.total ?? (Array.isArray(data.entries) ? data.entries.length : 0)),
    collections: Number(data.pagination?.collections?.total ?? (Array.isArray(data.collections) ? data.collections.length : 0)) });
  if (result.toolName === "list_translation_knowledge_catalog") return t("home:result_knowledge_catalog", { collections: Number(data.pagination?.collections?.total ?? 0), subjects: Number(data.pagination?.subjects?.total ?? 0) });
  if (typeof data.total === "number") return t("home:result_found", { count: data.total });
  if (Array.isArray(data.tools)) return t("home:result_capabilities", { count: data.tools.length });
  return undefined;
}

/** The tool page a result continues on, for the row's shortcut. */
export function toolResultPath(result: ToolResult): string | undefined {
  const data = dataOf(result);
  const capability = capabilityOf(result.toolName);
  if (!result.success || !capability || data.executionStatus === "prepared") return undefined;
  return agentToolPath(capability.toolKey, capability.route, result.toolName, data.kind);
}

/** Receipts with failures stay visible under the row; everything else waits in the row's details. */
export function ToolResultAttention({ result }: { result: ToolResult }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const data = dataOf(result);
  const sessionId = useAgentStore(state => state.session.id);
  const hasCurrentAction = usePreparedActionsStore(state => hasPreparedAction(state.actions, sessionId, data.actionId));
  const preparation = readReceipt(data.receipt);
  const receipt = readReceipt(objectValue(data.result).receipt) ?? preparation;
  const failing = [preparation, receipt].filter((item, index, all) => item && item.failureCount > 0 && all.indexOf(item) === index);
  // A prepared action shows its card with the confirm button; without its live action there is nothing to
  // confirm here, and saying so beats a reply that points to a button that is not there.
  const capability = capabilityOf(result.toolName);
  const orphaned = data.executionStatus === "prepared" && typeof data.actionId === "string" && !hasCurrentAction;
  if (!failing.length && !orphaned) return null;
  return <div className="space-y-2">
    {failing.map((item, index) => <AgentActionReceipt key={index} receipt={item!} />)}
    {orphaned && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300" data-testid="agent-prepared-missing">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t("home:action_prepared_missing")}</span>
      {capability && <Button variant="outline" size="sm" className="h-6 rounded-full px-2.5 text-[11px]"
        onClick={() => navigate(agentToolPath(capability.toolKey, capability.route, result.toolName, data.kind))}>{t("home:open_tool")}</Button>}
    </div>}
  </div>;
}

/** What a tool returned, behind its row's disclosure. */
export default function ToolResultDetails({ result }: { result: ToolResult }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const data = dataOf(result);
  const sessionId = useAgentStore(state => state.session.id);
  const hasCurrentAction = usePreparedActionsStore(state => hasPreparedAction(state.actions, sessionId, data.actionId));
  if (!isModernToolResult(result.toolName)) return <ClassicDetails result={result} />;
  const preparationReceipt = readReceipt(data.receipt);
  const receipt = readReceipt(objectValue(data.result).receipt) ?? preparationReceipt;
  const rows = taskRows(data);
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.entries) ? data.entries : [];
  const classicStores = result.toolName === "get_classic_subtitle_tasks" ? [...new Set(items.flatMap((item: any) => item && typeof item === "object" && Object.prototype.hasOwnProperty.call(classicPaths, item.store) ? [item.store as keyof typeof classicPaths] : []))] : [];
  const visibleRows = rows.slice(0, 5);
  const content = [
    visibleRows.length > 0 && <ul key="rows" className="divide-y divide-border/60 rounded-lg bg-muted/40 px-2.5">{visibleRows.map(row => <li key={row.id} className="min-w-0 py-1.5" data-task-status={row.status}>
      <div className="flex items-start gap-3"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{row.name}</span>{row.status && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{t(taskStatusKeys[row.status])}{row.progress !== undefined ? ` · ${row.progress}%` : ""}</span>}</div>
      {row.error && <p className="mt-0.5 text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(row.error, t)}</p>}
    </li>)}</ul>,
    rows.length > visibleRows.length && <p key="more" className="text-[11px] text-muted-foreground">{t("home:result_more_items", { count: rows.length - visibleRows.length })}</p>,
    typeof data.taskReadError === "string" && <p key="read-error" className="text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(data.taskReadError, t)}</p>,
    ...(result.toolName === "search_translation_knowledge" ? ["collections", "recipes"].map(kind => {
      const names = Array.isArray(data[kind]) ? (data[kind] as unknown[]).map(value => objectValue(value).name).filter((name): name is string => typeof name === "string") : [];
      return names.length > 0 && <p key={kind} className="text-muted-foreground [overflow-wrap:anywhere]">{t(kind === "collections" ? "home:result_collections" : "home:result_recipes")}: {names.slice(0, 5).join(" · ")}</p>;
    }) : []),
    result.toolName === "web_search" && Array.isArray(data.results) && data.results.length > 0 && <ul key="web" className="space-y-1">
      {(data.results as unknown[]).slice(0, 5).map((value, index) => { const hit = objectValue(value);
        return <li key={index} className="min-w-0 [overflow-wrap:anywhere]"><span>{String(hit.title ?? "")}</span><span className="text-muted-foreground"> · {hostOf(hit.url)}</span></li>; })}
    </ul>,
    result.toolName === "web_read" && typeof data.url === "string" && <p key="web" className="text-muted-foreground [overflow-wrap:anywhere]">{data.url}</p>,
    preparationReceipt && receipt?.phase === "submission" && preparationReceipt.failureCount === 0 && <AgentActionReceipt key="preparation" receipt={preparationReceipt} />,
    receipt && receipt.failureCount === 0 && (data.executionStatus !== "prepared" || !hasCurrentAction) && <AgentActionReceipt key="receipt" receipt={receipt} />,
    classicStores.length > 0 && <div key="stores" className="flex flex-wrap gap-1.5">
      {classicStores.map(store => <Button key={store} variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => navigate(classicPaths[store])}>{t(classicLabels[store])}</Button>)}
    </div>,
  ].filter(Boolean);
  if (!content.length) return null;
  return <div className="min-w-0 space-y-2 text-xs leading-5" data-testid="agent-tool-result">{content}</div>;
}

/** The details of a classic tool: the files it found or queued, or the errors behind a failure. */
function ClassicDetails({ result }: { result: ToolResult }) {
  const { t } = useTranslation();
  const data = dataOf(result);
  if (!result.success) {
    const details = Array.isArray(data.errors) ? (data.errors as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 5) : [];
    return details.length ? <ul className="space-y-0.5 rounded-lg bg-destructive/5 px-2.5 py-1.5 font-mono text-[11px] text-destructive">{details.map((item, index) => <li key={index} className="[overflow-wrap:anywhere]">{item}</li>)}</ul> : null;
  }
  if (Array.isArray(data.files)) {
    const count = Number(data.totalCount ?? data.files.length);
    const names = (data.files as unknown[]).slice(0, 10).map(file => typeof file === "string" ? file : String((file as Record<string, unknown>)?.fileName ?? ""));
    if (!names.length) return null;
    return <div className="space-y-2 text-xs leading-5">
      <ul className="divide-y divide-border/60 rounded-lg bg-muted/40 px-2.5">{names.map((name, index) => <li key={index} className="py-1 [overflow-wrap:anywhere]">{name}</li>)}</ul>
      {count > 10 && <p className="text-[11px] text-muted-foreground">{t("home:tool_result_more_files", { count })}</p>}
    </div>;
  }
  if (data.batch) {
    const lines = [t("home:tool_result_queued_batch_progress", { queuedCount: data.queuedCount, batchStart: Number(data.batch.batchStart ?? 0) + 1,
      batchEnd: data.batch.batchEnd, queuedThrough: data.batch.queuedThrough, totalFiles: data.totalFiles, remainingCount: data.batch.remainingCount }),
      ...(data.batch.hasMore ? [t("home:tool_result_queued_batch_more", { nextBatchStart: data.batch.nextBatchStart })] : [])];
    return <div className="space-y-1 text-xs leading-5 text-muted-foreground">{lines.map((line, index) => <p key={index}>{line}</p>)}</div>;
  }
  return null;
}
