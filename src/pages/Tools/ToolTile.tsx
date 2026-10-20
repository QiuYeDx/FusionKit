import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import AgentOrb from "@/components/agent-orb/AgentOrb";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
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
 * A tool in the grid. The title is the link and its hit area covers the whole tile; the light under the
 * border follows the pointer. A tool the agent can run through a workflow template also offers to hand
 * the job over, without opening the tool.
 */
export function ToolTile({ item, index, className, beta }: { item: ToolTileItem; index: number; className?: string; beta?: boolean }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const meta = TOOL_META[item.id];
  const tone = toneCss(meta);
  const Icon = meta.icon;
  const ref = useRef<HTMLDivElement>(null);
  const [agentHover, setAgentHover] = useState(false);
  const spot = (event: React.PointerEvent) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    ref.current!.style.setProperty("--spot-x", `${event.clientX - bounds.left}px`);
    ref.current!.style.setProperty("--spot-y", `${event.clientY - bounds.top}px`);
  };
  return <motion.div className={cn("min-w-0", className)} initial={reduceMotion ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.6, delay: 0.16 + index * 0.05, ease: EASE }}>
    <SmoothCorners radius={20} smoothing={0.72} asChild>
      <div ref={ref} data-tool-card={item.id} className="tool-tile group" style={{ "--tool-tone": tone } as CSSProperties} onPointerMove={spot}>
        <span className="tool-tile-clip" aria-hidden><Icon className="tool-tile-watermark" /></span>
        <div className="tool-tile-head">
          <SmoothCorners radius={13} smoothing={0.72} className="tool-tile-icon">
            <Icon aria-hidden className="size-5" />
          </SmoothCorners>
          {beta && <span className="tool-tile-beta">Beta</span>}
          <ArrowUpRight aria-hidden className="tool-tile-arrow" />
        </div>
        <h3 className="tool-tile-title">
          <Link to={meta.route!} id={`tool-title-${item.id}`} className="tool-tile-link">{t(item.titleKey)}</Link>
        </h3>
        <p className="tool-tile-description">{t(item.descKey)}</p>
        <div className="tool-tile-foot">
          <ul className="tool-tile-chips">
            {item.chips.map((chip) => <li key={chip}>{item.translateChips ? t(chip) : chip}</li>)}
          </ul>
          {item.templateId && <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <button type="button" className="tool-tile-agent" data-testid="tool-agent-handoff" data-template={item.templateId}
                onClick={() => openPromptTemplate(item.templateId!)} onPointerEnter={() => setAgentHover(true)} onPointerLeave={() => setAgentHover(false)}
                aria-label={`${t("tools:catalog.agent_handoff")} · ${t(item.titleKey)}`}>
                <AgentOrb size={18} fill={0.88} halo={false} state={agentHover ? "think" : "idle"} paused={!agentHover} />
                <span>{t("tools:catalog.agent_handoff")}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-64">{t("tools:catalog.agent_handoff_hint")}</TooltipContent>
          </Tooltip>}
        </div>
      </div>
    </SmoothCorners>
  </motion.div>;
}
