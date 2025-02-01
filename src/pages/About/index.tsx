import React from "react";
import { useTranslation } from "react-i18next";

const About: React.FC = () => {
  const { t, i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("about:title")}</div>
      <div className="mb-6">
        <div className="text-gray-600 dark:text-gray-300">
          {t("about:description")}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("about:subtitle.version")}
          </div>

          <div>0.1.0</div>
        </div>

        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("about:subtitle.author")}
          </div>

          <div>
            <a
              href="https://github.com/qiuyedx"
              target="_blank"
              className="link link-hover"
            >
              QiuYeDx
            </a>
          </div>
        </div>

        <div className="bg-base-200 p-4 rounded-lg overflow-auto">
          <div className="text-xl font-semibold mb-4 sticky left-0">
            {t("about:subtitle.contact")}
          </div>

          <div>
            <a href="mailto:me@qiueydx.com" className="link link-hover">
              me@qiuyedx.com
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default About;
