import {useTranslation} from "react-i18next";
import type {LocalSubtitleCueSummary as CueSummary} from "@/type/localSubtitle";

export function LocalSubtitleCueSummary({summary}: {summary: CueSummary}) {
  const {t} = useTranslation(["subtitle"]);
  return <div className="mt-2 min-w-0 text-xs leading-relaxed text-muted-foreground" data-testid="local-subtitle-cue-summary">
    <p>{t("subtitle:local_transcriber.cue_summary.total", {count:summary.cueCount})}</p>
    {summary.exceedsTargetCount > 0 ? <details className="mt-1">
      <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {t("subtitle:local_transcriber.cue_summary.exceeds", {count:summary.exceedsTargetCount})}
      </summary>
      <p className="mt-1 max-w-prose">{t("subtitle:local_transcriber.cue_summary.explanation")}</p>
    </details> : null}
  </div>;
}
