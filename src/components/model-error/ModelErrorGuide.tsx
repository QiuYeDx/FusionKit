import { AlertTriangle, CircleHelp, ExternalLink, Globe, Settings, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { ModelErrorCategory } from "@/lib/model-error-category";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  MODEL_ERROR_ACTION_LABEL_KEYS,
  modelErrorActionTarget,
  modelErrorGuide,
  openExternalPage,
  type ModelErrorActionKind,
  type ModelErrorContext,
  type ModelErrorProfileHint,
} from "@/services/ai-error-guide";

const ACTION_ICONS = {
  open_model_settings: Settings,
  open_network_settings: Globe,
  open_deepseek_keys: ExternalLink,
  open_deepseek_topup: Wallet,
  open_help: CircleHelp,
} as const satisfies Record<ModelErrorActionKind, unknown>;

export interface ModelErrorGuideProps {
  category: ModelErrorCategory;
  /** The profile the failed request used; DeepSeek gets its key and top-up links. */
  profile?: ModelErrorProfileHint;
  /** Runs before a button leaves the current place (for example to close a dialog). */
  onBeforeAction?: () => void;
  /** Hides the cause line when the surrounding text already says it. */
  hideCause?: boolean;
  /** Buttons that make no sense here (for example "open model settings" inside the model settings). */
  excludeActions?: readonly ModelErrorActionKind[];
  /** Where the advice is shown; next steps that would point to the current place are worded for it. */
  context?: ModelErrorContext;
  /** Exact wording that replaces the category's general cause and next step (a connection test that knows why it stopped). */
  cause?: string;
  next?: string;
  /** The provider's or the connection's own words, shown small under the advice. */
  detail?: string;
  /** Whose words the detail are: the service's answer (default) or what the connection reported. */
  detailSource?: "service" | "connection";
  className?: string;
  testId?: string;
}

/** Why a model request failed and what to do next, with a button for that step. */
export function ModelErrorGuide({ category, profile, onBeforeAction, hideCause, excludeActions, context, cause, next, detail, detailSource = "service", className, testId = "model-error-guide" }: ModelErrorGuideProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const guide = modelErrorGuide(category, profile, context);
  const actions = guide.actions.filter((kind) => !excludeActions?.includes(kind));
  const run = (kind: ModelErrorActionKind) => {
    const target = modelErrorActionTarget(kind, category);
    if (target.kind === "external") { openExternalPage(target.url); return; }
    onBeforeAction?.();
    navigate(target.to);
  };
  return (
    <div
      role="alert"
      data-testid={testId}
      data-category={category}
      className={cn("flex min-w-0 items-start gap-2 rounded-smooth-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300", className)}
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-1">
        {!hideCause && <p className="font-medium [overflow-wrap:anywhere]">{cause ?? t(guide.causeKey)}</p>}
        <p className="text-amber-700/90 dark:text-amber-300/85 [overflow-wrap:anywhere]">{next ?? t(guide.nextKey)}</p>
        {detail && (
          <p data-testid={`${testId}-detail`} data-source={detailSource} className="text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {t(detailSource === "connection" ? "common:model_error.connection_detail" : "common:model_error.detail", { detail })}
          </p>
        )}
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {actions.map((kind) => {
              const Icon = ACTION_ICONS[kind];
              return (
                <Button key={kind} type="button" variant="outline" size="xs" data-action={kind} onClick={() => run(kind)}
                  className="bg-background/80 text-foreground">
                  <Icon />{t(MODEL_ERROR_ACTION_LABEL_KEYS[kind])}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ModelErrorGuide;
