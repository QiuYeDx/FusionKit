import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import type { AgentToolCall as ToolCall, AgentToolResult } from "@/agent/types";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { actionErrorMessage } from "./action-error";
import AgentCard from "./AgentCard";
import ToolResultDetails, { ToolResultAttention, toolResultPath, toolResultSummary } from "./AgentToolResult";

const toolNameKeys = {
  scan_subtitle_files: "home:tool_name_scan",
  queue_subtitle_translate: "home:tool_name_translate",
  queue_subtitle_convert: "home:tool_name_convert",
  queue_subtitle_extract: "home:tool_name_extract",
  inspect_rename_paths: "home:tool_name_inspect_paths",
  create_name_translation_plan: "home:tool_name_preview_names",
  apply_name_translation_plan: "home:tool_name_apply_names",
  scan_subtitle_recovery_tasks: "home:tool_name_find_recovery",
  queue_recovered_subtitle_translate: "home:tool_name_queue_recovery",
  update_agent_plan: "home:tool_name_update_plan",
  get_classic_subtitle_tasks: "home:tool_name_classic_tasks",
  list_agent_capabilities: "home:tool_name_capabilities",
  list_studio_documents: "home:tool_name_studio_documents",
  get_studio_tasks: "home:tool_name_studio_tasks",
  import_studio_subtitles: "home:tool_name_import_subtitles",
  prepare_studio_translation: "home:prepared_translation_title",
  prepare_studio_transcription: "home:prepared_transcription_title",
  get_local_transcription_status: "home:tool_name_local_status",
  configure_local_transcription: "home:tool_name_configure_transcription",
  search_translation_knowledge: "home:tool_name_search_knowledge",
  list_translation_knowledge_catalog: "home:tool_name_knowledge_catalog",
  prepare_knowledge_changes: "home:tool_name_prepare_knowledge",
  open_app_page: "home:tool_name_open_page",
  subtitle_translator_update_settings: "home:tool_name_update_settings",
  subtitle_converter_update_settings: "home:tool_name_update_settings",
  subtitle_extractor_update_settings: "home:tool_name_update_settings",
  name_translator_update_settings: "home:tool_name_update_settings",
  studio_read_cues: "home:tool_name_read_cues",
  studio_find_cues: "home:tool_name_find_cues",
  studio_prepare_revision: "home:tool_name_prepare_revision",
  studio_prepare_cue_edits: "home:tool_name_prepare_cue_edits",
  studio_find_duplicates: "home:tool_name_find_duplicates",
  studio_check_consistency: "home:tool_name_check_consistency",
  web_search: "home:tool_name_web_search",
  web_read: "home:tool_name_web_read",
} as const;

/**
 * The tool calls of one stretch of a turn, as rows of one card: each row says in a line what the
 * call did; its result, parameters and data wait behind the row's disclosure. Failures and receipts
 * with failures stay visible.
 */
export function AgentToolGroup({ entries, running = false }: { entries: { call: ToolCall; result?: AgentToolResult }[]; running?: boolean }) {
  if (!entries.length) return null;
  return <AgentCard data-testid="agent-tool-group">
    <ul className="divide-y">{entries.map(({ call, result }) => <AgentToolRow key={call.toolCallId} call={call} result={result} running={running && !result} />)}</ul>
  </AgentCard>;
}

function AgentToolRow({ call, result, running }: { call: ToolCall; result?: AgentToolResult; running: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState("");
  const state = running ? "running" : result ? result.success ? "completed" : "failed" : "incomplete";
  const Icon = { running: Loader2, completed: CheckCircle2, failed: XCircle, incomplete: CircleDashed }[state];
  const label = { running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", incomplete: "home:tool_incomplete" } as const;
  const titleKey = toolNameKeys[call.toolName as keyof typeof toolNameKeys] ?? "home:tool_execution_fallback";
  const summary = result ? toolResultSummary(result, t) : undefined;
  const path = result ? toolResultPath(result) : undefined;
  const hasArgs = Object.keys(call.args ?? {}).length > 0;
  return <li data-tool-call-id={call.toolCallId} data-tool-call-status={state}>
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="detail" className="border-0">
        <div className="flex min-w-0 items-center [&>h3]:min-w-0 [&>h3]:flex-1">
          <AccordionTrigger className="min-w-0 gap-2 rounded-none py-2 pr-3 pl-3 text-xs font-normal focus-visible:ring-inset [&>svg]:size-3.5">
            <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", state === "completed" && "text-emerald-600 dark:text-emerald-400",
              state === "failed" && "text-destructive", running && "animate-spin motion-reduce:animate-none")} />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 font-medium">{t(titleKey)}</span>
              {summary && <span className="min-w-0 truncate text-muted-foreground" title={summary}>{summary}</span>}
            </span>
            {state !== "completed" && <span className={cn("shrink-0 text-[11px] text-muted-foreground", state === "failed" && "text-destructive")}>{t(label[state])}</span>}
          </AccordionTrigger>
          {path && <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("home:open_tool")} className="mr-1.5 size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground" onClick={() => navigate(path)}>
                <ArrowUpRight className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t("home:open_tool")}</TooltipContent>
          </Tooltip>}
        </div>
        {result && !result.success && <p className="px-3 pb-2 pl-8.5 text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{result.error ? actionErrorMessage(result.error, t) : t("home:action_failed")}</p>}
        {result?.success && <div className="empty:hidden px-3 pb-2 pl-8.5"><ToolResultAttention result={result} /></div>}
        <AccordionContent className="space-y-2 border-t bg-muted/20 px-3 pt-2.5 pb-3 text-[11px] leading-5 text-muted-foreground">
          {result && <div className="text-foreground"><ToolResultDetails result={result} /></div>}
          <p className="[overflow-wrap:anywhere]">{t("home:tool_identifier")}: <code className="text-foreground/80">{call.toolName}</code></p>
          {hasArgs && <div><p className="mb-0.5">{t("home:tool_parameters")}</p><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">{JSON.stringify(call.args, null, 2)}</pre></div>}
          {result?.data !== undefined && <div><p className="mb-0.5">{t("home:tool_result_data")}</p><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">{JSON.stringify(result.data, null, 2)}</pre></div>}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </li>;
}
