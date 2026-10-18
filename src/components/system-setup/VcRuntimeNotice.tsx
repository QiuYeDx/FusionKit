import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, LoaderCircle, RefreshCw, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { helpPath } from "@/pages/Help/helpNavigation";
import { openExternalPage } from "@/services/ai-error-guide";
import { getSystemSetupStore, useSystemSetup, vcRuntimeNeedsRepair } from "@/services/system-setup/system-setup-store";
import { VC_REDIST_DOWNLOAD_URL } from "@/system-setup/contract";

export interface VcRuntimeNoticeProps {
  /** Runs once a repair leaves the runtime in place (for example to start the download that waited). */
  onRepaired?: () => void;
  /** Extra wording for where the notice is shown (for example why a download waits). */
  description?: string;
  /**
   * Shows "View help" (the help on failed transcriptions); runs before leaving, for example to
   * close the dialog the notice is in. Left out where leaving would lose what is going on.
   */
  onHelp?: () => void;
  className?: string;
  testId?: string;
}

/**
 * "Microsoft runtime needed" with a one-click repair, on Windows only when the VC++ runtime is
 * missing or too old. Renders nothing otherwise; after a repair that needs a restart it says so.
 */
export function VcRuntimeNotice({ onRepaired, description, onHelp, className, testId = "vc-runtime-notice" }: VcRuntimeNoticeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { vc, vcChecking, repairing, repair } = useSystemSetup({ vc: true });
  const setup = getSystemSetupStore();
  const needed = vcRuntimeNeedsRepair(vc);
  const restart = !needed && repair?.outcome === "restart_required";
  if (!needed && !restart) return null;

  if (restart) {
    return (
      <div role="status" data-testid={testId} data-state="restart" className={cn("flex min-w-0 items-start gap-2 rounded-smooth-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs leading-5 text-emerald-800 dark:text-emerald-300", className)}>
        <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t("common:system_setup.vc_runtime.restart_required")}</p>
      </div>
    );
  }

  const run = async () => {
    const result = await setup.repairVcRuntime();
    if (result && result.outcome !== "opened_download" && !vcRuntimeNeedsRepair(result.status)) onRepaired?.();
  };
  const outcome = repair?.outcome;
  const result = outcome === "cancelled" ? "common:system_setup.vc_runtime.cancelled"
    : outcome === "failed" || outcome === "installed" ? "common:system_setup.vc_runtime.failed"
      : outcome === "opened_download" ? "common:system_setup.vc_runtime.opened_download" : undefined;
  const cause = vc?.status === "outdated" && vc.installedVersion && vc.requiredVersion
    ? t("common:system_setup.vc_runtime.outdated", { installed: vc.installedVersion, required: vc.requiredVersion })
    : t("common:system_setup.vc_runtime.missing");
  return (
    <div role="alert" data-testid={testId} data-state={vc?.status} className={cn("flex min-w-0 items-start gap-2 rounded-smooth-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300", className)}>
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium [overflow-wrap:anywhere]">{t("common:system_setup.vc_runtime.title")}</p>
        <p className="text-amber-700/90 dark:text-amber-300/85 [overflow-wrap:anywhere]">{cause}</p>
        <p className="text-amber-700/90 dark:text-amber-300/85 [overflow-wrap:anywhere]">
          {repairing ? t("common:system_setup.vc_runtime.repairing_hint")
            : t(vc?.bundled === false ? "common:system_setup.vc_runtime.next_download" : "common:system_setup.vc_runtime.next")}
        </p>
        {description && <p className="text-amber-700/90 dark:text-amber-300/85 [overflow-wrap:anywhere]">{description}</p>}
        {result && !repairing && <p data-testid={`${testId}-result`} data-outcome={outcome} className="font-medium [overflow-wrap:anywhere]">{t(result)}</p>}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <Button type="button" size="xs" data-testid={`${testId}-repair`} disabled={repairing} onClick={() => void run()}>
            {repairing ? <LoaderCircle className="animate-spin" /> : <Wrench />}
            {t(repairing ? "common:system_setup.vc_runtime.repairing" : "common:system_setup.vc_runtime.repair")}
          </Button>
          {(outcome === "failed" || outcome === "installed") && !repairing && (
            <Button type="button" variant="outline" size="xs" className="bg-background/80 text-foreground" onClick={() => openExternalPage(VC_REDIST_DOWNLOAD_URL)}>
              <ExternalLink />{t("common:system_setup.vc_runtime.manual_download")}
            </Button>
          )}
          {/* After installing it by hand (the download page, or "Download manually" after a failure). */}
          {(outcome === "opened_download" || outcome === "failed" || outcome === "installed") && !repairing && (
            <Button type="button" variant="outline" size="xs" data-testid={`${testId}-check-again`} className="bg-background/80 text-foreground" disabled={vcChecking}
              onClick={() => void setup.checkVcRuntime({ force: true }).then((status) => { if (status && !vcRuntimeNeedsRepair(status)) onRepaired?.(); })}>
              <RefreshCw className={vcChecking ? "animate-spin" : undefined} />{t("common:system_setup.vc_runtime.check_again")}
            </Button>
          )}
          {onHelp && (
            <Button type="button" variant="outline" size="xs" data-testid={`${testId}-help`} className="bg-background/80 text-foreground"
              onClick={() => { onHelp(); navigate(helpPath("transcription-failed")); }}>
              <CircleHelp />{t("common:action.view_help")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The notice above a whole tool page (the classic transcriber, whose own page is frozen), aligned
 * with the page's content column. Takes no space while the runtime is fine.
 */
export function VcRuntimePageNotice({ testId = "page-vc-runtime-notice" }: { testId?: string }) {
  const { vc, repair } = useSystemSetup({ vc: true });
  if (!vcRuntimeNeedsRepair(vc) && repair?.outcome !== "restart_required") return null;
  return (
    <div className="mx-auto max-w-7xl px-4 pt-[var(--tool-page-header-inset)] sm:px-8">
      <VcRuntimeNotice testId={testId} onHelp={() => undefined} />
    </div>
  );
}

export default VcRuntimeNotice;
