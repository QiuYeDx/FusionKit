import { useState, type ComponentProps } from "react";
import { AlertTriangle, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { apiKeyHasUnsendableCharacters } from "@/model-setup/contract";
import { cn } from "@/lib/utils";

type ApiKeyInputProps = Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * A key field that hides what was pasted until the user asks to see it, and says so when more
 * than the key came along (Chinese or full-width text, spaces), which no service would accept.
 */
export function ApiKeyInput({ value, onValueChange, className, ...props }: ApiKeyInputProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const label = t(visible ? "setting:fields.apikey_hide" : "setting:fields.apikey_show");
  const extraCharacters = !!value.trim() && apiKeyHasUnsendableCharacters(value);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="relative min-w-0">
        <Input
          {...props}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={extraCharacters || undefined}
          onChange={(event) => onValueChange(event.target.value)}
          className={cn("pr-9 font-mono", className)}
        />
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={visible}
          data-testid="api-key-visibility"
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-0 flex w-8 cursor-pointer items-center justify-center rounded-smooth-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {extraCharacters && (
        <p role="status" data-testid="api-key-characters" className="flex items-start gap-1 text-xs leading-5 text-amber-600 dark:text-amber-400">
          <AlertTriangle aria-hidden className="mt-1 size-3 shrink-0" />
          {t("setting:fields.apikey_characters_hint")}
        </p>
      )}
    </div>
  );
}

export default ApiKeyInput;
