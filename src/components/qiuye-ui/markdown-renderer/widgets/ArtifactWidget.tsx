"use client";

import React from "react";
import { FileText, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  MarkdownWidgetComponentProps,
  MarkdownWidgetDefinition,
} from "../markdown-types";

interface ArtifactProps {
  title: string;
  type?: "file" | "code" | "document";
  language?: string;
  content?: string;
  downloadUrl?: string;
  openUrl?: string;
}

function ArtifactWidgetComponent({
  id,
  props,
  context,
}: MarkdownWidgetComponentProps<ArtifactProps>) {
  const { title, type = "file", language, content, downloadUrl, openUrl } =
    props;

  const handleAction = (action: string) => {
    context.onWidgetAction?.({
      widgetId: id,
      type: "artifact",
      action,
      payload: { title, downloadUrl, openUrl },
    });
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground truncate">
          {title}
        </span>
        {language && (
          <span className="ml-auto rounded bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground uppercase">
            {language}
          </span>
        )}
        {type !== "file" && !language && (
          <span className="ml-auto rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {type}
          </span>
        )}
      </div>

      {content && (
        <div className="px-3 py-2">
          <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto max-h-32">
            {content.length > 300 ? `${content.slice(0, 300)}…` : content}
          </pre>
        </div>
      )}

      {(downloadUrl || openUrl) && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border/40">
          {downloadUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleAction("download")}
            >
              <Download className="h-3.5 w-3.5" />
              下载
            </Button>
          )}
          {openUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleAction("open")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              打开
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function parseArtifactProps(
  raw: unknown,
): { ok: true; props: ArtifactProps } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "props must be an object" };
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string") {
    return { ok: false, reason: "title is required and must be a string" };
  }

  return {
    ok: true,
    props: {
      title: value.title,
      type: (["file", "code", "document"] as const).includes(
        value.type as "file" | "code" | "document",
      )
        ? (value.type as ArtifactProps["type"])
        : "file",
      language:
        typeof value.language === "string" ? value.language : undefined,
      content: typeof value.content === "string" ? value.content : undefined,
      downloadUrl:
        typeof value.downloadUrl === "string" ? value.downloadUrl : undefined,
      openUrl: typeof value.openUrl === "string" ? value.openUrl : undefined,
    },
  };
}

export const artifactWidget: MarkdownWidgetDefinition<ArtifactProps> = {
  type: "artifact",
  displayName: "Artifact",
  version: 1,
  component: ArtifactWidgetComponent,
  parseProps: parseArtifactProps,
  permissions: ["client-action", "external-link"],
};
