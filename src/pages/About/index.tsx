import React from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UPDATE_CHECK_EVENT } from "@/components/update";

const About: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = import.meta.env.VITE_APP_VERSION || "-";

  const handleManualCheck = () => {
    window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
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
              {t("about:subtitle.version")} / {t("about:subtitle.update")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/50 p-4">
              <div className="text-xs text-muted-foreground">
                {t("about:subtitle.version")}
              </div>
              <div className="mt-2 font-mono text-lg font-semibold">
                {appVersion}
              </div>
            </div>
            <div className="flex flex-col justify-between gap-3 rounded-lg border bg-muted/50 p-4">
              <div className="text-xs text-muted-foreground">
                {t("about:subtitle.update")}
              </div>
              <Button size="sm" onClick={handleManualCheck} className="self-start">
                {t("common:action.check_update")}
              </Button>
            </div>
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
