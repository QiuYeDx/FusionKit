import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

const Tools: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("tools:title")}</div>
      <div className="mb-6">
        <div className="text-gray-600 dark:text-gray-300">
          {t("tools:description")}
        </div>
      </div>

      {/* 字幕工具箱 */}
      <div className="flex flex-col gap-4 mb-14">
        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("tools:subtitle.subtitle_tools")}
          </div>

          <div>{t("tools:sub_desc.subtitle_tools")}</div>

          <div className="flex mt-4 gap-2">
            <div
              className="badge border-solid border-gray-400 select-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
              onClick={() => navigate("/tools/subtitle/translator")}
            >
              {/* 字幕AI翻译 */}
              {t("tools:fields.subtitle_translator")}
            </div>
            <div
              className="badge border-solid border-gray-400 select-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
              onClick={() => navigate("/tools/subtitle/converter")}
            >
              {/* 字幕格式转换 */}
              {t("tools:fields.subtitle_formatter")}
            </div>
            <div className="badge border-solid border-gray-400 select-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => navigate("/tools/subtitle/extractor")}>
              {/* 字幕语言提取 */}
              {t("tools:fields.subtitle_language_extractor")}
            </div>
          </div>
        </div>

        {/* 音乐工具箱 */}
        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("tools:subtitle.music_tools")}
          </div>

          <div>{t("tools:sub_desc.music_tools")}</div>

          <div className="flex mt-4 gap-2">
            <div className="badge border-solid border-gray-400 select-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
              Coming soon...
            </div>
          </div>
        </div>

        {/* 重命名工具箱 */}
        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("tools:subtitle.rename_tools")}
          </div>

          <div>{t("tools:sub_desc.rename_tools")}</div>

          <div className="flex mt-4 gap-2">
            <div className="badge border-solid border-gray-400 select-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
              Coming soon...
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Tools;
