import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  File,
  Folder,
  FolderOpen,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ToolConfigPanel } from "@/pages/Tools/_shared/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getFilePathFromFile } from "@/utils/filePath";
import type { SelectedPath } from "@/services/rename/nameTypes";

interface PathPickerPanelProps {
  selectedPaths: SelectedPath[];
  isPlanning: boolean;
  onAddPaths: (paths: string[]) => Promise<void>;
  onRemovePath: (path: string) => void;
  onCreatePreview: () => Promise<void>;
  onReset: () => void;
}

export default function PathPickerPanel({
  selectedPaths,
  isPlanning,
  onAddPaths,
  onRemovePath,
  onCreatePreview,
  onReset,
}: PathPickerPanelProps) {
  const { t } = useTranslation("rename");
  const [isDragging, setIsDragging] = useState(false);
  const selectedListRef = useRef<HTMLDivElement>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  const checkSelectedListScroll = useCallback(() => {
    const root = selectedListRef.current;
    if (!root) return;

    const { scrollTop, scrollHeight, clientHeight } = root;
    const maxScroll = scrollHeight - clientHeight;
    setShowTopFade(scrollTop > 1);
    setShowBottomFade(maxScroll > 0 && scrollTop < maxScroll - 1);
  }, []);

  useEffect(() => {
    const root = selectedListRef.current;
    if (!root) return;

    root.addEventListener("scroll", checkSelectedListScroll, {
      passive: true,
    });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(checkSelectedListScroll);
    ro?.observe(root);
    checkSelectedListScroll();

    return () => {
      root.removeEventListener("scroll", checkSelectedListScroll);
      ro?.disconnect();
    };
  }, [checkSelectedListScroll, selectedPaths.length]);

  const selectPaths = async (
    allowFiles: boolean,
    allowDirectories: boolean
  ) => {
    const result = await window.ipcRenderer.invoke("select-rename-paths", {
      title: t("path.dialog_title"),
      buttonLabel: t("path.dialog_button"),
      allowFiles,
      allowDirectories,
      multiSelections: true,
    });

    if (!result?.canceled && result.filePaths?.length) {
      await onAddPaths(result.filePaths);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const paths = Array.from(event.dataTransfer.files)
      .map(getFilePathFromFile)
      .filter((path): path is string => Boolean(path));

    if (paths.length > 0) await onAddPaths(paths);
  };

  return (
    <ToolConfigPanel
      icon={FolderOpen}
      title={t("path.section_title")}
      action={
        <Badge variant="secondary" className="font-mono text-[11px]">
          {selectedPaths.length}
        </Badge>
      }
      contentClassName="space-y-4"
    >
        <div
          className={cn(
            "relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors",
            isDragging
              ? "border-primary bg-primary/5"
              : "border-border hover:bg-muted/40"
          )}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70">
            {isDragging ? (
              <FolderOpen className="h-5 w-5" />
            ) : (
              <Upload className="h-5 w-5" />
            )}
          </div>
          <div className="space-y-0.5">
            <div className="text-sm font-semibold">{t("path.drop_title")}</div>
            <div className="text-xs text-muted-foreground">
              {t("path.drop_hint")}
            </div>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => selectPaths(true, false)}
            >
              <File className="h-3.5 w-3.5" />
              {t("path.select_files")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => selectPaths(false, true)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("path.select_dirs")}
            </Button>
          </div>
        </div>

        <div className="relative">
          {selectedPaths.length === 0 ? (
            <div className="rounded-lg border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              {t("path.empty")}
            </div>
          ) : (
            <>
              <div
                ref={selectedListRef}
                className="max-h-[min(38vh,320px)] min-h-0 w-full overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg pr-1"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  {selectedPaths.map((item) => (
                    <div
                      key={item.path}
                      className="flex w-full min-w-0 items-start gap-2 overflow-hidden rounded-lg border bg-card px-3 py-2"
                    >
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                        {item.kind === "directory" ? (
                          <Folder className="h-3.5 w-3.5" />
                        ) : (
                          <File className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                            {item.basename}
                          </span>
                          <RiskBadge riskLevel={item.riskLevel} />
                        </div>
                        <div className="w-full min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {item.path}
                        </div>
                        {item.kind === "directory" ? (
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            {t("path.counts", {
                              files: item.directFileCount ?? 0,
                              directories: item.directDirectoryCount ?? 0,
                            })}
                          </div>
                        ) : null}
                        {item.warnings.length > 0 ? (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            <span className="min-w-0 truncate">
                              {item.warnings.join("；")}
                            </span>
                          </div>
                        ) : null}
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onRemovePath(item.path)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("path.remove_tooltip")}</TooltipContent>
                      </Tooltip>
                    </div>
                  ))}
                </div>
              </div>
              {showTopFade ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 right-1 top-0 z-[5] h-8 rounded-t-lg bg-gradient-to-b from-card to-transparent"
                />
              ) : null}
              {showBottomFade ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-0 left-0 right-1 z-[5] h-8 rounded-b-lg bg-gradient-to-t from-card to-transparent"
                />
              ) : null}
            </>
          )}
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button
            type="button"
            onClick={onCreatePreview}
            disabled={selectedPaths.length === 0 || isPlanning}
          >
            <RotateCw className={cn("h-3.5 w-3.5", isPlanning && "animate-spin")} />
            {t("path.create_preview")}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={isPlanning && selectedPaths.length === 0}
                onClick={onReset}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("path.reset_tooltip")}</TooltipContent>
          </Tooltip>
        </div>
    </ToolConfigPanel>
  );
}

function RiskBadge({
  riskLevel,
}: {
  riskLevel: SelectedPath["riskLevel"];
}) {
  if (riskLevel === "blocked") {
    return (
      <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
        blocked
      </Badge>
    );
  }

  if (riskLevel === "warning") {
    return (
      <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
        warning
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
      normal
    </Badge>
  );
}
