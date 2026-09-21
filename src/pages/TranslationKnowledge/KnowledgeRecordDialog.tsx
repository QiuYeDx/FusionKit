import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { cn } from '@/lib/utils';
import './knowledge-record-dialog.css';

/** Record reading/editing has its own action hierarchy; exchange dialogs keep their existing shell. */
export function KnowledgeRecordDialog({ title, description, icon, children, footer, footerStart, onClose, pending = false, closeLabel, testId, wide = false, error, restoreFocusTo }: {
  title: string; description?: string; icon?: ReactNode; children: ReactNode;
  footer?: ReactNode; footerStart?: ReactNode; onClose: () => void; pending?: boolean;
  closeLabel?: string; testId?: string; wide?: boolean;
  error?: string | null; restoreFocusTo?: () => HTMLElement | null;
}) {
  const { t } = useTranslation('knowledge');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    if (!error) return;
    // A fixed footer can submit while the error region is below the viewport.
    const frame = requestAnimationFrame(() => {
      const alert = bodyRef.current?.querySelector<HTMLElement>('[role="alert"]');
      if (!alert) return;
      alert.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      alert.tabIndex = -1; alert.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [error]);
  return <ScrollableDialog open onOpenChange={open => { if (!open && !pending) onClose(); }}
    maxWidth={wide ? 'sm:max-w-[760px]' : 'sm:max-w-[640px]'}
    contentClassName="knowledge-record-dialog"
    onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus({ preventScroll: true }); }}
    onCloseAutoFocus={event => {
      // A handoff to an editor/confirmation must leave focus in the new dialog.
      if (document.querySelector('[role="dialog"][data-state="open"]')) { event.preventDefault(); return; }
      const target = opener.current?.isConnected ? opener.current : restoreFocusTo?.();
      if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert]')) {
        event.preventDefault(); target.focus({ preventScroll: true });
      }
    }}>
    <ScrollableDialogHeader className="knowledge-record-header">
      <DialogTitle ref={titleRef} tabIndex={-1} className="knowledge-record-title">{icon}{title}</DialogTitle>
      <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="knowledge-record-content" fadeMaskHeight={16}>
      <div ref={bodyRef} data-testid={testId} className="knowledge-record-body" aria-busy={pending}>{children}</div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="knowledge-record-footer">
      {footerStart && <div className="knowledge-record-footer-start">{footerStart}</div>}
      <div data-testid="knowledge-record-primary-actions" className="knowledge-record-footer-end">
        <Button data-testid="knowledge-record-close" size="sm" variant="outline" disabled={pending} onClick={onClose}>{closeLabel ?? t('actions.close')}</Button>
        {footer}
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}

export function KnowledgeFormSection({ title, description, children, className }: {
  title: string; description?: string; children: ReactNode; className?: string;
}) {
  return <section className={cn('knowledge-form-section', className)}>
    <div className="knowledge-section-heading"><h3>{title}</h3>{description && <p>{description}</p>}</div>
    {children}
  </section>;
}

export function KnowledgeRecordMenu({ children, disabled, testId, label }: {
  children: ReactNode; disabled?: boolean; testId?: string; label?: string;
}) {
  const { t } = useTranslation('knowledge');
  // The enclosing dialog already owns the modal focus/pointer boundary. A second
  // modal lock can outlive it when a menu action dismisses or replaces the dialog.
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild><Button data-testid={testId} variant="outline" size="sm" disabled={disabled}><Ellipsis />{label ?? t('record.more')}<ChevronDown /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="knowledge-record-menu">{children}</DropdownMenuContent>
  </DropdownMenu>;
}
