import { useRef, useState, type ReactNode } from "react";
import { LoaderCircle, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent,
  ScrollableDialogFooter, DialogTitle, DialogDescription,
} from "@/components/qiuye-ui/scrollable-dialog";
import "./collection-action-dialog.css";

export function CollectionImpactRow({ icon: Icon, tone, title, description, badge, children, testId, defaultOpen = false }: {
  icon: LucideIcon;
  tone: string;
  title: string;
  description: string;
  badge: ReactNode;
  children?: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const content = <>
    <span aria-hidden="true" className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon className="size-5" /></span>
    <span className="min-w-0 flex-1 space-y-1">
      <span className="block text-sm font-medium leading-5">{title}</span>
      <span className="block text-xs font-normal leading-5 text-muted-foreground [overflow-wrap:anywhere]">{description}</span>
    </span>
    <span className="max-w-[35%] shrink-0 rounded-full bg-muted/70 px-2.5 py-1 text-center text-xs font-medium tabular-nums text-muted-foreground">{badge}</span>
  </>;
  return children ? <Accordion
    data-testid={testId}
    data-state={open ? "open" : "closed"}
    type="single"
    collapsible
    value={open ? "impact" : ""}
    onValueChange={value => setOpen(value === "impact")}
    className="collection-action-impact-row min-w-0"
  >
    <AccordionItem value="impact" className="border-0">
      <AccordionTrigger className="collection-action-impact-trigger cursor-pointer rounded-xl p-2 duration-150 ease-out focus-visible:bg-muted/40">{content}</AccordionTrigger>
      <AccordionContent forceMount motionOpen={open} aria-hidden={!open} inert={!open} className="px-2 pb-2">{children}</AccordionContent>
    </AccordionItem>
  </Accordion> : <div data-testid={testId} className="collection-action-impact-row flex min-w-0 items-center gap-3 p-2">{content}</div>;
}

export type CollectionActionState = {
  pending: boolean;
  disabled: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

/** Shared visual structure for collection actions; each action owns its meaning. */
export function CollectionActionDialog({ icon: Icon, tone, title, description, confirmLabel, destructive = false, pending, disabled, onClose, onSubmit, children }: CollectionActionState & {
  icon: LucideIcon;
  tone: string;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("knowledge");
  const cancelButton = useRef<HTMLButtonElement>(null);
  return <ScrollableDialog
    open
    animateSize
    onOpenChange={open => { if (!open && !pending) onClose(); }}
    maxWidth="sm:max-w-[600px]"
    contentClassName="max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[20px] [&>button]:hidden"
    onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus({ preventScroll: true }); }}
  >
    <ScrollableDialogHeader className="border-b-0 p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div data-testid="collection-maintenance-summary" className="flex items-start gap-3 text-left">
          <span aria-hidden="true" className={`flex size-14 shrink-0 items-center justify-center rounded-[16px] ${tone}`}><Icon className="size-6" /></span>
          <div className="min-w-0 space-y-1.5 pt-0.5">
            <DialogTitle className="text-lg leading-7 [overflow-wrap:anywhere]">{title}</DialogTitle>
            <DialogDescription className="text-sm leading-5">{description}</DialogDescription>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("actions.close")} disabled={pending} onClick={onClose}><X /></Button>
      </div>
    </ScrollableDialogHeader>
    <ScrollableDialogContent fadeMaskHeight={16} className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:px-4 [&>[data-slot=scroll-area-viewport]>div>div]:py-0">
      {children}
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="p-4">
      <div className="flex flex-wrap justify-end gap-3">
        <Button ref={cancelButton} variant="outline" className="min-w-24" disabled={pending} onClick={onClose}>{t("collection_actions.cancel")}</Button>
        <Button data-testid="knowledge-maintenance-confirm" variant={destructive ? "destructive" : "default"} className="min-w-32" disabled={disabled} onClick={onSubmit}>
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {pending ? t("maintenance.working") : confirmLabel}
        </Button>
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
