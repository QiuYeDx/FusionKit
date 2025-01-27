import React from "react";
import ThemeConfig from "./components/ThemeConfig";
import LanguageConfig from "./components/LanguageConfig";
import { useTranslation } from "react-i18next";

// TODO: 所有的设置均作为一个配置对象, 存储在用户本地, 应用初始化时优先加载
const Setting: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("setting")}</div>
      <div className="mb-6">
        <div className="text-gray-600 dark:text-gray-300">
          {t("setting_description")}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* 主题设置 */}
        <ThemeConfig />
        {/* 语言设置 */}
        <LanguageConfig />
      </div>
    </div>
  );
};

export default Setting;
