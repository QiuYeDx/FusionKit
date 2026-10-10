import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PreparedAction, PreparedKnowledgeChanges } from "@/agent/prepared-actions";
import type { ProposalItem } from "@/translation-knowledge/proposal";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Switch } from "@/components/ui/switch";
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
    counts.subjects && t("home:knowledge_count_subjects", { count: counts.subjects }),
    counts.collections && t("home:knowledge_count_collections", { count: counts.collections }),
    counts.created && t("home:knowledge_count_created", { count: counts.created }),
    counts.updated && t("home:knowledge_count_updated", { count: counts.updated }),
    counts.archived && t("home:knowledge_count_archived", { count: counts.archived }),
    existing && counts.existing && t("home:knowledge_count_existing", { count: counts.existing }),
  ].filter(Boolean).join(t("home:knowledge_count_separator"));
}

/** One line on what saving does: where it goes and how many of each change. */
export function knowledgeChangesSummary(changes: PreparedKnowledgeChanges, t: TFunction): string {
  const parts = countParts(changes.counts, t, true);
  const destination = soleDestination(changes);
  // "Into" when something is added there; edits and archives happen "in" it.
  return destination ? t(changes.counts.created ? "home:knowledge_summary_into" : "home:knowledge_summary_within", { collection: destination, changes: parts }) : parts;
}

/** What a saved card reports, from the action's result. */
export function knowledgeSavedSummary(action: PreparedAction, t: TFunction): string | undefined {
  const result = objectValue(action.result);
  if (action.status !== "completed" || result.executionStatus !== "saved") return undefined;
  if (result.alreadySaved) return t("home:knowledge_saved_already");
  const counts = objectValue(result.counts) as Partial<PreparedKnowledgeChanges["counts"]>;
  const changes = countParts(counts, t, false);
  const adopted = Number(result.adopted ?? 0);
  return adopted ? t("home:knowledge_saved_enabled", { changes, enabled: adopted })
    : Number(counts.created ?? 0) + Number(counts.updated ?? 0) ? t("home:knowledge_saved_review", { changes }) : t("home:knowledge_saved", { changes });
}

function kindLabel(item: ProposalItem, t: TFunction): string {
  if (item.group === "subjects") return t("home:knowledge_kind_subject");
  if (item.group === "collections") return t("home:knowledge_kind_collection");
  if (item.status === "exists") return t("home:knowledge_kind_exists");
  if (item.status === "update") return t("home:knowledge_kind_update");
  if (item.status === "archive") return t("home:knowledge_kind_archive");
  return t(`home:knowledge_kind_${item.kind === "rule" ? "rule" : item.kind === "context" ? "context" : "term"}`);
}

function Row({ item, destination }: { item: ProposalItem; destination?: string }) {
  const { t } = useTranslation();
  // The summary already names a single destination; only other collections are named per row.
  const detail = [item.group === "entries" && item.collectionName !== destination ? item.collectionName : undefined, item.note,
    item.sourceSite ? t("home:knowledge_from_site", { site: item.sourceSite }) : undefined].filter(Boolean).join(" · ");
  return <li className={cn("min-w-0 py-1.5 text-xs leading-5", item.status === "exists" && "opacity-70")} data-testid="knowledge-change-row" data-status={item.status}>
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {item.source !== undefined && item.target !== undefined
          ? <><span className="text-muted-foreground">{item.source}</span><span aria-hidden className="px-1 text-muted-foreground">→</span><span className="sr-only">{t("home:knowledge_arrow")}</span><span>{item.target}</span></>
          : item.label}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{kindLabel(item, t)}</span>
    </div>
    {detail && <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{detail}</p>}
    {item.warnings.map((warning, index) => <p key={index} className="text-[11px] text-amber-700 [overflow-wrap:anywhere] dark:text-amber-400" data-testid="knowledge-change-warning">
      {warning.code === "term_conflict" ? t("home:knowledge_warning_conflict", { collection: warning.collectionName ?? "", target: warning.target ?? "" }) : t("home:knowledge_warning_review")}
    </p>)}
  </li>;
}

/**
 * The body of a translation materials card: the changes, and whether saving enables them. Catalog
 * records that already exist are not listed; the entries name their collection.
 */
export default function AgentKnowledgeChanges({ action, adopt, onAdoptChange, disabled }: {
  action: PreparedAction; adopt: boolean; onAdoptChange: (value: boolean) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const changes = action.knowledge!;
  const rows = changes.items.filter(item => item.group === "entries" || item.status === "new");
  const destination = soleDestination(changes);
  const list = (items: ProposalItem[], className?: string) => <ul className={cn("divide-y divide-border/60", className)}>{items.map(item => <Row key={item.key} item={item} destination={destination} />)}</ul>;
  const switchId = `knowledge-adopt-${action.id}`;
  // The rest continue the same list when unfolded: one surface, scrolled with the conversation.
  return <div className="min-w-0 space-y-2" data-testid="knowledge-changes">
    {rows.length > VISIBLE_ROWS ? <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="more" className="border-0">
        <div className="rounded-lg bg-muted/40 px-2.5">
          {list(rows.slice(0, VISIBLE_ROWS))}
          <AccordionContent className="pb-0">{list(rows.slice(VISIBLE_ROWS), "border-t border-border/60")}</AccordionContent>
        </div>
        <AccordionTrigger data-testid="knowledge-changes-more" className="-ml-2 -mr-1 mt-1 gap-2 rounded-md py-1 pr-1 pl-2 text-xs font-normal text-muted-foreground [&>svg]:size-3.5">
          {expanded ? t("home:knowledge_show_less") : t("home:knowledge_show_more", { count: rows.length - VISIBLE_ROWS })}
        </AccordionTrigger>
      </AccordionItem>
    </Accordion> : list(rows, "rounded-lg bg-muted/40 px-2.5")}
    {action.status === "ready" && changes.adoptable > 0 && <div className="flex items-start gap-2.5 pt-0.5">
      <Switch id={switchId} checked={adopt} onCheckedChange={onAdoptChange} disabled={disabled} className="mt-0.5" />
      <label htmlFor={switchId} className="min-w-0 cursor-pointer text-xs leading-5">
        <span className="block">{t("home:knowledge_adopt")}</span>
        <span className="block text-[11px] text-muted-foreground">{adopt ? t("home:knowledge_adopt_on") : t("home:knowledge_adopt_off")}</span>
      </label>
    </div>}
  </div>;
}
