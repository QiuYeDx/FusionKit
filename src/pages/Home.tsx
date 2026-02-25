import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Subtitles,
  FileText,
  Music,
  Monitor,
  Rocket,
  ChevronRight,
  Zap,
  Shield
} from "lucide-react";
import FusionKitLogo from "@/assets/FusionKit.svg";

const Home: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="p-4">
      {/* 头部欢迎区域 */}
      <div className="flex flex-col items-center text-center mt-6 mb-12">
        <img
          src={FusionKitLogo}
          alt="FusionKit Logo"
          className="w-24 h-24 mb-6 rounded-2xl shadow-sm"
        />
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
          {t("home:welcome")}
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mb-8">
          {t("home:home_description")}
        </p>
        <div className="flex gap-4">
          <Button size="lg" onClick={() => navigate("/tools")}>
            <Rocket className="mr-2 h-5 w-5" />
            {t("home:get_started")}
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate("/about")}>
            {t("home:learn_more")}
          </Button>
        </div>
      </div>

      {/* 特色功能展示 */}
      <div className="flex flex-col gap-4 mb-14">
        {/* 工具总览 */}
        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("home:feature_rich")}
            </CardTitle>
            <CardDescription>
              {t("home:home_description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              {/* 字幕处理 */}
              <div
                className="group relative overflow-hidden rounded-lg border bg-background p-4 hover:bg-accent cursor-pointer transition-all duration-200 hover:shadow-sm"
                onClick={() => navigate("/tools")}
              >
                <div className="flex items-start justify-between">
                  <div className="flex flex-col gap-2">
                    <div className="rounded-md bg-primary/10 w-10 h-10 flex items-center justify-center text-primary">
                      <Subtitles className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-base mb-1">
                        {t("home:subtitle_tool_title")}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {t("home:subtitle_tool_description")}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-1 transition-transform mt-2" />
                </div>
              </div>

              {/* 文件重命名 */}
              <div
                className="group relative overflow-hidden rounded-lg border bg-background p-4 hover:bg-accent cursor-pointer transition-all duration-200 hover:shadow-sm"
                onClick={() => navigate("/tools")}
              >
                <div className="flex items-start justify-between">
                  <div className="flex flex-col gap-2">
                    <div className="rounded-md bg-primary/10 w-10 h-10 flex items-center justify-center text-primary">
                      <FileText className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-base mb-1">
                        {t("home:rename_tool_title")}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {t("home:rename_tool_description")}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-1 transition-transform mt-2" />
                </div>
              </div>

              {/* 音乐解密 */}
              <div
                className="group relative overflow-hidden rounded-lg border bg-background p-4 hover:bg-accent cursor-pointer transition-all duration-200 hover:shadow-sm"
                onClick={() => navigate("/tools")}
              >
                <div className="flex items-start justify-between">
                  <div className="flex flex-col gap-2">
                    <div className="rounded-md bg-primary/10 w-10 h-10 flex items-center justify-center text-primary">
                      <Music className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-base mb-1">
                        {t("home:music_tool_title")}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {t("home:music_tool_description")}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-1 transition-transform mt-2" />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 跨平台与特性 */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="overflow-auto">
            <CardHeader className="sticky left-0">
              <CardTitle className="text-xl flex items-center gap-2">
                <Monitor className="h-5 w-5" />
                {t("home:cross_platform_title")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 grid-cols-3">
                <div className="flex flex-col items-center justify-center p-4 rounded-lg border bg-muted/50">
                  <Monitor className="h-6 w-6 mb-2 text-muted-foreground" />
                  <span className="text-sm font-medium">Windows</span>
                </div>
                <div className="flex flex-col items-center justify-center p-4 rounded-lg border bg-muted/50">
                  <Monitor className="h-6 w-6 mb-2 text-muted-foreground" />
                  <span className="text-sm font-medium">macOS</span>
                </div>
                <div className="flex flex-col items-center justify-center p-4 rounded-lg border bg-muted/50">
                  <Monitor className="h-6 w-6 mb-2 text-muted-foreground" />
                  <span className="text-sm font-medium">Linux</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-4">
                {t("home:cross_platform_description")}
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-auto">
            <CardHeader className="sticky left-0">
              <CardTitle className="text-xl flex items-center gap-2">
                <Zap className="h-5 w-5" />
                {t("home:core_features_title")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2 rounded-full">
                    <Zap className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h4 className="text-sm font-medium">{t("home:feature_fast")}</h4>
                    <p className="text-sm text-muted-foreground">{t("home:feature_fast_description")}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2 rounded-full">
                    <Shield className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h4 className="text-sm font-medium">{t("home:feature_secure")}</h4>
                    <p className="text-sm text-muted-foreground">{t("home:feature_secure_description")}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Home;
