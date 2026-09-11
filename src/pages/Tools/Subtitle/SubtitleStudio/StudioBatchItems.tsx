import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './StudioBatch.css';

/** Keep scroll fades fixed to the viewport, including when result rows resize. */
export function StudioBatchItems({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const measure = () => {
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      const top = maxScroll > 1 && viewport.scrollTop > 1;
      const bottom = maxScroll > 1 && viewport.scrollTop < maxScroll - 1;
      setEdges(previous => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(list);
    viewport.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', measure);
    };
  }, []);

  return <div className="studio-batch-scroll" data-fade-top={edges.top} data-fade-bottom={edges.bottom}>
    <div ref={viewportRef} className="studio-batch-viewport">
      <ul ref={listRef} className="studio-batch-items">{children}</ul>
    </div>
    <div className="studio-batch-fade" data-edge="top" aria-hidden="true" />
    <div className="studio-batch-fade" data-edge="bottom" aria-hidden="true" />
  </div>;
}
