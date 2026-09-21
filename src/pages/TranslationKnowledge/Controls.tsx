import { KnowledgeDisclosure } from "./KnowledgeDisclosure";
import { diagnosticKey } from "./labels";
import { useId, useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ScrollableDialog,
  ScrollableDialogHeader,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  DialogDescription,
  DialogTitle,
} from "@/components/qiuye-ui/scrollable-dialog";
import { ToolField } from "@/pages/Tools/_shared/ui/ToolField";
import type { KnowledgeErrorCode } from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { PAGE_SIZE, splitLines } from "./model";

export function TextField({
  label,
  value,
  onChange,
  multiline,
  required,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    value,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => onChange(event.target.value),
    required,
    disabled,
  };
  return (
    <ToolField htmlFor={id} label={label} required={required} hint={hint}>
      {multiline ? (
        <Textarea {...props} rows={3} className="resize-y text-sm" />
      ) : (
        <Input {...props} className="h-8 text-sm" />
      )}
    </ToolField>
  );
}
export function Choice({
  label,
  value,
  onChange,
  options,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <ToolField label={label} htmlFor={id}>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} size="sm" className="w-full min-w-0">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ToolField>
  );
}
export function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm leading-5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}
export function MultiChoice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation("knowledge");
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </legend>
      <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border p-3">
        {options.length ? (
          options.map((item) => (
            <Check
              key={item.id}
              label={item.name}
              checked={value.includes(item.id)}
              onChange={(checked) =>
                onChange(
                  checked
                    ? [...value, item.id]
                    : value.filter((id) => id !== item.id),
                )
              }
            />
          ))
        ) : (
          <p className="text-xs text-muted-foreground">{t("empty.options")}</p>
        )}
      </div>
    </fieldset>
  );
}
export function ErrorNotice({
  error,
  diagnostics = [],
}: {
  error: KnowledgeErrorCode | "unexpected" | "required" | null;
  diagnostics?: Diagnostic[];
}) {
  const { t } = useTranslation("knowledge");
  return error ? (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-2 break-words">
        <p>{t(`errors.${error}`)}</p>
        {diagnostics.length > 0 && (
          <KnowledgeDisclosure variant="inline" title={t("detail.diagnostics")}>
            <ul className="space-y-2 text-xs">
              {diagnostics.map((item, index) => (
                <li key={index}>
                  <p>{t(diagnosticKey(`diagnostic.${item.code}`))}</p>
                  <p className="break-all font-mono">{item.path}</p>
                  <p className="whitespace-pre-wrap">{item.message}</p>
                </li>
              ))}
            </ul>
          </KnowledgeDisclosure>
        )}
      </div>
    </div>
  ) : null;
}
export function KnowledgeDialog({
  title,
  description,
  children,
  footer,
  onClose,
  pending = false,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  pending?: boolean;
  wide?: boolean;
}) {
  const { t } = useTranslation("knowledge");
  return (
    <ScrollableDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      maxWidth={wide ? "sm:max-w-3xl" : "sm:max-w-xl"}
      contentClassName="max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden"
      onOpenAutoFocus={() => {}}
    >
      <ScrollableDialogHeader className="p-3">
        <DialogTitle className="text-base">{title}</DialogTitle>
        <DialogDescription className={description ? "text-xs" : "sr-only"}>
          {description ?? title}
        </DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent
        fadeMasks
        fadeMaskHeight={24}
        className="min-h-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3"
      >
        <div className="space-y-4">{children}</div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onClose}
        >
          {t("actions.close")}
        </Button>
        {footer}
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}
export function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const { t } = useTranslation("knowledge");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="flex items-center justify-between gap-3 border-t p-3">
      <span className="text-xs text-muted-foreground">
        {t("pagination", { count: total, page: page + 1, pages })}
      </span>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          disabled={page === 0}
          aria-label={t("actions.previous")}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={page + 1 >= pages}
          aria-label={t("actions.next")}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

export function LinesField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [raw, setRaw] = useState(value);
  useEffect(() => {
    if (splitLines(raw).join("\n") !== value) setRaw(value);
  }, [value]);
  return (
    <TextField
      label={label}
      value={raw}
      onChange={(next) => {
        setRaw(next);
        onChange(next);
      }}
      multiline
    />
  );
}

const COMMON_LANGUAGES = [
  "ja",
  "en",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "fr",
  "de",
  "es",
  "ru",
  "pt",
] as const;
export function LanguageField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("knowledge");
  const [custom, setCustom] = useState(
    Boolean(value) && !COMMON_LANGUAGES.some((language) => language === value),
  );
  const ownValue = useRef<string | null>(null);
  useEffect(() => {
    if (ownValue.current === value) { ownValue.current = null; return; }
    setCustom(Boolean(value) && !COMMON_LANGUAGES.some(language => language === value));
  }, [value]);
  const changeValue = (next: string) => { ownValue.current = next; onChange(next); };
  let valid = true;
  try {
    const language = new Intl.Locale(value);
    valid =
      language.toString() === value &&
      !["auto", "und", "mul"].includes(language.language) &&
      (language.language !== "zh" ||
        ["Hans", "Hant"].includes(language.script ?? ""));
  } catch {
    valid = false;
  }
  return (
    <div className="space-y-2">
      <Choice
        label={label}
        value={custom ? "custom" : value}
        placeholder={t("filters.select")}
        onChange={(next) => {
          setCustom(next === "custom");
          if (next !== "custom") changeValue(next);
          else changeValue("");
        }}
        options={[
          ...COMMON_LANGUAGES.map((language) => ({
            value: language,
            label: t(`languages.${language}`),
          })),
          { value: "custom", label: t("languages.custom") },
        ]}
      />
      {custom && (
        <>
          <TextField
            label={t("languages.custom_tag")}
            value={value}
            onChange={changeValue}
            hint={t("languages.custom_help")}
            required
          />
          {value && !valid && (
            <p className="text-xs text-destructive">{t("languages.invalid")}</p>
          )}
        </>
      )}
    </div>
  );
}
