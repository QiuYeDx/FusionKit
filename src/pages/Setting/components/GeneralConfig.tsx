import useLanguage from "@/hooks/useLanguage";
import useThemeStore from "@/store/useThemeStore";
import useNotificationStore from "@/store/useNotificationStore";
import { showSystemNotification } from "@/utils/notification";
import { LangEnum } from "@/type/lang";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Bell } from "lucide-react";

function GeneralConfig() {
  const { t } = useTranslation();
  const { language, changeLanguage } = useLanguage();
  const { theme, setTheme } = useThemeStore();
  const { enabled: notificationEnabled, setEnabled: setNotificationEnabled } =
    useNotificationStore();

  return (
    <Card className="overflow-auto">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">
          {t("setting:subtitle.general_config")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 语言设置 */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.language")}
          </Label>
          <SegmentedControl
            size="sm"
            fullWidth
            className="min-w-0 flex-1"
            itemClassName="px-0.5"
            value={language}
            aria-label={t("setting:fields.language")}
            items={[
              {
                value: LangEnum.ZH,
                label: t("common:lang.zh", { defaultValue: "简体中文" }),
              },
              {
                value: LangEnum.ZH_HANT,
                label: t("common:lang.zh-Hant", { defaultValue: "繁體中文" }),
              },
              {
                value: LangEnum.JA,
                label: t("common:lang.ja", { defaultValue: "日本語" }),
              },
              {
                value: LangEnum.EN,
                label: t("common:lang.en", { defaultValue: "English" }),
              },
            ]}
            onValueChange={(value) => changeLanguage(value as LangEnum)}
          />
        </div>

        {/* 主题设置 */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.theme")}
          </Label>
          <SegmentedControl
            size="sm"
            fullWidth
            className="min-w-0 flex-1"
            value={theme}
            aria-label={t("setting:fields.theme")}
            items={(["light", "dark", "system"] as const).map((value) => ({
              value,
              label: t(`setting:fields.${value}_mode`),
            }))}
            onValueChange={(value) => setTheme(value as typeof theme)}
          />
        </div>

        {/* 系统通知设置 */}
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.notification.label")}
          </Label>
          <div className="flex items-center gap-3">
            <Switch
              checked={notificationEnabled}
              onCheckedChange={(checked) => {
                setNotificationEnabled(checked);
                if (checked) {
                  showSystemNotification(
                    t("setting:fields.notification.test_title"),
                    t("setting:fields.notification.test_body"),
                    true
                  );
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                showSystemNotification(
                  t("setting:fields.notification.test_title"),
                  t("setting:fields.notification.test_body"),
                  true
                )
              }
            >
              <Bell className="h-4 w-4 mr-1" />
              {t("setting:fields.notification.test_btn")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default GeneralConfig;
