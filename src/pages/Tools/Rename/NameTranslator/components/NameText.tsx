import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Middle-ellipsis name. Only the start shrinks (ellipsis at its end); the
 * tail is clipped from its left side only when it alone exceeds the width, so
 * the end of the name and the extension always stay visible. The full value is
 * available through the tooltip and to assistive technology.
 */
export function NameText({
  name,
  tooltip,
  className,
}: {
  name: string;
  tooltip?: string;
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
        className="w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal break-normal text-wrap [overflow-wrap:anywhere]"
      >
        {tooltip ?? name}
      </TooltipContent>
    </Tooltip>
  );
}
