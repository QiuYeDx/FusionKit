import * as React from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

function Accordion(props: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn("min-w-0 border-b last:border-b-0", className)} {...props} />;
}

function AccordionTrigger({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return <AccordionPrimitive.Header className="flex min-w-0">
    <AccordionPrimitive.Trigger
      data-slot="accordion-trigger"
      className={cn("flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md py-3 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180 motion-reduce:transition-none", className)}
      {...props}
    >
      {children}
      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>;
}

function AccordionContent({ className, children, forceMount, ...props }: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return <AccordionPrimitive.Content
    data-slot="accordion-content"
    forceMount={forceMount}
    className={cn("overflow-hidden text-sm", forceMount
      ? "grid grid-rows-[0fr] invisible transition-[grid-template-rows,visibility] duration-200 ease-out data-[state=open]:grid-rows-[1fr] data-[state=open]:visible data-[state=closed]:[transition-delay:0ms,200ms] data-[state=open]:delay-0 motion-reduce:transition-none motion-reduce:delay-0"
      : "data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none")}
    {...props}
  >
    <div className="min-h-0 overflow-hidden">
      <div className={cn("pb-4", className)}>{children}</div>
    </div>
  </AccordionPrimitive.Content>;
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
