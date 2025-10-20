import React from "react";
import GeneralConfig from "./components/GeneralConfig";
import { useTranslation } from "react-i18next";
import ModelConfig from "./components/ModelConfig";

// TODO: 所有的设置均作为一个配置对象, 存储在用户本地, 应用初始化时优先加载
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

      <div className="flex flex-col gap-4">
        {/* 常规设置 (主题 + 语言) */}
        <GeneralConfig />
        {/* 模型设置 */}
        <ModelConfig />
        {/* 代理设置 */}
        {/* TODO */}
      </div>
    </div>
  );
};

export default Setting;
