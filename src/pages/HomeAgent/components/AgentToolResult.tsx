import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import type { AgentToolResult as ToolResult } from "@/agent/types";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { actionErrorMessage } from "./action-error";

export function isModernToolResult(toolName: string) {
  return toolName === "list_agent_capabilities" || toolName === "update_agent_plan" || toolName === "get_classic_subtitle_tasks" || AGENT_CAPABILITIES.some(capability => (capability.operations as readonly string[]).includes(toolName) && !["translator", "converter", "extractor"].includes(capability.toolKey));
}

const taskStatusKeys = { queued: "home:result_submitted", running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", cancelled: "home:action_dismissed" } as const;
const classicLabels = { translate: "home:capability_translator", convert: "home:capability_converter", extract: "home:capability_extractor" } as const;
const classicPaths = { translate: "/tools/subtitle/translator", convert: "/tools/subtitle/converter", extract: "/tools/subtitle/extractor" } as const;

export default function AgentToolResult({ result }: { result: ToolResult }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState("");
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  const capability = result.toolName === "get_classic_subtitle_tasks" ? undefined : AGENT_CAPABILITIES.find(item => (item.operations as readonly string[]).includes(result.toolName));
  let summary: string;
  if (!result.success) summary = result.error ? actionErrorMessage(result.error, t) : t("home:action_failed");
  else if (result.toolName === "update_agent_plan") summary = t("home:result_plan_updated");
  else if (data.cancelled) summary = t("home:action_dismissed");
  else if (data.executionStatus === "prepared") summary = t("home:action_ready");
  else if (data.executionStatus === "submitted" || data.executionStatus === "queued") summary = t("home:result_submitted");
  else if (data.executionStatus === "configured") summary = t("home:result_configured");
  else if (typeof data.importedCount === "number") summary = t("home:result_imported", { count: data.importedCount, total: Number(data.total ?? data.importedCount) });
  else if (typeof data.total === "number") summary = t("home:result_found", { count: data.total });
  else if (Array.isArray(data.tools)) summary = t("home:result_capabilities", { count: data.tools.length });
  else summary = t("home:result_checked");
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.entries) ? data.entries : [];
  const classicStores = result.toolName === "get_classic_subtitle_tasks" ? [...new Set(items.flatMap(item => item && typeof item === "object" && Object.prototype.hasOwnProperty.call(classicPaths, item.store) ? [item.store as keyof typeof classicPaths] : []))] : [];
  const Icon = result.success ? CheckCircle2 : XCircle;
  return <div className="min-w-0 rounded-xl border bg-card/40 p-3" data-testid="agent-tool-result">
    <div className="flex items-start gap-2"><Icon aria-hidden className={`mt-0.5 size-3.5 shrink-0 ${result.success ? "text-muted-foreground" : "text-destructive"}`} /><p className="min-w-0 text-xs leading-5 [overflow-wrap:anywhere]">{summary}</p></div>
    {items.length > 0 && <ul className="mt-2 space-y-1 pl-5 text-xs text-muted-foreground">{items.slice(0, 5).map((item, index) => {
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const label = typeof value.name === "string" ? value.name : typeof value.fileName === "string" ? value.fileName : typeof value.title === "string" ? value.title : "";
      const status = typeof value.status === "string" && Object.prototype.hasOwnProperty.call(taskStatusKeys, value.status) ? value.status as keyof typeof taskStatusKeys : null;
      return label ? <li key={index} className="flex items-start gap-3"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>{status && <span className="shrink-0 text-[11px]">{t(taskStatusKeys[status])}{status === "running" && typeof value.progress === "number" && Number.isFinite(value.progress) ? ` · ${Math.round(Math.max(0, Math.min(100, value.progress)))}%` : ""}</span>}</li> : null;
    })}</ul>}
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded} className="mt-1">
      <AccordionItem value="details" className="border-0">
        <AccordionTrigger className="py-1 text-[11px] font-normal text-muted-foreground">{t("home:result_details")}</AccordionTrigger>
        <AccordionContent className="pb-1"><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 [overflow-wrap:anywhere]">{JSON.stringify(data, null, 2)}</pre></AccordionContent>
      </AccordionItem>
    </Accordion>
    {capability && <Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" onClick={() => navigate(capability.route)}>{t("home:open_tool")}</Button>}
    {classicStores.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{classicStores.map(store => <Button key={store} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate(classicPaths[store])}>{t(classicLabels[store])}</Button>)}</div>}
  </div>;
}
