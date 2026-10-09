import type { ComponentProps } from "react";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { cn } from "@/lib/utils";

/**
 * The one card surface of the conversation: tool activity, plans, prepared actions
 * and their history share its radius, border and background so they line up.
 */
export default function AgentCard({ className, ...props }: ComponentProps<typeof SmoothCorners>) {
  return <SmoothCorners radius={14} smoothing={0.72} className={cn("min-w-0 overflow-hidden border bg-card text-card-foreground", className)} {...props} />;
}
