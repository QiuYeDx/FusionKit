import useTheme from "@/hook/useTheme";
import { useTranslation } from "react-i18next";

function ThemeConfig() {
  const { t } = useTranslation(); // 使用 useTranslation Hook 获取 t 函数
  // 使用 useTheme Hook 获取当前主题和设置主题的函数
  const { theme, setTheme } = useTheme();

  return (
    <div className="bg-base-200 p-4 rounded-lg overflow-auto">
      <div className="text-xl font-semibold mb-4 sticky left-0">{t("theme_config")}</div>

      <div className="join">
        <input
          className="join-item btn btn-sm bg-base-100"
          type="radio"
          name="theme"
          aria-label={t('light_mode')}
          checked={theme === "light"}
          onChange={() => setTheme("light")}
        />
        <input
          className="join-item btn btn-sm bg-base-100 mt-[3px]"
          type="radio"
          name="theme"
          aria-label={t('dark_mode')}
          checked={theme === "dark"}
          onChange={() => setTheme("dark")}
        />
        <input
          className="join-item btn btn-sm bg-base-100 mt-[3px]"
          type="radio"
          name="theme"
          aria-label={t('system_mode')}
          checked={theme === "system"}
          onChange={() => setTheme("system")}
        />
      </div>
    </div>
  );
}

export default ThemeConfig;
