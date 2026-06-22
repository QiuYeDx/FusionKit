import { useTranslation } from "react-i18next";
import { ArrowRight, Languages, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
    <Card className="overflow-hidden p-0 gap-0">
      <div className="flex items-center gap-2 px-4 py-3 bg-muted/40 border-b">
        <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
          {t("options.section_title")}
        </span>
      </div>

      <div className="p-4 space-y-5">
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("options.scope_label")}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {SCOPE_OPTIONS.map((scope) => (
              <button
                key={scope.value}
                type="button"
                disabled={disabled}
                className={[
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  options.scope === scope.value
                    ? "border-primary/50 bg-primary/5"
                    : "hover:bg-accent/40",
                ].join(" ")}
                onClick={() => onUpdateOptions({ scope: scope.value })}
              >
                <div className="text-[12.5px] font-medium">
                  {t(scope.labelKey)}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {t(scope.hintKey)}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("options.target_kind_label")}
          </div>
          <ButtonGroup className="w-full">
            {TARGET_KIND_OPTIONS.map((kind) => (
              <Button
                key={kind.value}
                type="button"
                size="sm"
                className="flex-1"
                disabled={disabled}
                variant={options.targetKind === kind.value ? "default" : "outline"}
                onClick={() => onUpdateOptions({ targetKind: kind.value })}
              >
                {t(`options.target_kind.${kind.value}`)}
              </Button>
            ))}
          </ButtonGroup>
        </div>

        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <div>
            <Label className="text-[12.5px]">
              {t("options.max_depth_label")}
            </Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("options.max_depth_hint")}
            </p>
          </div>
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
        </div>

        <div className="h-px bg-border -mx-4" />

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Languages className="h-3.5 w-3.5" />
            {t("options.language_label")}
          </div>
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
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("options.naming_style_label")}
          </div>
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
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("options.output_mode_label")}
          </div>
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
        </div>

        <div className="space-y-2">
          <ToggleRow
            label={t("options.skip_hidden_label")}
            hint={t("options.skip_hidden_hint")}
            checked={!options.includeHidden}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onUpdateOptions({ includeHidden: !checked })
            }
          />
          <ToggleRow
            label={t("options.preserve_extension_label")}
            hint={t("options.preserve_extension_hint")}
            checked={options.preserveExtension}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onUpdateOptions({ preserveExtension: checked })
            }
          />
          <ToggleRow
            label={t("options.preserve_tokens_label")}
            hint={t("options.preserve_tokens_hint")}
            checked={options.preserveTechnicalTokens}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onUpdateOptions({ preserveTechnicalTokens: checked })
            }
          />
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("options.collision_label")}
          </div>
          <ButtonGroup className="w-full">
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={disabled}
              variant={options.collisionPolicy === "fail" ? "default" : "outline"}
              onClick={() => onUpdateOptions({ collisionPolicy: "fail" })}
            >
              {t("options.collision_fail")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={disabled}
              variant={
                options.collisionPolicy === "append_index" ? "default" : "outline"
              }
              onClick={() => onUpdateOptions({ collisionPolicy: "append_index" })}
            >
              {t("options.collision_append_index")}
            </Button>
          </ButtonGroup>
        </div>
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40">
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium leading-tight">
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      </span>
      <Switch
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}
