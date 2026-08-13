import { useTranslation } from "react-i18next";
import { ArrowRight, Languages, Settings2 } from "lucide-react";
import {
  ToolConfigDivider,
  ToolConfigPanel,
  ToolField,
  ToolRadioButtonGroup,
  ToolSwitchRow,
} from "@/pages/Tools/_shared/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  NameNamingStyle,
  NameOutputMode,
  NameTranslationLanguage,
  NameTranslationOptions,
  NameTranslationScope,
  NameTranslationSourceLanguage,
  NameTranslationTargetKind,
} from "@/services/rename/nameTypes";

interface OptionsPanelProps {
  options: NameTranslationOptions;
  disabled?: boolean;
  onUpdateOptions: (patch: Partial<NameTranslationOptions>) => void;
}

const SCOPE_OPTIONS: Array<{
  value: NameTranslationScope;
  labelKey: string;
  hintKey: string;
}> = [
  {
    value: "self",
    labelKey: "options.scope.self.label",
    hintKey: "options.scope.self.hint",
  },
  {
    value: "children",
    labelKey: "options.scope.children.label",
    hintKey: "options.scope.children.hint",
  },
  {
    value: "descendants",
    labelKey: "options.scope.descendants.label",
    hintKey: "options.scope.descendants.hint",
  },
];

const TARGET_KIND_OPTIONS: Array<{
  value: NameTranslationTargetKind;
}> = [
  { value: "files" },
  { value: "directories" },
  { value: "both" },
];

const LANGUAGES: Array<{ value: NameTranslationLanguage }> = [
  { value: "ZH" },
  { value: "EN" },
  { value: "JA" },
  { value: "KO" },
  { value: "FR" },
  { value: "DE" },
  { value: "ES" },
  { value: "RU" },
  { value: "PT" },
];

const SOURCE_LANGUAGES: Array<{
  value: NameTranslationSourceLanguage;
}> = [{ value: "auto" }, ...LANGUAGES];

const NAMING_STYLES: Array<{ value: NameNamingStyle }> = [
  { value: "preserve" },
  { value: "space" },
  { value: "kebab" },
  { value: "snake" },
  { value: "title" },
  { value: "lower" },
];

const OUTPUT_MODES: Array<{ value: NameOutputMode }> = [
  { value: "target_only" },
  { value: "bilingual_target_first" },
  { value: "bilingual_original_first" },
];

export default function OptionsPanel({
  options,
  disabled,
  onUpdateOptions,
}: OptionsPanelProps) {
  const { t } = useTranslation("rename");

  return (
    <ToolConfigPanel icon={Settings2} title={t("options.section_title")}>
      <ToolField label={t("options.scope_label")} className="space-y-2">
        <ToolRadioButtonGroup
          value={options.scope}
          ariaLabel={t("options.scope_label")}
          disabled={disabled}
          options={SCOPE_OPTIONS.map((scope) => ({
            value: scope.value,
            label: t(scope.labelKey),
          }))}
          onValueChange={(scope) => onUpdateOptions({ scope })}
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t(
            SCOPE_OPTIONS.find((scope) => scope.value === options.scope)?.hintKey ??
              SCOPE_OPTIONS[0].hintKey,
          )}
        </p>
      </ToolField>

      <ToolField label={t("options.target_kind_label")}>
        <ToolRadioButtonGroup
          value={options.targetKind}
          ariaLabel={t("options.target_kind_label")}
          disabled={disabled}
          options={TARGET_KIND_OPTIONS.map((kind) => ({
            value: kind.value,
            label: t(`options.target_kind.${kind.value}`),
          }))}
          onValueChange={(targetKind) => onUpdateOptions({ targetKind })}
        />
      </ToolField>

      <ToolField
        label={t("options.max_depth_label")}
        action={
          <Input
            type="number"
            min={2}
            max={20}
            className="h-8 w-20 font-mono text-xs"
            disabled={disabled || options.scope !== "descendants"}
            value={options.scope === "descendants" ? options.maxDepth : 1}
            onChange={(event) =>
              onUpdateOptions({ maxDepth: Number(event.target.value) || 2 })
            }
          />
        }
      >
        <p className="text-[11px] text-muted-foreground">
          {t("options.max_depth_hint")}
        </p>
      </ToolField>

      <ToolConfigDivider />

      <ToolField
        label={
          <span className="flex items-center gap-1.5">
            <Languages className="h-3.5 w-3.5" />
            {t("options.language_label")}
          </span>
        }
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
          <Select
            value={options.sourceLang}
            disabled={disabled}
            onValueChange={(value) =>
              onUpdateOptions({
                sourceLang: value as NameTranslationSourceLanguage,
              })
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_LANGUAGES.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {language.value === "auto"
                    ? t("options.source_auto")
                    : t(`options.languages.${language.value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          <Select
            value={options.targetLang}
            disabled={disabled}
            onValueChange={(value) =>
              onUpdateOptions({ targetLang: value as NameTranslationLanguage })
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {t(`options.languages.${language.value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ToolField>

      <ToolField label={t("options.naming_style_label")}>
        <Select
          value={options.namingStyle}
          disabled={disabled}
          onValueChange={(value) =>
            onUpdateOptions({ namingStyle: value as NameNamingStyle })
          }
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NAMING_STYLES.map((style) => (
              <SelectItem key={style.value} value={style.value}>
                {t(`options.naming_styles.${style.value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>

      <ToolField label={t("options.output_mode_label")}>
        <Select
          value={options.outputMode}
          disabled={disabled}
          onValueChange={(value) =>
            onUpdateOptions({ outputMode: value as NameOutputMode })
          }
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTPUT_MODES.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {t(`options.output_mode.${mode.value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {options.outputMode !== "target_only" && (
          <div className="flex items-center gap-2 mt-1.5">
            <Label className="text-[11px] text-muted-foreground whitespace-nowrap">
              {t("options.separator_label")}
            </Label>
            <Input
              className="h-7 w-24 font-mono text-xs text-center"
              disabled={disabled}
              value={options.bilingualSeparator}
              onChange={(event) =>
                onUpdateOptions({ bilingualSeparator: event.target.value })
              }
            />
          </div>
        )}
      </ToolField>

      <div className="space-y-2">
        <ToolSwitchRow
          testId="name-translator-skip-hidden"
          label={t("options.skip_hidden_label")}
          hint={t("options.skip_hidden_hint")}
          checked={!options.includeHidden}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onUpdateOptions({ includeHidden: !checked })
          }
        />
        <ToolSwitchRow
          testId="name-translator-preserve-extension"
          label={t("options.preserve_extension_label")}
          hint={t("options.preserve_extension_hint")}
          checked={options.preserveExtension}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onUpdateOptions({ preserveExtension: checked })
          }
        />
        <ToolSwitchRow
          testId="name-translator-preserve-tokens"
          label={t("options.preserve_tokens_label")}
          hint={t("options.preserve_tokens_hint")}
          checked={options.preserveTechnicalTokens}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onUpdateOptions({ preserveTechnicalTokens: checked })
          }
        />
      </div>

      <ToolField label={t("options.collision_label")}>
        <ToolRadioButtonGroup
          value={options.collisionPolicy}
          ariaLabel={t("options.collision_label")}
          disabled={disabled}
          options={(["fail", "append_index"] as const).map((policy) => ({
            value: policy,
            label: t(`options.collision_${policy}`),
          }))}
          onValueChange={(collisionPolicy) => onUpdateOptions({ collisionPolicy })}
        />
      </ToolField>
    </ToolConfigPanel>
  );
}
