import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronRight } from "lucide-react";

const Tools: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("tools:title")}</div>
      <div className="mb-6">
        <div className="text-muted-foreground">
          {t("tools:description")}
        </div>
      </div>

      {/* 字幕工具箱 */}
      <div className="flex flex-col gap-4 mb-14">
        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("tools:subtitle.subtitle_tools")}
            </CardTitle>
            <CardDescription>
              {t("tools:sub_desc.subtitle_tools")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              <div
                className="group relative overflow-hidden rounded-lg border bg-background p-4 hover:bg-accent cursor-pointer transition-all duration-200 hover:shadow-lg"
                onClick={() => navigate("/tools/subtitle/translator")}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-base mb-1">
                      {t("tools:fields.subtitle_translator")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      使用AI模型翻译字幕文件
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
              
              <div
                className="group relative overflow-hidden rounded-lg border bg-background p-4 hover:bg-accent cursor-pointer transition-all duration-200 hover:shadow-lg"
                onClick={() => navigate("/tools/subtitle/converter")}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-base mb-1">
                      {t("tools:fields.subtitle_formatter")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      转换字幕格式（SRT、ASS等）
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
              
              <div
                className="group relative overflow-hidden rounded-lg border bg-background p-4 hover:bg-accent cursor-pointer transition-all duration-200 hover:shadow-lg"
                onClick={() => navigate("/tools/subtitle/extractor")}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-base mb-1">
                      {t("tools:fields.subtitle_language_extractor")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      从双语字幕中提取指定语言
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 音乐工具箱 */}
        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("tools:subtitle.music_tools")}
            </CardTitle>
            <CardDescription>
              {t("tools:sub_desc.music_tools")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              <div className="relative overflow-hidden rounded-lg border bg-muted/50 p-4 opacity-60">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-base mb-1">
                      敬请期待
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      更多音乐工具即将推出
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 重命名工具箱 */}
        <Card className="overflow-auto">
          <CardHeader className="sticky left-0">
            <CardTitle className="text-xl">
              {t("tools:subtitle.rename_tools")}
            </CardTitle>
            <CardDescription>
              {t("tools:sub_desc.rename_tools")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              <div className="relative overflow-hidden rounded-lg border bg-muted/50 p-4 opacity-60">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-base mb-1">
                      敬请期待
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      批量重命名工具即将推出
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Tools;
