import { useTranslation } from "react-i18next";

const isMac = navigator.userAgent.includes("Mac");

function AppTitleBar() {
  const { t } = useTranslation();

  return (
    <div className="app-region-drag h-10 w-full fixed z-50 top-0 flex justify-center items-center">
      {isMac && (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2 h-7 w-[72px] rounded-full bg-background/60 backdrop-blur-md border border-border/40 pointer-events-none" />
      )}
      <div className="h-7 px-4 flex items-center rounded-full text-xs font-mono bg-background/60 backdrop-blur-md border border-border/40 select-none">
        {t("common:app_name", { defaultValue: "FusionKit" })}
      </div>
    </div>
  );
}

export default AppTitleBar;
