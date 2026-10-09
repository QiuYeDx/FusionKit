import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import type { AgentToolCall as ToolCall, AgentToolResult } from "@/agent/types";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { actionErrorMessage } from "./action-error";

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

export default function AgentToolCall({ call, result, running = false }: { call: ToolCall; result?: AgentToolResult; running?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const state = running ? "running" : result ? result.success ? "completed" : "failed" : "incomplete";
  const Icon = { running: Loader2, completed: CheckCircle2, failed: XCircle, incomplete: CircleDashed }[state];
  const label = { running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", incomplete: "home:tool_incomplete" } as const;
  const titleKey = toolNameKeys[call.toolName as keyof typeof toolNameKeys] ?? "home:tool_execution_fallback";
  return <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded} className="min-w-0 rounded-xl border bg-card/50" data-tool-call-id={call.toolCallId} data-tool-call-status={state}>
    <AccordionItem value="detail" className="border-0">
      <AccordionTrigger className="gap-2 rounded-[11px] px-3 py-2 text-xs data-[state=open]:rounded-b-none">
        <Icon aria-hidden className={`size-3.5 shrink-0 ${state === "failed" ? "text-destructive" : "text-muted-foreground"} ${running ? "animate-spin motion-reduce:animate-none" : ""}`} />
        <span className="min-w-0 flex-1 text-left [overflow-wrap:anywhere]">{t(titleKey)}</span>
        <span className="shrink-0 font-normal text-muted-foreground">{t(label[state])}</span>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        <p className="mb-2 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{t("home:tool_identifier")}: <code>{call.toolName}</code></p>
        <p className="mb-1 text-[11px] text-muted-foreground">{t("home:tool_parameters")}</p>
        <pre className="whitespace-pre-wrap text-[11px] leading-5 [overflow-wrap:anywhere]">{JSON.stringify(call.args, null, 2)}</pre>
        {result?.error && <p className="mt-2 text-xs text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(result.error, t)}</p>}
      </AccordionContent>
    </AccordionItem>
  </Accordion>;
}
