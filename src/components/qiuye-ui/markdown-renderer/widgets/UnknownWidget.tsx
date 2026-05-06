"use client";

import { AlertCircle } from "lucide-react";

interface UnknownWidgetProps {
  type: string;
  id: string;
  raw: string;
  reason?: string;
}

export function UnknownWidget({ type, reason }: UnknownWidgetProps) {
  return (
    <div className="my-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <p className="text-sm">
          未知组件{" "}
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-xs font-mono">
            {type}
          </code>
        </p>
      </div>
      {reason && (
        <p className="mt-1 text-xs text-muted-foreground/70">{reason}</p>
      )}
    </div>
  );
}
