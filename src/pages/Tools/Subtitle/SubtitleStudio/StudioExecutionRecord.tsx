import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, FileClock, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import {
  ScrollableDialog,
  ScrollableDialogHeader,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/qiuye-ui/scrollable-dialog";
import type { ExecutionRecordPage } from "@/subtitle-studio/execution-view-contract";
import type { DocumentPage } from "@/subtitle-studio/ipc-contract";
import { KnowledgeDisclosure } from '@/pages/TranslationKnowledge/KnowledgeDisclosure';
import { StudioExecutionKnowledge } from './StudioExecutionKnowledge';
import {
  StudioFileName,
  StudioIconButton,
  StudioPagination,
} from "./StudioControls";

type TranslationTrack = DocumentPage["translationTracks"][number];
/** This also recognizes tracks written before the explicit origin field existed. */
export function hasExecutionRecordEntry(track: TranslationTrack) {
  return (
    !!track.executionRef ||
    track.origin === "ai" ||
    Object.values(track.entries).some((entry) => entry.origin === "ai")
  );
}

function TextContext({
  title,
  texts,
}: {
  title: string;
  texts: readonly string[];
}) {
  const { t } = useTranslation();
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium">{title}</h3>
      {texts.length ? (
        <ol className="space-y-1">
          {texts.map((text, index) => (
            <li
              key={index}
              className="rounded-md bg-muted/35 p-2 text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("studio:execution.no_context")}
        </p>
      )}
    </section>
  );
}

/** Read-only, one-batch-at-a-time inspection tied to the selected track, not task lifetime. */
export function StudioExecutionRecord({
  page,
  track,
}: {
  page: DocumentPage;
  track: TranslationTrack;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [batchOffset, setBatchOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    identity: string;
    offset: number;
    value: ExecutionRecordPage;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  const contentRoot = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const identity = JSON.stringify([
    page.summary.id,
    track.id,
    track.executionRef ?? null,
  ]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const active = useRef(false);
  const current =
    result?.identity === identity && result.offset === batchOffset
      ? result.value
      : null;
  const available = current?.state === "available" ? current : null;
  const knownBatches =
    result?.identity === identity && result.value.state === "available"
      ? result.value.totalBatches
      : 0;
  const hasError = failed || current?.state === "unavailable";
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(i18n.language)
      : t("studio:execution.unknown");
  };
  const language = (value: string) => {
    try {
      return (
        new Intl.DisplayNames([i18n.language], { type: "language" }).of(
          value === "zh" ? "zh-Hans" : value,
        ) ?? value
      );
    } catch {
      return value;
    }
  };
  const close = () => {
    epoch.current++;
    active.current = false;
    setOpen(false);
    setPending(false);
  };
  const begin = () => {
    if (active.current) return;
    active.current = true;
    setResult(null);
    setBatchOffset(0);
    setFailed(false);
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const requestEpoch = ++epoch.current;
    const requestIdentity = identity;
    let cancelled = false;
    setPending(true);
    setFailed(false);
    void window.subtitleStudio
      .readExecutionRecord({
        documentId: page.summary.id,
        trackId: track.id,
        batchOffset,
      })
      .then(
        (response) => {
          if (
            cancelled ||
            requestEpoch !== epoch.current ||
            !active.current ||
            identityRef.current !== requestIdentity
          )
            return;
          if (response.ok)
            setResult({
              identity: requestIdentity,
              offset: batchOffset,
              value: response.value,
            });
          else {
            setResult(null);
            setFailed(true);
          }
        },
        () => {
          if (
            !cancelled &&
            requestEpoch === epoch.current &&
            active.current &&
            identityRef.current === requestIdentity
          ) {
            setResult(null);
            setFailed(true);
          }
        },
      )
      .finally(() => {
        if (
          !cancelled &&
          requestEpoch === epoch.current &&
          active.current &&
          identityRef.current === requestIdentity
        )
          setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, identity, batchOffset, refresh, page.summary.revision]);
  // A track change must not leave the previous track's trace open or apply late IPC results.
  useEffect(() => {
    close();
    setResult(null);
    setBatchOffset(0);
    setFailed(false);
  }, [identity]);
  useEffect(
    () => () => {
      epoch.current++;
      active.current = false;
    },
    [],
  );
  const changeBatch = (offset: number) => {
    if (pending || offset < 0 || offset >= knownBatches) return;
    epoch.current++;
    setBatchOffset(offset);
    setFailed(false);
    contentRoot.current
      ?.closest<HTMLElement>("[data-slot=scroll-area-viewport]")
      ?.scrollTo({ top: 0 });
  };
  return (
    <>
      <Button
        ref={trigger}
        data-testid="studio-execution-record"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={begin}
      >
        <FileClock className="size-3.5" />
        {t("studio:execution.open")}
      </Button>
      <ScrollableDialog animateSize
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        maxWidth="sm:max-w-3xl"
        contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected)
            trigger.current.focus({ preventScroll: true });
        }}
      >
        <ScrollableDialogHeader className="p-3">
          <DialogTitle className="text-base">
            {t("studio:execution.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("studio:execution.description")}
          </DialogDescription>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <StudioFileName name={page.summary.origin.displayName} />
          </div>
        </ScrollableDialogHeader>
        <ScrollableDialogContent
          fadeMaskHeight={16}
          className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3"
        >
          <div
            ref={contentRoot}
            data-testid="studio-execution-record-content"
            aria-busy={pending}
            className="min-w-0 space-y-4 [overflow-wrap:anywhere]"
          >
            <DialogTransition transitionKey={pending && !current ? 'loading' : hasError ? 'error' : available ? `${available.recordId}:${available.batchOffset}` : current?.state ?? 'empty'} stageClassName="min-w-0 space-y-4">
            {pending && (
              <p
                role="status"
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                {t("studio:loading")}
              </p>
            )}
            {hasError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
              >
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p>{t(current?.state === "unavailable" ? "studio:errors.translation_record_unavailable" : "studio:execution.load_error")}</p>
              </div>
            )}
            {current?.state === "legacy" && (
              <p className="rounded-md border bg-muted/25 p-3 text-sm leading-6">
                {t("studio:execution.legacy")}
              </p>
            )}
            {available && (
              <>
                <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">
                      {t("studio:execution.model")}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {available.config.model.modelKey}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("studio:execution.language")}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {language(available.config.language)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("studio:execution.saved_at")}
                    </dt>
                    <dd className="mt-1">{formatDate(available.createdAt)}</dd>
                  </div>
                </dl>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium">
                    {t("studio:execution.instructions")}
                  </h3>
                  <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                    {available.knowledge?.compiled.instructions || available.config.instructions ||
                      t("studio:execution.no_instructions")}
                  </p>
                </section>
                <section className="space-y-2 border-t pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                      {t("studio:execution.batch", {
                        current: available.batchOffset + 1,
                        total: available.totalBatches,
                      })}
                    </h3>
                    <span className="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">
                      {t(
                        available.batch.request
                          ? "studio:execution.request_saved"
                          : "studio:execution.not_sent",
                      )}
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t(
                      available.batch.request
                        ? "studio:execution.request_saved_help"
                        : "studio:execution.not_sent_help",
                    )}
                  </p>
                </section>
                <TextContext
                  title={t("studio:execution.source")}
                  texts={available.batch.items.map((item) => item.text.replace(/<\/?m[1-9]\d{0,2}>/g, ""))}
                />
                {available.knowledge && <StudioExecutionKnowledge key={`${available.recordId}-${available.batchOffset}`} knowledge={available.knowledge} />}
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextContext
                    title={t("studio:execution.before")}
                    texts={available.batch.before}
                  />
                  <TextContext
                    title={t("studio:execution.after")}
                    texts={available.batch.after}
                  />
                </div>
                <TextContext
                  title={t("studio:execution.prior_ai")}
                  texts={available.batch.request?.priorModelTranslations ?? []}
                />
                <KnowledgeDisclosure
                  key={`${available.recordId}-${available.batchOffset}`}
                  data-testid="studio-execution-technical"
                  title={t("studio:execution.technical")}
                >
                  <p className="text-xs text-muted-foreground">
                    {t("studio:execution.policy_version")}:{" "}
                    {available.policyVersion}
                  </p>
                  {available.batch.request && (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {t("studio:execution.request_saved_at")}:{" "}
                        {formatDate(available.batch.request.createdAt)}
                      </p>
                      <h3 className="text-xs font-medium">
                        {t("studio:execution.http_body")}
                      </h3>
                      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/35 p-2 text-[11px] leading-5">
                        {available.batch.request.httpBody}
                      </pre>
                    </>
                  )}
                </KnowledgeDisclosure>
              </>
            )}
            </DialogTransition>
          </div>
        </ScrollableDialogContent>
        <ScrollableDialogFooter className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {knownBatches > 0 && (
              <StudioPagination
                compact
                offset={batchOffset}
                total={knownBatches}
                pageSize={1}
                busy={pending}
                onChange={changeBatch}
              />
            )}
            <StudioIconButton
              label={t(
                hasError
                  ? "studio:execution.retry"
                  : "studio:execution.refresh",
              )}
              disabled={pending}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw
                className={pending ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </StudioIconButton>
          </div>
          <Button size="sm" variant="outline" onClick={close}>
            {t("studio:batch.close")}
          </Button>
        </ScrollableDialogFooter>
      </ScrollableDialog>
    </>
  );
}
