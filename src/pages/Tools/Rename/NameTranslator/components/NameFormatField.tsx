import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { ToolField, ToolRadioButtonGroup } from "@/pages/Tools/_shared/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BILINGUAL_STYLES,
  MAX_NAME_TEMPLATE_CHARS,
  ORIGINAL_TOKEN,
  TRANSLATED_TOKEN,
  composeName,
  getTemplateError,
  type BilingualOrder,
  type BilingualStyle,
} from "@/name-translation/naming-rules";
import useNameTranslatorConfigStore, {
  resolveNameTemplate,
  type NameMode,
} from "@/store/tools/rename/nameTranslatorConfig";

/** Name format: translation only, bilingual presets, or a custom template. */
export function NameFormatField({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("rename");
  const config = useNameTranslatorConfigStore((state) => state.config);
  const updateConfig = useNameTranslatorConfigStore((state) => state.updateConfig);
  const templateRef = useRef<HTMLInputElement>(null);

  const template = resolveNameTemplate(config);
  const templateError = config.nameMode === "custom" ? getTemplateError(config.customTemplate) : null;
  const preview = composeName({
    originalName: t("settings.format.sample_original"),
    kind: "file",
    translatedStem: t("settings.format.sample_translated"),
    template,
  });

  const insertToken = (token: string) => {
    const input = templateRef.current;
    const value = config.customTemplate;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`.slice(0, MAX_NAME_TEMPLATE_CHARS);
    updateConfig({ customTemplate: next });
    requestAnimationFrame(() => {
      input?.focus();
      const caret = Math.min(start + token.length, next.length);
      input?.setSelectionRange(caret, caret);
    });
  };

  const modeOptions: { value: NameMode; label: string }[] = [
    { value: "translated", label: t("settings.format.mode_translated") },
    { value: "bilingual", label: t("settings.format.mode_bilingual") },
    { value: "custom", label: t("settings.format.mode_custom") },
  ];

  return (
    <ToolField label={t("settings.format.label")} hint={t("settings.format.hint")}>
      <div className="space-y-2">
        <ToolRadioButtonGroup
          value={config.nameMode}
          options={modeOptions}
          ariaLabel={t("settings.format.label")}
          disabled={disabled}
          onValueChange={(nameMode) => updateConfig({ nameMode })}
        />

        {config.nameMode === "bilingual" ? (
          <div className="grid grid-cols-2 gap-2">
            <Select
              value={config.bilingualOrder}
              disabled={disabled}
              onValueChange={(value) => updateConfig({ bilingualOrder: value as BilingualOrder })}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.format.order")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="translated_first">{t("settings.format.order_translated_first")}</SelectItem>
                <SelectItem value="original_first">{t("settings.format.order_original_first")}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={config.bilingualStyle}
              disabled={disabled}
              onValueChange={(value) => updateConfig({ bilingualStyle: value as BilingualStyle })}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.format.style")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BILINGUAL_STYLES.map((style) => (
                  <SelectItem key={style} value={style}>
                    {t(`settings.format.styles.${style}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {config.nameMode === "custom" ? (
          <div className="space-y-1.5">
            <Input
              ref={templateRef}
              value={config.customTemplate}
              disabled={disabled}
              maxLength={MAX_NAME_TEMPLATE_CHARS}
              spellCheck={false}
              aria-label={t("settings.format.template")}
              aria-invalid={Boolean(templateError)}
              onChange={(event) => updateConfig({ customTemplate: event.target.value })}
              className="h-8 font-mono text-[12.5px]"
            />
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => insertToken(TRANSLATED_TOKEN)}>
                <Plus />
                {t("settings.format.insert_translated")}
              </Button>
              <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => insertToken(ORIGINAL_TOKEN)}>
                <Plus />
                {t("settings.format.insert_original")}
              </Button>
            </div>
            {templateError ? (
              <p role="alert" className="text-[11px] leading-4 text-destructive">
                {t(`settings.format.errors.${templateError}`)}
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="min-w-0 text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]" aria-live="polite">
          {t("settings.format.preview", { name: preview })}
        </p>
      </div>
    </ToolField>
  );
}
