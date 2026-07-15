import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import {
  ToolConfigPanel,
  ToolDetailLayout,
  ToolPanel,
  ToolStatBar,
} from "@/pages/Tools/_shared/ui";
import { TOOL_META, type ToolKey } from "@/pages/Tools/_shared/toolMeta";
import type {
  AudioToolConfigStatus,
  AudioToolConfigSummary,
} from "@/store/tools/audio/audioToolConfig";

interface AudioToolShellProps {
  toolKey: Extract<
    ToolKey,
    | "audioTranscriber"
    | "speechSynthesizer"
    | "realtimeCaptions"
    | "realtimeVoice"
  >;
  titleKey: string;
  descriptionKey: string;
  workspaceTitleKey: string;
  configSummary: AudioToolConfigSummary;
  settingsPath: string;
  asideExtra?: (context: AudioToolShellContext) => React.ReactNode;
  children?: (context: AudioToolShellContext) => React.ReactNode;
}

export interface AudioToolShellContext {
  configSummary: AudioToolConfigSummary;
  statusTone: ReturnType<typeof resolveStatusTone>;
  dialectValue: string;
  modelValue: string;
}

export function AudioToolShell({
  toolKey,
  titleKey,
  descriptionKey,
  workspaceTitleKey,
  configSummary,
  settingsPath,
  asideExtra,
  children,
}: AudioToolShellProps) {
  const { t } = useTranslation(["audio", "common", "setting"]);
  const navigate = useNavigate();
  const meta = TOOL_META[toolKey];
  const testIdPrefix = toolKey === "speechSynthesizer"
    ? "speech"
    : toolKey === "audioTranscriber"
      ? "transcriber"
      : toolKey === "realtimeCaptions"
        ? "captions"
        : toolKey === "realtimeVoice"
          ? "voice"
          : undefined;
  const statusTone = resolveStatusTone(configSummary.status);
  const modelValue = configSummary.modelKey ?? "-";
  const dialectValue = configSummary.audioDialect
    ? t(`setting:fields.audio.dialect.${configSummary.audioDialect}`)
    : "-";
  const context: AudioToolShellContext = {
    configSummary,
    statusTone,
    dialectValue,
    modelValue,
  };

  const providerValue = configSummary.providerPreset
    ? t(`setting:fields.audio.provider.${configSummary.providerPreset}`)
    : "-";
  const modeValue = configSummary.activeMode
    ? t(`audio:speech.mode.${configSummary.activeMode}`)
    : "-";
  const capabilityValue = configSummary.capabilities[0]
    ? t(`setting:fields.audio.capability.${configSummary.capabilities[0]}`)
    : "-";
  const statItems = useMemo(
    () => [
      {
        label: t("audio:global.audio_api"),
        value: configSummary.profileName ?? "-",
        tone: configSummary.profileName
          ? "default" as const
          : "warning" as const,
      },
      {
        label: t("audio:global.status"),
        value: t(`audio:status.${configSummary.status}`),
        tone: configSummary.status === "ready"
          ? "success" as const
          : "warning" as const,
      },
      {
        label: t("audio:global.provider"),
        value: providerValue,
      },
      {
        label: t(
          configSummary.activeMode
            ? "audio:global.mode"
            : "audio:global.capabilities",
        ),
        value: configSummary.activeMode ? modeValue : capabilityValue,
      },
    ],
    [
      configSummary.profileName,
      configSummary.status,
      capabilityValue,
      modeValue,
      providerValue,
      t,
    ],
  );

  const header = (
    <ToolPageHeader
      meta={meta}
      title={t(titleKey)}
      description={t(descriptionKey)}
      right={
        <Button
          data-testid={testIdPrefix ? `${testIdPrefix}-change-api` : undefined}
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => navigate(settingsPath)}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t("audio:global.change_audio_api")}
        </Button>
      }
    />
  );

  const aside = (
    <div
      data-testid={testIdPrefix ? `${testIdPrefix}-config-summary` : undefined}
    >
      <ToolConfigPanel
        icon={SlidersHorizontal}
        title={t("audio:global.api_config_title")}
      >
        <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {t("audio:global.status")}
          </span>
          <Badge variant="outline" className={statusTone.className}>
            {statusTone.icon}
            {t(`audio:status.${configSummary.status}`)}
          </Badge>
        </div>
        <ConfigLine
          label={t("audio:global.audio_api")}
          value={configSummary.profileName}
        />
        {configSummary.providerPreset ? (
          <ConfigLine label={t("audio:global.provider")} value={providerValue} />
        ) : null}
        {configSummary.activeMode ? (
          <ConfigLine
            label={t("audio:global.mode")}
            value={modeValue}
          />
        ) : null}
        {configSummary.audioDialect || configSummary.modelKey ? (
          <details className="rounded-md border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground">
              {t("audio:global.technical_details")}
            </summary>
            <div className="mt-2 space-y-2">
              <ConfigLine
                label={t("audio:global.dialect")}
                value={dialectValue}
              />
              <ConfigLine
                label={t("audio:global.model")}
                value={modelValue}
                mono
              />
            </div>
          </details>
        ) : null}
        {configSummary.availableModes?.length ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">
              {t("audio:global.capabilities")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {configSummary.availableModes.map((mode) => (
                <Badge
                  key={mode}
                  variant="outline"
                  className="px-1.5 py-0 text-[10px] text-muted-foreground"
                >
                  {t(`audio:speech.mode.${mode}`)}
                </Badge>
              ))}
            </div>
          </div>
        ) : configSummary.capabilities.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">
              {t("audio:global.capabilities")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {configSummary.capabilities.map((capability) => (
                <Badge
                  key={capability}
                  variant="outline"
                  className="px-1.5 py-0 text-[10px] text-muted-foreground"
                >
                  {t(`setting:fields.audio.capability.${capability}`)}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        {asideExtra ? (
          <div className="border-t pt-3">
            {asideExtra(context)}
          </div>
        ) : null}
        </div>
      </ToolConfigPanel>
    </div>
  );

  return (
    <ToolDetailLayout header={header} aside={aside}>
      <ToolStatBar
        title={t("audio:global.summary")}
        icon={<Cpu />}
        columns={4}
        items={statItems}
      />
      {children ? (
        children(context)
      ) : (
        <ToolPanel
          icon={meta.icon}
          title={t(workspaceTitleKey)}
          badge={
            <Badge variant="outline" className={statusTone.className}>
              {t(`audio:status.${configSummary.status}`)}
            </Badge>
          }
          bodyClassName="p-6"
        >
          <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
            <div className="max-w-md space-y-3">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
                {statusTone.symbol}
              </div>
              <div className="text-sm font-medium">
                {t(`audio:workspace.${configSummary.status}.title`)}
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">
                {t(`audio:workspace.${configSummary.status}.description`)}
              </div>
            </div>
          </div>
        </ToolPanel>
      )}
    </ToolDetailLayout>
  );
}

function ConfigLine({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? "truncate font-mono" : "truncate"}>
        {value || "-"}
      </span>
    </div>
  );
}

function resolveStatusTone(status: AudioToolConfigStatus) {
  if (status === "ready") {
    return {
      className: "gap-1 border-emerald-500/25 text-emerald-700 dark:text-emerald-300",
      icon: <CheckCircle2 className="h-3 w-3" />,
      symbol: <CheckCircle2 className="h-4 w-4" />,
    };
  }

  return {
    className: "gap-1 border-amber-500/25 text-amber-700 dark:text-amber-300",
    icon: <AlertTriangle className="h-3 w-3" />,
    symbol: <AlertTriangle className="h-4 w-4" />,
  };
}

export default AudioToolShell;
