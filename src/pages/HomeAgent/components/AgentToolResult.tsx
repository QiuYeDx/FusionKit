import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import type { AgentToolResult as ToolResult } from "@/agent/types";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { actionErrorMessage } from "./action-error";
import AgentActionReceipt from "./AgentActionReceipt";
import { agentToolPath, hasPreparedAction, objectValue, readReceipt, taskRows, taskStatusKeys } from "../presentation";
import useAgentStore from "@/store/agent/useAgentStore";
import { usePreparedActionsStore } from "@/agent/prepared-actions";

/** Tools a page lends to the assistant while it is open (see src/agent/page-context.ts). */
const PAGE_TOOLS = ["open_app_page", "studio_read_cues", "studio_find_cues", "studio_prepare_revision",
  "subtitle_translator_update_settings", "subtitle_converter_update_settings", "subtitle_extractor_update_settings", "name_translator_update_settings"];

export function isModernToolResult(toolName: string) {
  return PAGE_TOOLS.includes(toolName) || toolName === "list_agent_capabilities" || toolName === "update_agent_plan" || toolName === "get_classic_subtitle_tasks" || AGENT_CAPABILITIES.some(capability => (capability.operations as readonly string[]).includes(toolName) && !["translator", "converter", "extractor"].includes(capability.toolKey));
}

const classicLabels = { translate: "home:capability_translator", convert: "home:capability_converter", extract: "home:capability_extractor" } as const;
const classicPaths = { translate: "/tools/subtitle/translator", convert: "/tools/subtitle/converter", extract: "/tools/subtitle/extractor" } as const;

export default function AgentToolResult({ result }: { result: ToolResult }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState("");
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  const preparationReceipt = readReceipt(data.receipt);
  const receipt = readReceipt(objectValue(data.result).receipt) ?? preparationReceipt;
  const sessionId = useAgentStore(state => state.session.id);
  const hasCurrentAction = usePreparedActionsStore(state => hasPreparedAction(state.actions, sessionId, data.actionId));
  const rows = taskRows(data);
  const taskQuery = ["get_studio_tasks", "get_local_transcription_status", "get_classic_subtitle_tasks"].includes(result.toolName);
  const capability = result.toolName === "get_classic_subtitle_tasks" ? undefined : AGENT_CAPABILITIES.find(item => (item.operations as readonly string[]).includes(result.toolName));
  let summary: string;
  if (!result.success) summary = result.error ? actionErrorMessage(result.error, t) : t("home:action_failed");
  else if (result.toolName === "update_agent_plan") summary = t("home:result_plan_updated");
  else if (data.status === "awaiting_user_review") summary = Number(data.proposedRevisions) > 0
    ? t("home:result_revision_ready", { count: Number(data.proposedRevisions), checked: Number(data.checkedCues ?? 0) })
    : t("home:result_revision_none", { checked: Number(data.checkedCues ?? 0) });
  else if (data.status === "awaiting_scan_confirmation") summary = t("home:result_revision_confirm", { count: Number(data.cueCount ?? 0) });
  else if (result.toolName.endsWith("_update_settings")) summary = t("home:result_settings_updated", { count: Object.keys(objectValue(data.changed)).length });
  else if (result.toolName === "open_app_page") summary = t("home:result_page_opened", { page: typeof data.title === "string" ? data.title : String(data.route ?? "") });
  else if (result.toolName === "studio_read_cues") summary = t("home:result_read_cues", { count: Array.isArray(data.items) ? data.items.length : 0 });
  else if (data.cancelled) summary = t("home:action_dismissed");
  else if (data.executionStatus === "prepared") summary = t("home:result_preparation_created");
  else if (data.executionStatus === "submitted" || data.executionStatus === "queued") summary = t("home:result_submitted");
  else if (data.executionStatus === "configured") summary = t("home:result_configured");
  else if (typeof data.importedCount === "number") summary = t("home:result_imported", { count: data.importedCount, total: Number(data.total ?? data.importedCount) });
  else if (taskQuery && typeof data.total === "number") summary = t("home:result_tasks", { count: data.total });
  else if (result.toolName === "search_translation_knowledge") summary = t("home:result_knowledge", { entries: Array.isArray(data.entries) ? data.entries.length : 0, collections: Array.isArray(data.collections) ? data.collections.length : 0, recipes: Array.isArray(data.recipes) ? data.recipes.length : 0 });
  else if (typeof data.total === "number") summary = t("home:result_found", { count: data.total });
  else if (Array.isArray(data.tools)) summary = t("home:result_capabilities", { count: data.tools.length });
  else summary = t("home:result_checked");
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.entries) ? data.entries : [];
  const classicStores = result.toolName === "get_classic_subtitle_tasks" ? [...new Set(items.flatMap(item => item && typeof item === "object" && Object.prototype.hasOwnProperty.call(classicPaths, item.store) ? [item.store as keyof typeof classicPaths] : []))] : [];
  const Icon = result.success ? CheckCircle2 : XCircle;
  const visibleRows = rows.slice(0, 5);
  return <div className="min-w-0 rounded-xl border bg-card/40 p-3" data-testid="agent-tool-result">
    <div className="flex items-start gap-2"><Icon aria-hidden className={`mt-0.5 size-3.5 shrink-0 ${result.success ? "text-muted-foreground" : "text-destructive"}`} /><p className="min-w-0 text-xs leading-5 [overflow-wrap:anywhere]">{summary}</p></div>
    {visibleRows.length > 0 && <ul className="mt-2 space-y-1 pl-5 text-xs text-muted-foreground">{visibleRows.map(row => <li key={row.id} className="min-w-0 rounded-lg py-1" data-task-status={row.status}>
      <div className="flex items-start gap-3"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{row.name}</span>{row.status && <span className="shrink-0 text-[11px]">{t(taskStatusKeys[row.status])}{row.progress !== undefined ? ` · ${row.progress}%` : ""}</span>}</div>
      {row.error && <p className="mt-1 text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(row.error, t)}</p>}
    </li>)}</ul>}
    {rows.length > visibleRows.length && <p className="mt-1 pl-5 text-[11px] text-muted-foreground">{t("home:result_more_items", { count: rows.length - visibleRows.length })}</p>}
    {typeof data.taskReadError === "string" && <p className="mt-2 text-xs text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(data.taskReadError, t)}</p>}
    {result.toolName === "search_translation_knowledge" && ["collections", "recipes"].map(kind => {
      const names = Array.isArray(data[kind]) ? (data[kind] as unknown[]).map(value => objectValue(value).name).filter((name): name is string => typeof name === "string") : [];
      return names.length ? <p key={kind} className="mt-2 pl-5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{t(kind === "collections" ? "home:result_collections" : "home:result_recipes")}: {names.slice(0, 5).join(" · ")}</p> : null;
    })}
    {preparationReceipt && receipt?.phase === "submission" && preparationReceipt.failureCount > 0 && <AgentActionReceipt receipt={preparationReceipt} />}
    {receipt && (data.executionStatus !== "prepared" || !hasCurrentAction) && <AgentActionReceipt receipt={receipt} />}
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded} className="mt-1">
      <AccordionItem value="details" className="border-0">
        <AccordionTrigger className="py-1 text-[11px] font-normal text-muted-foreground">{t("home:result_details")}</AccordionTrigger>
        <AccordionContent className="pb-1"><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 [overflow-wrap:anywhere]">{JSON.stringify(data, null, 2)}</pre></AccordionContent>
      </AccordionItem>
    </Accordion>
    {capability && data.executionStatus !== "prepared" && <Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" onClick={() => navigate(agentToolPath(capability.toolKey, capability.route, result.toolName, data.kind))}>{t("home:open_tool")}</Button>}
    {classicStores.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{classicStores.map(store => <Button key={store} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate(classicPaths[store])}>{t(classicLabels[store])}</Button>)}</div>}
  </div>;
}
