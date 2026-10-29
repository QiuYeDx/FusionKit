import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Settings2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUDIO_FORMATS,
  COMPRESS_CODECS,
  CONVERSION_TASKS,
  MAX_SHORT_SIDES,
  TIERS,
  VIDEO_CONTAINERS,
  type AudioFormat,
  type CompressCodec,
  type MaxShortSide,
  type Tier,
} from "@/media-converter/contract";
import { mediaErrorCodeOf, type MediaConverterController, type MediaConverterState } from "@/services/media-converter/controller";
import {
  compressCodecOf,
  useMediaConverterPreferences,
} from "@/store/tools/media/useMediaConverterPreferences";
import { showToast } from "@/utils/toast";
import { ToolConfigDisclosure } from "../../_shared/ui/ToolConfigDisclosure";
import { ToolConfigPanel } from "../../_shared/ui/ToolConfigPanel";
import { ToolField } from "../../_shared/ui/ToolField";
import { ToolOutputPathPicker } from "../../_shared/ui/ToolOutputPathPicker";
import { ToolRadioButtonGroup } from "../../_shared/ui/ToolRadioButtonGroup";
import { ToolSwitchRow } from "../../_shared/ui/ToolSwitchRow";
import {
  AUDIO_TIER_LABELS,
  CODEC_COMPATIBILITY_LABELS,
  CODEC_LABELS,
  CONFLICT_LABELS,
  CONTAINER_LABELS,
  OUTPUT_MODE_LABELS,
  TASK_LABELS,
  TIER_LABELS,
  encoderLabel,
  requestErrorLabel,
} from "./labels";

/** The names formats go by everywhere; they are not translated. */
export const FORMAT_NAMES = {
  mp4: "MP4", mkv: "MKV", webm: "WebM", mov: "MOV",
  mp3: "MP3", m4a: "M4A (AAC)", opus: "Opus", flac: "FLAC", wav: "WAV", alac: "ALAC",
} as const satisfies Record<(typeof VIDEO_CONTAINERS)[number] | AudioFormat, string>;
const CODEC_NAMES = { av1: "AV1", hevc: "HEVC", h264: "H.264" } as const satisfies Record<CompressCodec, string>;
/** Lossy audio formats: only they have a quality tier (AC-WORKBENCH-03-3). */
const LOSSY_AUDIO: ReadonlySet<string> = new Set<AudioFormat>(["mp3", "m4a", "opus"]);
const ORIGINAL_RESOLUTION = "original";

/**
 * The aside sticks 40px below the top (ToolDetailLayout `lg:top-10`). The floating bottom navigation
 * and the Agent orb end 50px above the window's bottom edge; 6px more keeps the panel's end clear of them.
 */
const STICKY_TOP_PX = 40;
const BOTTOM_RESERVE_PX = 56;
/** `ToolConfigDisclosure` pads its content 8px above and 12px below. */
const DISCLOSURE_CONTENT_PADDING_PX = 20;

const HINT = "text-[11px] leading-relaxed text-muted-foreground";

export interface MediaConverterSettingsProps {
  state: MediaConverterState;
  controller: MediaConverterController;
  /** The panel cannot fit the window even with "output and performance" folded: the page stops keeping it in view. */
  onTallChange?: (tall: boolean) => void;
}

/**
 * The settings panel (AC-WORKBENCH-03-1–4, AC-WORKBENCH-05-2): the task, its fields with their
 * defaults, then "output and performance", folded when the open panel would be taller than the
 * window. Everything but low-usage mode lives in the preferences store; low-usage mode is the main
 * process's queue option.
 */
export function MediaConverterSettings({ state, controller, onTallChange }: MediaConverterSettingsProps) {
  const { t } = useTranslation("media");
  const preferences = useMediaConverterPreferences();
  const { task, compress, convert, extract, output, conflict } = preferences;
  const capabilities = state.engine?.capabilities;
  const ready = capabilities?.state === "ready";
  const defaultCodec = state.defaults?.compressCodec ?? "h264";
  const codec = compressCodecOf(preferences, defaultCodec);
  const av1Hardware = ready && !!state.resolvedEncoders?.av1.gpuOn?.hardware;
  const gpuOn = codec === "av1" && av1Hardware && compress.useGpuForAv1;
  // The encoder this codec gets here; only a finished detection tells (before it, every chain is a CPU one).
  const resolved = ready ? state.resolvedEncoders?.[codec]?.[gpuOn ? "gpuOn" : "gpuOff"] ?? null : null;

  const panelRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const codecFieldId = useId();
  // The hint and its button go away with the switch: the keyboard focus moves to the codec it chose, not to the page.
  const useAv1 = () => {
    preferences.setCompress({ codec: "av1" });
    requestAnimationFrame(() => document.getElementById(codecFieldId)?.querySelector<HTMLElement>('[role=radio][data-value="av1"]')?.focus());
  };
  const { tooTall, tall, settled } = usePanelFit(panelRef, outputRef);
  const [outputOpen, setOutputOpen] = useState<boolean | null>(null);
  const outputExpanded = outputOpen ?? !tooTall;
  useEffect(() => { onTallChange?.(tall); }, [tall, onTallChange]);

  const [pickingDirectory, setPickingDirectory] = useState(false);
  const pickDirectory = async () => {
    if (pickingDirectory) return;
    setPickingDirectory(true);
    try {
      const directory = await controller.pickOutputDirectory();
      if (directory) preferences.setOutputDirectory(directory);
    } catch (error) {
      showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error");
    } finally {
      setPickingDirectory(false);
    }
  };
  // A folder the engine no longer lists (forgotten, or its state was reset) goes back to "beside the
  // source", once the snapshot says which folders it knows; not while a pick is changing the list.
  const reconcileOutputDirectories = preferences.reconcileOutputDirectories;
  useEffect(() => {
    if (state.phase !== "ready" || pickingDirectory) return;
    if (reconcileOutputDirectories(state.outputDirectories)) showToast(t("settings.output_directory_missing"), "warning");
  }, [state.phase, state.outputDirectories, pickingDirectory, output, reconcileOutputDirectories, t]);

  const setLowUsage = (lowUsage: boolean) => {
    controller.setOptions({ lowUsage }).catch(error => showToast(t(requestErrorLabel(mediaErrorCodeOf(error))), "error"));
  };

  const lowUsage = state.options?.lowUsage ?? false;
  const outputSummary = [
    t(OUTPUT_MODE_LABELS[output.mode]),
    t(CONFLICT_LABELS[conflict]),
    lowUsage ? t("settings.low_usage_on") : null,
  ].filter(Boolean).join(" · ");

  return (
    <div ref={panelRef} data-testid="media-converter-settings" data-output-expanded={outputExpanded} data-too-tall={tooTall} data-tall={tall}>
      <ToolConfigPanel icon={Settings2} title={t("settings.title")}>
        <ToolField label={t("settings.task_label")}>
          <ToolRadioButtonGroup
            value={task}
            ariaLabel={t("settings.task_label")}
            options={CONVERSION_TASKS.map(value => ({ value, label: t(TASK_LABELS[value]), testId: `media-task-${value}` }))}
            onValueChange={preferences.setTask}
          />
        </ToolField>

        {/* The task's own fields fade in; the panel keeps the same frame. */}
        <div key={task} data-testid={`media-settings-${task}`} className="animate-in fade-in-0 space-y-4 duration-200 motion-reduce:animate-none">
          {task === "compress" ? (
            <>
              <ToolField label={t("settings.tier_label")}>
                <ToolRadioButtonGroup
                  value={compress.tier}
                  ariaLabel={t("settings.tier_label")}
                  options={TIERS.map(value => ({ value, label: t(TIER_LABELS[value]), testId: `media-tier-${value}` }))}
                  onValueChange={tier => preferences.setCompress({ tier })}
                />
              </ToolField>

              <ToolField id={codecFieldId} label={t("settings.codec_label")} testId="media-codec-field">
                <ToolRadioButtonGroup
                  value={codec}
                  orientation="vertical"
                  ariaLabel={t("settings.codec_label")}
                  options={COMPRESS_CODECS.map(value => ({ value, label: t(CODEC_LABELS[value]), testId: `media-codec-${value}` }))}
                  onValueChange={value => preferences.setCompress({ codec: value })}
                />
                <p data-testid="media-codec-compatibility" className={HINT}>{t(CODEC_COMPATIBILITY_LABELS[codec])}</p>
                {resolved?.weak ? (
                  <WeakEncoderNotice
                    codec={CODEC_NAMES[codec]}
                    encoder={t(encoderLabel(resolved.encoder, resolved.variant))}
                    onUseAv1={useAv1}
                  />
                ) : null}
              </ToolField>

              {/* Two short choices share a row, so the folded panel fits a 1280×800 window (design 纵向预算). */}
              <div data-testid="media-format-row" className="grid grid-cols-2 gap-3">
                <ToolField className="min-w-0" label={t("settings.container_label")} hint={t("settings.container_hint")}>
                  <ToolRadioButtonGroup
                    value={compress.container}
                    ariaLabel={t("settings.container_label")}
                    options={(["auto", "mp4", "mkv"] as const).map(value => ({ value, label: t(CONTAINER_LABELS[value]), testId: `media-container-${value}` }))}
                    onValueChange={container => preferences.setCompress({ container })}
                  />
                </ToolField>

                <ToolField className="min-w-0" label={t("settings.resolution_label")} htmlFor="media-resolution">
                  <Select
                    value={compress.maxShortSide === null ? ORIGINAL_RESOLUTION : String(compress.maxShortSide)}
                    onValueChange={value => preferences.setCompress({ maxShortSide: value === ORIGINAL_RESOLUTION ? null : Number(value) as MaxShortSide })}
                  >
                    {/* `sm` is 28px, the height of the segmented control beside it. */}
                    <SelectTrigger id="media-resolution" data-testid="media-resolution" size="sm" className="w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ORIGINAL_RESOLUTION}>{t("settings.resolution_original")}</SelectItem>
                      {MAX_SHORT_SIDES.map(side => <SelectItem key={side} value={String(side)}>{`${side}p`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </ToolField>
              </div>

              <GpuSwitch
                checked={gpuOn}
                disabledReason={codec !== "av1" ? t("settings.gpu_disabled_codec") : !ready ? t("settings.gpu_disabled_detecting") : !av1Hardware ? t("settings.gpu_disabled_hardware") : null}
                label={t("settings.gpu_label")}
                hint={t("settings.gpu_hint")}
                onCheckedChange={useGpuForAv1 => preferences.setCompress({ useGpuForAv1 })}
              />

              <ToolSwitchRow
                id="media-discard-if-not-smaller"
                testId="media-discard-if-not-smaller"
                label={t("settings.discard_label")}
                hint={t("settings.discard_hint")}
                checked={compress.discardIfNotSmaller}
                onCheckedChange={discardIfNotSmaller => preferences.setCompress({ discardIfNotSmaller })}
              />
            </>
          ) : task === "convert" ? (
            <>
              <ToolField label={t("settings.target_label")} htmlFor="media-convert-target">
                <Select value={convert.target} onValueChange={value => preferences.setConvert({ target: value as typeof convert.target })}>
                  <SelectTrigger id="media-convert-target" data-testid="media-convert-target" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{t("settings.target_group_video")}</SelectLabel>
                      {VIDEO_CONTAINERS.map(value => <SelectItem key={value} value={value}>{FORMAT_NAMES[value]}</SelectItem>)}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>{t("settings.target_group_audio")}</SelectLabel>
                      {AUDIO_FORMATS.map(value => <SelectItem key={value} value={value}>{FORMAT_NAMES[value]}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </ToolField>
              <ToolSwitchRow
                id="media-prefer-remux"
                testId="media-prefer-remux"
                label={t("settings.remux_label")}
                hint={t("settings.remux_hint")}
                checked={convert.preferRemux}
                onCheckedChange={preferRemux => preferences.setConvert({ preferRemux })}
              />
              <TierField
                label={t((AUDIO_FORMATS as readonly string[]).includes(convert.target) ? "settings.reencode_audio_tier_label" : "settings.reencode_tier_label")}
                audio={(AUDIO_FORMATS as readonly string[]).includes(convert.target)}
                value={convert.tier}
                onValueChange={tier => preferences.setConvert({ tier })}
              />
            </>
          ) : (
            <>
              <ToolField label={t("settings.extract_format_label")} htmlFor="media-extract-format">
                <Select value={extract.format} onValueChange={value => preferences.setExtract({ format: value as typeof extract.format })}>
                  <SelectTrigger id="media-extract-format" data-testid="media-extract-format" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="copy">{t("settings.extract_copy")}</SelectItem>
                    {AUDIO_FORMATS.map(value => <SelectItem key={value} value={value}>{FORMAT_NAMES[value]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ToolField>
              {LOSSY_AUDIO.has(extract.format) ? (
                <TierField label={t("settings.audio_tier_label")} audio value={extract.tier} onValueChange={tier => preferences.setExtract({ tier })} />
              ) : null}
              <ToolSwitchRow
                id="media-all-tracks"
                testId="media-all-tracks"
                label={t("settings.all_tracks_label")}
                hint={t("settings.all_tracks_hint")}
                checked={extract.allTracks}
                onCheckedChange={allTracks => preferences.setExtract({ allTracks })}
              />
            </>
          )}
        </div>

        {/* Last in the panel: it takes the panel's bottom padding and leaves the outer border as the edge (FK-PIT-0089). */}
        <div className="-mb-3">
          <ToolConfigDisclosure
            testId="media-output-group"
            className={cn("border-b-0", !settled && "[&>div]:transition-none")}
            icon={Cpu}
            title={t("settings.output_group")}
            summary={outputSummary}
            open={outputExpanded}
            onOpenChange={setOutputOpen}
            contentClassName="space-y-4"
          >
            <div ref={outputRef} className="space-y-4">
              <ToolField label={t("settings.output_mode_label")}>
                <ToolRadioButtonGroup
                  value={output.mode}
                  ariaLabel={t("settings.output_mode_label")}
                  options={(["source", "directory"] as const).map(value => ({ value, label: t(OUTPUT_MODE_LABELS[value]), testId: `media-output-${value}` }))}
                  onValueChange={mode => {
                    if (mode === "source") preferences.setOutputSource();
                    else void pickDirectory();
                  }}
                />
                {output.mode === "directory" ? (
                  <ToolOutputPathPicker
                    value={output.directory.displayName}
                    placeholder={t("settings.no_directory")}
                    selectLabel={t("settings.choose_directory")}
                    disabled={pickingDirectory}
                    onSelect={() => void pickDirectory()}
                  />
                ) : (
                  <p className={HINT}>{t("settings.output_source_hint")}</p>
                )}
              </ToolField>

              <ToolField label={t("settings.conflict_label")}>
                <ToolRadioButtonGroup
                  value={conflict}
                  ariaLabel={t("settings.conflict_label")}
                  options={(["number", "overwrite"] as const).map(value => ({ value, label: t(CONFLICT_LABELS[value]), testId: `media-conflict-${value}` }))}
                  onValueChange={preferences.setConflict}
                />
                {conflict === "overwrite" ? (
                  <p data-testid="media-overwrite-warning" role="note" className="flex gap-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                    <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                    <span>{t("settings.overwrite_warning")}</span>
                  </p>
                ) : null}
              </ToolField>

              {/* Not disabled while the main process saves it: a disabled switch would drop the keyboard focus on every toggle. */}
              <ToolSwitchRow
                id="media-low-usage"
                testId="media-low-usage"
                label={t("settings.low_usage_label")}
                hint={t("settings.low_usage_hint")}
                checked={lowUsage}
                disabled={!state.options}
                onCheckedChange={setLowUsage}
              />
            </div>
          </ToolConfigDisclosure>
        </div>
      </ToolConfigPanel>
    </div>
  );
}

function TierField({ label, audio = false, value, onValueChange }: { label: string; audio?: boolean; value: Tier; onValueChange: (tier: Tier) => void }) {
  const { t } = useTranslation("media");
  return (
    <ToolField label={label}>
      <ToolRadioButtonGroup
        value={value}
        ariaLabel={label}
        options={TIERS.map(tier => ({ value: tier, label: t(audio ? AUDIO_TIER_LABELS[tier] : TIER_LABELS[tier]), testId: `media-tier-${tier}` }))}
        onValueChange={onValueChange}
      />
    </ToolField>
  );
}

/**
 * Only a weak CPU encoder works for this codec here (AC-WORKBENCH-05-2): one amber line under the
 * compatibility sentence, as the queue rows warn, with "use AV1" at its end.
 */
function WeakEncoderNotice({ codec, encoder, onUseAv1 }: { codec: string; encoder: string; onUseAv1: () => void }) {
  const { t } = useTranslation("media");
  const sentence = t("settings.weak_encoder", { codec, encoder });
  // A Chinese or Japanese sentence ends in a full-width stop, which carries its own space; a Latin one needs one before the link.
  const gap = /[\u3000-\u303f\uff00-\uffef]$/.test(sentence) ? "" : " ";
  return (
    <p data-testid="media-weak-encoder" role="note" className="flex gap-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
      <TriangleAlert aria-hidden className="mt-[3px] size-3 shrink-0" />
      <span className="min-w-0">
        {sentence}{gap}
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 align-baseline text-[11px] font-medium text-amber-800 underline underline-offset-2 dark:text-amber-300"
          data-testid="media-use-av1"
          onClick={onUseAv1}
        >
          {t("settings.use_av1")}
        </Button>
      </span>
    </p>
  );
}

/**
 * "Use the graphics card": AV1 only, and only with an AV1 hardware encoder (AC-WORKBENCH-03-2).
 * When it cannot be turned on, a tooltip says why; the row takes focus so the keyboard reaches it.
 */
function GpuSwitch({ checked, disabledReason, label, hint, onCheckedChange }: {
  checked: boolean; disabledReason: string | null; label: string; hint: string; onCheckedChange: (checked: boolean) => void;
}) {
  const reasonId = useId();
  const row = <ToolSwitchRow id="media-use-gpu" testId="media-use-gpu" label={label} hint={hint} checked={checked} disabled={disabledReason !== null} onCheckedChange={onCheckedChange} />;
  if (disabledReason === null) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div data-testid="media-use-gpu-reason-trigger" tabIndex={0} role="group" aria-label={label} aria-describedby={reasonId} className="rounded-smooth-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {row}
          <span id={reasonId} className="sr-only">{disabledReason}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" data-testid="media-use-gpu-reason" className="max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal text-balance">
        {disabledReason}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Whether the panel fits the window with "output and performance" open (`tooTall` folds it by
 * default) and folded (`tall`: it cannot fit either way). `settled` turns on the disclosure's
 * transition only after the first measurement, so the first frame never animates.
 */
function usePanelFit(panelRef: RefObject<HTMLDivElement | null>, outputRef: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ tooTall: false, tall: false });
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const content = outputRef.current;
    if (!panel || !content) return;
    const measure = () => {
      const toggle = content.closest("[data-slot=tool-config-disclosure]")?.querySelector(":scope > button");
      if (!toggle) return;
      const available = window.innerHeight - STICKY_TOP_PX - BOTTOM_RESERVE_PX;
      // The panel down to the folded group's header, its outer border below it, and the group's content when open.
      const folded = toggle.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 1;
      const open = folded + content.offsetHeight + DISCLOSURE_CONTENT_PADDING_PX;
      setFit(previous => previous.tooTall === open > available && previous.tall === folded > available
        ? previous : { tooTall: open > available, tall: folded > available });
    };
    measure();
    const frame = requestAnimationFrame(() => setSettled(true));
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelRef, outputRef]);
  return { ...fit, settled };
}

export default MediaConverterSettings;
