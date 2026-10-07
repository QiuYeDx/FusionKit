import { useTranslation } from "react-i18next";
import { FilePlus2, FolderPlus, Loader2, Settings2, Upload } from "lucide-react";
import {
  ToolConfigDisclosure,
  ToolConfigPanel,
  ToolField,
  ToolSwitchRow,
} from "@/pages/Tools/_shared/ui";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  NAME_LANGUAGES,
  NAME_TRANSLATION_LIMITS,
  type NameInspectRejection,
  type NameLanguage,
  type NameSourceLanguage,
} from "@/name-translation/contract";
import { NameFormatField } from "./NameFormatField";
import useNameTranslatorConfigStore from "@/store/tools/rename/nameTranslatorConfig";

export function AddEntriesPanel({
  adding,
  dragging,
  rejected,
  onAddFiles,
  onAddFolders,
}: {
  adding: boolean;
  dragging: boolean;
  rejected: readonly NameInspectRejection[];
  onAddFiles: () => void;
  onAddFolders: () => void;
}) {
  const { t } = useTranslation("rename");
  return (
    <ToolConfigPanel icon={Upload} title={t("add.title")} contentClassName="space-y-3">
      <SmoothCorners
        radius={18}
        smoothing={0.74}
        data-testid="name-translator-drop"
        className={cn(
          "flex flex-col gap-3 border-2 border-dashed p-3 transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70">
            {adding ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{t("add.drop_title")}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t("add.drop_hint")}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" size="sm" disabled={adding} onClick={onAddFiles}>
            <FilePlus2 />
            {t("add.files")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={adding} onClick={onAddFolders}>
            <FolderPlus />
            {t("add.folders")}
          </Button>
        </div>
      </SmoothCorners>
      {rejected.length > 0 ? (
        <ul className="space-y-1 text-xs leading-5 text-amber-700 dark:text-amber-300" aria-live="polite">
          {rejected.slice(0, 4).map((item) => (
            <li key={item.path} className="[overflow-wrap:anywhere]">
              {t(`add.rejected.${item.reason}`, { path: item.path })}
            </li>
          ))}
          {rejected.length > 4 ? <li>{t("add.rejected_more", { count: rejected.length - 4 })}</li> : null}
        </ul>
      ) : null}
    </ToolConfigPanel>
  );
}

const LANGUAGE_KEYS: Record<NameLanguage, string> = {
  ZH: "languages.ZH",
  ZH_HANT: "languages.ZH_HANT",
  JA: "languages.JA",
  EN: "languages.EN",
  KO: "languages.KO",
  FR: "languages.FR",
  DE: "languages.DE",
  ES: "languages.ES",
  RU: "languages.RU",
  PT: "languages.PT",
};

export function SettingsPanel({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("rename");
  const config = useNameTranslatorConfigStore((state) => state.config);
  const updateConfig = useNameTranslatorConfigStore((state) => state.updateConfig);

  return (
    <ToolConfigPanel icon={Settings2} title={t("settings.title")}>
      <ToolField label={t("settings.target_lang")} htmlFor="name-translator-target">
        <Select
          value={config.targetLang}
          disabled={disabled}
          onValueChange={(value) => updateConfig({ targetLang: value as NameLanguage })}
        >
          <SelectTrigger id="name-translator-target" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NAME_LANGUAGES.map((language) => (
              <SelectItem key={language} value={language}>
                {t(LANGUAGE_KEYS[language])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>
      <ToolField label={t("settings.source_lang")} htmlFor="name-translator-source">
        <Select
          value={config.sourceLang}
          disabled={disabled}
          onValueChange={(value) => updateConfig({ sourceLang: value as NameSourceLanguage })}
        >
          <SelectTrigger id="name-translator-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("languages.auto")}</SelectItem>
            {NAME_LANGUAGES.map((language) => (
              <SelectItem key={language} value={language}>
                {t(LANGUAGE_KEYS[language])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>
      <NameFormatField disabled={disabled} />
      <ToolSwitchRow
        label={t("settings.include_hidden")}
        hint={t("settings.include_hidden_hint")}
        checked={config.includeHidden}
        disabled={disabled}
        onCheckedChange={(includeHidden) => updateConfig({ includeHidden })}
      />
      <div className="-mb-3">
      <ToolConfigDisclosure
        title={t("settings.instructions")}
        summary={config.instructions.trim() ? config.instructions.trim() : t("settings.instructions_empty")}
        className="border-b-0"
        defaultOpen={Boolean(config.instructions)}
      >
        <Textarea
          value={config.instructions}
          disabled={disabled}
          maxLength={NAME_TRANSLATION_LIMITS.maxInstructionsChars}
          placeholder={t("settings.instructions_placeholder")}
          aria-label={t("settings.instructions")}
          onChange={(event) => updateConfig({ instructions: event.target.value })}
          className="min-h-20 resize-y text-[13px]"
        />
      </ToolConfigDisclosure>
      </div>
    </ToolConfigPanel>
  );
}
