import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { CONFIRMATION_ITEMS_SHOWN, useExternalConfirmationsStore } from "@/agent/external/confirmations";

/**
 * Asks the user, on whatever page is open, whether an external agent may do
 * something. One request at a time, oldest first; closing the dialog declines.
 */
export default function ExternalAgentConfirmDialog() {
  const { t } = useTranslation("setting");
  const requests = useExternalConfirmationsStore((state) => state.requests);
  const decide = useExternalConfirmationsStore((state) => state.decide);
  const open = requests.filter((item) => item.status === "pending" || item.status === "running");
  const request = open[0];
  const [allowSession, setAllowSession] = useState(false);
  const checkboxId = useId();
  // Each request starts unticked.
  useEffect(() => { setAllowSession(false); }, [request?.id]);

  const running = request?.status === "running";
  const decline = () => { if (request && !running) decide(request.id, false); };
  const shown = request?.items.slice(0, CONFIRMATION_ITEMS_SHOWN) ?? [];
  const hidden = request ? request.items.length - shown.length : 0;
  const values = request ? { ...request.values, content: request.content ? t(`external_agent.confirm.content.${request.content}`) : "" } : {};

  return (
    <ScrollableDialog
      animateSize
      open={!!request}
      onOpenChange={(next) => { if (!next) decline(); }}
      contentClassName="external-agent-confirm-dialog"
      onOpenAutoFocus={(event) => { event.preventDefault(); document.getElementById("external-agent-confirm-decline")?.focus(); }}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      {request && <>
        <ScrollableDialogHeader>
          <div className="flex items-baseline justify-between gap-3 pr-6">
            <DialogTitle className="min-w-0 break-words">{t("external_agent.confirm.title", { client: request.client, action: t(`external_agent.confirm.action.${request.action}`) })}</DialogTitle>
            {open.length > 1 && <span className="shrink-0 text-xs text-muted-foreground" data-testid="external-agent-confirm-queue">{t("external_agent.confirm.queue", { count: open.length - 1 })}</span>}
          </div>
          <DialogDescription>{t(`external_agent.confirm.summary.${request.summary}`, values)}</DialogDescription>
        </ScrollableDialogHeader>
        <ScrollableDialogContent>
          <div className="flex flex-col gap-3">
            {request.warning === "overwrite" && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{t("external_agent.confirm.overwrite_warning")}</AlertDescription>
              </Alert>
            )}
            {shown.length > 0 && (
              <ul className="divide-y rounded-md border bg-muted/30 text-sm" data-testid="external-agent-confirm-items">
                {shown.map((item, index) => (
                  <li key={index} className="flex items-start gap-2 px-3 py-2">
                    {item.tag && <span className="mt-0.5 shrink-0 rounded border px-1.5 py-px text-[11px] leading-4 text-muted-foreground">{t(`external_agent.confirm.tag.${item.tag}`)}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="break-words whitespace-pre-line">{item.text}</div>
                      {item.detail && <div className="mt-0.5 text-xs break-all text-muted-foreground">{item.detail}</div>}
                    </div>
                  </li>
                ))}
                {hidden > 0 && <li className="px-3 py-2 text-muted-foreground">{t("external_agent.confirm.more", { count: hidden })}</li>}
              </ul>
            )}
          </div>
        </ScrollableDialogContent>
        <ScrollableDialogFooter>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {request.sessionGrant ? (
              <div className="flex min-w-0 items-center gap-2">
                <Checkbox id={checkboxId} checked={allowSession} disabled={running} onCheckedChange={(value) => setAllowSession(value === true)} />
                <Label htmlFor={checkboxId} className="text-sm font-normal leading-snug">{t("external_agent.confirm.allow_session")}</Label>
              </div>
            ) : <span className="hidden sm:block" />}
            <div className="flex shrink-0 justify-end gap-2">
              <Button id="external-agent-confirm-decline" variant="outline" disabled={running} onClick={decline}>{t("external_agent.confirm.decline")}</Button>
              <Button variant={request.destructive ? "destructive" : "default"} disabled={running} data-testid="external-agent-confirm-allow"
                onClick={() => decide(request.id, true, { allowSession })}>
                {running && <Loader2 className="animate-spin" />}
                {t("external_agent.confirm.allow")}
              </Button>
            </div>
          </div>
        </ScrollableDialogFooter>
      </>}
    </ScrollableDialog>
  );
}
