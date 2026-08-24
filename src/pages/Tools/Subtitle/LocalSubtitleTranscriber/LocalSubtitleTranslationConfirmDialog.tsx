import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SubtitleTranslationImportConfigSummary } from "@/type/generatedSubtitleImport";
import type { LocalSubtitleFormat } from "@/type/localSubtitle";

export function LocalSubtitleTranslationConfirmDialog({
  snapshot,
  format,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly snapshot: SubtitleTranslationImportConfigSummary | null;
  readonly format: LocalSubtitleFormat | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation(["subtitle", "common"]);
  return (
    <ScrollableDialog
      open={snapshot !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      maxWidth="sm:max-w-lg"
    >
      <ScrollableDialogHeader>
        <DialogTitle>
          {t("subtitle:local_transcriber.post_action.confirm_title")}
        </DialogTitle>
        <DialogDescription>
          {t("subtitle:local_transcriber.post_action.confirm_description")}
        </DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent>
        {snapshot ? (
          <div className="space-y-3 text-sm">
            <SummaryRow
              label={t("subtitle:local_transcriber.post_action.mode")}
              value={t(snapshot.handoffMode === "enqueue_translation"
                ? "subtitle:local_transcriber.post_action.enqueue"
                : "subtitle:local_transcriber.post_action.enqueue_and_start")}
            />
            <SummaryRow
              label={t("subtitle:local_transcriber.post_action.handoff_format")}
              value={format ?? "-"}
            />
            <SummaryRow
              label={t("subtitle:local_transcriber.post_action.languages")}
              value={`${snapshot.sourceLang} -> ${snapshot.targetLang}`}
            />
            <SummaryRow
              label={t("subtitle:local_transcriber.post_action.profile")}
              value={snapshot.executionBinding.status === "ready"
                ? snapshot.executionBinding.taskProfileLabel
                : t("subtitle:local_transcriber.post_action.needs_configuration")}
            />
            <SummaryRow
              label={t("subtitle:local_transcriber.post_action.translation_output")}
              value={snapshot.outputDirectoryLabel ?? snapshot.outputMode}
            />
            {snapshot.handoffMode === "enqueue_and_start_translation" ? (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                {t("subtitle:local_transcriber.post_action.cost_notice")}
              </div>
            ) : (
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {t("subtitle:local_transcriber.post_action.session_only_notice")}
              </div>
            )}
          </div>
        ) : null}
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          {t("common:action.cancel")}
        </Button>
        <Button type="button" disabled={pending} onClick={onConfirm}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("subtitle:local_transcriber.post_action.confirm")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge variant="outline" className="min-w-0 max-w-[65%] whitespace-normal text-right">
        {value}
      </Badge>
    </div>
  );
}
