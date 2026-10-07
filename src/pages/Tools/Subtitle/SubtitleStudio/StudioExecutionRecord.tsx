import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, FileClock, FileText, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import './StudioExecutionRecord.css';

type TranslationTrack = DocumentPage["translationTracks"][number];
type AvailableRecord = Extract<ExecutionRecordPage, { state: "available" }>;
/** This also recognizes tracks written before the explicit origin field existed. */
export function hasExecutionRecordEntry(track: TranslationTrack) {
  return (
    !!track.executionRef ||
    track.origin === "ai" ||
    Object.values(track.entries).some((entry) => entry.origin === "ai")
  );
}

/** One labelled part of what the model received; context groups stay visually secondary. */
function InputGroup({ kind, label, note, texts }: {
  kind: "context" | "source" | "ai";
  label: string;
  note?: string;
  texts: readonly string[];
}) {
  return (
    <div className="studio-execution-group" data-kind={kind}>
      <div className="studio-execution-group-label">
        <span>{label}</span>
        <span className="studio-execution-count">{texts.length}</span>
        {note && <span className="studio-execution-group-note">{note}</span>}
      </div>
      <ol>
        {texts.map((text, index) => (
          <li key={index}>
            <span className="studio-execution-line-number" aria-hidden={kind !== "source"}>
              {kind === "source" ? index + 1 : ""}
            </span>
            <span className="studio-execution-line-text">{text}</span>
          </li>
        ))}
      </ol>
    </div>
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
  // Record-level settings are identical for every batch; keep them steady while the next batch loads.
  const record: AvailableRecord | null =
    result?.identity === identity && result.value.state === "available"
      ? result.value
      : null;
  const knownBatches = record?.totalBatches ?? 0;
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
  const instructions = record?.knowledge?.compiled.instructions || record?.config.instructions;
  const request = available?.batch.request ?? null;
  const batchKey = pending && !current
    ? "loading"
    : hasError
      ? "error"
      : available
        ? `${available.recordId}:${available.batchOffset}`
        : current?.state ?? "empty";
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
        maxWidth="sm:max-w-[720px]"
        contentClassName="studio-execution-dialog grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected)
            trigger.current.focus({ preventScroll: true });
        }}
      >
        <ScrollableDialogHeader className="studio-execution-header">
          <DialogTitle className="text-base">
            {t("studio:execution.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("studio:execution.description")}
          </DialogDescription>
          <div className="studio-execution-file">
            <FileText aria-hidden="true" />
            <StudioFileName name={page.summary.origin.displayName} />
          </div>
        </ScrollableDialogHeader>
        <ScrollableDialogContent fadeMaskHeight={16} className="studio-execution-body">
          <div
            ref={contentRoot}
            data-testid="studio-execution-record-content"
            aria-busy={pending}
            className="studio-execution-content"
          >
            {/* The gap lives inside the stage so mounting the summary never jumps the batch below. */}
            <DialogTransition transitionKey="summary" stageClassName="pb-4">
              {record && !hasError && (
                <dl className="studio-execution-summary" data-testid="studio-execution-summary">
                  <div>
                    <dt>{t("studio:execution.model")}</dt>
                    <dd>{record.config.model.modelKey}</dd>
                  </div>
                  <div>
                    <dt>{t("studio:execution.language")}</dt>
                    <dd>{language(record.config.language)}</dd>
                  </div>
                  <div>
                    <dt>{t("studio:execution.saved_at")}</dt>
                    <dd>{formatDate(record.createdAt)}</dd>
                  </div>
                  <div className="studio-execution-summary-wide">
                    <dt>{t("studio:execution.instructions")}</dt>
                    <dd data-empty={!instructions || undefined}>
                      {instructions || t("studio:execution.no_instructions")}
                    </dd>
                  </div>
                </dl>
              )}
            </DialogTransition>
            <DialogTransition transitionKey={batchKey} stageClassName="studio-execution-stage">
              {pending && !current && (
                <p role="status" className="studio-execution-loading">
                  <LoaderCircle className="studio-spin" />
                  {t("studio:loading")}
                </p>
              )}
              {hasError && (
                <div role="alert" className="studio-execution-error">
                  <AlertCircle />
                  <p>{t(current?.state === "unavailable" ? "studio:errors.translation_record_unavailable" : "studio:execution.load_error")}</p>
                </div>
              )}
              {current?.state === "legacy" && (
                <p className="studio-execution-legacy">
                  <FileClock />
                  <span>{t("studio:execution.legacy")}</span>
                </p>
              )}
              {available && (
                <section className="studio-execution-batch" data-testid="studio-execution-batch">
                  <header className="studio-execution-batch-header">
                    <h3>
                      {t("studio:execution.batch", {
                        current: available.batchOffset + 1,
                        total: available.totalBatches,
                      })}
                    </h3>
                    <Tooltip delayDuration={250}>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="studio-execution-state" data-state={request ? "saved" : "pending"}>
                          {t(request ? "studio:execution.request_saved" : "studio:execution.not_sent")}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        {t(request ? "studio:execution.request_saved_help" : "studio:execution.not_sent_help")}
                      </TooltipContent>
                    </Tooltip>
                  </header>
                  <div className="studio-execution-input" data-testid="studio-execution-input">
                    {available.batch.before.length > 0 && (
                      <InputGroup kind="context" label={t("studio:execution.before")} note={t("studio:execution.context_note")} texts={available.batch.before} />
                    )}
                    <InputGroup
                      kind="source"
                      label={t("studio:execution.source")}
                      texts={available.batch.items.map((item) => item.text.replace(/<\/?m[1-9]\d{0,2}>/g, ""))}
                    />
                    {available.batch.after.length > 0 && (
                      <InputGroup kind="context" label={t("studio:execution.after")} note={t("studio:execution.context_note")} texts={available.batch.after} />
                    )}
                    {!!request?.priorModelTranslations.length && (
                      <InputGroup kind="ai" label={t("studio:execution.prior_ai")} note={t("studio:execution.prior_ai_note")} texts={request.priorModelTranslations} />
                    )}
                  </div>
                  {available.knowledge && <StudioExecutionKnowledge key={`${available.recordId}-${available.batchOffset}`} knowledge={available.knowledge} />}
                  <KnowledgeDisclosure
                    key={`${available.recordId}-${available.batchOffset}`}
                    data-testid="studio-execution-technical"
                    title={t("studio:execution.technical")}
                    contentClassName="studio-execution-technical"
                  >
                    <dl className="studio-execution-facts">
                      <div>
                        <dt>{t("studio:execution.policy_version")}</dt>
                        <dd>{available.policyVersion}</dd>
                      </div>
                      {request && (
                        <div>
                          <dt>{t("studio:execution.request_saved_at")}</dt>
                          <dd>{formatDate(request.createdAt)}</dd>
                        </div>
                      )}
                      {available.knowledge && (
                        <div>
                          <dt>{t("studio:execution.knowledge_digest")}</dt>
                          <dd>{available.knowledge.digest}</dd>
                        </div>
                      )}
                    </dl>
                    {request && (
                      <div className="studio-execution-http">
                        <h4>{t("studio:execution.http_body")}</h4>
                        <pre>{request.httpBody}</pre>
                      </div>
                    )}
                  </KnowledgeDisclosure>
                </section>
              )}
            </DialogTransition>
          </div>
        </ScrollableDialogContent>
        <ScrollableDialogFooter className="studio-execution-footer">
          <div className="studio-execution-footer-start">
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
              <RefreshCw className={pending ? "studio-spin" : undefined} />
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
