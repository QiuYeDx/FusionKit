import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import ToolBadge from "./_shared/ToolBadge";
import { TOOL_META, type ToolKey, toneCss } from "./_shared/toolMeta";

type CardItem = {
  id: ToolKey;
  titleKey: string;
  descKey: string;
  /** Localized short feature chips */
  chips?: string[];
};

type Category = {
  key: "subtitle" | "music" | "rename";
  titleKey: string;
  hintKey: string;
  items: CardItem[];
};

const CATEGORIES: Category[] = [
  {
    key: "subtitle",
    titleKey: "tools:subtitle.subtitle_tools",
    hintKey: "tools:sub_desc.subtitle_tools",
    items: [
      {
        id: "translator",
        titleKey: "tools:fields.subtitle_translator",
        descKey: "tools:field_desc.subtitle_translator",
        chips: ["LRC · SRT", "DeepSeek · OpenAI"],
      },
      {
        id: "converter",
        titleKey: "tools:fields.subtitle_formatter",
        descKey: "tools:field_desc.subtitle_formatter",
        chips: ["SRT · VTT · LRC"],
      },
      {
        id: "extractor",
        titleKey: "tools:fields.subtitle_language_extractor",
        descKey: "tools:field_desc.subtitle_language_extractor",
        chips: ["LRC · SRT"],
      },
    ],
  },
  {
    key: "music",
    titleKey: "tools:subtitle.music_tools",
    hintKey: "tools:sub_desc.music_tools",
    items: [
      {
        id: "music",
        titleKey: "tools:coming_soon.title",
        descKey: "tools:coming_soon.music_desc",
      },
    ],
  },
  {
    key: "rename",
    titleKey: "tools:subtitle.rename_tools",
    hintKey: "tools:sub_desc.rename_tools",
    items: [
      {
        id: "rename",
        titleKey: "tools:coming_soon.title",
        descKey: "tools:coming_soon.rename_desc",
      },
    ],
  },
];

const Tools: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appVersion = (import.meta as any).env?.VITE_APP_VERSION || "";

  const stableCount = CATEGORIES.flatMap((c) => c.items).filter(
    (i) => TOOL_META[i.id]?.status === "stable"
  ).length;
  const totalCount = CATEGORIES.flatMap((c) => c.items).length;

  return (
    <div className="px-4 sm:px-8 pt-6 pb-[100px] max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-end justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tracking-tight">
            {t("tools:title")}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {t("tools:description")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {appVersion ? (
            <Badge variant="outline" className="font-mono text-[11px]">
              v{appVersion}
            </Badge>
          ) : null}
          <Badge
            variant="secondary"
            className="font-mono text-[11px]"
          >
            {stableCount} / {totalCount}
          </Badge>
        </div>
      </div>

      <div className="flex flex-col gap-8">
        {CATEGORIES.map((cat) => (
          <CategoryBlock
            key={cat.key}
            cat={cat}
            onOpen={(id) => {
              const route = TOOL_META[id]?.route;
              if (route) navigate(route);
            }}
          />
        ))}
      </div>
    </div>
  );
};

function CategoryBlock({
  cat,
  onOpen,
}: {
  cat: Category;
  onOpen: (id: ToolKey) => void;
}) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-4 px-0.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-foreground m-0">
          {t(cat.titleKey)}
        </h2>
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground truncate">
          {t(cat.hintKey)}
        </span>
      </div>

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {cat.items.map((it) => (
          <ToolCard key={it.id} item={it} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function ToolCard({
  item,
  onOpen,
}: {
  item: CardItem;
  onOpen: (id: ToolKey) => void;
}) {
  const { t } = useTranslation();
  const meta = TOOL_META[item.id];
  const isSoon = meta.status === "soon";
  const tone = toneCss(meta);
  const Icon = meta.icon;

  return (
    <div
      onClick={() => !isSoon && onOpen(item.id)}
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card p-4 transition-all duration-200",
        isSoon
          ? "border-dashed opacity-65 cursor-default"
          : "cursor-pointer hover:-translate-y-[1px] hover:shadow-[0_6px_20px_-8px_rgba(0,0,0,0.12)]"
      )}
      style={
        !isSoon
          ? ({
              ["--tone" as any]: tone,
            } as React.CSSProperties)
          : undefined
      }
      onMouseEnter={(e) => {
        if (isSoon) return;
        e.currentTarget.style.borderColor = `color-mix(in oklch, ${tone} 50%, var(--border))`;
      }}
      onMouseLeave={(e) => {
        if (isSoon) return;
        e.currentTarget.style.borderColor = "";
      }}
    >
      {!isSoon && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-4 right-4 h-[2px] rounded-b-full opacity-85"
          style={{ background: tone }}
        />
      )}

      <div className="flex items-start gap-3">
        <ToolBadge icon={Icon} tone={tone} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold m-0 truncate">
              {t(item.titleKey)}
            </h3>
            {isSoon && (
              <Badge
                variant="outline"
                className="text-[10px] h-4 px-1.5 font-normal"
              >
                <Clock className="h-2.5 w-2.5 mr-0.5" />
                {t("tools:coming_soon.title")}
              </Badge>
            )}
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground mt-1 line-clamp-2">
            {t(item.descKey)}
          </p>
        </div>
        {!isSoon && (
          <ArrowRight className="h-4 w-4 text-muted-foreground mt-1 shrink-0 transition-transform group-hover:translate-x-0.5" />
        )}
      </div>

      {item.chips && item.chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3.5">
          {item.chips.map((c, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-[3px] rounded-md border bg-muted/30 text-[11px] font-medium text-foreground/80"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: tone }}
              />
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default Tools;
