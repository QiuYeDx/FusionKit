import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, History, Info, Loader2, RotateCcw, Settings, X, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { NameUnrecoveredEntry } from "@/name-translation/contract";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";

function UnrecoveredList({ items }: { items: readonly NameUnrecoveredEntry[] }) {
  const { t } = useTranslation("rename");
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs leading-5">
      {items.map((item, index) => (
        <li key={`${item.currentPath}:${index}`} className="[overflow-wrap:anywhere]">
          {item.currentPath ? t("outcome.unrecovered_item", { current: item.currentPath, expected: item.expectedPath }) : null}
          <span className="text-muted-foreground"> {item.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function NameTranslatorBanners({ modelReady }: { modelReady: boolean }) {
  const { t } = useTranslation("rename");
  const navigate = useNavigate();
  const outcome = useNameTranslatorStore((state) => state.outcome);
  const recovery = useNameTranslatorStore((state) => state.recovery);
  const recoveryBusy = useNameTranslatorStore((state) => state.recoveryBusy);
  const translationError = useNameTranslatorStore((state) => state.translationError);
  const notice = useNameTranslatorStore((state) => state.notice);
  const store = useNameTranslatorStore.getState;

  return (
    <>
      {!modelReady ? (
        <Alert>
          <Info className="size-4" />
          <AlertTitle>{t("model.missing_title")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("model.missing_description")}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => navigate("/setting?tab=model")}>
              <Settings />
              {t("model.open_settings")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {recovery.map((journal) => (
        <Alert key={journal.journalId} variant="destructive" data-testid="name-translator-recovery">
          <History className="size-4" />
          <AlertTitle>{t("recovery.title")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {t("recovery.description", {
                time: new Date(journal.createdAt).toLocaleString(),
                count: journal.stepCount - journal.undoneCount,
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(recoveryBusy)}
                onClick={() => void store().resolveRecovery(journal.journalId, "undo")}
              >
                {recoveryBusy === journal.journalId ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {t("recovery.restore")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={Boolean(recoveryBusy)}
                onClick={() => void store().resolveRecovery(journal.journalId, "dismiss")}
              >
                {t("recovery.keep")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}

      {outcome?.kind === "completed" ? (
        <Alert data-testid="name-translator-outcome" className="border-emerald-500/30">
          {outcome.undoState === "done" ? <RotateCcw className="size-4" /> : <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />}
          <AlertTitle className="flex items-center justify-between gap-2">
            <span>
              {outcome.undoState === "done"
                ? t("outcome.undone", { count: outcome.renamed.length })
                : outcome.undoState === "partial"
                  ? t("outcome.undo_partial")
                  : t("outcome.completed", { count: outcome.renamed.length })}
            </span>
          </AlertTitle>
          <AlertDescription>
            {outcome.undoState === "partial" ? <UnrecoveredList items={outcome.undoFailures ?? []} /> : null}
            <div className="mt-1 flex flex-wrap gap-2">
              {outcome.undoState !== "done" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={outcome.undoState === "running"}
                  onClick={() => void store().undoLast()}
                >
                  {outcome.undoState === "running" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {outcome.undoState === "partial" ? t("outcome.retry_undo") : t("outcome.undo")}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={() => store().dismissOutcome()}>
                {t("outcome.dismiss")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {outcome?.kind === "failed" ? (
        <Alert variant="destructive" data-testid="name-translator-outcome">
          <XCircle className="size-4" />
          <AlertTitle className="flex items-start justify-between gap-2">
            <span>{outcome.rollback === "complete" ? t("outcome.failed_rolled_back") : t("outcome.failed_partial")}</span>
            <button type="button" aria-label={t("outcome.dismiss")} onClick={() => store().dismissOutcome()} className="rounded p-0.5 opacity-70 hover:opacity-100">
              <X className="size-3.5" />
            </button>
          </AlertTitle>
          <AlertDescription>
            <p className="[overflow-wrap:anywhere]">{t("outcome.failed_at", { path: outcome.failedPath, message: outcome.message })}</p>
            <UnrecoveredList items={outcome.unrecovered} />
          </AlertDescription>
        </Alert>
      ) : null}

      {translationError && translationError.message !== "missing_task_model" ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle className="flex items-start justify-between gap-2">
            <span>{t(`errors.${translationError.code}`, { defaultValue: t("errors.internal") })}</span>
            <button
              type="button"
              aria-label={t("outcome.dismiss")}
              onClick={() => useNameTranslatorStore.setState({ translationError: null })}
              className="rounded p-0.5 opacity-70 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </AlertTitle>
          <AlertDescription className="[overflow-wrap:anywhere]">{translationError.message}</AlertDescription>
        </Alert>
      ) : null}

      {notice?.kind === "truncated" ? (
        <Alert>
          <Info className="size-4" />
          <AlertTitle className="flex items-start justify-between gap-2">
            <span>{t("notice.truncated_title")}</span>
            <button
              type="button"
              aria-label={t("outcome.dismiss")}
              onClick={() => useNameTranslatorStore.setState({ notice: null })}
              className="rounded p-0.5 opacity-70 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </AlertTitle>
          <AlertDescription className="[overflow-wrap:anywhere]">{t("notice.truncated", { path: notice.path })}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
