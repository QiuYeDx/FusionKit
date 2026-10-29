import { useTranslation } from "react-i18next";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { HardwareEncoderFamily, VideoEncoderId } from "@/media-converter/contract";
import {
  hardwareEncodeRunning,
  mediaErrorCodeOf,
  type MediaConverterController,
  type MediaConverterState,
} from "@/services/media-converter/controller";
import { showToast } from "@/utils/toast";
import {
  ENGINE_ADVICE_LABELS,
  ENGINE_UNAVAILABLE_LABELS,
  HARDWARE_FAMILY_LABELS,
  encoderLabel,
  engineUnavailableCode,
  hardwareFamilyOf,
  requestErrorLabel,
} from "./labels";

type EngineView =
  | { kind: "detecting" }
  | { kind: "ready"; families: HardwareEncoderFamily[]; encoders: VideoEncoderId[]; degraded: VideoEncoderId[];
    driverUpdates: Array<{ family: HardwareEncoderFamily; minimumVersion: string | null }> }
  | { kind: "unavailable"; code: ReturnType<typeof engineUnavailableCode> };

/** What the header says about the engine: the runtime's failure first, then the encoder detection. */
export function engineView(state: MediaConverterState): EngineView {
  if (state.phase === "failed") return { kind: "unavailable", code: engineUnavailableCode(state.error ?? "unknown") };
  const engine = state.engine;
  if (!engine) return { kind: "detecting" };
  if (engine.runtime.state === "unavailable") return { kind: "unavailable", code: engineUnavailableCode(engine.runtime.code) };
  const capabilities = engine.capabilities;
  if (capabilities.state === "unavailable") return { kind: "unavailable", code: engineUnavailableCode(capabilities.code) };
  if (capabilities.state !== "ready") return { kind: "detecting" };
  const families: HardwareEncoderFamily[] = [];
  for (const encoder of capabilities.hardwareEncoders) {
    const family = hardwareFamilyOf(encoder);
    if (family && !families.includes(family)) families.push(family);
  }
  return { kind: "ready", families, encoders: [...capabilities.hardwareEncoders], degraded: [...capabilities.degraded], driverUpdates: [...capabilities.driverUpdates] };
}

const DOT = "size-1.5 shrink-0 rounded-full";

/**
 * The engine status in the page header (AC-WORKBENCH-05-1): detecting, ready with the hardware
 * encoders (or CPU only), or unavailable with the reason; details and advice in its tooltip.
 * "Detect again" sits next to it and is unavailable while a hardware encode runs.
 */
export function EngineStatusBadge({ state, controller }: { state: MediaConverterState; controller: MediaConverterController }) {
  const { t } = useTranslation("media");
  const view = engineView(state);
  const hardwareBusy = hardwareEncodeRunning(state);
  const detecting = view.kind === "detecting" && state.phase !== "idle";
  const redetectBlocked = hardwareBusy || detecting || state.redetecting || state.phase === "loading";
  const warn = view.kind === "ready" && view.driverUpdates.length > 0;

  const label = view.kind === "detecting"
    ? t("engine.detecting")
    : view.kind === "unavailable"
      ? t("engine.unavailable_label", { reason: t(ENGINE_UNAVAILABLE_LABELS[view.code]) })
      : view.families.length
        ? view.families.map(family => t(HARDWARE_FAMILY_LABELS[family])).join(" · ")
        : t("engine.cpu_only");

  const redetect = () => {
    // Without a snapshot there is nothing to detect again: read it again instead.
    const pending = state.phase === "failed" ? controller.load() : controller.redetect();
    pending.catch(error => showToast(t(mediaErrorCodeOf(error) === "busy" ? "engine.redetect_busy" : requestErrorLabel(mediaErrorCodeOf(error))), "error"));
  };

  return (
    // The same 8px between the badge and the icon button as the model badge of the other tool headers.
    <div className="flex min-w-0 items-center gap-2" data-testid="media-engine-status" data-state={view.kind} data-warning={warn ? "true" : undefined}>
      {/* Announces the state as it changes (detecting → ready), without the button's own name. */}
      <span className="sr-only" role="status" aria-live="polite">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge asChild variant={view.kind === "unavailable" ? "destructive" : "secondary"} className="h-6 max-w-[16rem] gap-1.5 px-2.5 font-normal">
            <button type="button" data-testid="media-engine-badge">
              {view.kind === "detecting" ? (
                <LoaderCircle aria-hidden className="animate-spin text-muted-foreground motion-reduce:animate-none" />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    DOT,
                    view.kind === "unavailable" ? "bg-destructive" : warn ? "bg-amber-500" : "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]",
                  )}
                />
              )}
              <span className="min-w-0 truncate text-[11px]">{label}</span>
            </button>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal text-left [text-wrap:pretty]" data-testid="media-engine-details">
          <EngineDetails view={view} />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events: the wrapper keeps its tooltip reachable. */}
          <span className="inline-flex" tabIndex={redetectBlocked ? 0 : undefined} data-testid="media-engine-redetect-wrapper">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              data-testid="media-engine-redetect"
              aria-label={t("engine.redetect")}
              disabled={redetectBlocked}
              onClick={redetect}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" data-testid="media-engine-redetect-tooltip" className="max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal">
          {hardwareBusy ? t("engine.redetect_busy") : detecting || state.redetecting ? t("engine.detecting") : t("engine.redetect")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function EngineDetails({ view }: { view: EngineView }) {
  const { t } = useTranslation("media");
  if (view.kind === "detecting") return <p>{t("engine.detecting_detail")}</p>;
  if (view.kind === "unavailable") {
    return (
      <div className="space-y-1">
        <p className="font-medium">{t(ENGINE_UNAVAILABLE_LABELS[view.code])}</p>
        <p className="opacity-80">{t(ENGINE_ADVICE_LABELS[view.code])}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {view.encoders.length ? (
        <div>
          <p className="font-medium">{t("engine.hardware_title")}</p>
          <ul className="opacity-80" data-testid="media-engine-encoders">{view.encoders.map(encoder => <li key={encoder}>{t(encoderLabel(encoder))}</li>)}</ul>
        </div>
      ) : (
        <p>{t("engine.cpu_only_detail")}</p>
      )}
      {view.degraded.length > 0 && <p className="opacity-80">{t("engine.degraded", { encoders: view.degraded.map(encoder => t(encoderLabel(encoder))).join(t("engine.list_separator")) })}</p>}
      {view.driverUpdates.map(update => (
        <p key={update.family} data-testid="media-engine-driver-update">
          {update.minimumVersion
            ? t("engine.driver_update_version", { family: t(HARDWARE_FAMILY_LABELS[update.family]), version: update.minimumVersion })
            : t("engine.driver_update", { family: t(HARDWARE_FAMILY_LABELS[update.family]) })}
        </p>
      ))}
    </div>
  );
}

export default EngineStatusBadge;
