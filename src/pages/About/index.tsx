import React from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const About: React.FC = () => {
  const { t, i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("about:title")}</div>
      <div className="mb-6">
        <div className="text-muted-foreground">
          {t("about:description")}
        </div>
      </div>

      <div className="flex flex-col gap-4 mb-16">
        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("about:subtitle.version")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div>0.1.3</div>
          </CardContent>
        </Card>

        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("about:subtitle.github")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <a
              href="https://github.com/QiuYeDx/FusionKit"
              target="_blank"
              className="text-primary hover:underline"
            >
              https://github.com/QiuYeDx/FusionKit
            </a>
          </CardContent>
        </Card>

        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("about:subtitle.author")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <a
              href="https://github.com/qiuyedx"
              target="_blank"
              className="text-primary hover:underline"
            >
              QiuYeDx
            </a>
          </CardContent>
        </Card>

        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("about:subtitle.contact")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <a 
              href="mailto:me@qiueydx.com" 
              className="text-primary hover:underline"
            >
              me@qiuyedx.com
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default About;
