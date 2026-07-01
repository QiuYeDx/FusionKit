import { cn } from "@/lib/utils";

type ToolConfigDividerProps = {
  className?: string;
};

export function ToolConfigDivider({ className }: ToolConfigDividerProps) {
  return <div className={cn("h-px bg-border -mx-4", className)} />;
}

export default ToolConfigDivider;
