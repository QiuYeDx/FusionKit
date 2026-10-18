import { CircleHelp, Copy, Globe, Languages, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { helpPath } from "@/pages/Help/helpNavigation";
import { settingPath } from "@/pages/Setting/settingNavigation";
import type { LocalSubtitleError } from "@/type/localSubtitle";
import { showToast } from "@/utils/toast";
import { localSubtitleErrorView, type LocalSubtitleErrorTextKey } from "./localSubtitleErrorGuide";

export interface LocalSubtitleDisplayError {
  readonly code?: string;
  readonly stage?: string;
  readonly field?: string;
  readonly message: string;
}

const SUBTITLE_TRANSLATOR_PATH = "/tools/subtitle/translator";

/**
 * Why something failed and what to do next, in plain words for the error's code, with a button
 * where one helps. The original message, code, stage and field stay folded in the diagnostics,
 * ready to copy for a bug report. The page's own user-facing messages (bridge mismatch, failed
 * hand-off) are kept; other messages without a code are raw text and go to the diagnostics.
 */
export function LocalSubtitleErrorNotice({
  error,
  cause,
  guidance,
  cpuRetry,
}: {
  error: LocalSubtitleDisplayError | LocalSubtitleError;
  /** The cause in this place's own words; replaces the code's. */
  cause?: string;
  /** The next step for where the notice is shown; replaces the code's own next step. */
  guidance?: string;
  /** The "Retry on CPU" button is shown for this error, so the next step may point to it. */
  cpuRetry?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const view = localSubtitleErrorView(error, (key: LocalSubtitleErrorTextKey) => t(key), { cause, guidance, cpuRetry });
  const copy = () => {
    navigator.clipboard.writeText(view.diagnostics)
      .then(() => showToast(t("subtitle:local_transcriber.error_guide.copied"), "success"))
      .catch(() => showToast(t("common:error.copy_failed"), "error"));
  };
  const actionButton = "bg-background/80";
  return (
    <div
      data-testid="local-subtitle-error"
      data-code={error.code}
      className="w-full min-w-0 max-w-full overflow-hidden rounded-smooth-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs"
    >
      {view.headline ? (
        <div className="whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]">
          {view.headline}
        </div>
      ) : null}
      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {view.cause}
      </div>
      {view.next ? (
        <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">
          {view.next}
        </div>
      ) : null}
      {view.actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {view.actions.includes("open_network_settings") ? (
            <Button type="button" variant="outline" size="xs" className={actionButton} onClick={() => navigate(settingPath("proxy"))}>
              <Globe />{t("subtitle:local_transcriber.error_guide.open_network_settings")}
            </Button>
          ) : null}
          {view.actions.includes("open_model_settings") ? (
            <Button type="button" variant="outline" size="xs" className={actionButton} onClick={() => navigate(settingPath("model"))}>
              <Settings />{t("common:model_error.actions.open_model_settings")}
            </Button>
          ) : null}
          {view.actions.includes("open_translator") ? (
            <Button type="button" variant="outline" size="xs" className={actionButton} onClick={() => navigate(SUBTITLE_TRANSLATOR_PATH)}>
              <Languages />{t("subtitle:local_transcriber.error_guide.open_translator")}
            </Button>
          ) : null}
          {view.actions.includes("open_help") ? (
            <Button type="button" variant="outline" size="xs" className={actionButton} onClick={() => navigate(helpPath(view.helpSection))}>
              <CircleHelp />{t("common:action.view_help")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {view.diagnostics ? (
        <details data-testid="local-subtitle-error-details" className="mt-1.5 text-muted-foreground">
          <summary className="cursor-pointer select-none text-[11px] leading-4 hover:text-foreground">
            {t("subtitle:local_transcriber.error_guide.details")}
          </summary>
          <div className="mt-1.5 space-y-1.5">
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-smooth-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-4 [overflow-wrap:anywhere]">
              {view.diagnostics}
            </pre>
            <Button type="button" variant="ghost" size="xs" onClick={copy} className="text-muted-foreground">
              <Copy />{t("subtitle:local_transcriber.error_guide.copy")}
            </Button>
          </div>
        </details>
      ) : null}
    </div>
  );
}
