import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PreparedActionReceipt } from "@/agent/prepared-actions";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { actionErrorMessage } from "./action-error";
import { taskStatusKeys } from "../presentation";

/**
 * A preparation or submission receipt in one line: the count, and its items behind a disclosure.
 * Failed items stay visible while it is folded.
 */
export default function AgentActionReceipt({ receipt }: { receipt: PreparedActionReceipt }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const failed = receipt.items.filter(item => item.status === "failed");
  const prefix = receipt.phase === "preparation" ? "home:receipt_preparation" : "home:receipt_submission";
  const summary = receipt.failureCount
    ? t(prefix, { count: receipt.successCount, total: receipt.total, failed: receipt.failureCount })
    : t(`${prefix}_ok`, { count: receipt.successCount, total: receipt.total });
  const row = (item: PreparedActionReceipt["items"][number]) => <li key={item.id} className="min-w-0 py-1.5 text-xs leading-5">
    <div className="flex items-start justify-between gap-3"><span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span>
      <span className={cn("shrink-0 text-[11px] text-muted-foreground", item.status === "failed" && "text-destructive")}>{t(taskStatusKeys[item.status])}</span></div>
    {item.error && <p className="text-[11px] text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(item.error, t)}</p>}
  </li>;
  const summaryClass = cn("text-xs leading-5", receipt.failureCount ? "text-destructive" : "text-muted-foreground");
  return <div className="min-w-0" data-testid="agent-action-receipt" data-receipt-phase={receipt.phase}>
    {receipt.items.length > 0 ? <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="items" className="border-0">
        {/* The hover surface reaches past the text, so the label never touches its edge. */}
        <AccordionTrigger data-testid="receipt-toggle" className="-ml-2 -mr-1 gap-2 rounded-md py-1 pr-1 pl-2 font-normal [&>svg]:size-3.5">
          <span className={cn("min-w-0 flex-1", summaryClass)} data-testid="receipt-summary">{summary}</span>
        </AccordionTrigger>
        <AccordionContent className="pb-0">
          <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-lg bg-muted/40 px-2.5">{receipt.items.map(row)}</ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion> : <p className={summaryClass} data-testid="receipt-summary">{summary}</p>}
    {!expanded && failed.length > 0 && <ul className="mt-1 divide-y divide-border/60 rounded-lg bg-destructive/5 px-2.5">{failed.slice(0, 3).map(row)}</ul>}
  </div>;
}
