import type { ReactNode } from 'react';
import { ClipPathTabsContent } from '@/components/qiuye-ui/clip-path-tabs';

/** Keep raw input and each panel's scroll position alive while another tab is selected. */
export function EntrySettingsPanel({ value, active, children }: {
  value: string; active: boolean; children: ReactNode;
}) {
  return <ClipPathTabsContent value={value} forceMount inert={!active} aria-hidden={!active}
    tabIndex={active ? 0 : -1} className="knowledge-entry-settings-panel"
    data-testid={`knowledge-entry-${value}`}>
    {children}
  </ClipPathTabsContent>;
}
