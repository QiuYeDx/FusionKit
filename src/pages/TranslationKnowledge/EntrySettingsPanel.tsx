import type { ReactNode } from 'react';
import { ClipPathTabsContent } from '@/components/qiuye-ui/clip-path-tabs';

/** Preserve unfinished inputs while the dialog owns all content scrolling. */
export function EntrySettingsPanel({ value, active, children }: {
  value: string; active: boolean; children: ReactNode;
}) {
  return <ClipPathTabsContent value={value} forceMount hidden={!active} inert={!active}
    aria-hidden={!active} tabIndex={active ? 0 : -1}
    className="knowledge-entry-settings-panel" data-testid={`knowledge-entry-${value}`}>
    {children}
  </ClipPathTabsContent>;
}
