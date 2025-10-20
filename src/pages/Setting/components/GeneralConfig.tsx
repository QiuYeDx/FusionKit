import useLanguage from "@/hook/useLanguage";
import useThemeStore from "@/store/useThemeStore";
import { LangEnum } from "@/type/lang";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

function GeneralConfig() {
  const { t } = useTranslation();
  const { language, changeLanguage } = useLanguage();
  const { theme, setTheme } = useThemeStore();

  return (
    <Card className="overflow-auto">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">
          {t("setting:subtitle.general_config")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 语言设置 */}
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.language")}
          </Label>
          <ButtonGroup>
            <Button
              size="sm"
              variant={language === LangEnum.ZH ? "default" : "outline"}
              onClick={() => changeLanguage(LangEnum.ZH)}
            >
              {t("common:lang.zh", { defaultValue: "中文" })}
            </Button>
            <Button
              size="sm"
              variant={language === LangEnum.JA ? "default" : "outline"}
              onClick={() => changeLanguage(LangEnum.JA)}
            >
              {t("common:lang.ja", { defaultValue: "日本語" })}
            </Button>
            <Button
              size="sm"
              variant={language === LangEnum.EN ? "default" : "outline"}
              onClick={() => changeLanguage(LangEnum.EN)}
            >
              {t("common:lang.en", { defaultValue: "English" })}
            </Button>
          </ButtonGroup>
        </div>

        {/* 主题设置 */}
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.theme")}
          </Label>
          <ButtonGroup>
            <Button
              size="sm"
              variant={theme === "light" ? "default" : "outline"}
              onClick={() => setTheme("light")}
            >
              {t('setting:fields.light_mode')}
            </Button>
            <Button
              size="sm"
              variant={theme === "dark" ? "default" : "outline"}
              onClick={() => setTheme("dark")}
            >
              {t('setting:fields.dark_mode')}
            </Button>
            <Button
              size="sm"
              variant={theme === "system" ? "default" : "outline"}
              onClick={() => setTheme("system")}
            >
              {t('setting:fields.system_mode')}
            </Button>
          </ButtonGroup>
        </div>
      </CardContent>
    </Card>
  );
}

export default GeneralConfig;

