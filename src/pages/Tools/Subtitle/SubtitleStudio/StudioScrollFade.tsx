import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './StudioScrollFade.css';

/** The overlays belong to the viewport, never to its scrolling content. */
export function StudioScrollFade({ children, className = '', viewportClassName = '', contentClassName = '', maxHeight = 250 }: {
  children: ReactNode; className?: string; viewportClassName?: string; contentClassName?: string; maxHeight?: CSSProperties['maxHeight'];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    const viewport = viewportRef.current; const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => {
      const maximum = viewport.scrollHeight - viewport.clientHeight;
      const top = maximum > 1 && viewport.scrollTop > 1;
      const bottom = maximum > 1 && viewport.scrollTop < maximum - 1;
      setEdges(previous => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(content);
    viewport.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', measure); };
  }, []);
  return <div className={`studio-scroll-fade ${className}`} data-fade-top={edges.top} data-fade-bottom={edges.bottom}>
    <div ref={viewportRef} className={`studio-scroll-fade-viewport ${viewportClassName}`} style={{ maxHeight }}>
      <div ref={contentRef} className={`studio-scroll-fade-content ${contentClassName}`}>{children}</div>
    </div>
    <div className="studio-scroll-fade-edge" data-edge="top" aria-hidden="true" />
    <div className="studio-scroll-fade-edge" data-edge="bottom" aria-hidden="true" />
  </div>;
}
