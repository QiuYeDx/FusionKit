import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ClipPathTabsContent } from '@/components/qiuye-ui/clip-path-tabs';

/** Keep raw input and each panel's scroll position alive while another tab is selected. */
export function EntrySettingsPanel({ value, active, children }: {
  value: string; active: boolean; children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false, gutter: 0 });
  useLayoutEffect(() => {
    const scroll = viewport.current, body = content.current;
    if (!scroll || !body) return;
    const update = () => {
      const max = scroll.scrollHeight - scroll.clientHeight;
      const next = { top: max > 1 && scroll.scrollTop > 1, bottom: max > 1 && scroll.scrollTop < max - 1,
        gutter: scroll.offsetWidth - scroll.clientWidth };
      setEdges(previous => previous.top === next.top && previous.bottom === next.bottom && previous.gutter === next.gutter ? previous : next);
    };
    update();
    scroll.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    observer.observe(body);
    return () => { scroll.removeEventListener('scroll', update); observer.disconnect(); };
  }, [active]);
  return <div inert={!active} aria-hidden={!active} data-state={active ? 'active' : 'inactive'} className="knowledge-entry-settings-panel">
    <ClipPathTabsContent ref={viewport} value={value} forceMount tabIndex={active ? 0 : -1}
      className="knowledge-entry-settings-scroll" data-testid={`knowledge-entry-${value}`}>
      <div ref={content}>{children}</div>
    </ClipPathTabsContent>
    <div aria-hidden="true" data-edge="top" data-visible={edges.top} className="knowledge-entry-settings-fade"
      style={{ '--settings-scrollbar-width': `${edges.gutter}px` } as CSSProperties} />
    <div aria-hidden="true" data-edge="bottom" data-visible={edges.bottom} className="knowledge-entry-settings-fade"
      style={{ '--settings-scrollbar-width': `${edges.gutter}px` } as CSSProperties} />
  </div>;
}
