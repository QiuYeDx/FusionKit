import type { TFunction } from "i18next";
import { FileVideo2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToolRadioButtonGroup } from "@/pages/Tools/_shared/ui";
import type {
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleMediaProbeSummary,
} from "@/type/localSubtitleIpc";
import {
  formatLocalSubtitleBytes,
  formatLocalSubtitleDuration,
  type LocalSubtitleDraftMediaProbe,
} from "./localSubtitleTranscriberModel";

const AUTO_TRACK_VALUE = "auto";

interface LocalSubtitleDraftMediaListProps {
  readonly files: readonly LocalSubtitleAuthorizedMedia[];
  readonly probes: ReadonlyMap<string, LocalSubtitleDraftMediaProbe>;
  readonly explicitAudioStreamIds: ReadonlyMap<string, string>;
  readonly disabled: boolean;
  readonly probeQueuePending: boolean;
  onClear(): void;
  onRemove(fileToken: string): void;
  onRetryProbe(file: LocalSubtitleAuthorizedMedia): void;
  onAudioStreamChange(fileToken: string, audioStreamId: string | null): void;
}

export function LocalSubtitleDraftMediaList({
  files,
  probes,
  explicitAudioStreamIds,
  disabled,
  probeQueuePending,
  onClear,
  onRemove,
  onRetryProbe,
  onAudioStreamChange,
}: LocalSubtitleDraftMediaListProps) {
  const { t } = useTranslation("subtitle");

  return (
    <div data-testid="local-subtitle-draft-files" className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-3 px-1">
        <div className="text-xs font-medium text-muted-foreground">
          {t("local_transcriber.file.selected_count", { count: files.length })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={onClear}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("local_transcriber.actions.clear_files")}
        </Button>
      </div>
      <div className="mt-1 max-h-[28rem] space-y-1 overflow-y-auto">
        {files.map((file) => {
          const probe = probes.get(file.fileToken);
          return (
            <div
              key={file.fileToken}
              data-testid="local-subtitle-draft-file"
              className="min-w-0 rounded-lg px-2 py-2.5"
            >
              <div className="flex min-w-0 items-start gap-3">
                <FileVideo2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{file.displayName}</div>
                  <DraftMediaSummary file={file} probe={probe} />
                </div>
                {probe?.status === "error" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled || probeQueuePending}
                    onClick={() => onRetryProbe(file)}
                    aria-label={t("local_transcriber.actions.retry_probe", {
                      name: file.displayName,
                    })}
                    title={t("local_transcriber.actions.retry_probe", {
                      name: file.displayName,
                    })}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  onClick={() => onRemove(file.fileToken)}
                  aria-label={t("local_transcriber.actions.remove_draft_file", {
                    name: file.displayName,
                  })}
                  title={t("local_transcriber.actions.remove_draft_file", {
                    name: file.displayName,
                  })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {probe?.status === "ready" && probe.summary.audioTracks.length > 1 ? (
                <div className="ml-7 mt-3 max-h-56 overflow-y-auto pr-1">
                  <ToolRadioButtonGroup
                    value={explicitAudioStreamIds.get(file.fileToken) ?? AUTO_TRACK_VALUE}
                    orientation="vertical"
                    disabled={disabled}
                    ariaLabel={t("local_transcriber.audio.group_label", {
                      name: file.displayName,
                    })}
                    options={createTrackOptions(probe.summary, t)}
                    onValueChange={(value) => {
                      onAudioStreamChange(
                        file.fileToken,
                        value === AUTO_TRACK_VALUE ? null : value,
                      );
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DraftMediaSummary({
  file,
  probe,
}: {
  readonly file: LocalSubtitleAuthorizedMedia;
  readonly probe: LocalSubtitleDraftMediaProbe | undefined;
}) {
  const { t } = useTranslation("subtitle");
  if (!probe || probe.status === "loading") {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("local_transcriber.file.probing")}
      </div>
    );
  }
  if (probe.status === "error") {
    return (
      <div className="mt-1 text-[11px] text-destructive [overflow-wrap:anywhere]">
        {"kind" in probe.error
          ? t("local_transcriber.file.probe_mismatch")
          : probe.error.message}
      </div>
    );
  }

  const { summary } = probe;
  const onlyTrack = summary.audioTracks.length === 1
    ? trackMetadata(summary.audioTracks[0]!, t)
    : null;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <span>{formatLocalSubtitleBytes(file.byteSize)}</span>
      <span>{formatLocalSubtitleDuration(summary.durationMs)}</span>
      <span>
        {t("local_transcriber.audio.track_count", {
          count: summary.audioTracks.length,
        })}
      </span>
      {onlyTrack ? <span className="min-w-0 truncate">{onlyTrack}</span> : null}
    </div>
  );
}

function createTrackOptions(
  summary: LocalSubtitleMediaProbeSummary,
  t: TFunction<"subtitle">,
) {
  const automatic = summary.audioTracks.find(
    (track) => track.streamId === summary.autoSelectedStreamId,
  )!;
  return [
    {
      value: AUTO_TRACK_VALUE,
      label: (
        <span className="min-w-0">
          {t("local_transcriber.audio.auto", { track: automatic.ordinal })}
        </span>
      ),
    },
    ...summary.audioTracks.map((track) => {
      const details = trackMetadata(track, t);
      return {
        value: track.streamId,
        ariaLabel: details
          ? t("local_transcriber.audio.track_aria", {
              track: track.ordinal,
              details,
            })
          : t("local_transcriber.audio.track", { track: track.ordinal }),
        label: (
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block font-medium">
                {t("local_transcriber.audio.track", { track: track.ordinal })}
              </span>
              {details ? (
                <span className="block break-words text-[11px] opacity-80">
                  {details}
                </span>
              ) : null}
            </span>
            {track.isDefault ? (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {t("local_transcriber.audio.default")}
              </Badge>
            ) : null}
          </span>
        ),
      };
    }),
  ];
}

function trackMetadata(
  track: LocalSubtitleMediaProbeSummary["audioTracks"][number],
  t: TFunction<"subtitle">,
): string {
  return [
    track.title,
    track.language,
    track.codec?.toUpperCase(),
    track.channels === undefined
      ? undefined
      : t("local_transcriber.audio.channels", { count: track.channels }),
    track.sampleRateHz === undefined
      ? undefined
      : t("local_transcriber.audio.sample_rate", {
          rate: formatSampleRate(track.sampleRateHz),
        }),
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function formatSampleRate(sampleRateHz: number): string {
  if (sampleRateHz % 1_000 === 0) return `${sampleRateHz / 1_000} kHz`;
  return `${sampleRateHz} Hz`;
}
