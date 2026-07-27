import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  FileWarning,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getLocalSubtitleOverwriteRecoveryService,
  type LocalSubtitleOverwriteRecoveryFeedback,
  type LocalSubtitleOverwriteRecoveryItem,
} from "@/services/local-subtitle/localSubtitleOverwriteRecoveryService";
import type { LocalSubtitleTaskEventEnvelope } from "@/type/localSubtitle";

const DIRECTION_KEYS = {
  finalize: "local_transcriber.overwrite_recovery.direction.finalize",
  rollback: "local_transcriber.overwrite_recovery.direction.rollback",
} as const;

const STATE_KEYS = {
  not_started: "local_transcriber.overwrite_recovery.state.not_started",
  pending: "local_transcriber.overwrite_recovery.state.pending",
  retry_failed: "local_transcriber.overwrite_recovery.state.retry_failed",
  settled: "local_transcriber.overwrite_recovery.state.settled",
} as const;

export default function LocalSubtitleOverwriteRecoveryPrompt() {
  const { t, i18n } = useTranslation("subtitle");
  const service = useMemo(
    () => getLocalSubtitleOverwriteRecoveryService(),
    [],
  );
  const state = useSyncExternalStore(
    service.subscribe,
    service.getState,
    service.getState,
  );
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void service.refresh();
  }, [service]);

  useEffect(() => {
    const refreshWhenActive = () => {
      if (document.visibilityState === "visible") void service.refresh();
    };
    window.addEventListener("focus", refreshWhenActive);
    document.addEventListener("visibilitychange", refreshWhenActive);
    return () => {
      window.removeEventListener("focus", refreshWhenActive);
      document.removeEventListener("visibilitychange", refreshWhenActive);
    };
  }, [service]);

  useEffect(() => {
    try {
      return window.localSubtitleApi?.onTaskEvent((event) => {
        if (isOverwriteRecoveryCandidateEvent(event)) {
          void service.refreshAfterCurrent();
        }
      });
    } catch {
      return undefined;
    }
  }, [service]);

  useEffect(() => {
    if (
      !autoOpened.current &&
      state.availability === "ready" &&
      state.items.length > 0
    ) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [state.availability, state.items.length]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        service.clearFeedback();
        void service.refresh();
      }
    },
    [service],
  );

  const showTrigger =
    !open &&
    (state.items.length > 0 ||
      state.availability === "unavailable" ||
      state.availability === "blocked" ||
      state.availability === "error");
  const triggerLabel =
    state.availability === "unavailable"
      ? t("local_transcriber.overwrite_recovery.unavailable.title")
      : state.availability === "blocked"
      ? t("local_transcriber.overwrite_recovery.blocked.title")
      : state.availability === "error"
        ? t("local_transcriber.overwrite_recovery.error.generic")
        : t("local_transcriber.overwrite_recovery.trigger_label", {
            count: state.items.length,
          });
  const dialogDescription =
    state.availability === "unavailable"
      ? t("local_transcriber.overwrite_recovery.unavailable.title")
      : state.availability === "blocked"
      ? t("local_transcriber.overwrite_recovery.blocked.title")
      : state.availability === "error"
        ? t("local_transcriber.overwrite_recovery.error.generic")
        : t("local_transcriber.overwrite_recovery.pending_count", {
            count: state.items.length,
          });

  return (
    <>
      {showTrigger ? (
        <div className="app-region-no-drag fixed bottom-16 left-3 z-40">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                className="relative rounded-md bg-background/80 shadow-sm backdrop-blur-md"
                aria-label={triggerLabel}
                onClick={() => handleOpenChange(true)}
              >
                <FileWarning className="size-4 text-amber-600 dark:text-amber-400" />
                {state.items.length > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1.5 -top-1.5 flex size-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold leading-none text-white"
                  >
                    {state.items.length > 99 ? "99+" : state.items.length}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {triggerLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      <ScrollableDialog
        open={open}
        onOpenChange={handleOpenChange}
        maxWidth="sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogTitleRef.current?.focus();
        }}
      >
        <ScrollableDialogHeader>
          <DialogTitle
            ref={dialogTitleRef}
            tabIndex={-1}
            className="flex items-center gap-2 outline-none"
          >
            <FileWarning className="size-4 text-amber-600 dark:text-amber-400" />
            {t("local_transcriber.overwrite_recovery.title")}
          </DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </ScrollableDialogHeader>

        <ScrollableDialogContent
          fadeMasks
          className="min-w-0 max-w-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!w-full [&_[data-slot=scroll-area-viewport]>div]:!max-w-full"
        >
          <div className="min-w-0 max-w-full space-y-3 overflow-hidden">
            <RecoveryFeedback feedback={state.feedback} />
            {state.queryErrorCode ? (
              <RecoveryError code={state.queryErrorCode} />
            ) : null}

            {state.availability === "blocked" ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>
                  {t("local_transcriber.overwrite_recovery.blocked.title")}
                </AlertTitle>
                <AlertDescription>
                  {t(
                    "local_transcriber.overwrite_recovery.blocked.description",
                  )}
                </AlertDescription>
              </Alert>
            ) : state.availability === "unavailable" ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>
                  {t(
                    "local_transcriber.overwrite_recovery.unavailable.title",
                  )}
                </AlertTitle>
                <AlertDescription>
                  {t(
                    "local_transcriber.overwrite_recovery.unavailable.description",
                  )}
                </AlertDescription>
              </Alert>
            ) : state.availability === "idle" && state.refreshing ? (
              <LoadingState />
            ) : state.availability === "ready" && state.items.length === 0 ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center text-center">
                {state.refreshing ? (
                  <Loader2 className="mb-3 size-7 animate-spin text-muted-foreground" />
                ) : (
                  <CheckCircle2 className="mb-3 size-7 text-emerald-600 dark:text-emerald-400" />
                )}
                <p className="text-sm font-medium">
                  {state.refreshing
                    ? t("local_transcriber.overwrite_recovery.loading")
                    : t("local_transcriber.overwrite_recovery.empty_title")}
                </p>
              </div>
            ) : state.items.length > 0 ? (
              <LocalSubtitleOverwriteRecoveryList
                items={state.items}
                actionRecoveryId={state.actionRecoveryId}
                locale={i18n.resolvedLanguage ?? i18n.language}
                labels={{
                  itemTitle: (code) =>
                    t("local_transcriber.overwrite_recovery.item_title", {
                      code,
                    }),
                  recoveryCode: t(
                    "local_transcriber.overwrite_recovery.field.recovery_code",
                  ),
                  format: t("local_transcriber.overwrite_recovery.field.format"),
                  createdAt: t(
                    "local_transcriber.overwrite_recovery.field.created_at",
                  ),
                  chooseDirectory: t(
                    "local_transcriber.overwrite_recovery.choose_original_directory",
                  ),
                  retry: t("local_transcriber.overwrite_recovery.retry"),
                  working: t("local_transcriber.overwrite_recovery.working"),
                  directions: {
                    finalize: t(DIRECTION_KEYS.finalize),
                    rollback: t(DIRECTION_KEYS.rollback),
                  },
                  states: {
                    not_started: t(STATE_KEYS.not_started),
                    pending: t(STATE_KEYS.pending),
                    retry_failed: t(STATE_KEYS.retry_failed),
                    settled: t(STATE_KEYS.settled),
                  },
                }}
                onRecover={(recoveryId) => void service.recover(recoveryId)}
              />
            ) : null}
          </div>
        </ScrollableDialogContent>

        <ScrollableDialogFooter className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(state.actionRecoveryId) || state.refreshing}
            onClick={() => void service.refresh()}
          >
            <RefreshCw className={state.refreshing ? "animate-spin" : ""} />
            {t("local_transcriber.overwrite_recovery.refresh")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => handleOpenChange(false)}
          >
            {t("local_transcriber.overwrite_recovery.close")}
          </Button>
        </ScrollableDialogFooter>
      </ScrollableDialog>
    </>
  );
}

interface RecoveryListLabels {
  readonly itemTitle: (code: string) => string;
  readonly recoveryCode: string;
  readonly format: string;
  readonly createdAt: string;
  readonly chooseDirectory: string;
  readonly retry: string;
  readonly working: string;
  readonly directions: Readonly<Record<"finalize" | "rollback", string>>;
  readonly states: Readonly<
    Record<
      "not_started" | "pending" | "retry_failed" | "settled",
      string
    >
  >;
}

export function LocalSubtitleOverwriteRecoveryList({
  items,
  actionRecoveryId,
  locale,
  labels,
  onRecover,
}: {
  readonly items: readonly LocalSubtitleOverwriteRecoveryItem[];
  readonly actionRecoveryId: string | null;
  readonly locale: string;
  readonly labels: RecoveryListLabels;
  readonly onRecover: (recoveryId: string) => void;
}) {
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  const formatCreatedAt = useCallback(
    (createdAt: number) => {
      const date = new Date(createdAt);
      if (Number.isNaN(date.getTime())) return String(createdAt);

      try {
        return dateFormatter.format(date);
      } catch {
        return String(createdAt);
      }
    },
    [dateFormatter],
  );

  return (
    <ul className="min-w-0 max-w-full divide-y overflow-hidden rounded-md border">
      {items.map((item) => {
        const working = actionRecoveryId === item.recoveryId;
        const actionLabel = working
          ? labels.working
          : item.requiresDirectorySelection
            ? labels.chooseDirectory
            : labels.retry;
        return (
          <li
            key={item.recoveryId}
            className="flex min-w-0 max-w-full flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">
                  {labels.itemTitle(item.displayCode)}
                </span>
                <Badge variant="outline">{item.format}</Badge>
                <Badge variant="secondary">
                  {labels.directions[item.direction]}
                </Badge>
                <Badge
                  variant={
                    item.state === "retry_failed" ? "destructive" : "outline"
                  }
                >
                  {labels.states[item.state]}
                </Badge>
              </div>
              <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <dt>{labels.recoveryCode}</dt>
                <dd className="min-w-0 break-words font-mono">
                  {item.displayCode}
                </dd>
                <dt>{labels.format}</dt>
                <dd className="min-w-0 break-words">{item.format}</dd>
                <dt>{labels.createdAt}</dt>
                <dd className="min-w-0 break-words">
                  {formatCreatedAt(item.createdAt)}
                </dd>
              </dl>
            </div>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              variant={item.requiresDirectorySelection ? "default" : "outline"}
              disabled={Boolean(actionRecoveryId)}
              aria-label={`${actionLabel}, ${item.displayCode}`}
              onClick={() => onRecover(item.recoveryId)}
            >
              {working ? (
                <Loader2 className="animate-spin" />
              ) : item.requiresDirectorySelection ? (
                <FolderOpen />
              ) : (
                <RefreshCw />
              )}
              {actionLabel}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function LoadingState() {
  const { t } = useTranslation("subtitle");
  return (
    <div className="flex min-h-[160px] items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {t("local_transcriber.overwrite_recovery.loading")}
    </div>
  );
}

function RecoveryFeedback({
  feedback,
}: {
  feedback: LocalSubtitleOverwriteRecoveryFeedback | null;
}) {
  const { t } = useTranslation("subtitle");
  if (!feedback) return null;
  if (feedback.kind === "error") return <RecoveryError code={feedback.code} />;

  return (
    <Alert>
      {feedback.kind === "recovered" ? <CheckCircle2 /> : <FolderOpen />}
      <AlertTitle>
        {feedback.kind === "cancelled"
          ? t("local_transcriber.overwrite_recovery.selection_cancelled")
          : feedback.outcome === "finalized"
            ? t(
                "local_transcriber.overwrite_recovery.settled.finalized",
              )
            : t(
                "local_transcriber.overwrite_recovery.settled.rolled_back",
              )}
      </AlertTitle>
    </Alert>
  );
}

export function RecoveryError({ code }: { code: string }) {
  const { t } = useTranslation("subtitle");
  let message: string;
  switch (code) {
    case "recovery_pending":
    case "output_write_failed":
      message = t(
        "local_transcriber.overwrite_recovery.error.recovery_pending",
      );
      break;
    case "directory_authorization_required":
    case "authorization_expired":
      message = t(
        "local_transcriber.overwrite_recovery.error.directory_authorization_required",
      );
      break;
    case "persistence_failed":
      message = t(
        "local_transcriber.overwrite_recovery.error.persistence_failed",
      );
      break;
    case "invalid_request":
    case "invalid_ipc_request":
      message = t(
        "local_transcriber.overwrite_recovery.error.invalid_request",
      );
      break;
    case "invalid_state":
    case "resource_busy":
      message = t(
        "local_transcriber.overwrite_recovery.error.invalid_state",
      );
      break;
    case "invalid_result":
    case "invalid_content":
      message = t(
        "local_transcriber.overwrite_recovery.error.invalid_result",
      );
      break;
    default:
      message = t("local_transcriber.overwrite_recovery.error.generic");
  }
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription className="text-destructive">
        {message}
      </AlertDescription>
    </Alert>
  );
}

export function isOverwriteRecoveryCandidateEvent(
  envelope: LocalSubtitleTaskEventEnvelope,
): boolean {
  if (envelope.event.type !== "task-updated") return false;
  const task = envelope.event.task;
  return (
    task.error?.code === "output_write_failed" ||
    task.artifactResults.some(
      (artifact) =>
        artifact.status !== "committed" &&
        artifact.errorCode === "output_write_failed",
    )
  );
}
