import { useState, type ComponentProps, type ReactNode } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { cn } from '@/lib/utils';

/** The same Accordion interaction for document lists, previews and diagnostics. */
export function StudioDisclosure({
  title, children, open, defaultOpen = false, onOpenChange, triggerLabel, triggerTestId,
  className, triggerClassName, contentClassName, lazyMount = false, ...props
}: Omit<ComponentProps<'div'>, 'title' | 'defaultValue' | 'dir'> & {
  title: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerLabel?: string;
  triggerTestId?: string;
  triggerClassName?: string;
  contentClassName?: string;
  lazyMount?: boolean;
}) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const expanded = open ?? innerOpen;
  const [visited, setVisited] = useState(expanded);
  if (expanded && !visited) setVisited(true);
  return <Accordion {...props} type="single" collapsible value={expanded ? 'content' : ''}
    onValueChange={value => {
      const nextOpen = value === 'content';
      if (open === undefined) setInnerOpen(nextOpen);
      onOpenChange?.(nextOpen);
    }} className={cn('min-w-0', className)}>
    <AccordionItem value="content" className="border-0">
      <AccordionTrigger data-testid={triggerTestId} aria-label={triggerLabel} className={cn('min-h-10 cursor-pointer gap-2 px-3 py-2 text-xs', triggerClassName)}>
        {title}
      </AccordionTrigger>
      <AccordionContent forceMount motionOpen={expanded} aria-hidden={!expanded} inert={!expanded} className={cn('p-0', contentClassName)}>
        {(!lazyMount || expanded || visited) && children}
      </AccordionContent>
    </AccordionItem>
  </Accordion>;
}
