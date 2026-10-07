import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Middle-ellipsis name. Only the start shrinks (ellipsis at its end); the
 * tail is clipped from its left side only when it alone exceeds the width, so
 * the end of the name and the extension always stay visible. The tooltip shows
 * the full name, with an optional small detail line such as the containing
 * folder; assistive technology reads the full name.
 */
export function NameText({
  name,
  detail,
  className,
}: {
  name: string;
  /** Secondary line under the name in the tooltip (e.g. the folder path). */
  detail?: string;
  className?: string;
}) {
  const characters = Array.from(name);
  const tailLength = Math.min(12, Math.ceil(characters.length / 2));
  return (
    <Tooltip delayDuration={450}>
      <TooltipTrigger asChild>
        <span className={cn("flex min-w-0 max-w-full overflow-hidden whitespace-nowrap", className)}>
          <span className="sr-only">{name}</span>
          <span aria-hidden="true" className="min-w-0 overflow-hidden text-ellipsis">
            {characters.slice(0, -tailLength).join("")}
          </span>
          {/* The tail never shrinks while the start has room; it is only capped at
              the full width. rtl moves its overflow edge to the left so the end
              of the name stays visible; bdi keeps the reading order. */}
          <span aria-hidden="true" dir="rtl" className="max-w-full shrink-0 overflow-hidden text-ellipsis">
            <bdi dir="ltr">{characters.slice(-tailLength).join("")}</bdi>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        sideOffset={6}
        data-testid="name-tooltip"
        className="w-max max-w-[min(24rem,calc(100vw-2rem))] whitespace-normal px-2.5 py-1.5 text-left [overflow-wrap:anywhere] [text-wrap:wrap]"
      >
        <div className="text-[12.5px] font-medium leading-[18px]">{name}</div>
        {detail ? (
          <div className="mt-0.5 text-[10.5px] leading-[14px] text-background/60">{detail}</div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
