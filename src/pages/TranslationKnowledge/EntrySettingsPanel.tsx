import { useReducedMotionPreference } from '@/hooks/use-reduced-motion';
import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ClipPathTabsContent } from '@/components/qiuye-ui/clip-path-tabs';

/** Preserve unfinished inputs while the dialog owns all content scrolling. */
export function EntrySettingsPanel({ value, active, children }: {
  value: string; active: boolean; children: ReactNode;
}) {
  const reducedMotion = useReducedMotionPreference();
  const [settledHidden, setSettledHidden] = useState(!active);
  return <ClipPathTabsContent value={value} forceMount asChild>
    <motion.div
      inert={!active} aria-hidden={!active} tabIndex={active ? 0 : -1}
      data-dialog-exiting={!active && !settledHidden ? 'true' : undefined}
      className="knowledge-entry-settings-panel" data-testid={`knowledge-entry-${value}`}
      initial={false}
      animate={active ? 'active' : 'inactive'}
      variants={{ active: { opacity: 1, y: 0 }, inactive: { opacity: 0, y: reducedMotion ? 0 : -4 } }}
      transition={{ duration: reducedMotion ? 0 : active ? 0.18 : 0.12, ease: 'easeOut' }}
      style={{ position: active ? 'relative' : 'absolute', top: 0, left: 0, width: '100%', display: active || !settledHidden ? undefined : 'none', pointerEvents: active ? undefined : 'none' }}
      onAnimationStart={() => { if (active) setSettledHidden(false); }}
      onAnimationComplete={definition => { if (definition === (active ? 'active' : 'inactive')) setSettledHidden(!active); }}
    >{children}</motion.div>
  </ClipPathTabsContent>;
}
