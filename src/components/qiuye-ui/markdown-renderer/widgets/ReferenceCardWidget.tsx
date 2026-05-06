"use client";

import React from "react";
import { ExternalLink } from "lucide-react";
import { sanitizeUrl } from "@/lib/markdown/sanitize-url";
import { isUrlAllowed } from "@/lib/markdown/link-policy";
import type {
  MarkdownWidgetComponentProps,
  MarkdownWidgetDefinition,
} from "../markdown-types";

interface ReferenceCardProps {
  title: string;
  href: string;
  description?: string;
}

function ReferenceCardWidgetComponent({
  props,
}: MarkdownWidgetComponentProps<ReferenceCardProps>) {
  const { title, href, description } = props;

  const isExternal =
    href.startsWith("http://") || href.startsWith("https://");

  return (
    <a
      href={href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      className="group block rounded-lg border border-border/60 bg-card/50 px-4 py-3 no-underline transition-colors hover:border-primary/30 hover:bg-primary/5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate">
            {title}
          </p>
          {description && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {description}
            </p>
          )}
        </div>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 group-hover:text-primary/60 transition-colors mt-0.5" />
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground/60 font-mono truncate">
        {href}
      </p>
    </a>
  );
}

function parseReferenceCardProps(
  raw: unknown,
): { ok: true; props: ReferenceCardProps } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "props must be an object" };
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string" || typeof value.href !== "string") {
    return { ok: false, reason: "title and href are required" };
  }

  const href = sanitizeUrl(value.href);
  if (!isUrlAllowed(href, "untrusted")) {
    return { ok: false, reason: "href is not allowed" };
  }

  return {
    ok: true,
    props: {
      title: value.title,
      href,
      description:
        typeof value.description === "string" ? value.description : undefined,
    },
  };
}

export const referenceCardWidget: MarkdownWidgetDefinition<ReferenceCardProps> =
  {
    type: "reference-card",
    displayName: "Reference Card",
    version: 1,
    component: ReferenceCardWidgetComponent,
    parseProps: parseReferenceCardProps,
    permissions: ["external-link"],
  };
