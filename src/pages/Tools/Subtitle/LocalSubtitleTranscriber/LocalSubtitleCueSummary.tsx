import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { LocalSubtitleCueSummary as CueSummary } from "@/type/localSubtitle";

export function LocalSubtitleCueSummary({ summary }: { summary: CueSummary }) {
  const { t } = useTranslation(["subtitle"]);
  if (summary.exceedsTargetCount === 0) return null;
  const label = t("subtitle:local_transcriber.cue_summary.exceeds", { count: summary.exceedsTargetCount });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" tabIndex={0} aria-label={label}
          data-testid="local-subtitle-cue-summary"
          className="h-4 shrink-0 cursor-help px-1.5 text-[10px] font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          {summary.exceedsTargetCount}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 text-left leading-relaxed" sideOffset={6}>
        <p className="font-medium">{label}</p>
        <p>{t("subtitle:local_transcriber.cue_summary.explanation")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
