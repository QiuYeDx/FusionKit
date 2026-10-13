import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PreparedAction, PreparedKnowledgeChanges } from "@/agent/prepared-actions";
import type { ProposalItem } from "@/translation-knowledge/proposal";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { objectValue } from "../presentation";

/** Rows shown before the rest fold away. */
const VISIBLE_ROWS = 6;

/** The one collection every new or edited entry goes to, which the summary names; undefined when several. */
function soleDestination(changes: PreparedKnowledgeChanges): string | undefined {
  const destinations = [...new Set(changes.items.filter(item => item.group === "entries" && item.status !== "exists" && item.collectionName).map(item => item.collectionName!))];
  return destinations.length === 1 ? destinations[0] : undefined;
}
function countParts(counts: Partial<PreparedKnowledgeChanges["counts"]>, t: TFunction, existing: boolean): string {
  return [
    counts.collections && t("home:knowledge_count_collections", { count: counts.collections }),
    counts.created && t("home:knowledge_count_created", { count: counts.created }),
    counts.updated && t("home:knowledge_count_updated", { count: counts.updated }),
    counts.disabled && t("home:knowledge_count_disabled", { count: counts.disabled }),
    counts.enabled && t("home:knowledge_count_enabled", { count: counts.enabled }),
    existing && counts.existing && t("home:knowledge_count_existing", { count: counts.existing }),
  ].filter(Boolean).join(t("home:knowledge_count_separator"));
}

/** One line on what saving does: where it goes and how many of each change. */
export function knowledgeChangesSummary(changes: PreparedKnowledgeChanges, t: TFunction): string {
  const parts = countParts(changes.counts, t, true);
  const destination = soleDestination(changes);
  // "Into" when something is added there; edits happen "in" it.
  return destination ? t(changes.counts.created ? "home:knowledge_summary_into" : "home:knowledge_summary_within", { collection: destination, changes: parts }) : parts;
}

/** What a saved card reports, from the action's result. */
export function knowledgeSavedSummary(action: PreparedAction, t: TFunction): string | undefined {
  const result = objectValue(action.result);
  if (action.status !== "completed" || result.executionStatus !== "saved") return undefined;
  if (result.alreadySaved) return t("home:knowledge_saved_already");
  const counts = objectValue(result.counts) as Partial<PreparedKnowledgeChanges["counts"]>;
  return t("home:knowledge_saved", { changes: countParts(counts, t, false) });
}

function kindLabel(item: ProposalItem, t: TFunction): string {
  if (item.group === "collections") return t("home:knowledge_kind_collection");
  if (item.status === "exists") return t("home:knowledge_kind_exists");
  if (item.status === "update") return t("home:knowledge_kind_update");
  if (item.status === "disable") return t("home:knowledge_kind_disable");
  if (item.status === "enable") return t("home:knowledge_kind_enable");
  return t(`home:knowledge_kind_${item.kind === "rule" ? "rule" : item.kind === "context" ? "context" : "term"}`);
}

function Row({ item, destination }: { item: ProposalItem; destination?: string }) {
  const { t } = useTranslation();
  // The summary already names a single destination; only other collections are named per row.
  const detail = [item.group === "entries" && item.collectionName !== destination ? item.collectionName : undefined, item.note].filter(Boolean).join(" · ");
  // Wording the assistant did not hear from the user says where it came from, so it gets checked before confirming.
  const origin = item.status === "exists" ? undefined : item.sourceSite ? t("home:knowledge_from_site", { site: item.sourceSite })
    : item.basis === "agent_inferred" ? t("home:knowledge_ai_inferred") : undefined;
  return <li className={cn("min-w-0 py-1.5 text-xs leading-5", item.status === "exists" && "opacity-70")} data-testid="knowledge-change-row" data-status={item.status}>
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {item.source !== undefined && item.target !== undefined
          ? <><span className="text-muted-foreground">{item.source}</span><span aria-hidden className="px-1 text-muted-foreground">→</span><span className="sr-only">{t("home:knowledge_arrow")}</span><span>{item.target}</span></>
          : item.label}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{kindLabel(item, t)}</span>
    </div>
    {(detail || origin) && <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
      {origin && <span data-testid="knowledge-change-origin" className="mr-1.5 inline-block rounded bg-amber-500/10 px-1 text-amber-700 dark:text-amber-400">{origin}</span>}
      {detail}
    </p>}
    {item.warnings.map((warning, index) => <p key={index} className="text-[11px] text-amber-700 [overflow-wrap:anywhere] dark:text-amber-400" data-testid="knowledge-change-warning">
      {t("home:knowledge_warning_conflict", { collection: warning.collectionName ?? "", target: warning.target ?? "" })}
    </p>)}
  </li>;
}

/**
 * The body of a translation materials card: the changes confirming saves, enabled at once.
 * Collections that already exist are not listed; the entries name their collection.
 */
export default function AgentKnowledgeChanges({ action }: { action: PreparedAction }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const changes = action.knowledge!;
  const rows = changes.items.filter(item => item.group === "entries" || item.status === "new");
  const destination = soleDestination(changes);
  const list = (items: ProposalItem[], className?: string) => <ul className={cn("divide-y divide-border/60", className)}>{items.map(item => <Row key={item.key} item={item} destination={destination} />)}</ul>;
  // The rest continue the same list when unfolded: one surface, scrolled with the conversation.
  return <div className="min-w-0 space-y-2" data-testid="knowledge-changes">
    {rows.length > VISIBLE_ROWS ? <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="more" className="border-0">
        <div className="rounded-smooth-lg bg-muted/40 px-2.5">
          {list(rows.slice(0, VISIBLE_ROWS))}
          <AccordionContent className="pb-0">{list(rows.slice(VISIBLE_ROWS), "border-t border-border/60")}</AccordionContent>
        </div>
        <AccordionTrigger data-testid="knowledge-changes-more" className="-ml-2 -mr-1 mt-1 gap-2 rounded-smooth-md py-1 pr-1 pl-2 text-xs font-normal text-muted-foreground [&>svg]:size-3.5">
          {expanded ? t("home:knowledge_show_less") : t("home:knowledge_show_more", { count: rows.length - VISIBLE_ROWS })}
        </AccordionTrigger>
      </AccordionItem>
    </Accordion> : list(rows, "rounded-smooth-lg bg-muted/40 px-2.5")}
  </div>;
}
