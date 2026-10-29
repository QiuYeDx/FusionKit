import type {
  AddFilesResult,
  CompressCodec,
  ConversionTask,
  EncoderId,
  EngineReasonCode,
  HardwareEncoderFamily,
  HdrFormat,
  ItemPhase,
  ItemStatus,
  MediaConverterErrorCode,
  OutputConflict,
  OutputContainer,
  PickFileFilter,
  PlanConfirmationCode,
  PlanNotApplicableCode,
  PlanWarningCode,
  ProbeFailureCode,
  StreamDropReason,
  SubtitleKind,
  Tier,
  VariantKey,
} from "@/media-converter/contract";

// Code → message key maps for the `media` namespace (`useTranslation("media")`). Every map covers its
// whole code union, so `t(MAP[code])` with a typed code resolves to a finite key set that
// check-i18n-usage verifies without manifest entries.

export const TASK_LABELS = {
  compress: "settings.task.compress",
  convert: "settings.task.convert",
  "extract-audio": "settings.task.extract",
} as const satisfies Record<ConversionTask, string>;

/** Video tiers: compression and video re-encoding. */
export const TIER_LABELS = {
  quality: "settings.tier.quality",
  balanced: "settings.tier.balanced",
  size: "settings.tier.size",
} as const satisfies Record<Tier, string>;

/** The same tiers for audio: high, standard, small (module-encode design §1). */
export const AUDIO_TIER_LABELS = {
  quality: "settings.audio_tier.quality",
  balanced: "settings.audio_tier.balanced",
  size: "settings.audio_tier.size",
} as const satisfies Record<Tier, string>;

/** Output codecs named by purpose (AC-WORKBENCH-03-2). */
export const CODEC_LABELS = {
  av1: "settings.codec.av1",
  hevc: "settings.codec.hevc",
  h264: "settings.codec.h264",
} as const satisfies Record<CompressCodec, string>;

/** The one compatibility sentence under the codec (AC-WORKBENCH-03-2). */
export const CODEC_COMPATIBILITY_LABELS = {
  av1: "settings.codec_compatibility.av1",
  hevc: "settings.codec_compatibility.hevc",
  h264: "settings.codec_compatibility.h264",
} as const satisfies Record<CompressCodec, string>;

export const CONTAINER_LABELS = {
  auto: "settings.container.auto",
  mp4: "settings.container.mp4",
  mkv: "settings.container.mkv",
} as const satisfies Record<"auto" | "mp4" | "mkv", string>;

export const OUTPUT_MODE_LABELS = {
  source: "settings.output_mode.source",
  directory: "settings.output_mode.directory",
} as const satisfies Record<"source" | "directory", string>;

export const CONFLICT_LABELS = {
  number: "settings.conflict.number",
  overwrite: "settings.conflict.overwrite",
} as const satisfies Record<OutputConflict, string>;

/** Friendly encoder names ("SVT-AV1 (CPU)", "NVIDIA NVENC HEVC"); `h264_mf_sw` is h264_mf's software mode. */
export const ENCODER_LABELS = {
  libsvtav1: "encoders.libsvtav1",
  av1_nvenc: "encoders.av1_nvenc",
  av1_qsv: "encoders.av1_qsv",
  av1_amf: "encoders.av1_amf",
  hevc_nvenc: "encoders.hevc_nvenc",
  hevc_qsv: "encoders.hevc_qsv",
  hevc_amf: "encoders.hevc_amf",
  hevc_mf: "encoders.hevc_mf",
  libkvazaar: "encoders.libkvazaar",
  h264_nvenc: "encoders.h264_nvenc",
  h264_qsv: "encoders.h264_qsv",
  h264_amf: "encoders.h264_amf",
  h264_mf: "encoders.h264_mf",
  h264_mf_sw: "encoders.h264_mf_sw",
  libopenh264: "encoders.libopenh264",
  aac: "encoders.aac",
  libopus: "encoders.libopus",
  libmp3lame: "encoders.libmp3lame",
  flac: "encoders.flac",
  alac: "encoders.alac",
  pcm_s16le: "encoders.pcm_s16le",
  pcm_s24le: "encoders.pcm_s24le",
  pcm_s32le: "encoders.pcm_s32le",
  pcm_f32le: "encoders.pcm_f32le",
  mov_text: "encoders.mov_text",
  srt: "encoders.srt",
  webvtt: "encoders.webvtt",
} as const satisfies Record<EncoderId | "h264_mf_sw", string>;

/** The key of an encoder's friendly name: h264_mf's software mode is a CPU encoder with a name of its own (`encoderNameKey`). */
export function encoderLabel(encoder: EncoderId, variant: VariantKey | null = null): (typeof ENCODER_LABELS)[keyof typeof ENCODER_LABELS] {
  return encoder === "h264_mf" && variant === "8bit_sw" ? ENCODER_LABELS.h264_mf_sw : ENCODER_LABELS[encoder];
}

/** Hardware encoder families as the engine badge names them ("NVIDIA NVENC"). */
export const HARDWARE_FAMILY_LABELS = {
  nvenc: "engine.family.nvenc",
  qsv: "engine.family.qsv",
  amf: "engine.family.amf",
  mf: "engine.family.mf",
} as const satisfies Record<HardwareEncoderFamily, string>;

/** The family of a hardware video encoder, by its ffmpeg name. */
export function hardwareFamilyOf(encoder: string): HardwareEncoderFamily | null {
  if (encoder.endsWith("_nvenc")) return "nvenc";
  if (encoder.endsWith("_qsv")) return "qsv";
  if (encoder.endsWith("_amf")) return "amf";
  if (encoder.endsWith("_mf")) return "mf";
  return null;
}

/** Why the engine cannot be used, as the badge says it; the runtime has its own codes, anything else is `unknown`. */
export type EngineUnavailableCode = "platform_unsupported" | "runtime_missing" | "runtime_invalid" | "runtime_version_mismatch" | "runtime_spawn_failed"
  | "no_device" | "driver_too_old" | "unknown";

export const ENGINE_UNAVAILABLE_LABELS = {
  platform_unsupported: "engine.unavailable.platform_unsupported",
  runtime_missing: "engine.unavailable.runtime_missing",
  runtime_invalid: "engine.unavailable.runtime_invalid",
  runtime_version_mismatch: "engine.unavailable.runtime_version_mismatch",
  runtime_spawn_failed: "engine.unavailable.runtime_spawn_failed",
  no_device: "engine.unavailable.no_device",
  driver_too_old: "engine.unavailable.driver_too_old",
  unknown: "engine.unavailable.unknown",
} as const satisfies Record<EngineUnavailableCode, string>;

/** What to do about it (AC-WORKBENCH-05-1): reinstall for a damaged runtime, try again otherwise. */
export const ENGINE_ADVICE_LABELS = {
  platform_unsupported: "engine.advice.platform_unsupported",
  runtime_missing: "engine.advice.reinstall",
  runtime_invalid: "engine.advice.reinstall",
  runtime_version_mismatch: "engine.advice.reinstall",
  runtime_spawn_failed: "engine.advice.spawn_failed",
  no_device: "engine.advice.retry",
  driver_too_old: "engine.advice.driver",
  unknown: "engine.advice.retry",
} as const satisfies Record<EngineUnavailableCode, string>;

/** Engine and request codes alike: whatever the badge has no words for reads as `unknown`. */
export function engineUnavailableCode(code: EngineReasonCode | MediaConverterErrorCode): EngineUnavailableCode {
  return Object.hasOwn(ENGINE_UNAVAILABLE_LABELS, code) ? (code as EngineUnavailableCode) : "unknown";
}

/** Failed requests of the panel and the badge (pick a folder, low-usage mode, detect again). */
type RequestErrorCode = "busy" | "platform_unsupported" | "invalid_request" | "unknown";

export const REQUEST_ERROR_LABELS = {
  busy: "request_errors.busy",
  platform_unsupported: "request_errors.platform_unsupported",
  invalid_request: "request_errors.invalid_request",
  unknown: "request_errors.unknown",
} as const satisfies Record<RequestErrorCode, string>;

export function requestErrorLabel(code: MediaConverterErrorCode): (typeof REQUEST_ERROR_LABELS)[RequestErrorCode] {
  return Object.hasOwn(REQUEST_ERROR_LABELS, code) ? REQUEST_ERROR_LABELS[code as RequestErrorCode] : REQUEST_ERROR_LABELS.unknown;
}

// ── Adding files and the queue (T-WORKBENCH-03) ────────────────────────────────────────────────

/** The file-type menu of the upload area: the main-process dialog's filter (AC-WORKBENCH-02-1). */
export const PICK_FILTER_LABELS = {
  video: "upload.filter.video",
  audio: "upload.filter.audio",
  all: "upload.filter.all",
} as const satisfies Record<PickFileFilter, string>;

type AddRejectionCode = AddFilesResult["rejected"][number]["code"];

/** Why one dropped or picked file was not added, with its name (AC-WORKBENCH-02-1, AC-WORKBENCH-02-3). */
export const ADD_REJECTION_LABELS = {
  folder_not_supported: "add.rejected.folder_not_supported",
  temporary_copy_unresolved: "add.rejected.temporary_copy_unresolved",
  file_unavailable: "add.rejected.file_unavailable",
  not_a_regular_file: "add.rejected.not_a_regular_file",
} as const satisfies Record<AddRejectionCode, string>;

/** The same for several files of one reason, with their count. */
export const ADD_REJECTION_MANY_LABELS = {
  folder_not_supported: "add.rejected_many.folder_not_supported",
  temporary_copy_unresolved: "add.rejected_many.temporary_copy_unresolved",
  file_unavailable: "add.rejected_many.file_unavailable",
  not_a_regular_file: "add.rejected_many.not_a_regular_file",
} as const satisfies Record<AddRejectionCode, string>;

/** Probe failures of the file itself; a runtime failure is the engine's (`engineUnavailableCode`). */
type FileProbeFailureCode = Exclude<ProbeFailureCode, "platform_unsupported" | "runtime_missing" | "runtime_invalid" | "runtime_version_mismatch" | "runtime_spawn_failed">;

/** Why a file cannot be processed (AC-WORKBENCH-02-3), as `media:errors.<code>`. */
export const PROBE_FAILURE_LABELS = {
  no_media_streams: "errors.no_media_streams",
  container_not_allowed: "errors.container_not_allowed",
  wechat_silk_unsupported: "errors.wechat_silk_unsupported",
  probe_failed: "errors.probe_failed",
  file_unavailable: "errors.file_unavailable",
  not_a_regular_file: "errors.not_a_regular_file",
} as const satisfies Record<FileProbeFailureCode, string>;

/** What to do about it. */
export const PROBE_ADVICE_LABELS = {
  no_media_streams: "advice.no_media_streams",
  container_not_allowed: "advice.container_not_allowed",
  wechat_silk_unsupported: "advice.wechat_silk_unsupported",
  probe_failed: "advice.probe_failed",
  file_unavailable: "advice.file_unavailable",
  not_a_regular_file: "advice.not_a_regular_file",
} as const satisfies Record<FileProbeFailureCode, string>;

type ProbeFailureLabels =
  | { reason: (typeof PROBE_FAILURE_LABELS)[FileProbeFailureCode]; advice: (typeof PROBE_ADVICE_LABELS)[FileProbeFailureCode] }
  | { reason: (typeof ENGINE_UNAVAILABLE_LABELS)[EngineUnavailableCode]; advice: (typeof ENGINE_ADVICE_LABELS)[EngineUnavailableCode] };

/** The reason and advice keys of an unsupported item: the file's own, or the engine's when the runtime failed. */
export function probeFailureLabels(code: ProbeFailureCode): ProbeFailureLabels {
  if (Object.hasOwn(PROBE_FAILURE_LABELS, code)) {
    const own = code as FileProbeFailureCode;
    return { reason: PROBE_FAILURE_LABELS[own], advice: PROBE_ADVICE_LABELS[own] };
  }
  const engine = engineUnavailableCode(code);
  return { reason: ENGINE_UNAVAILABLE_LABELS[engine], advice: ENGINE_ADVICE_LABELS[engine] };
}

export const ITEM_STATUS_LABELS = {
  analyzing: "queue.status.analyzing",
  unsupported: "queue.status.unsupported",
  idle: "queue.status.idle",
  queued: "queue.status.queued",
  running: "queue.status.running",
  succeeded: "queue.status.succeeded",
  skipped: "queue.status.skipped",
  failed: "queue.status.failed",
  cancelled: "queue.status.cancelled",
  interrupted: "queue.status.interrupted",
  input_changed: "queue.status.input_changed",
} as const satisfies Record<ItemStatus, string>;

export const ITEM_PHASE_LABELS = {
  preparing: "queue.phase.preparing",
  encoding: "queue.phase.encoding",
  pass1: "queue.phase.pass1",
  pass2: "queue.phase.pass2",
  finalizing: "queue.phase.finalizing",
} as const satisfies Record<ItemPhase, string>;

/** The HDR mark of a video (AC-WORKBENCH-02-2); `none` has none. */
export const HDR_LABELS = {
  hdr10: "queue.hdr.hdr10",
  hlg: "queue.hdr.hlg",
  dolby_vision: "queue.hdr.dolby_vision",
} as const satisfies Record<Exclude<HdrFormat, "none">, string>;

/** Channel layouts by their count: mono, stereo, 5.1, 7.1, else "n channels" (with `count`). */
export function channelsLabel(channels: number) {
  if (channels === 1) return "queue.channels.mono" as const;
  if (channels === 2) return "queue.channels.stereo" as const;
  if (channels === 6) return "queue.channels.surround_51" as const;
  if (channels === 8) return "queue.channels.surround_71" as const;
  return "queue.channels.count" as const;
}

/** What the plan warns about, as `media:warnings.<code>` (with `count`, and `from`/`to` for a fallback). */
export const PLAN_WARNING_LABELS = {
  cpu_weak_encoder: "warnings.cpu_weak_encoder",
  hdr_tonemapped: "warnings.hdr_tonemapped",
  dolby_vision_rpu_dropped: "warnings.dolby_vision_rpu_dropped",
  chroma_subsampled: "warnings.chroma_subsampled",
  cover_dropped: "warnings.cover_dropped",
  downmixed_to_stereo: "warnings.downmixed_to_stereo",
  subtitle_styling_lost: "warnings.subtitle_styling_lost",
  subtitle_dropped: "warnings.subtitle_dropped",
  attachment_dropped: "warnings.attachment_dropped",
  mp4_default_subtitle_forced: "warnings.mp4_default_subtitle_forced",
  encoder_fallback: "warnings.encoder_fallback",
  chapters_dropped: "warnings.chapters_dropped",
  mp4_default_audio_forced: "warnings.mp4_default_audio_forced",
  duration_unverified: "warnings.duration_unverified",
  output_name_collision: "warnings.output_name_collision",
} as const satisfies Record<PlanWarningCode, string>;

/** Dropped subtitles named by what they are: "2 image subtitles will be dropped". */
export const SUBTITLE_DROPPED_LABELS = {
  image: "warnings.subtitle_dropped_image",
  text: "warnings.subtitle_dropped_text",
  other: "warnings.subtitle_dropped",
} as const satisfies Record<SubtitleKind, string>;

/** What the user confirms before the start (AC-WORKBENCH-03-6). */
export const PLAN_CONFIRMATION_LABELS = {
  lossy_to_lossless: "plan.confirm.lossy_to_lossless",
} as const satisfies Record<PlanConfirmationCode, string>;

/**
 * Why the current task does not apply to a file (AC-WORKBENCH-02-3): an audio file under "compress
 * video" or "extract audio", a target that needs a picture or a sound the file does not have.
 */
export type NotApplicableReason = "audio_compress" | "audio_extract" | "no_video" | "no_audio";

export const NOT_APPLICABLE_LABELS = {
  audio_compress: "queue.not_applicable.audio_compress",
  audio_extract: "queue.not_applicable.audio_extract",
  no_video: "queue.not_applicable.no_video",
  no_audio: "queue.not_applicable.no_audio",
} as const satisfies Record<NotApplicableReason, string>;

export function notApplicableReason(code: PlanNotApplicableCode, task: ConversionTask): NotApplicableReason {
  if (code === "no_video_stream") return "no_video";
  if (code === "no_audio_stream") return "no_audio";
  return task === "extract-audio" ? "audio_extract" : "audio_compress";
}

export const STREAM_KIND_LABELS = {
  video: "plan.kind.video",
  audio: "plan.kind.audio",
  subtitle: "plan.kind.subtitle",
  cover: "plan.kind.cover",
} as const satisfies Record<"video" | "audio" | "subtitle" | "cover", string>;

/** Why a stream is not in an output (with `format`, the output's). */
export const STREAM_DROP_LABELS = {
  not_selected: "plan.drop.not_selected",
  subtitle_dropped: "plan.drop.subtitle_dropped",
  cover_dropped: "plan.drop.cover_dropped",
} as const satisfies Record<StreamDropReason, string>;

/** Plan errors the interface explains itself; any other code reads as `unknown`. */
type PlanErrorLabelCode = "dolby_vision_p5_unsupported" | "unknown";

export const PLAN_ERROR_LABELS = {
  dolby_vision_p5_unsupported: "plan.errors.dolby_vision_p5_unsupported",
  unknown: "plan.errors.unknown",
} as const satisfies Record<PlanErrorLabelCode, string>;

export function planErrorLabel(code: MediaConverterErrorCode): (typeof PLAN_ERROR_LABELS)[PlanErrorLabelCode] {
  return code === "dolby_vision_p5_unsupported" ? PLAN_ERROR_LABELS.dolby_vision_p5_unsupported : PLAN_ERROR_LABELS.unknown;
}

// Names that are the same in every language: formats and codecs go by these.

/** Output containers as the plan names them. */
export const OUTPUT_CONTAINER_NAMES = {
  mp4: "MP4", mov: "MOV", mkv: "MKV", webm: "WebM", mp3: "MP3", m4a: "M4A", opus: "Opus", ogg: "Ogg", flac: "FLAC", wav: "WAV", aiff: "AIFF", mka: "MKA",
} as const satisfies Record<OutputContainer, string>;

const CODEC_NAMES: Readonly<Record<string, string>> = {
  // Video.
  h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8", mpeg2video: "MPEG-2", mpeg1video: "MPEG-1", mpeg4: "MPEG-4",
  msmpeg4v3: "MPEG-4 v3", h263: "H.263", prores: "ProRes", dnxhd: "DNxHD", mjpeg: "MJPEG", vc1: "VC-1", wmv3: "WMV 9", wmv2: "WMV 8",
  theora: "Theora", ffv1: "FFV1", flv1: "FLV", rv40: "RealVideo 4", png: "PNG", gif: "GIF",
  // Audio.
  aac: "AAC", mp3: "MP3", mp2: "MP2", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", alac: "ALAC", ac3: "AC-3", eac3: "E-AC-3", dts: "DTS",
  truehd: "TrueHD", wmav2: "WMA", wmapro: "WMA Pro", wmalossless: "WMA Lossless", amr_nb: "AMR-NB", amr_wb: "AMR-WB", ape: "APE",
  wavpack: "WavPack", tta: "TTA", cook: "RealAudio",
  // Subtitles.
  subrip: "SRT", ass: "ASS", ssa: "SSA", mov_text: "MP4 Timed Text", webvtt: "WebVTT", hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub",
  dvb_subtitle: "DVB", xsub: "XSUB", text: "Text",
};

/** A codec as people know it ("H.264", "HEVC", "PGS"); PCM in any sample format is "PCM", anything unknown its ffmpeg name in capitals. */
export function codecDisplayName(codec: string): string {
  if (codec.startsWith("pcm_")) return "PCM";
  return Object.hasOwn(CODEC_NAMES, codec) ? CODEC_NAMES[codec] : codec.toUpperCase();
}
