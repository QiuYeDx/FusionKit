import React from "react";
import { useTranslation } from "react-i18next";

const Tools: React.FC = () => {
  const { t, i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("tools:title")}</div>
      <div className="mb-6">
        <div className="text-gray-600 dark:text-gray-300">
          {t("tools:description")}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("tools:subtitle.subtitle_tools")}
          </div>

          <div>{t("tools:sub_desc.subtitle_tools")}</div>
        </div>

        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("tools:subtitle.music_tools")}
          </div>

          <div>{t("tools:sub_desc.music_tools")}</div>
        </div>

        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("tools:subtitle.rename_tools")}
          </div>

          <div>{t("tools:sub_desc.rename_tools")}</div>
        </div>
      </div>
    </div>
  );
};

export default Tools;
