import React from "react";
import type { ToolMeta } from "./toolMeta";
import ToolBadge from "./ToolBadge";
import { toneCss } from "./toolMeta";

type Props = {
  meta: ToolMeta;
  title: string;
  description?: React.ReactNode;
  /** Optional right-side slot (e.g. model tag, settings button) */
  right?: React.ReactNode;
};

export default function ToolPageHeader({
  meta,
  title,
  description,
  right,
}: Props) {
  const tone = toneCss(meta);

  return (
    <div className="mb-5 flex items-start gap-3">
      <ToolBadge icon={meta.icon} tone={tone} size={44} />
      <div className="flex-1 min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight leading-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        ) : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}
