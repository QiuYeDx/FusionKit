import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PreparedActionReceipt } from "@/agent/prepared-actions";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { actionErrorMessage } from "./action-error";
import { taskStatusKeys } from "../presentation";

export default function AgentActionReceipt({ receipt }: { receipt: PreparedActionReceipt }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const failed = receipt.items.filter(item => item.status === "failed");
  const row = (item: PreparedActionReceipt["items"][number]) => <li key={item.id} className="min-w-0 rounded-lg p-2 text-xs">
    <div className="flex items-start justify-between gap-3"><span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span><span className="shrink-0 text-muted-foreground">{t(taskStatusKeys[item.status])}</span></div>
    {item.error && <p className="mt-1 text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(item.error, t)}</p>}
  </li>;
  return <div className="min-w-0" data-testid="agent-action-receipt" data-receipt-phase={receipt.phase}>
    <p className={`text-xs leading-5 ${receipt.failureCount ? "text-destructive" : "text-muted-foreground"}`} data-testid="receipt-summary">
      {t(receipt.phase === "preparation" ? "home:receipt_preparation" : "home:receipt_submission", { count: receipt.successCount, total: receipt.total, failed: receipt.failureCount })}
    </p>
    {!expanded && failed.length > 0 && <ul className="mt-1 space-y-1">{failed.slice(0, 3).map(row)}</ul>}
    {receipt.items.length > 0 && <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="items" className="border-0">
        <AccordionTrigger data-testid="receipt-toggle" className="py-1 text-[11px] font-normal text-muted-foreground">{t("home:receipt_items", { count: receipt.items.length })}</AccordionTrigger>
        <AccordionContent className="pb-0"><ul className="max-h-64 space-y-1 overflow-y-auto">{receipt.items.map(row)}</ul></AccordionContent>
      </AccordionItem>
    </Accordion>}
  </div>;
}
