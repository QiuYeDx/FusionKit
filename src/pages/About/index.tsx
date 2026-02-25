import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UPDATE_CHECK_EVENT, UPDATE_STATUS_EVENT } from "@/components/update";

const About: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = import.meta.env.VITE_APP_VERSION || "-";
  const [updateChecking, setUpdateChecking] = useState(false);

  const handleManualCheck = () => {
    setUpdateChecking(true);
    window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ checking: boolean; source: "manual" | "auto" }>)
        .detail;
      if (!detail || detail.source !== "manual") return;
      setUpdateChecking(detail.checking);
    };

    window.addEventListener(UPDATE_STATUS_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(UPDATE_STATUS_EVENT, handler as EventListener);
    };
  }, []);

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
              <Button
                size="sm"
                onClick={handleManualCheck}
                disabled={updateChecking}
                aria-busy={updateChecking}
                className="self-start"
              >
                {updateChecking
                  ? t("common:update.checking")
                  : t("common:action.check_update")}
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
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-x-4">
              <a
                href="https://github.com/qiuyedx"
                target="_blank"
                className="text-primary hover:underline"
              >
                QiuYeDx
              </a>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <a
                href="https://qiuvision.com"
                target="_blank"
                className="text-muted-foreground hover:text-primary hover:underline"
              >
                qiuvision.com
              </a>
              <span className="text-muted-foreground/40">|</span>
              <a
                href="https://blog.qiuyedx.com"
                target="_blank"
                className="text-muted-foreground hover:text-primary hover:underline"
              >
                blog.qiuyedx.com
              </a>
            </div>
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
