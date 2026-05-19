import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  icon: LucideIcon;
  /** CSS color string, e.g. var(--tool-translator) */
  tone: string;
  size?: number;
  className?: string;
};

export default function ToolBadge({ icon: Icon, tone, size = 36, className }: Props) {
  const iconSize = Math.round(size * 0.46);
  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[10px] border",
        className
      )}
      style={{
        width: size,
        height: size,
        background: `color-mix(in oklch, ${tone} 14%, transparent)`,
        borderColor: `color-mix(in oklch, ${tone} 32%, transparent)`,
        color: tone,
      }}
    >
      <Icon style={{ width: iconSize, height: iconSize }} />
    </div>
  );
}
