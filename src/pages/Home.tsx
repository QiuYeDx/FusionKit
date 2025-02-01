import { useTranslation } from "react-i18next";

function Home() {
  const { t } = useTranslation();

  return (
    <div className="p-6 bg-base-100 mb-12 overflow-visible">
      {/* 欢迎语 */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-gray-800 dark:text-gray-100 mb-4">
          {t("home:welcome")}
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-300">
          {t("home:home_description")}
        </p>
      </div>

      {/* 功能介绍 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* 字幕处理 */}
        <div className="bg-base-200 p-6 rounded-lg">
          <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-100 mb-4">
            {t("home:subtitle_tool_title")}
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            {t("home:subtitle_tool_description")}
          </p>
        </div>

        {/* 文件批量重命名 */}
        <div className="bg-base-200 p-6 rounded-lg">
          <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-100 mb-4">
            {t("home:rename_tool_title")}
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            {t("home:rename_tool_description")}
          </p>
        </div>

        {/* 付费音乐解密 */}
        <div className="bg-base-200 p-6 rounded-lg">
          <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-100 mb-4">
            {t("home:music_tool_title")}
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            {t("home:music_tool_description")}
          </p>
        </div>
      </div>

      {/* 跨平台支持 */}
      {/* <div className="text-center mt-8">
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-100 mb-4">
          {t("home:cross_platform_title")}
        </h2>
        <p className="text-gray-600 dark:text-gray-300 mb-4">
          {t("home:cross_platform_description")}
        </p>
        <div className="flex justify-center space-x-4">
          <span className="text-gray-600 dark:text-gray-300">Windows</span>
          <span className="text-gray-600 dark:text-gray-300">macOS</span>
          <span className="text-gray-600 dark:text-gray-300">Linux</span>
        </div>
      </div> */}

      {/* 操作按钮 */}
      {/* <div className="text-center mt-8">
        <button className="btn btn-primary mr-4">
          {t("home:get_started")}
        </button>
        <button className="btn btn-outline">
          {t("home:learn_more")}
        </button>
      </div> */}
    </div>
  );
}

export default Home;
