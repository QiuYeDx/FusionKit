import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  FolderOpen,
  FileSearch,
  FileInput,
  Loader2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
} from "lucide-react";
import { showToast } from "@/utils/toast";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useModelStore from "@/store/useModelStore";
import type { ModelProfile } from "@/type/model";
import {
  scanTranslationRecoveryArtifacts,
  inspectTranslationRecoveryArtifact,
  createRecoveredSubtitleTaskDraft,
} from "@/services/subtitle/translatorRecoveryService";
import type {
  TranslationRecoveryCandidate,
  TranslationRecoveryScanResult,
  SubtitleTranslatorTask,
  TranslationRecoveryInputMode,
} from "@/type/subtitle";
import { TaskStatus } from "@/type/subtitle";

type RecoveryDialogState = "idle" | "scanning" | "ready" | "importing" | "error";

interface RecoveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function RecoveryDialog({ open, onOpenChange }: RecoveryDialogProps) {
  const { t } = useTranslation();
  const outputURL = useSubtitleTranslatorStore((s) => s.outputURL);
  const addRecoveredTasks = useSubtitleTranslatorStore((s) => s.addRecoveredTasks);
  const startAllTasks = useSubtitleTranslatorStore((s) => s.startAllTasks);

  const [state, setState] = useState<RecoveryDialogState>("idle");
  const [candidates, setCandidates] = useState<TranslationRecoveryCandidate[]>([]);
  const [scanResult, setScanResult] = useState<TranslationRecoveryScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>("");

  const reset = useCallback(() => {
    setState("idle");
    setCandidates([]);
    setScanResult(null);
    setSelected(new Set());
    setError("");
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  }, [onOpenChange, reset]);

  const handleScanCurrentOutput = useCallback(async () => {
    if (!outputURL) return;
    setState("scanning");
    try {
      const result = await scanTranslationRecoveryArtifacts({
        roots: [outputURL],
        recursive: true,
      });
      setScanResult(result);
      setCandidates(result.candidates);
      setState("ready");

      const recoverable = result.candidates.filter(
        (c) => c.recoverability === "ready" || c.recoverability === "ready_from_manifest"
      );
      setSelected(new Set(recoverable.map((c) => c.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [outputURL]);

  const handleSelectDirectory = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.invoke("select-output-directory", {
        title: "Select Directory to Scan",
        buttonLabel: "Scan",
      });
      if (!result || result.canceled || !result.filePaths?.length) return;

      setState("scanning");
      const scanRes = await scanTranslationRecoveryArtifacts({
        roots: [result.filePaths[0]],
        recursive: true,
      });
      setScanResult(scanRes);
      setCandidates(scanRes.candidates);
      setState("ready");

      const recoverable = scanRes.candidates.filter(
        (c) => c.recoverability === "ready" || c.recoverability === "ready_from_manifest"
      );
      setSelected(new Set(recoverable.map((c) => c.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  const handleImportSingle = useCallback(async () => {
    try {
      const filePath = await window.ipcRenderer.invoke("select-recovery-manifest-file");
      if (!filePath) return;

      setState("scanning");
      const candidate = await inspectTranslationRecoveryArtifact(filePath);
      setScanResult({
        candidates: [candidate],
        scannedDirs: 1,
        scannedFiles: 1,
        skippedFiles: 0,
        truncated: false,
        errors: [],
      });
      setCandidates([candidate]);
      setState("ready");

      if (candidate.recoverability === "ready" || candidate.recoverability === "ready_from_manifest") {
        setSelected(new Set([candidate.id]));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  const handleToggleCandidate = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const recoverable = candidates.filter(
      (c) => c.recoverability === "ready" || c.recoverability === "ready_from_manifest"
    );
    setSelected(new Set(recoverable.map((c) => c.id)));
  }, [candidates]);

  const handleDeselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleAddToQueue = useCallback(async (andStart = false) => {
    const selectedCandidates = candidates.filter((c) => selected.has(c.id));
    if (selectedCandidates.length === 0) return;

    setState("importing");

    const taskProfile: ModelProfile | null = useModelStore.getState().getTaskProfile();

    if (!taskProfile) {
      showToast("Please configure a task model first", "error");
      setState("ready");
      return;
    }

    try {
      const tasks: SubtitleTranslatorTask[] = [];

      for (const candidate of selectedCandidates) {
        const inputMode: TranslationRecoveryInputMode =
          candidate.recoverability === "ready" ? "source_file" : "manifest_fragments";

        const draft = await createRecoveredSubtitleTaskDraft({
          checkpointPath: candidate.checkpointPath,
          recoveryInputMode: inputMode,
        });

        const task: SubtitleTranslatorTask = {
          ...draft,
          fileContent: draft.fileContent || "",
          status: TaskStatus.NOT_STARTED,
          apiKey: taskProfile.apiKey,
          apiModel: taskProfile.modelKey,
          endPoint: taskProfile.baseUrl,
          conflictPolicy: "index",
          concurrentSlices: true,
        };

        tasks.push(task);
      }

      const { addedCount, skippedCount } = addRecoveredTasks(tasks);

      if (addedCount > 0) {
        showToast(
          t("subtitle:translator.recovery.import_success").replace("{count}", String(addedCount)),
          "success",
        );
      }
      if (skippedCount > 0) {
        showToast(
          t("subtitle:translator.recovery.duplicate_skipped").replace("{count}", String(skippedCount)),
          "default",
        );
      }

      if (andStart && addedCount > 0) {
        startAllTasks();
      }

      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [candidates, selected, addRecoveredTasks, startAllTasks, handleOpenChange, t]);

  const handleOpenLocation = useCallback((dirPath: string) => {
    window.ipcRenderer.invoke("show-item-in-folder", dirPath);
  }, []);

  const recoverableCount = candidates.filter(
    (c) => c.recoverability === "ready" || c.recoverability === "ready_from_manifest"
  ).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[min(calc(100vw-2rem),48rem)] max-w-none min-w-0 flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("subtitle:translator.recovery.title")}</DialogTitle>
        </DialogHeader>

        {state === "idle" && (
          <div className="flex flex-col gap-3 py-4">
            {outputURL && (
              <Button
                variant="outline"
                className="justify-start h-auto py-3 px-4"
                onClick={handleScanCurrentOutput}
              >
                <FileSearch className="h-4 w-4 mr-3 shrink-0" />
                <div className="text-left">
                  <div className="text-sm font-medium">
                    {t("subtitle:translator.recovery.scan_current_output")}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[400px]">
                    {outputURL}
                  </div>
                </div>
              </Button>
            )}
            <Button
              variant="outline"
              className="justify-start h-auto py-3 px-4"
              onClick={handleSelectDirectory}
            >
              <FolderOpen className="h-4 w-4 mr-3 shrink-0" />
              <span className="text-sm font-medium">
                {t("subtitle:translator.recovery.select_directory")}
              </span>
            </Button>
            <Button
              variant="outline"
              className="justify-start h-auto py-3 px-4"
              onClick={handleImportSingle}
            >
              <FileInput className="h-4 w-4 mr-3 shrink-0" />
              <span className="text-sm font-medium">
                {t("subtitle:translator.recovery.import_manifest")}
              </span>
            </Button>
          </div>
        )}

        {state === "scanning" && (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{t("subtitle:translator.recovery.scanning")}</span>
          </div>
        )}

        {state === "error" && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <span className="text-sm text-destructive">{error}</span>
            <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
              {t("subtitle:translator.recovery.select_directory")}
            </Button>
          </div>
        )}

        {state === "ready" && candidates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
            <FileSearch className="h-8 w-8" />
            <span className="text-sm">{t("subtitle:translator.recovery.no_candidates")}</span>
            <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
              {t("subtitle:translator.recovery.select_directory")}
            </Button>
          </div>
        )}

        {state === "ready" && candidates.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {t("subtitle:translator.recovery.scan_complete").replace("{count}", String(candidates.length))}
                {scanResult?.truncated && (
                  <span className="ml-1 text-amber-500">
                    ({t("subtitle:translator.recovery.scan_truncated").replace("{count}", String(candidates.length))})
                  </span>
                )}
              </span>
              <div className="flex shrink-0 gap-2">
                <button className="hover:underline" onClick={handleSelectAll}>
                  {t("subtitle:translator.recovery.select_all")}
                </button>
                <button className="hover:underline" onClick={handleDeselectAll}>
                  {t("subtitle:translator.recovery.deselect_all")}
                </button>
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1 overflow-hidden rounded-md border">
              <div className="min-w-0 divide-y">
                {candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    isSelected={selected.has(candidate.id)}
                    onToggle={() => handleToggleCandidate(candidate.id)}
                    onOpenLocation={() => handleOpenLocation(candidate.outputDir)}
                    t={t}
                  />
                ))}
              </div>
            </ScrollArea>

            {selected.size > 0 && (
              <div className="shrink-0 px-1 text-xs text-muted-foreground">
                {t("subtitle:translator.recovery.selected_count").replace("{count}", String(selected.size))}
              </div>
            )}
          </div>
        )}

        {state === "importing" && (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">...</span>
          </div>
        )}

        {state === "ready" && candidates.length > 0 && (
          <DialogFooter className="shrink-0 gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("subtitle:translator.recovery.ignore")}
            </Button>
            <Button
              variant="outline"
              disabled={selected.size === 0}
              onClick={() => handleAddToQueue(false)}
            >
              {t("subtitle:translator.recovery.add_to_queue")}
              {selected.size > 0 && ` (${selected.size})`}
            </Button>
            <Button
              disabled={selected.size === 0}
              onClick={() => handleAddToQueue(true)}
            >
              {t("subtitle:translator.recovery.add_and_start")}
              {selected.size > 0 && ` (${selected.size})`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Candidate Row ───────────────────────────────────────────────────────────

function CandidateRow({
  candidate,
  isSelected,
  onToggle,
  onOpenLocation,
  t,
}: {
  candidate: TranslationRecoveryCandidate;
  isSelected: boolean;
  onToggle: () => void;
  onOpenLocation: () => void;
  t: (key: string) => string;
}) {
  const isRecoverable =
    candidate.recoverability === "ready" || candidate.recoverability === "ready_from_manifest";

  return (
    <div className="flex min-w-0 items-start gap-3 overflow-hidden px-3 py-2.5 transition-colors hover:bg-muted/50">
      <div className="shrink-0 pt-0.5">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggle}
          disabled={!isRecoverable}
        />
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <MiddleEllipsisTooltip
            text={candidate.fileName}
            className="flex-1 text-sm font-medium"
          />
          <RecoverabilityBadge recoverability={candidate.recoverability} t={t} />
          <SourceStateBadge sourceState={candidate.sourceState} t={t} />
        </div>

        <div className="mt-1 flex min-w-0 items-center gap-3 overflow-hidden text-xs text-muted-foreground">
          <span className="shrink-0">
            {candidate.options.sourceLang} → {candidate.options.targetLang}
          </span>
          <span className="shrink-0">
            {candidate.resolvedFragments}/{candidate.totalFragments} ({candidate.progress}%)
          </span>
          <MiddleEllipsisTooltip text={candidate.outputDir} className="flex-1 font-mono" />
        </div>

        {candidate.recoverability === "ready_from_manifest" && (
          <MiddleEllipsisTooltip
            text={t("subtitle:translator.recovery.source_unavailable_hint")}
            className="mt-1 text-xs text-amber-600"
          />
        )}

        {candidate.blockingReason && !isRecoverable && (
          <MiddleEllipsisTooltip
            text={candidate.blockingReason}
            className="mt-1 text-xs text-destructive"
          />
        )}
      </div>

      <div className="shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOpenLocation}>
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function MiddleEllipsisTooltip({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { leading, trailing } = splitMiddleText(text);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "flex min-w-0 max-w-full overflow-hidden whitespace-nowrap",
            className
          )}
          aria-label={text}
        >
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {leading}
          </span>
          {trailing && (
            <span className="max-w-[50%] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {trailing}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[640px] break-all text-left">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function splitMiddleText(text: string): { leading: string; trailing: string } {
  if (text.length <= 16) return { leading: text, trailing: "" };

  const trailingLength = Math.min(24, Math.max(8, Math.floor(text.length * 0.35)));
  return {
    leading: text.slice(0, -trailingLength),
    trailing: text.slice(-trailingLength),
  };
}

function RecoverabilityBadge({
  recoverability,
  t,
}: {
  recoverability: TranslationRecoveryCandidate["recoverability"];
  t: (key: string) => string;
}) {
  switch (recoverability) {
    case "ready":
      return (
        <Badge variant="default" className="text-[10px] px-1.5 py-0 gap-0.5 bg-green-600">
          <CheckCircle2 className="h-2.5 w-2.5" />
          {t("subtitle:translator.recovery.ready")}
        </Badge>
      );
    case "ready_from_manifest":
      return (
        <Badge variant="default" className="text-[10px] px-1.5 py-0 gap-0.5 bg-amber-600">
          <Clock className="h-2.5 w-2.5" />
          {t("subtitle:translator.recovery.ready_from_manifest")}
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5">
          <CheckCircle2 className="h-2.5 w-2.5" />
          {t("subtitle:translator.recovery.completed")}
        </Badge>
      );
    default:
      return (
        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 gap-0.5">
          <XCircle className="h-2.5 w-2.5" />
          {t(`subtitle:translator.recovery.${recoverability}`)}
        </Badge>
      );
  }
}

function SourceStateBadge({
  sourceState,
  t,
}: {
  sourceState: TranslationRecoveryCandidate["sourceState"];
  t: (key: string) => string;
}) {
  switch (sourceState) {
    case "matched":
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-green-600 border-green-200">
          {t("subtitle:translator.recovery.source_matched")}
        </Badge>
      );
    case "missing":
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-200">
          {t("subtitle:translator.recovery.source_missing")}
        </Badge>
      );
    case "changed":
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-200">
          {t("subtitle:translator.recovery.source_changed")}
        </Badge>
      );
    default:
      return null;
  }
}
