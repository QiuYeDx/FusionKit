import useLanguage from "@/hook/useLanguage";
import { useTranslation } from "react-i18next";

function LanguageConfig() {
  const { t } = useTranslation(); // 使用 useTranslation Hook 获取 t 函数
  const { language, changeLanguage } = useLanguage();

  return (
    <div className="bg-base-200 p-4 rounded-lg overflow-auto">
      <div className="text-xl font-semibold mb-4 sticky left-0">{t('language_config')}</div>

      <div className="join">
        <input
          className="join-item btn btn-sm bg-base-100"
          type="radio"
          name="language"
          aria-label="中文" // 固定显示“中文”
          checked={language === "zh"}
          onChange={() => changeLanguage("zh")}
        />
        <input
          className="join-item btn btn-sm bg-base-100 mt-[3px]"
          type="radio"
          name="language"
          aria-label="日本語" // 固定显示“日本語”
          checked={language === "ja"}
          onChange={() => changeLanguage("ja")}
        />
        <input
          className="join-item btn btn-sm bg-base-100 mt-[3px]"
          type="radio"
          name="language"
          aria-label="English" // 固定显示“English”
          checked={language === "en"}
          onChange={() => changeLanguage("en")}
        />
      </div>
    </div>
  );
}

export default LanguageConfig;