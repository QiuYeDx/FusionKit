import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Loader2, RefreshCw } from "lucide-react";
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
import type {
  GeneratedSubtitleArtifactSummary,
  LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type { LocalSubtitleArtifactTextResult } from "@/type/localSubtitleIpc";
import { showToast } from "@/utils/toast";
import {
  LocalSubtitleErrorNotice,
  type LocalSubtitleDisplayError,
} from "./LocalSubtitleErrorNotice";

export const LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS = 12_000;

export interface LocalSubtitleArtifactPreviewSelection {
  readonly taskName: string;
  readonly artifact: GeneratedSubtitleArtifactSummary;
}

type ArtifactPreviewState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly data: LocalSubtitleArtifactTextResult }
  | { readonly status: "error"; readonly error: LocalSubtitleDisplayError };

export function createLocalSubtitleArtifactPreviewPage(
  rawText: string,
  requestedPage: number,
  pageSize = LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS,
) {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0
    ? pageSize
    : LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS;
  const pageCount = Math.max(1, Math.ceil(rawText.length / safePageSize));
  const pageIndex = Math.min(
    pageCount - 1,
    Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0),
  );
  return {
    pageIndex,
    pageCount,
    text: rawText.slice(pageIndex * safePageSize, (pageIndex + 1) * safePageSize),
  };
}

export function LocalSubtitleArtifactPreviewDialog({
  selection,
  onOpenChange,
}: {
  readonly selection: LocalSubtitleArtifactPreviewSelection | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["subtitle", "common"]);
  const generationRef = useRef(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<ArtifactPreviewState>({ status: "idle" });
  const [pageIndex, setPageIndex] = useState(0);
  const artifactRef = selection?.artifact.artifactRef;

  useEffect(() => {
    const generation = ++generationRef.current;
    setPageIndex(0);
    if (!artifactRef) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    void window.localSubtitleApi.readArtifactText(artifactRef).then((result) => {
      if (generation !== generationRef.current) return;
      setState(result.ok
        ? { status: "ready", data: result.data }
        : { status: "error", error: result.error });
    }).catch((error: unknown) => {
      if (generation !== generationRef.current) return;
      setState({
        status: "error",
        error: {
          message: error instanceof Error
            ? error.message
            : t("subtitle:local_transcriber.preview.read_failed"),
        },
      });
    });
    return () => {
      generationRef.current += 1;
    };
  }, [artifactRef, retryGeneration, t]);

  const page = state.status === "ready"
    ? createLocalSubtitleArtifactPreviewPage(state.data.rawText, pageIndex)
    : null;

  const handleCopy = async () => {
    if (state.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(state.data.plainText);
      showToast(t("subtitle:local_transcriber.preview.copied"), "success");
    } catch {
      showToast(t("subtitle:local_transcriber.preview.copy_failed"), "error");
    }
  };

  return (
    <ScrollableDialog
      open={selection !== null}
      onOpenChange={onOpenChange}
      maxWidth="sm:max-w-3xl"
    >
      <ScrollableDialogHeader>
        <DialogTitle>{t("subtitle:local_transcriber.preview.title")}</DialogTitle>
        <DialogDescription className="break-words [overflow-wrap:anywhere]">
          {selection
            ? t("subtitle:local_transcriber.preview.description", {
                name: selection.taskName,
                format: selection.artifact.format,
              })
            : ""}
        </DialogDescription>
      </ScrollableDialogHeader>

      <ScrollableDialogContent
        fadeMasks
        className="min-w-0 max-w-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!max-w-full [&_[data-slot=scroll-area-viewport]>div]:!min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!w-full"
      >
        <div className="w-full min-w-0 max-w-full overflow-hidden">
          {state.status === "loading" || state.status === "idle" ? (
            <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("subtitle:local_transcriber.preview.loading")}
            </div>
          ) : null}

          {state.status === "error" ? (
            <div className="space-y-3">
              <LocalSubtitleErrorNotice error={state.error} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRetryGeneration((value) => value + 1)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("subtitle:local_transcriber.preview.retry")}
              </Button>
            </div>
          ) : null}

          {state.status === "ready" && page ? (
            <div className="min-w-0 space-y-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{state.data.format}</Badge>
                <span>
                  {t("subtitle:local_transcriber.preview.cue_count", {
                    count: state.data.cueCount,
                  })}
                </span>
                <span>
                  {t("subtitle:local_transcriber.preview.page", {
                    current: page.pageIndex + 1,
                    total: page.pageCount,
                  })}
                </span>
              </div>
              <pre
                data-testid="local-subtitle-artifact-preview"
                className="w-full min-w-0 max-w-full whitespace-pre-wrap break-words border-y bg-muted/20 px-3 py-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]"
              >
                {page.text}
              </pre>
            </div>
          ) : null}
        </div>
      </ScrollableDialogContent>

      <ScrollableDialogFooter className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex h-8 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!page || page.pageIndex === 0}
            aria-label={t("subtitle:local_transcriber.preview.previous_page")}
            title={t("subtitle:local_transcriber.preview.previous_page")}
            onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!page || page.pageIndex >= page.pageCount - 1}
            aria-label={t("subtitle:local_transcriber.preview.next_page")}
            title={t("subtitle:local_transcriber.preview.next_page")}
            onClick={() => setPageIndex((value) => value + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={state.status !== "ready"}
            onClick={() => void handleCopy()}
          >
            <Copy className="h-4 w-4" />
            {t("subtitle:local_transcriber.preview.copy_plain_text")}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common:action.close")}
          </Button>
        </div>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

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
