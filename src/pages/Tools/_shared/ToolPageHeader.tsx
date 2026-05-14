import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ToolMeta } from "./toolMeta";
import ToolBadge from "./ToolBadge";
import { toneCss } from "./toolMeta";

type Props = {
  meta: ToolMeta;
  title: string;
  description?: React.ReactNode;
  /** Localized category label, e.g. "字幕工具箱" */
  categoryLabel: string;
  /** Optional right-side slot (e.g. model tag, settings button) */
  right?: React.ReactNode;
};

export default function ToolPageHeader({
  meta,
  title,
  description,
  categoryLabel,
  right,
}: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const tone = toneCss(meta);

  return (
    <div className="mb-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => navigate("/tools")}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {t("tools:title", "工具")}
        </Button>
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        <span className="text-muted-foreground">{categoryLabel}</span>
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        <span className="text-foreground">{title}</span>
      </div>

      {/* Title row */}
      <div className="flex items-start gap-3">
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
    </div>
  );
}
