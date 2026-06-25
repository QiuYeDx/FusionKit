import * as React from "react";
import { cn } from "@/lib/utils";

type ToolDetailLayoutProps = {
  /** Page header, typically a <ToolPageHeader />. */
  header: React.ReactNode;
  /** Left configuration column. */
  aside: React.ReactNode;
  /** Main working column. */
  children: React.ReactNode;
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
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-5">
        <div className="min-w-0">{aside}</div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

export default ToolDetailLayout;
