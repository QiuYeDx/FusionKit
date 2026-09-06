import { useTranslation } from "react-i18next";
import {
  DialogDescription, DialogTitle, ScrollableDialog, ScrollableDialogContent,
  ScrollableDialogFooter, ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Button } from "@/components/ui/button";
import type { LocalSubtitleTaskSummary } from "@/type/localSubtitle";
import { LocalSubtitleErrorNotice } from "./LocalSubtitleErrorNotice";
export { LocalSubtitleArtifactPreviewDialog, type LocalSubtitleArtifactPreviewSelection } from "./LocalSubtitleArtifactPreviewDialog";
export { LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS, createLocalSubtitleArtifactPreviewPage } from "./localSubtitlePreviewModel";

export function LocalSubtitleErrorDetailsDialog({
  task,
  onOpenChange,
}: {
  readonly task: LocalSubtitleTaskSummary | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["subtitle", "common"]);
  const error = task?.error;
  const metadata = error?.details?.metadata
    ? Object.entries(error.details.metadata)
    : [];

  return (
    <ScrollableDialog
      open={task !== null && error !== undefined}
      onOpenChange={onOpenChange}
      maxWidth="sm:max-w-2xl"
    >
      <ScrollableDialogHeader>
        <DialogTitle>{t("subtitle:local_transcriber.error_details.title")}</DialogTitle>
        <DialogDescription className="break-words [overflow-wrap:anywhere]">
          {task?.displayName ?? ""}
        </DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent
        fadeMasks
        className="min-w-0 max-w-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!max-w-full [&_[data-slot=scroll-area-viewport]>div]:!min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!w-full"
      >
        {error ? (
          <div className="w-full min-w-0 max-w-full space-y-4 overflow-hidden">
            <LocalSubtitleErrorNotice error={error} />
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] border-y text-xs">
              <DiagnosticField
                label={t("subtitle:local_transcriber.error_details.stage")}
                value={error.stage}
              />
              <DiagnosticField
                label={t("subtitle:local_transcriber.error_details.retryable")}
                value={t(error.retryable
                  ? "subtitle:local_transcriber.error_details.yes"
                  : "subtitle:local_transcriber.error_details.no")}
              />
              {error.field ? (
                <DiagnosticField
                  label={t("subtitle:local_transcriber.error_details.field")}
                  value={error.field}
                />
              ) : null}
              {error.causeCode ? (
                <DiagnosticField
                  label={t("subtitle:local_transcriber.error_details.cause")}
                  value={error.causeCode}
                />
              ) : null}
              <DiagnosticField
                label={t("subtitle:local_transcriber.error_details.truncated")}
                value={t(error.details?.truncated
                  ? "subtitle:local_transcriber.error_details.yes"
                  : "subtitle:local_transcriber.error_details.no")}
              />
            </dl>

            {error.details?.summary ? (
              <DiagnosticBlock
                title={t("subtitle:local_transcriber.error_details.summary")}
                value={error.details.summary}
              />
            ) : null}
            {error.details?.lines?.length ? (
              <section className="min-w-0 overflow-hidden">
                <h3 className="mb-2 text-xs font-medium">
                  {t("subtitle:local_transcriber.error_details.lines")}
                </h3>
                <pre className="w-full min-w-0 max-w-full whitespace-pre-wrap break-words border-y bg-muted/20 px-3 py-3 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
                  {error.details.lines.join("\n")}
                </pre>
              </section>
            ) : null}
            {metadata.length > 0 ? (
              <section className="min-w-0 overflow-hidden">
                <h3 className="mb-2 text-xs font-medium">
                  {t("subtitle:local_transcriber.error_details.metadata")}
                </h3>
                <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] border-y font-mono text-[11px]">
                  {metadata.map(([key, value]) => (
                    <DiagnosticField key={key} label={key} value={String(value)} />
                  ))}
                </dl>
              </section>
            ) : null}
          </div>
        ) : null}
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex justify-end">
        <Button type="button" onClick={() => onOpenChange(false)}>
          {t("common:action.close")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

function DiagnosticField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="border-b py-2 pr-3 font-medium text-muted-foreground last:border-b-0">
        {label}
      </dt>
      <dd className="min-w-0 border-b py-2 last:border-b-0 break-words [overflow-wrap:anywhere]">
        {value}
      </dd>
    </>
  );
}

function DiagnosticBlock({ title, value }: { readonly title: string; readonly value: string }) {
  return (
    <section className="min-w-0 overflow-hidden">
      <h3 className="mb-2 text-xs font-medium">{title}</h3>
      <div className="w-full min-w-0 max-w-full whitespace-pre-wrap break-words border-y bg-muted/20 px-3 py-3 text-xs leading-relaxed [overflow-wrap:anywhere]">
        {value}
      </div>
    </section>
  );
}
