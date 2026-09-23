import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { cn } from '@/lib/utils';
import './knowledge-record-dialog.css';

/** Record reading/editing has its own action hierarchy; exchange dialogs keep their existing shell. */
export function KnowledgeRecordDialog({ title, description, icon, children, notice, footer, footerStart, onClose, pending = false, closeLabel, testId, wide = false, error, restoreFocusTo }: {
  title: string; description?: string; icon?: ReactNode; children: ReactNode;
  /** Optional feedback owns its animated spacing instead of a parent flex gap. */
  notice?: ReactNode;
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
    // The first frame can still have a zero-height error region. Follow only
    // that region's opening and the viewport, so scrolling isn't clamped to
    // the old scrollHeight before the error has entered the document flow.
    const alert = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[role="alert"]') ?? [])
      .find(element => !element.closest('[data-dialog-exiting="true"], [inert]'));
    const viewport = alert?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!alert || !viewport) return;
    const region = alert.closest<HTMLElement>('[data-flow-motion="true"]');
    let frame = 0, focused = false, active = true;
    const stop = () => {
      active = false; cancelAnimationFrame(frame);
      resize.disconnect(); motion.disconnect();
      viewport.removeEventListener('wheel', stop);
      viewport.removeEventListener('pointerdown', stop);
      viewport.removeEventListener('keydown', stop);
    };
    const reveal = () => {
      frame = 0;
      if (!alert.isConnected || alert.closest('[data-dialog-exiting="true"], [inert]')) { stop(); return; }
      if (!focused) { alert.tabIndex = -1; alert.focus({ preventScroll: true }); focused = true; }
      const bounds = viewport.getBoundingClientRect();
      const top = bounds.top + viewport.clientTop, bottom = top + viewport.clientHeight;
      const rect = alert.getBoundingClientRect();
      const delta = rect.top < top || rect.height > viewport.clientHeight ? rect.top - top
        : rect.bottom > bottom ? rect.bottom - bottom : 0;
      if (delta) viewport.scrollTop += delta;
      const visible = alert.getBoundingClientRect();
      if (region?.dataset.flowAnimating !== 'true' && visible.top >= top - 1
        && visible.top + Math.min(visible.height, viewport.clientHeight) <= bottom + 1) stop();
    };
    const schedule = () => { if (active && !frame) frame = requestAnimationFrame(reveal); };
    const resize = new ResizeObserver(schedule);
    const motion = new MutationObserver(schedule);
    resize.observe(viewport); resize.observe(region ?? alert);
    if (region) motion.observe(region, { attributes: true, attributeFilter: ['data-flow-animating'] });
    // Once the user navigates or scrolls, their intent wins over error reveal.
    viewport.addEventListener('wheel', stop, { passive: true });
    viewport.addEventListener('pointerdown', stop, { passive: true });
    viewport.addEventListener('keydown', stop);
    schedule();
    return stop;
  }, [error]);
  return <ScrollableDialog open animateSize onOpenChange={open => { if (!open && !pending) onClose(); }}
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
      <div ref={bodyRef} data-testid={testId} className="min-w-0" aria-busy={pending}>
        <div className="knowledge-record-body">{children}</div>
        {notice}
      </div>
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
