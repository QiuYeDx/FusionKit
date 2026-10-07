import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Blocks } from "lucide-react";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollableDialog, ScrollableDialogContent, ScrollableDialogHeader } from "@/components/qiuye-ui/scrollable-dialog";
import { agentToolPath } from "../presentation";

export const capabilityLabels = {
  subtitleStudio: { title: "home:capability_studio", description: "home:capability_studio_description" },
  translationKnowledge: { title: "home:capability_knowledge", description: "home:capability_knowledge_description" },
  translator: { title: "home:capability_translator", description: "home:capability_translator_description" },
  converter: { title: "home:capability_converter", description: "home:capability_converter_description" },
  extractor: { title: "home:capability_extractor", description: "home:capability_extractor_description" },
  localSubtitleTranscriber: { title: "home:capability_local", description: "home:capability_local_description" },
  nameTranslator: { title: "home:capability_names", description: "home:capability_names_description" },
} as const;

export default function AgentCapabilities() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="h-7 gap-1.5 rounded-full px-2 text-xs text-muted-foreground" data-testid="agent-capabilities-trigger">
      <Blocks className="size-3.5" />{t("home:capabilities_title")}
    </Button>
    <ScrollableDialog open={open} onOpenChange={setOpen} maxWidth="sm:max-w-xl">
      <ScrollableDialogHeader className="p-3 pr-12">
        <DialogTitle className="text-base">{t("home:capabilities_title")}</DialogTitle>
        <DialogDescription className="text-xs leading-5">{t("home:capabilities_description")}</DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="p-0 [&_[data-dialog-body-measure]]:p-3 [&_[data-dialog-body-measure]]:min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!block" fadeMasks fadeMaskHeight={20}>
        <div className="space-y-1" data-testid="agent-capabilities-list">
          {AGENT_CAPABILITIES.map(capability => {
            const labels = capabilityLabels[capability.toolKey as keyof typeof capabilityLabels];
            if (!labels) return null;
            return <div key={capability.toolKey} className="flex items-start gap-3 rounded-lg p-2 hover:bg-muted/40">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">{t(labels.title)}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{t(labels.description)}</p>
              </div>
              <Button variant="ghost" size="sm" className="size-7 shrink-0 p-0" aria-label={t("home:open_tool_named", { name: t(labels.title) })} onClick={() => { setOpen(false); navigate(agentToolPath(capability.toolKey, capability.route)); }}><ArrowUpRight className="size-4" /></Button>
            </div>;
          })}
        </div>
      </ScrollableDialogContent>
    </ScrollableDialog>
  </>;
}
