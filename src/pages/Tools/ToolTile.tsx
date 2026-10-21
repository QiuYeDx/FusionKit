import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import AgentOrb from "@/components/agent-orb/AgentOrb";
import { SpotlightTile, SpotlightTileLink } from "@/components/qiuye-ui/spotlight-tile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { openPromptTemplate } from "@/pages/HomeAgent/components/PromptTemplates";
import { cn } from "@/lib/utils";
import { TOOL_META, toneCss, type ToolKey } from "./_shared/toolMeta";

const EASE = [0.23, 1, 0.32, 1] as const;

export interface ToolTileItem {
  id: ToolKey;
  titleKey: string;
  descKey: string;
  /** Short feature labels: i18n keys, or literal format names. */
  chips: string[];
  translateChips?: boolean;
  /** The workflow template that hands this job to the agent. */
  templateId?: string;
}

/**
 * A tool in the grid, on qiuye-ui's SpotlightTile. The title is the link and its hit area covers the whole
 * tile. A tool the agent can run through a workflow template also offers to hand the job over, without
 * opening the tool.
 */
export function ToolTile({ item, index, className, beta }: { item: ToolTileItem; index: number; className?: string; beta?: boolean }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const meta = TOOL_META[item.id];
  const Icon = meta.icon;
  const [agentHover, setAgentHover] = useState(false);
  const handoff = item.templateId && <Tooltip delayDuration={400}>
    <TooltipTrigger asChild>
      <button type="button" className="tool-agent-handoff" data-testid="tool-agent-handoff" data-template={item.templateId}
        onClick={() => openPromptTemplate(item.templateId!)} onPointerEnter={() => setAgentHover(true)} onPointerLeave={() => setAgentHover(false)}
        aria-label={`${t("tools:catalog.agent_handoff")} · ${t(item.titleKey)}`}>
        <AgentOrb size={18} fill={0.88} halo={false} state={agentHover ? "think" : "idle"} paused={!agentHover} />
        <span>{t("tools:catalog.agent_handoff")}</span>
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" sideOffset={6} className="max-w-64">{t("tools:catalog.agent_handoff_hint")}</TooltipContent>
  </Tooltip>;
  // The tiles rise with the page instead of on entering the view, so one peeking above the bottom edge is
  // never an invisible click target, and they show at once when motion is reduced.
  return <motion.div className={cn("min-w-0", className)} initial={reduceMotion ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.6, delay: 0.16 + index * 0.05, ease: EASE }}>
    <SpotlightTile data-tool-card={item.id} appear={false} tone={toneCss(meta)} icon={<Icon />} badge={beta ? "Beta" : undefined} arrow
      title={<SpotlightTileLink asChild><Link to={meta.route!} id={`tool-title-${item.id}`}>{t(item.titleKey)}</Link></SpotlightTileLink>}
      description={t(item.descKey)} chips={item.chips.map((chip) => item.translateChips ? t(chip) : chip)} actions={handoff || undefined}
      className="h-full min-h-[178px]" />
  </motion.div>;
}
