import { useReducedMotionPreference } from '@/hooks/use-reduced-motion';
import { Children, forwardRef, useEffect, useLayoutEffect, useRef, useState, type Key, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { cn } from '@/lib/utils';

export const dialogSizeTransition = { type: 'spring', duration: 0.3, bounce: 0 } as const;
export const dialogContentTransition = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const;

/** Only moving regions that still contribute to the live document flow. */
export function hasMovingFlow(element: Element) {
  return Array.from(element.querySelectorAll('[data-flow-animating="true"]'))
    .some(region => !region.closest('[data-dialog-exiting="true"]') && region.getClientRects().length > 0);
}

/** Observe the natural inner box, never the height being animated. */
export function useNaturalHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ height: number; following: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      // Retained tab panels use display:none. Their missing layout box is not
      // an empty content tree: preserve the last natural size (or initial auto)
      // so showing the tab doesn't manufacture nested 0 -> content animations.
      if (!element.getClientRects().length) return;
      setSize(previous => {
        const height = element.getBoundingClientRect().height;
        const following = hasMovingFlow(element);
        return previous !== null && Math.abs(previous.height - height) < 0.1 && previous.following === following ? previous : { height, following };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, height: size?.height ?? null, following: size?.following ?? false };
}

/** Animate the actual flow footprint. Siblings move through normal layout, without text scaling. */
export function DialogMotionRegion({ children, className, innerClassName, open = true, fade = false, enterFromZero = false, transitionKey, onHeightComplete }: {
  children: ReactNode; className?: string; innerClassName?: string; open?: boolean; fade?: boolean;
  enterFromZero?: boolean; onHeightComplete?: () => void;
  /** A retained tab/step change owns its size transition, even if children reflow. */
  transitionKey?: Key;
}) {
  const { ref, height, following } = useNaturalHeight();
  const outer = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotionPreference();
  const [visibility, setVisibility] = useState({ open, transitionKey, moving: false });
  if (visibility.open !== open || visibility.transitionKey !== transitionKey) setVisibility({ open, transitionKey, moving: true });
  // A parent's own open/close (including reversal) owns its interpolation even
  // while a nested disclosure is moving. Retained tabs also own reflow at a new
  // width when revealed. Only steady, open parents follow their descendants.
  const follow = open && following && !visibility.moving;
  const target = open ? height ?? (enterFromZero ? 0 : 'auto') : 0;
  const latestTarget = useRef(target); latestTarget.current = target;
  // Mark before ResizeObserver runs. Ancestors follow this already interpolated
  // geometry directly; restarting a spring for every measured frame adds lag.
  useLayoutEffect(() => {
    const element = outer.current;
    if (!element) return;
    if (!reduce && !follow && typeof target === 'number' && Math.abs(element.getBoundingClientRect().height - target) > 0.1) element.dataset.flowAnimating = 'true';
    else delete element.dataset.flowAnimating;
  }, [target, reduce, follow]);
  return <motion.div ref={outer} data-flow-motion="true"
    initial={enterFromZero ? { height: 0 } : false} animate={{ height: target }}
    onAnimationComplete={() => {
      // A panel can become display:none while its child finishes. Its hidden
      // zero rect must not leave a stale "moving" marker for the next visit.
      if (outer.current?.getClientRects().length && typeof latestTarget.current === 'number' && Math.abs(outer.current.getBoundingClientRect().height - latestTarget.current) > 0.5) return;
      if (outer.current) delete outer.current.dataset.flowAnimating;
      setVisibility(previous => previous.moving ? { ...previous, moving: false } : previous);
      onHeightComplete?.();
    }}
    transition={reduce || follow ? { duration: 0 } : dialogSizeTransition} className={cn('min-w-0 overflow-hidden', className)}>
    <motion.div ref={ref} data-flow-motion-inner="true" className={cn('flow-root min-w-0', innerClassName)}
      style={{ visibility: fade && !open && !visibility.moving ? 'hidden' : undefined }}
      initial={false} animate={{ opacity: fade && !open ? 0 : 1 }}
      transition={reduce ? { duration: 0 } : { ...dialogContentTransition, duration: open ? 0.18 : 0.16 }}>{children}</motion.div>
  </motion.div>;
}

const TransitionStage = forwardRef<HTMLDivElement, { children: ReactNode; className?: string }>(function TransitionStage({ children, className }, ref) {
  const present = useIsPresent();
  const reduce = useReducedMotionPreference();
  return <motion.div ref={ref} className={cn('dialog-motion-stage min-w-0', className)}
    data-dialog-exiting={present ? undefined : 'true'} inert={!present} aria-hidden={present ? undefined : true}
    initial={{ opacity: 0, y: reduce ? 0 : 4 }} animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: reduce ? 0 : -3, transition: { ...dialogContentTransition, duration: reduce ? 0 : 0.16 } }}
    transition={reduce ? { duration: 0 } : dialogContentTransition}>
    {children}
  </motion.div>;
});

/** Key only semantic stages; keep live form subtrees mounted across edits. */
export function DialogTransition({ transitionKey, children, className, stageClassName, animateHeight = true }: {
  transitionKey: Key; children: ReactNode; className?: string; stageClassName?: string; animateHeight?: boolean;
}) {
  const hasContent = Children.toArray(children).some(child => child !== '');
  const currentContent = useRef(hasContent); currentContent.current = hasContent;
  const [retained, setRetained] = useState(hasContent);
  const [heightDone, setHeightDone] = useState(false);
  const [exitDone, setExitDone] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  useEffect(() => {
    if (hasContent) { setRetained(true); setHeightDone(false); setExitDone(false); }
    else if (exitDone && (heightDone || !animateHeight)) setRetained(false);
  }, [hasContent, exitDone, heightDone, animateHeight]);
  // Remove empty wrappers after exit so gap/space-y/:last-child keep their meaning.
  // A later reappearance animates in; the initial dialog render does not cascade.
  if (!hasContent && !retained) return null;
  const content = <AnimatePresence initial={mounted.current} mode="popLayout" onExitComplete={() => { if (!currentContent.current) setExitDone(true); }}>
      {hasContent && <TransitionStage key={transitionKey} className={stageClassName}>{children}</TransitionStage>}
    </AnimatePresence>;
  return animateHeight ? <DialogMotionRegion className={cn('relative', className)} innerClassName="relative"
    open={hasContent} enterFromZero={mounted.current && !retained}
    onHeightComplete={() => { if (!currentContent.current) setHeightDone(true); }}>{content}</DialogMotionRegion>
    : <div className={cn('relative min-w-0', className)}>{content}</div>;
}
