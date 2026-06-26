import * as React from "react";
import { cn } from "@/lib/utils";

type ToolDetailLayoutProps = {
  /** Page header, typically a <ToolPageHeader />. */
  header: React.ReactNode;
  /** Left configuration column. */
  aside: React.ReactNode;
  /** Main working column. */
  children: React.ReactNode;
  asideClassName?: string;
  mainClassName?: string;
  className?: string;
};

/**
 * Shared scaffold for tool detail pages: a centered, padded container with a
 * header and a fixed-width configuration aside next to a fluid main column.
 *
 * Keeping this in one place guarantees every tool detail page shares the same
 * rhythm (max width, padding, column widths, gaps).
 */
export function ToolDetailLayout({
  header,
  aside,
  children,
  asideClassName,
  mainClassName,
  className,
}: ToolDetailLayoutProps) {
  return (
    <div
      className={cn(
        "mx-auto max-w-7xl px-4 pb-[100px] pt-6 sm:px-8",
        className,
      )}
    >
      {header}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside
          className={cn("min-w-0 lg:sticky lg:top-10", asideClassName)}
        >
          {aside}
        </aside>
        <main className={cn("flex min-w-0 flex-col gap-3", mainClassName)}>
          {children}
        </main>
      </div>
    </div>
  );
}

export default ToolDetailLayout;
