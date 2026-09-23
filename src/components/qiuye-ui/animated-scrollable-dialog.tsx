import { useReducedMotionPreference } from '@/hooks/use-reduced-motion';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, usePresence } from 'motion/react';
import { Dialog, DialogCloseButton, DialogContent, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { DialogTransition, dialogSizeTransition, hasMovingFlow } from './dialog-motion';
import type { ScrollableDialogProps } from './scrollable-dialog';

const number = (value: string) => Number.parseFloat(value) || 0;
type Size = { width: number; height: number; borderWidth: number; following: boolean };

function MeasuredSurface({ children, className, contentClassName, maxWidth = 'sm:max-w-md', transitionKey = 'content', onOpenAutoFocus, onCloseAutoFocus }: ScrollableDialogProps) {
  const root = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [entered, setEntered] = useState(false);
  const [present, safeToRemove] = usePresence();
  const reduce = useReducedMotionPreference();

  const measure = useCallback(() => {
    const surface = root.current, widthProbe = probe.current;
    if (!surface || !widthProbe || !present) return;
    const style = getComputedStyle(surface);
    const borderWidth = number(style.borderLeftWidth) + number(style.borderRightWidth);
    const width = widthProbe.offsetWidth;
    const sections = Array.from(surface.querySelectorAll<HTMLElement>('[data-dialog-section]'))
      .filter(section => !section.closest('[data-dialog-exiting="true"]'));
    let height = number(style.borderTopWidth) + number(style.borderBottomWidth);
    for (const section of sections) {
      const sectionStyle = getComputedStyle(section);
      if (sectionStyle.display === 'none') continue;
      if (section.dataset.dialogSection === 'body') {
        // The viewport is constrained by the animated frame. Its natural,
        // padded content is deliberately measured instead of that viewport.
        const content = section.querySelector<HTMLElement>('[data-dialog-body-measure]');
        const viewport = section.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
        const viewportStyle = viewport && getComputedStyle(viewport);
        height += (content?.offsetHeight ?? 0)
          + number(sectionStyle.borderTopWidth) + number(sectionStyle.borderBottomWidth)
          + number(sectionStyle.paddingTop) + number(sectionStyle.paddingBottom)
          + (viewportStyle ? number(viewportStyle.borderTopWidth) + number(viewportStyle.borderBottomWidth) : 0);
      } else height += section.offsetHeight;
      height += number(sectionStyle.marginTop) + number(sectionStyle.marginBottom);
    }
    const maxHeight = Number.parseFloat(style.maxHeight);
    const target = { width, height: Math.min(height, Number.isFinite(maxHeight) ? maxHeight : innerHeight - 32), borderWidth, following: hasMovingFlow(surface) };
    setSize(previous => previous && Math.abs(previous.width - target.width) < 0.5 && Math.abs(previous.height - target.height) < 0.5 && previous.borderWidth === borderWidth && previous.following === target.following ? previous : target);
  }, [present]);

  useLayoutEffect(() => {
    const surface = root.current;
    if (!surface || !probe.current || !present) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // ResizeObserver already runs after layout. An extra rAF here would add a
    // second paint of lag when a local region is supplying animated geometry.
    const observer = new ResizeObserver(measure);
    const observeContent = () => {
      observer.disconnect();
      observer.observe(probe.current!);
      surface.querySelectorAll<HTMLElement>('[data-dialog-section="header"], [data-dialog-section="footer"], [data-dialog-body-measure]').forEach(element => {
        if (!element.closest('[data-dialog-exiting="true"]')) observer.observe(element);
      });
      schedule();
    };
    observeContent();
    const mutations = new MutationObserver(observeContent);
    mutations.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-state', 'data-dialog-exiting'] });
    window.addEventListener('resize', schedule);
    measure();
    return () => { observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); };
  }, [measure, present]);
  // Width changes reflow the natural content at its target width before the
  // next height target is read. The animated frame never becomes the ruler.
  useLayoutEffect(measure, [measure, size?.width, children, transitionKey]);

  return <>
    {createPortal(<div ref={probe} aria-hidden="true" inert data-dialog-size-probe
      className={cn('pointer-events-none invisible fixed left-0 top-0 h-0 w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:w-full', maxWidth)} />, document.body)}
    <DialogContent portal={false} forceMount asChild showCloseButton={false}
      className={cn('p-0 max-h-[85vh] w-[calc(100vw-2rem)] sm:w-full gap-0 overflow-hidden data-[state=open]:animate-none data-[state=closed]:animate-none', maxWidth, contentClassName)}
      onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
    <motion.div ref={root} data-animated-dialog="true"
      data-dialog-exiting={present ? undefined : 'true'} inert={!present} aria-hidden={present ? undefined : true}
      style={{ animation: 'none', transition: 'none', ...(size && { maxWidth: 'calc(100vw - 2rem)' }) }}
      initial={{ opacity: 0, y: reduce ? 0 : 4 }}
      animate={present ? 'open' : 'closed'}
      variants={{ open: { ...(size && { width: size.width, height: size.height }), opacity: 1, y: 0 }, closed: { ...(size && { width: size.width, height: size.height }), opacity: 0, y: reduce ? 0 : 4 } }}
      onAnimationComplete={definition => { if (!present && definition === 'closed') safeToRemove?.(); else if (present && definition === 'open') setEntered(true); }}
      transition={{ width: reduce || !entered ? { duration: 0 } : dialogSizeTransition, height: reduce || !entered || size?.following ? { duration: 0 } : dialogSizeTransition, opacity: { duration: reduce ? 0 : 0.16 }, y: { duration: reduce ? 0 : 0.16 } }}>
      <div data-dialog-measure className={cn('contents min-h-0 min-w-0', className)}
        style={{ display: 'block', height: '100%', width: size ? size.width - size.borderWidth : undefined }}>
        <DialogTransition animateHeight={false} transitionKey={transitionKey} className="h-full" stageClassName="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          {children}
        </DialogTransition>
      </div>
      <DialogCloseButton />
    </motion.div>
    </DialogContent>
  </>;
}

function AnimatedOverlay() {
  const [present, safeToRemove] = usePresence();
  const reduce = useReducedMotionPreference();
  return <DialogOverlay forceMount asChild className="data-[state=open]:animate-none data-[state=closed]:animate-none"><motion.div
    style={{ animation: 'none', transition: 'none' }}
    initial={{ opacity: 0 }} animate={present ? 'open' : 'closed'} variants={{ open: { opacity: 1 }, closed: { opacity: 0 } }}
    transition={{ duration: reduce ? 0 : 0.14 }}
    onAnimationComplete={definition => { if (!present && definition === 'closed') safeToRemove?.(); }} /></DialogOverlay>;
}

/** Opt-in measured shell: keeps a single live form and lets presence own exit. */
export function AnimatedScrollableDialog(props: ScrollableDialogProps) {
  const [parentPresent, safeToRemove] = usePresence();
  const visible = props.open && parentPresent;
  const wasVisible = useRef(visible);
  if (visible) wasVisible.current = true;
  useLayoutEffect(() => {
    if (!parentPresent && !wasVisible.current) safeToRemove?.();
  }, [parentPresent, safeToRemove]);
  return <Dialog open={visible} onOpenChange={props.onOpenChange}>
    <DialogPortal forceMount>
      <AnimatePresence onExitComplete={() => { wasVisible.current = false; if (!parentPresent) safeToRemove?.(); }}>
        {visible && <AnimatedOverlay key="overlay" />}
        {visible && <MeasuredSurface key="surface" {...props} />}
      </AnimatePresence>
    </DialogPortal>
  </Dialog>;
}
