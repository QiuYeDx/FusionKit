import React from "react";
import GeneralConfig from "./components/GeneralConfig";
import { useTranslation } from "react-i18next";
import ModelConfig from "./components/ModelConfig";
import ProxyConfig from "./components/ProxyConfig";

const Setting: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("setting:title")}</div>
      <div className="mb-6">
        <div className="text-muted-foreground">
          {t("setting:description")}
        </div>
      </div>

      <div className="flex flex-col gap-4 pb-[42px]">
        {/* 常规设置 (主题 + 语言) */}
        <GeneralConfig />
        {/* 代理设置 */}
        <ProxyConfig />
        {/* 模型设置 */}
        <ModelConfig />
      </div>
    </div>
  );
};

export default Setting;
