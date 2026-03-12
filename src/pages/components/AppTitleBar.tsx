import { useTranslation } from "react-i18next";

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
      <div
        className={`h-7 px-4 flex items-center justify-center rounded-full text-xs font-mono bg-background/60 backdrop-blur-md border border-border/40 select-none ${
          isWindows ? "app-region-no-drag relative min-w-[112px] group" : ""
        }`}
      >
        {isWindows ? (
          <>
            <span className="transition-opacity duration-150 group-hover:opacity-0">
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
          appName
        )}
      </div>
    </div>
  );
}

export default AppTitleBar;
