import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import type { AgentToolCall as ToolCall, AgentToolResult } from "@/agent/types";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { actionErrorMessage } from "./action-error";
import AgentCard from "./AgentCard";
import ToolResultBody, { isModernToolResult } from "./AgentToolResult";

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
  open_app_page: "home:tool_name_open_page",
  subtitle_translator_update_settings: "home:tool_name_update_settings",
  subtitle_converter_update_settings: "home:tool_name_update_settings",
  subtitle_extractor_update_settings: "home:tool_name_update_settings",
  name_translator_update_settings: "home:tool_name_update_settings",
  studio_read_cues: "home:tool_name_read_cues",
  studio_find_cues: "home:tool_name_find_cues",
  studio_prepare_revision: "home:tool_name_prepare_revision",
} as const;

/**
 * One card per tool call: its name and state in the header, what it returned in the body and the
 * raw parameters and data behind the header's disclosure. `body` replaces the default result view,
 * for results that are not modern tool payloads.
 */
export default function AgentToolCall({ call, result, running = false, body }: { call: ToolCall; result?: AgentToolResult; running?: boolean; body?: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const state = running ? "running" : result ? result.success ? "completed" : "failed" : "incomplete";
  const Icon = { running: Loader2, completed: CheckCircle2, failed: XCircle, incomplete: CircleDashed }[state];
  const label = { running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", incomplete: "home:tool_incomplete" } as const;
  const titleKey = toolNameKeys[call.toolName as keyof typeof toolNameKeys] ?? "home:tool_execution_fallback";
  const content = body !== undefined ? body : result && isModernToolResult(result.toolName) ? <ToolResultBody result={result} />
    : result && !result.success ? <p className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{result.error ? actionErrorMessage(result.error, t) : t("home:action_failed")}</p> : null;
  const hasArgs = Object.keys(call.args ?? {}).length > 0;
  return <AgentCard data-tool-call-id={call.toolCallId} data-tool-call-status={state}>
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="detail" className="border-0">
        <AccordionTrigger className="items-center gap-2 rounded-none px-3 py-2 text-xs hover:bg-muted/40 hover:no-underline focus-visible:ring-inset [&>svg]:translate-y-0">
          <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", state === "completed" && "text-emerald-600 dark:text-emerald-400",
            state === "failed" && "text-destructive", running && "animate-spin motion-reduce:animate-none")} />
          <span className="min-w-0 flex-1 text-left font-medium [overflow-wrap:anywhere]">{t(titleKey)}</span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{t(label[state])}</span>
        </AccordionTrigger>
        {content && <div className="border-t px-3 py-2.5">{content}</div>}
        <AccordionContent className="space-y-2 border-t bg-muted/20 px-3 pt-2.5 pb-3 text-[11px] leading-5 text-muted-foreground">
          <p className="[overflow-wrap:anywhere]">{t("home:tool_identifier")}: <code className="text-foreground/80">{call.toolName}</code></p>
          {hasArgs && <div><p className="mb-0.5">{t("home:tool_parameters")}</p><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">{JSON.stringify(call.args, null, 2)}</pre></div>}
          {result?.data !== undefined && <div><p className="mb-0.5">{t("home:tool_result_data")}</p><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">{JSON.stringify(result.data, null, 2)}</pre></div>}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </AgentCard>;
}
