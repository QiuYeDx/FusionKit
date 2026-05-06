"use client";

import React from "react";
import { Terminal, CheckCircle, Loader2, XCircle } from "lucide-react";
import type {
  MarkdownWidgetComponentProps,
  MarkdownWidgetDefinition,
} from "../markdown-types";

interface ToolCallProps {
  name: string;
  status?: "pending" | "running" | "success" | "error";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

function ToolCallWidgetComponent({
  props,
}: MarkdownWidgetComponentProps<ToolCallProps>) {
  const { name, status = "success", input, output, error } = props;

  const statusConfig = {
    pending: {
      icon: <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />,
      label: "等待中",
      borderColor: "border-border/60",
    },
    running: {
      icon: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
      label: "执行中",
      borderColor: "border-blue-500/30",
    },
    success: {
      icon: <CheckCircle className="h-4 w-4 text-green-500" />,
      label: "完成",
      borderColor: "border-green-500/30",
    },
    error: {
      icon: <XCircle className="h-4 w-4 text-destructive" />,
      label: "失败",
      borderColor: "border-destructive/30",
    },
  };

  const config = statusConfig[status] || statusConfig.success;

  return (
    <div
      className={`rounded-lg border ${config.borderColor} bg-card/50 overflow-hidden`}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground font-mono">
          {name}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {config.icon}
          <span className="text-xs text-muted-foreground">{config.label}</span>
        </div>
      </div>

      {(input || output || error) && (
        <div className="px-3 py-2 space-y-1.5 text-xs">
          {input && Object.keys(input).length > 0 && (
            <div>
              <span className="text-muted-foreground/70">输入: </span>
              <code className="text-foreground/80 font-mono">
                {JSON.stringify(input, null, 0)}
              </code>
            </div>
          )}
          {output && Object.keys(output).length > 0 && (
            <div>
              <span className="text-muted-foreground/70">输出: </span>
              <code className="text-foreground/80 font-mono">
                {JSON.stringify(output, null, 0)}
              </code>
            </div>
          )}
          {error && (
            <div className="text-destructive">
              <span className="text-destructive/70">错误: </span>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseToolCallProps(
  raw: unknown,
): { ok: true; props: ToolCallProps } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "props must be an object" };
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string") {
    return { ok: false, reason: "name is required and must be a string" };
  }

  return {
    ok: true,
    props: {
      name: value.name,
      status: (["pending", "running", "success", "error"] as const).includes(
        value.status as "pending" | "running" | "success" | "error",
      )
        ? (value.status as ToolCallProps["status"])
        : "success",
      input:
        value.input && typeof value.input === "object"
          ? (value.input as Record<string, unknown>)
          : undefined,
      output:
        value.output && typeof value.output === "object"
          ? (value.output as Record<string, unknown>)
          : undefined,
      error: typeof value.error === "string" ? value.error : undefined,
    },
  };
}

export const toolCallWidget: MarkdownWidgetDefinition<ToolCallProps> = {
  type: "tool-call",
  displayName: "Tool Call",
  version: 1,
  component: ToolCallWidgetComponent,
  parseProps: parseToolCallProps,
  permissions: ["client-action"],
};
