import { useEffect, useRef } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MODEL_CONNECTION_TEST_TIMEOUT_MS, type ModelConnectionTestResult } from "@/model-setup/contract";
import { ModelErrorGuide } from "@/components/model-error/ModelErrorGuide";
import {
  CONNECTION_TEST_REASON_KEYS,
  type ModelErrorActionKind,
  type ModelErrorProfileHint,
} from "@/services/ai-error-guide";
import { cn } from "@/lib/utils";

export type ConnectionTestState =
  | { readonly status: "idle" }
  | { readonly status: "testing" }
  | { readonly status: "done"; readonly result: ModelConnectionTestResult };

/** The answer of a connection test: a spinner, the time it took, or why it failed and what to do. */
export function ConnectionTestStatus({ state, profile, excludeActions, onBeforeAction, context = "connection_test", className }: {
  state: ConnectionTestState;
  profile?: ModelErrorProfileHint;
  excludeActions?: readonly ModelErrorActionKind[];
  onBeforeAction?: () => void;
  /** The welcome wizard has no form fields to point at. */
  context?: "connection_test" | "wizard";
  className?: string;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const shown = state.status === "done" ? `${state.result.category}:${state.result.latencyMs}` : state.status;
  // The answer appears below the form, which may be scrolled out of view in a small window.
  useEffect(() => {
    if (shown === "idle") return;
    let frame = 0;
    const until = performance.now() + 600;
    const reveal = () => {
      root.current?.scrollIntoView({ block: "nearest" });
      if (performance.now() < until) frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  if (state.status === "idle") return null;
  if (state.status === "testing") {
    return (
      <div ref={root} role="status" data-testid="connection-test-status" data-state="testing" className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" />{t("setting:fields.connection_test.testing")}
      </div>
    );
  }
  const { result } = state;
  if (result.ok) {
    return (
      <div ref={root} role="status" data-testid="connection-test-status" data-state="ok" className={cn("flex items-center gap-2 rounded-smooth-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400", className)}>
        <CheckCircle2 className="size-3.5 shrink-0" />{t("setting:fields.connection_test.success", { ms: result.latencyMs })}
      </div>
    );
  }
  const reason = result.reason ? CONNECTION_TEST_REASON_KEYS[result.reason] : undefined;
  const detail = [result.httpStatus ? `HTTP ${result.httpStatus}` : "", result.detail ?? ""].filter(Boolean).join(" · ");
  return (
    <div ref={root} data-testid="connection-test-status" data-state="failed" data-reason={result.reason} className={className}>
      <ModelErrorGuide
        category={result.category === "ok" ? "unknown" : result.category}
        profile={profile}
        context={context}
        excludeActions={excludeActions}
        onBeforeAction={onBeforeAction}
        cause={reason ? t(reason.cause, { seconds: Math.round(MODEL_CONNECTION_TEST_TIMEOUT_MS / 1000) }) : undefined}
        next={reason && "next" in reason ? t(reason.next) : undefined}
        detail={detail || undefined}
        detailSource={result.detailSource ?? "service"}
        testId="connection-test-guide"
      />
    </div>
  );
}

export default ConnectionTestStatus;
