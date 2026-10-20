import useLanguage from "@/hooks/useLanguage";
import useThemeStore from "@/store/useThemeStore";
import useNotificationStore from "@/store/useNotificationStore";
import useCursorStore, { type ClickableCursor } from "@/store/useCursorStore";
import { showSystemNotification } from "@/utils/notification";
import { LangEnum } from "@/type/lang";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Bell, Languages, MousePointer2, SunMoon } from "lucide-react";
import { Panel, PanelRow, PageSection } from "@/pages/components/page-kit";

function GeneralConfig() {
  const { t } = useTranslation();
  const { language, changeLanguage } = useLanguage();
  const { theme, setTheme } = useThemeStore();
  const { enabled: notificationEnabled, setEnabled: setNotificationEnabled } = useNotificationStore();
  const { clickableCursor, setClickableCursor } = useCursorStore();
  const testNotification = () => showSystemNotification(t("setting:fields.notification.test_title"), t("setting:fields.notification.test_body"), true);

  return <>
    <PageSection title={t("setting:groups.appearance")} description={t("setting:groups.appearance_hint")}>
      <Panel>
        <PanelRow icon={Languages} tone="blue" label={t("setting:fields.language")} description={t("setting:fields.language_hint")} wide
          control={<SegmentedControl size="sm" fullWidth className="min-w-0 flex-1" itemClassName="px-0.5" value={language} aria-label={t("setting:fields.language")}
            items={[
              { value: LangEnum.ZH, label: t("common:lang.zh", { defaultValue: "简体中文" }) },
              { value: LangEnum.ZH_HANT, label: t("common:lang.zh-Hant", { defaultValue: "繁體中文" }) },
              { value: LangEnum.JA, label: t("common:lang.ja", { defaultValue: "日本語" }) },
              { value: LangEnum.EN, label: t("common:lang.en", { defaultValue: "English" }) },
            ]}
            onValueChange={(value) => changeLanguage(value as LangEnum)} />} />
        <PanelRow icon={SunMoon} tone="violet" label={t("setting:fields.theme")} description={t("setting:fields.theme_hint")} wide
          control={<SegmentedControl size="sm" fullWidth className="min-w-0 flex-1" value={theme} aria-label={t("setting:fields.theme")}
            items={(["light", "dark", "system"] as const).map((value) => ({ value, label: t(`setting:fields.${value}_mode`) }))}
            onValueChange={(value) => setTheme(value as typeof theme)} />} />
        <PanelRow icon={MousePointer2} tone="neutral" label={t("setting:fields.cursor.label")} description={t("setting:fields.cursor.hint")} wide
          control={<SegmentedControl size="sm" fullWidth className="min-w-0 flex-1" value={clickableCursor} aria-label={t("setting:fields.cursor.hint")}
            items={(["pointer", "default"] as const).map((value) => ({ value, label: t(`setting:fields.cursor.${value}`) }))}
            onValueChange={(value) => setClickableCursor(value as ClickableCursor)} />} />
      </Panel>
    </PageSection>

    <PageSection title={t("setting:groups.notifications")} description={t("setting:groups.notifications_hint")}>
      <Panel>
        <PanelRow icon={Bell} tone="amber" label={t("setting:fields.notification.label")} description={t("setting:fields.notification.hint")}
          control={<>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={testNotification}>{t("setting:fields.notification.test_btn")}</Button>
            <Switch checked={notificationEnabled} aria-label={t("setting:fields.notification.label")}
              onCheckedChange={(checked) => { setNotificationEnabled(checked); if (checked) testNotification(); }} />
          </>} />
      </Panel>
    </PageSection>
  </>;
}

export default GeneralConfig;
