import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_EXTERNAL_PERMISSIONS,
  type ExternalPermission,
  type ExternalPermissionCode,
  type ExternalPermissions,
} from "@/agent/external/contract";

/** The operations grouped as the user thinks of them; every permission code appears once. */
const PERMISSION_GROUPS: ReadonlyArray<{ key: "studio" | "knowledge" | "files" | "safety"; codes: ExternalPermissionCode[] }> = [
  { key: "studio", codes: ["import_studio_subtitles", "create_studio_translation_track", "write_studio_translations", "split_studio_cue", "insert_studio_cue", "export_studio_document", "start_studio_transcription"] },
  { key: "knowledge", codes: ["prepare_knowledge_changes"] },
  { key: "files", codes: ["convert_subtitle_files", "extract_subtitle_language", "rename_paths", "undo_name_changes"] },
  { key: "safety", codes: ["overwrite_files"] },
];
const LEVELS: ExternalPermission[] = ["deny", "ask", "allow"];
const LEVEL_TONE: Record<ExternalPermission, string> = {
  deny: "text-destructive",
  ask: "text-amber-600 dark:text-amber-400",
  allow: "text-emerald-600 dark:text-emerald-400",
};

/** The custom level: one deny / ask / allow choice per permission code. */
export function ExternalAgentPermissions({ permissions, disabled, onChange }: {
  permissions: ExternalPermissions;
  disabled: boolean;
  onChange: (change: Partial<ExternalPermissions>) => void;
}) {
  const { t } = useTranslation("setting");
  const isDefault = (Object.keys(DEFAULT_EXTERNAL_PERMISSIONS) as ExternalPermissionCode[]).every(code => permissions[code] === DEFAULT_EXTERNAL_PERMISSIONS[code]);
  const setAll = (level: ExternalPermission) => onChange(Object.fromEntries(PERMISSION_GROUPS.flatMap(group => group.codes).map(code => [code, level])));
  return (
    <div className="space-y-3 rounded-smooth-lg border bg-muted/20 px-3.5 py-3" data-testid="setting-external-permissions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{t("external_agent.permissions.description")}</p>
        <div className="flex shrink-0 items-center gap-1">
          {LEVELS.map(level => (
            <Button key={level} type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={disabled}
              data-testid={`setting-external-permissions-all-${level}`} onClick={() => setAll(level)}>
              {t(`external_agent.permissions.all.${level}`)}
            </Button>
          ))}
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" disabled={disabled || isDefault}
            data-testid="setting-external-permissions-reset" onClick={() => onChange({ ...DEFAULT_EXTERNAL_PERMISSIONS })}>
            <RotateCcw className="size-3.5" />{t("external_agent.permissions.reset")}
          </Button>
        </div>
      </div>
      {PERMISSION_GROUPS.map(group => (
        <div key={group.key} className="space-y-1">
          <div className="px-0.5 text-[11px] font-medium text-muted-foreground">{t(`external_agent.permissions.groups.${group.key}`)}</div>
          <div className="divide-y rounded-smooth-md border bg-background">
            {group.codes.map(code => {
              const current = permissions[code];
              const name = code === "overwrite_files" ? t("external_agent.permissions.overwrite_files") : t(`external_agent.activity.tools.${code}`);
              return (
                <div key={code} className="flex items-center justify-between gap-4 px-3 py-2" data-testid="setting-external-permission" data-code={code}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13px]">{name}</span>
                      <code className="font-mono text-[10.5px] text-muted-foreground/80">{code}</code>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t(`external_agent.permissions.codes.${code}`)}</p>
                  </div>
                  <SegmentedControl size="sm" variant="contained" value={current} disabled={disabled} aria-label={name}
                    onValueChange={value => { if (value !== current) onChange({ [code]: value as ExternalPermission }); }}
                    items={LEVELS.map(level => ({
                      value: level, testId: `setting-external-permission-${code}-${level}`,
                      label: <span className={cn(current === level && LEVEL_TONE[level])}>{t(`external_agent.permissions.levels.${level}`)}</span>,
                      ariaLabel: t(`external_agent.permissions.levels.${level}`),
                    }))} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
