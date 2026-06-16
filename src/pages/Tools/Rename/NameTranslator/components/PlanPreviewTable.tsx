import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  File,
  Folder,
  FolderOpen,
  Pencil,
  RotateCcw,
  RotateCw,
  SkipForward,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  NameTranslationPlan,
  NameTranslationPlanItem,
} from "@/services/rename/nameTypes";

interface PlanPreviewTableProps {
  plan: NameTranslationPlan | null;
  isPlanning: boolean;
  originalSuggestions: Record<
    string,
    Pick<NameTranslationPlanItem, "newName" | "translatedStem" | "targetPath">
  >;
  onEditItem: (
    itemId: string,
    patch: Partial<NameTranslationPlanItem>
  ) => void;
  onRevalidate: () => Promise<void>;
  onUseAutoIndex: () => void;
}

const PAGE_SIZE = 50;
const LONG_TEXT_TOOLTIP_CLASS =
  "max-w-[min(560px,calc(100vw-2rem))] whitespace-normal text-left text-wrap break-words leading-relaxed [overflow-wrap:anywhere] [word-break:normal]";
const PATH_TOOLTIP_CLASS = cn(
  LONG_TEXT_TOOLTIP_CLASS,
  "font-mono text-[11px]"
);

export default function PlanPreviewTable({
  plan,
  isPlanning,
  originalSuggestions,
  onEditItem,
  onRevalidate,
  onUseAutoIndex,
}: PlanPreviewTableProps) {
  const { t } = useTranslation("rename");
  const [page, setPage] = useState(0);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});

  useEffect(() => {
    setPage(0);
    setDraftNames({});
  }, [plan?.planId]);

  const pageCount = plan ? Math.max(1, Math.ceil(plan.items.length / PAGE_SIZE)) : 1;
  const pageItems = useMemo(() => {
    if (!plan) return [];
    const start = page * PAGE_SIZE;
    return plan.items.slice(start, start + PAGE_SIZE);
  }, [page, plan]);

  const commitDraft = (item: NameTranslationPlanItem) => {
    const nextName = (draftNames[item.id] ?? item.newName).trim();
    if (!nextName || nextName === item.newName) return;
    onEditItem(item.id, {
      newName: nextName,
      status: "ready",
      reason: undefined,
    });
  };

  if (!plan) {
    return (
      <Card className="overflow-hidden p-0 gap-0">
        <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3 space-y-0 border-b">
          <CardTitle className="text-[13.5px] font-semibold">
            {t("preview.title")}
          </CardTitle>
          <Badge variant="secondary" className="font-mono text-[11px]">
            dry-run
          </Badge>
        </CardHeader>
        <div className="px-4 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
            <Pencil className="h-5 w-5" />
          </div>
          <div className="mt-3 text-sm font-medium">
            {t("preview.empty_title")}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("preview.empty_desc")}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden p-0 gap-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3 space-y-0 border-b">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="text-[13.5px] font-semibold">
            {t("preview.title")}
          </CardTitle>
          <Badge variant="secondary" className="font-mono text-[11px]">
            {plan.items.length} / {plan.totalTargets}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPlanning}
            onClick={onRevalidate}
          >
            <RotateCw className={cn("h-3.5 w-3.5", isPlanning && "animate-spin")} />
            {t("preview.revalidate")}
          </Button>
        </div>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <SummaryBadge
          label={t("preview.summary.ready")}
          value={plan.readyCount}
          tone="ready"
        />
        <SummaryBadge
          label={t("preview.summary.blocked")}
          value={plan.blockedCount}
          tone="blocked"
        />
        <SummaryBadge
          label={t("preview.summary.skipped")}
          value={plan.skippedCount}
          tone="muted"
        />
        <SummaryBadge
          label={t("preview.summary.unchanged")}
          value={plan.unchangedCount}
          tone="muted"
        />
        {plan.warnings.length > 0 ? (
          <SummaryBadge
            label={t("preview.summary.warnings")}
            value={plan.warnings.length}
            tone="warning"
          />
        ) : null}
      </div>

      {plan.clarificationRequired ? (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("preview.clarification_title")}</AlertTitle>
            <AlertDescription>
              <p>{plan.clarificationRequired.message}</p>
              {plan.clarificationRequired.choices?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {plan.clarificationRequired.choices.map((choice) => (
                    <Badge key={choice} variant="outline">
                      {choice}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <ScrollArea className="w-full">
        <table className="w-full caption-bottom text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[94px]">
                {t("preview.columns.status")}
              </TableHead>
              <TableHead className="w-[74px]">
                {t("preview.columns.type")}
              </TableHead>
              <TableHead className="min-w-[160px]">
                {t("preview.columns.original_name")}
              </TableHead>
              <TableHead className="min-w-[190px]">
                {t("preview.columns.new_name")}
              </TableHead>
              <TableHead className="min-w-[220px]">
                {t("preview.columns.source_path")}
              </TableHead>
              <TableHead className="min-w-[220px]">
                {t("preview.columns.target_path")}
              </TableHead>
              <TableHead className="min-w-[150px]">
                {t("preview.columns.reason")}
              </TableHead>
              <TableHead className="w-[128px] text-right">
                {t("preview.columns.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.map((item) => {
              const draft = draftNames[item.id] ?? item.newName;
              const suggestion = originalSuggestions[item.id];
              return (
                <TableRow
                  key={item.id}
                  className={cn(
                    item.status === "blocked" && "bg-destructive/5",
                    ["skipped", "unchanged"].includes(item.status) && "opacity-70"
                  )}
                >
                  <TableCell>
                    <StatusBadge status={item.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-xs">
                      {item.kind === "directory" ? (
                        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <File className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {t(`preview.kind.${item.kind}`)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block max-w-[220px] truncate text-xs font-medium">
                          {item.originalName}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className={LONG_TEXT_TOOLTIP_CLASS}
                      >
                        {item.originalName}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Input
                          value={draft}
                          disabled={item.status === "applied"}
                          className="h-8 min-w-[180px] font-mono text-xs"
                          onChange={(event) =>
                            setDraftNames((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          onBlur={() => commitDraft(item)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className={LONG_TEXT_TOOLTIP_CLASS}
                      >
                        {draft}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block max-w-[320px] truncate font-mono text-[11px] text-muted-foreground">
                          {item.sourcePath}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className={PATH_TOOLTIP_CLASS}>
                        {item.sourcePath}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block max-w-[320px] truncate font-mono text-[11px] text-muted-foreground">
                          {item.targetPath}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className={PATH_TOOLTIP_CLASS}>
                        {item.targetPath}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <ReasonCell item={item} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <IconAction
                        label={t("preview.actions.skip")}
                        disabled={item.status === "skipped" || item.status === "applied"}
                        onClick={() =>
                          onEditItem(item.id, {
                            status: "skipped",
                            reason: "manual_skip",
                          })
                        }
                      >
                        <SkipForward className="h-3.5 w-3.5" />
                      </IconAction>
                      <IconAction
                        label={t("preview.actions.restore")}
                        disabled={!suggestion || item.status === "applied"}
                        onClick={() =>
                          suggestion &&
                          onEditItem(item.id, {
                            ...suggestion,
                            status: "ready",
                            reason: undefined,
                          })
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </IconAction>
                      <IconAction
                        label={t("preview.actions.auto_index")}
                        disabled={item.status !== "blocked"}
                        onClick={onUseAutoIndex}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </IconAction>
                      <IconAction
                        label={t("preview.actions.open_folder")}
                        onClick={() =>
                          window.ipcRenderer.invoke("show-item-in-folder", item.sourcePath)
                        }
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </IconAction>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </table>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
        <div className="text-[11px] text-muted-foreground">
          {t("preview.pagination_hint", { count: PAGE_SIZE })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            {t("preview.previous")}
          </Button>
          <span className="font-mono text-[11px] text-muted-foreground">
            {page + 1} / {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= pageCount - 1}
            onClick={() =>
              setPage((current) => Math.min(pageCount - 1, current + 1))
            }
          >
            {t("preview.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SummaryBadge({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ready" | "blocked" | "warning" | "muted";
}) {
  return (
    <Badge
      variant={tone === "blocked" ? "destructive" : tone === "muted" ? "outline" : "secondary"}
      className={cn(
        "gap-1 font-mono text-[11px]",
        tone === "ready" && "text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "text-amber-700 dark:text-amber-300"
      )}
    >
      {label}
      <span>{value}</span>
    </Badge>
  );
}

function StatusBadge({
  status,
}: {
  status: NameTranslationPlanItem["status"];
}) {
  const { t } = useTranslation("rename");
  const className =
    status === "ready"
      ? "text-emerald-700 dark:text-emerald-300"
      : status === "blocked" || status === "failed"
        ? ""
        : "text-muted-foreground";

  return (
    <Badge
      variant={
        status === "blocked" || status === "failed"
          ? "destructive"
          : status === "ready" || status === "applied"
            ? "secondary"
            : "outline"
      }
      className={cn("font-mono text-[10.5px]", className)}
    >
      {t(`preview.status.${status}`)}
    </Badge>
  );
}

function ReasonCell({ item }: { item: NameTranslationPlanItem }) {
  const warnings = item.warnings.slice(0, 2);
  if (!item.reason && warnings.length === 0) {
    return <span className="text-[11px] text-muted-foreground">-</span>;
  }

  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {item.reason ? (
        <Badge variant="outline" className="max-w-full truncate text-[10.5px]">
          {item.reason}
        </Badge>
      ) : null}
      {warnings.map((warning) => (
        <Badge
          key={warning}
          variant="outline"
          className="max-w-full truncate text-[10.5px]"
        >
          {warning}
        </Badge>
      ))}
      {item.warnings.length > warnings.length ? (
        <span className="text-[11px] text-muted-foreground">
          +{item.warnings.length - warnings.length}
        </span>
      ) : null}
    </div>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
