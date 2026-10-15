import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useExternalAgentStore } from "@/agent/external/store";
import { useExternalConfirmationsStore } from "@/agent/external/confirmations";
import { unseenTotal, useExternalActivityStore } from "@/agent/external/activity-store";
import { externalActivityPath } from "@/pages/ExternalAgentActivity/route";
import { cn } from "@/lib/utils";

const isMac = navigator.userAgent.includes("Mac");
const isWindows = navigator.userAgent.includes("Windows");

type WindowControlAction = "close" | "minimize" | "toggle-maximize";

const WINDOWS_TRAFFIC_LIGHTS: ReadonlyArray<{
  action: WindowControlAction;
  ariaLabel: string;
  colorClassName: string;
}> = [
  { action: "close", ariaLabel: "关闭窗口", colorClassName: "bg-[#FF5F57]" },
  { action: "minimize", ariaLabel: "最小化窗口", colorClassName: "bg-[#FEBC2E]" },
  { action: "toggle-maximize", ariaLabel: "最大化或还原窗口", colorClassName: "bg-[#28C840]" },
];

/**
 * A small capsule left of the app name: connected external agents, whether one is
 * working or waiting for a yes, and how many changes ran without asking since the
 * activity page was last open. Clicking opens that page.
 */
function ExternalAgentIndicator() {
  const { t } = useTranslation("setting");
  const navigate = useNavigate();
  const sessions = useExternalAgentStore((state) => state.status?.sessions);
  const running = useExternalAgentStore((state) => state.running);
  const waiting = useExternalConfirmationsStore((state) => state.requests.some((item) => item.status === "pending"));
  const unseen = useExternalActivityStore((state) => state.unseen);
  const total = unseenTotal({ unseen });
  const count = sessions?.length ?? 0;
  if (!count && !total) return null;
  const target = Object.entries(unseen).find(([, value]) => value > 0)?.[0] ?? (count === 1 ? sessions![0].id : undefined);
  const name = count === 1 ? sessions![0].client.name : count > 1 ? t("external_agent.activity.titlebar.connections", { count }) : null;
  const label = [
    count ? t("external_agent.titlebar", { count }) : null,
    total ? t("external_agent.activity.titlebar.unseen", { count: total }) : null,
    waiting ? t("external_agent.activity.titlebar.pending") : running ? t("external_agent.activity.titlebar.running") : null,
    t("external_agent.activity.titlebar.open"),
  ].filter(Boolean).join(" · ");
  return (
    <button type="button" onClick={() => navigate(externalActivityPath(target))} aria-label={label} title={label} data-testid="titlebar-external-agent"
      data-state={waiting ? "waiting" : running ? "running" : count ? "connected" : "idle"}
      className="app-region-no-drag flex h-7 max-w-48 items-center gap-1.5 rounded-full border border-border/40 bg-background/60 px-2.5 text-xs backdrop-blur-md transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full",
        waiting ? "bg-amber-500" : count ? "bg-emerald-500" : "bg-muted-foreground/50",
        running && !waiting && "animate-pulse motion-reduce:animate-none")} />
      {name && <span className="min-w-0 truncate font-mono">{name}</span>}
      {total > 0 && <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground" data-testid="titlebar-external-unseen">{total > 99 ? "99+" : total}</span>}
    </button>
  );
}

function AppTitleBar() {
  const { t } = useTranslation();
  const appName = t("common:app_name", { defaultValue: "FusionKit" });

  const handleWindowControl = async (action: WindowControlAction) => {
    try {
      await window.ipcRenderer.invoke("window-control", action);
    } catch (error) {
      console.error("[AppTitleBar] window control failed:", error);
    }
  };

  return (
    <div className="app-region-drag h-10 w-full fixed z-50 top-0 flex justify-center items-center">
      {isMac && (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2 h-7 w-[72px] rounded-full bg-background/60 backdrop-blur-md border border-border/40 pointer-events-none" />
      )}
      {/* Left of the name, so the name stays centred and Windows' hover buttons never cover it. */}
      <div className="relative flex items-center">
      <div className="absolute right-full top-1/2 mr-2 -translate-y-1/2">
        <ExternalAgentIndicator />
      </div>
      <div
        className={`h-7 px-4 flex items-center justify-center rounded-full text-xs font-mono bg-background/60 backdrop-blur-md border border-border/40 select-none ${
          isWindows ? "app-region-no-drag relative min-w-[112px] group" : ""
        }`}
      >
        {isWindows ? (
          <>
            <span className="flex items-center transition-opacity duration-150 group-hover:opacity-0">
              {appName}
            </span>
            <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto">
              {WINDOWS_TRAFFIC_LIGHTS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  aria-label={item.ariaLabel}
                  title={item.ariaLabel}
                  className={`h-3 w-3 rounded-full border border-black/10 ${item.colorClassName} transition-transform duration-150 hover:scale-110 active:scale-95`}
                  onClick={() => void handleWindowControl(item.action)}
                />
              ))}
            </div>
          </>
        ) : (
          <span className="flex items-center">{appName}</span>
        )}
      </div>
      </div>
    </div>
  );
}

export default AppTitleBar;
