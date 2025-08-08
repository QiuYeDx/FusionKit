import { useTranslation } from "react-i18next";

function AppTitleBar() {
  const { t } = useTranslation();
  // TODO: macOS 高度 24px, Windows 下的高度待确认, 可能需要为动态高度
  return (
    <div className="app-region-drag glass h-6 w-full fixed z-50 top-0 flex justify-center items-center text-xs font-mono">
      {t("common:app_name", { defaultValue: "FusionKit" })}
    </div>
  );
}

export default AppTitleBar;
