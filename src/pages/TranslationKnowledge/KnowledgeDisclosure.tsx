import { useState, type ReactNode } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";

/** Consistent secondary sections; collapsing must not reset unfinished form input. */
export function KnowledgeDisclosure({
  title, description, children, variant = "panel", defaultOpen = false,
  className, contentClassName, id, "data-testid": testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  variant?: "panel" | "inline";
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
  id?: string;
  "data-testid"?: string;
}) {
  const [value, setValue] = useState(defaultOpen ? "content" : "");
  const open = value === "content";
  return <Accordion
    id={id}
    data-testid={testId}
    data-slot="knowledge-disclosure"
    type="single"
    collapsible
    value={value}
    onValueChange={setValue}
    className={cn("min-w-0", variant === "panel" ? "rounded-xl border bg-card" : "rounded-lg", className)}
  >
    <AccordionItem value="content" className="border-0">
      <AccordionTrigger className={cn("w-full cursor-pointer px-3", variant === "panel" ? "min-h-11 rounded-xl" : "min-h-9 rounded-lg px-2 py-2 text-xs")}>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 [overflow-wrap:anywhere]">
          <span className="leading-5">{title}</span>
          {description && <span className="text-xs font-normal leading-5 text-muted-foreground">{description}</span>}
        </span>
      </AccordionTrigger>
      <AccordionContent
        forceMount
        aria-hidden={!open}
        inert={!open}
        className={cn("space-y-3 px-3 pb-3 pt-1 [overflow-wrap:anywhere]", variant === "inline" && "px-2 pb-2", contentClassName)}
      >{children}</AccordionContent>
    </AccordionItem>
  </Accordion>;
}
