"use client";

import React from "react";
import { cn } from "@/lib/utils";

/** MarkdownTableContainer 组件的属性 */
interface MarkdownTableContainerProps {
  /** 表格内容 */
  children: React.ReactNode;
  /** 根容器额外类名 */
  className?: string;
}

/**
 * MarkdownTableContainer — Markdown 表格横向滚动容器
 *
 * 在窄屏或列数较多时，将横向溢出限制在表格内部滚动，
 * 并根据滚动位置显示左右渐变遮罩，避免内容被硬裁切。
 */
export function MarkdownTableContainer({
  children,
  className,
}: MarkdownTableContainerProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [showLeftFade, setShowLeftFade] = React.useState(false);
  const [showRightFade, setShowRightFade] = React.useState(false);

  const checkScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const maxScrollLeft = el.scrollWidth - el.clientWidth;
    setShowLeftFade(el.scrollLeft > 1);
    setShowRightFade(maxScrollLeft > 1 && el.scrollLeft < maxScrollLeft - 1);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => checkScroll();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => checkScroll());
    ro.observe(el);
    if (el.firstElementChild) {
      ro.observe(el.firstElementChild);
    }

    checkScroll();

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  return (
    <div
      data-qv-markdown-table-container=""
      className={cn(
        "relative w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
    >
      <div
        ref={scrollRef}
        data-qv-markdown-table-scroll=""
        className="w-full min-w-0 overflow-x-auto overscroll-x-contain [scrollbar-width:thin]"
      >
        {children}
      </div>

      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-background via-background/85 to-transparent opacity-0 transition-opacity duration-200",
          showLeftFade && "opacity-100",
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background via-background/85 to-transparent opacity-0 transition-opacity duration-200",
          showRightFade && "opacity-100",
        )}
      />
    </div>
  );
}
