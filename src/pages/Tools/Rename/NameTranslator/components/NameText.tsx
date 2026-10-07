import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Middle-ellipsis name: the start shrinks first so the tail and extension stay
 * visible. The full value is available through the tooltip and to assistive
 * technology.
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
        <span className={cn("flex min-w-0 max-w-full whitespace-nowrap", className)}>
          <span className="sr-only">{name}</span>
          <span aria-hidden="true" className="min-w-0 overflow-hidden text-ellipsis">
            {characters.slice(0, -tailLength).join("")}
          </span>
          <span aria-hidden="true" className="max-w-[50%] shrink-0 overflow-hidden">
            {characters.slice(-tailLength).join("")}
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
