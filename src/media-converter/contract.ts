import { z } from 'zod';

/**
 * Shared protocol of the media converter: reason codes, the runtime status, the media
 * information the engine probes, and the conversion settings and plan summary of the planner.
 * The preload bundle and the renderer import this file too, so it depends on zod only
 * (`scripts/check-preload-bundle.mjs`).
 */

// ── Reason codes ───────────────────────────────────────────────────────────────────────────────
// Closed, English snake_case; the interface maps each one to text through i18n.

/** Every reason code the engine produces (module-engine requirements and design). */
export const ENGINE_REASON_CODES = [
  // Bundled runtime (R-ENGINE-01).
  'platform_unsupported', 'runtime_missing', 'runtime_invalid', 'runtime_version_mismatch', 'runtime_spawn_failed',
  // Probe (R-ENGINE-02).
  'probe_failed', 'no_media_streams', 'container_not_allowed', 'wechat_silk_unsupported',
  // Encoder capability categories (R-ENGINE-03); `runtime_missing` above is one of them as well.
  // `busy` answers "detect again" while a hardware encode runs.
  'driver_too_old', 'no_device', 'session_limit', 'params_rejected', 'unknown', 'busy',
  // Encoding process (R-ENGINE-04); `duration_unverified` is a warning on a success.
  'encoder_stalled', 'output_open_failed', 'disk_full', 'duration_unverified',
  // Queue (R-ENGINE-05). `encode_failed` is an encode that failed for no more specific reason (the
  // process's `unknown`, whose detail is the redacted log tail).
  'input_missing', 'input_changed', 'confirmation_required', 'encode_failed',
  // Output (R-ENGINE-06); `output_name_collision` is a warning. `output_publish_failed`: the finished
  // output could not be put under its name.
  'disk_space_low', 'output_cap_exceeded', 'file_too_large_for_volume', 'output_is_input', 'output_dir_unwritable',
  'output_path_too_long', 'overwrite_trash_failed', 'output_name_collision', 'output_publish_failed',
  // IPC and input authorization (R-ENGINE-07).
  'invalid_request', 'folder_not_supported', 'not_a_regular_file', 'file_unavailable', 'temporary_copy_unresolved',
] as const;
export const engineReasonCodeSchema = z.enum(ENGINE_REASON_CODES);
export type EngineReasonCode = z.infer<typeof engineReasonCodeSchema>;

/** Why the bundled ffmpeg/ffprobe cannot be used (AC-ENGINE-01-2, AC-ENGINE-01-3). */
export const runtimeFailureCodeSchema = engineReasonCodeSchema.extract([
  'platform_unsupported', 'runtime_missing', 'runtime_invalid', 'runtime_version_mismatch', 'runtime_spawn_failed',
]);
export type RuntimeFailureCode = z.infer<typeof runtimeFailureCodeSchema>;

/** Why a file cannot be processed after it was added (AC-ENGINE-02-4); a runtime failure applies to every file. */
export const probeFailureCodeSchema = engineReasonCodeSchema.extract([
  'probe_failed', 'no_media_streams', 'container_not_allowed', 'wechat_silk_unsupported', 'file_unavailable', 'not_a_regular_file',
  'platform_unsupported', 'runtime_missing', 'runtime_invalid', 'runtime_version_mismatch', 'runtime_spawn_failed',
]);
export type ProbeFailureCode = z.infer<typeof probeFailureCodeSchema>;

/** Warnings a plan can carry (module-encode design §1); plan warnings may also hold the engine's `duration_unverified`. */
const PLAN_WARNINGS = [
  'cpu_weak_encoder', 'hdr_tonemapped', 'dolby_vision_rpu_dropped', 'chroma_subsampled', 'cover_dropped', 'downmixed_to_stereo',
  'subtitle_styling_lost', 'subtitle_dropped', 'attachment_dropped', 'mp4_default_subtitle_forced', 'encoder_fallback',
  // The target cannot hold chapters (FLAC, WAV, Ogg Vorbis, AIFF): told before the start (AC-ENCODE-04-3).
  'chapters_dropped',
  // MP4/MOV enable the first audio track of a video when the source marks none default, as they do
  // the first subtitle (AC-ENCODE-01-4).
  'mp4_default_audio_forced',
] as const;
const PLAN_SKIPS = ['already_target', 'not_smaller'] as const;
const PLAN_NOT_APPLICABLE = ['task_not_applicable', 'no_audio_stream', 'no_video_stream'] as const;
const PLAN_ERRORS = ['no_encoder_available', 'dolby_vision_p5_unsupported'] as const;
const PLAN_CONFIRMATIONS = ['lossy_to_lossless'] as const;

/**
 * Every reason code the planner produces (module-encode, defined once by T-ENCODE-01): warnings,
 * skips, not-applicable answers, errors and confirmations. `duration_unverified` and
 * `output_name_collision` are engine codes above and are reused, not declared again.
 */
export const PLAN_REASON_CODES = [...PLAN_WARNINGS, ...PLAN_SKIPS, ...PLAN_NOT_APPLICABLE, ...PLAN_ERRORS, ...PLAN_CONFIRMATIONS] as const;
export const planReasonCodeSchema = z.enum(PLAN_REASON_CODES);
export type PlanReasonCode = z.infer<typeof planReasonCodeSchema>;

export const planWarningCodeSchema = z.enum([...PLAN_WARNINGS, 'duration_unverified', 'output_name_collision']);
export type PlanWarningCode = z.infer<typeof planWarningCodeSchema>;
/** Why an item is skipped without running ffmpeg (`already_target`) or after it (`not_smaller`). */
export const planSkipCodeSchema = planReasonCodeSchema.extract(PLAN_SKIPS);
export type PlanSkipCode = z.infer<typeof planSkipCodeSchema>;
/** The task does not apply to this kind of media (AC-ENCODE-01-6). */
export const planNotApplicableCodeSchema = planReasonCodeSchema.extract(PLAN_NOT_APPLICABLE);
export type PlanNotApplicableCode = z.infer<typeof planNotApplicableCodeSchema>;
/** No plan can be made: no arguments are produced. */
export const planErrorCodeSchema = planReasonCodeSchema.extract(PLAN_ERRORS);
export type PlanErrorCode = z.infer<typeof planErrorCodeSchema>;
/** The user confirms these before the item can start. */
export const planConfirmationCodeSchema = planReasonCodeSchema.extract(PLAN_CONFIRMATIONS);
export type PlanConfirmationCode = z.infer<typeof planConfirmationCodeSchema>;

/**
 * Warnings that mean content is lost or changed for the worse, which the interface shows on the
 * row and confirms before the start; the others (`cpu_weak_encoder`, `encoder_fallback`,
 * `mp4_default_subtitle_forced`, `mp4_default_audio_forced`, `duration_unverified`,
 * `output_name_collision`) only inform.
 */
export const PLAN_LOSS_CODES: readonly PlanWarningCode[] = [
  'subtitle_dropped', 'attachment_dropped', 'cover_dropped', 'chapters_dropped', 'subtitle_styling_lost', 'hdr_tonemapped',
  'dolby_vision_rpu_dropped', 'downmixed_to_stereo', 'chroma_subsampled',
];

// ── Runtime status ─────────────────────────────────────────────────────────────────────────────

/**
 * The bundled runtime part of the engine status. It stays `unverified` until media work first
 * needs it (the first visit to the tool page or the first added file), never at app start.
 */
export const runtimeStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unverified') }),
  z.strictObject({ state: z.literal('ready'), version: z.string().min(1).max(64) }),
  z.strictObject({ state: z.literal('unavailable'), code: runtimeFailureCodeSchema }),
]);
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

// ── Media information ──────────────────────────────────────────────────────────────────────────

/**
 * Demuxers of real media containers, by their ffmpeg short name. Every ffprobe and ffmpeg input is
 * restricted to these (`-format_whitelist`): playlist and reference formats such as hls, dash,
 * concat, sdp, tee and image2 open other files, and lavfi or `*_pipe` read no file at all.
 */
export const MEDIA_DEMUXERS = [
  'mov', 'matroska', 'avi', 'asf', 'flv', 'mpegts', 'mpeg', 'mp3', 'aac', 'wav', 'flac', 'ogg', 'aiff', 'ape', 'amr',
  'ac3', 'eac3', 'dts', 'caf', 'wv', 'tta', 'rm', 'mxf', 'w64', 'mpegvideo', 'h264', 'hevc',
] as const;
export const mediaDemuxerSchema = z.enum(MEDIA_DEMUXERS);
export type MediaDemuxer = z.infer<typeof mediaDemuxerSchema>;

/**
 * What the source container is, for "already the target format" decisions: the MP4 family by
 * `major_brand`, Matroska by DocType, otherwise by extension within the demuxer's family. Other
 * demuxers name a single format and are their own identity. `unknown` never equals a target.
 */
export const CONTAINER_IDENTITIES = [
  'mp4', 'mov', 'm4a', '3gp', '3g2', 'matroska', 'webm', 'opus',
  'avi', 'asf', 'flv', 'mpegts', 'mpeg', 'mp3', 'aac', 'wav', 'flac', 'ogg', 'aiff', 'ape', 'amr',
  'ac3', 'eac3', 'dts', 'caf', 'wv', 'tta', 'rm', 'mxf', 'w64', 'mpegvideo', 'h264', 'hevc', 'unknown',
] as const;
export const containerIdentitySchema = z.enum(CONTAINER_IDENTITIES);
export type ContainerIdentity = z.infer<typeof containerIdentitySchema>;

export const HDR_FORMATS = ['none', 'hdr10', 'hlg', 'dolby_vision'] as const;
export type HdrFormat = (typeof HDR_FORMATS)[number];
export const SUBTITLE_KINDS = ['text', 'image', 'other'] as const;
export type SubtitleKind = (typeof SUBTITLE_KINDS)[number];
export const CHROMA_SUBSAMPLINGS = ['420', '422', '444', '411', '410', '440', '400'] as const;
export type ChromaSubsampling = (typeof CHROMA_SUBSAMPLINGS)[number];
export const FIELD_ORDERS = ['progressive', 'tt', 'bb', 'tb', 'bt'] as const;
export type FieldOrder = (typeof FIELD_ORDERS)[number];

const MAX_STREAMS = 512;
/** Microseconds; 100 days is far beyond any real file and keeps every value a safe integer. */
const microseconds = z.number().int().min(0).max(8_640_000_000_000);
const count = z.number().int().min(0).max(1_000_000);
/** Bits per second. */
const bitRate = z.number().int().min(0).max(1_000_000_000_000);
const token = z.string().min(1).max(64);
const label = z.string().min(1).max(256);
/** `num/den` with both parts positive. */
const rational = z.string().regex(/^[1-9]\d{0,9}\/[1-9]\d{0,9}$/);
const unit = z.number().min(0).max(1);
const chromaticity = z.strictObject({ x: unit, y: unit });

export const masteringDisplaySchema = z.strictObject({
  /** CIE 1931 xy of the display primaries and white point, when the source signals them. */
  primaries: z.strictObject({ red: chromaticity, green: chromaticity, blue: chromaticity, whitePoint: chromaticity }).nullable(),
  /** cd/m², when the source signals them. */
  luminance: z.strictObject({ min: z.number().min(0).max(100_000), max: z.number().min(0).max(100_000) }).nullable(),
});
export type MasteringDisplay = z.infer<typeof masteringDisplaySchema>;

export const hdrInfoSchema = z.strictObject({
  /** Dolby Vision whenever the stream carries a DOVI configuration record, whatever its transfer. */
  format: z.enum(HDR_FORMATS),
  dolbyVision: z.strictObject({
    profile: z.number().int().min(0).max(31),
    level: z.number().int().min(0).max(63).nullable(),
    /** `dv_bl_signal_compatibility_id`: 0 has no compatible base layer, 1 HDR10, 2 SDR, 4 HLG. */
    compatibilityId: z.number().int().min(0).max(15),
    /** False for profile 5 or compatibility id 0: the base layer alone does not show correctly. */
    compatible: z.boolean(),
    rpuPresent: z.boolean(),
    elPresent: z.boolean(),
    blPresent: z.boolean(),
  }).nullable(),
  /** HDR10 static metadata, from the stream side data or else the first frame of the primary video. */
  masteringDisplay: masteringDisplaySchema.nullable(),
  contentLight: z.strictObject({ maxCll: z.number().int().min(0).max(65_535), maxFall: z.number().int().min(0).max(65_535) }).nullable(),
});
export type HdrInfo = z.infer<typeof hdrInfoSchema>;

/** `index` is the absolute stream index (`-map 0:<index>`); `typeIndex` counts the streams of the same type as ffmpeg's `0:v:N`, `0:a:N`, `0:s:N` do. */
const streamPosition = { index: z.number().int().min(0).max(65_535), typeIndex: z.number().int().min(0).max(65_535) };

export const videoStreamSchema = z.strictObject({
  ...streamPosition,
  codec: token,
  profile: token.nullable(),
  pixFmt: token.nullable(),
  /** From the pixel format table, else `bits_per_raw_sample`. */
  bitDepth: z.number().int().min(1).max(32).nullable(),
  chromaSubsampling: z.enum(CHROMA_SUBSAMPLINGS).nullable(),
  width: z.number().int().min(0).max(65_536),
  height: z.number().int().min(0).max(65_536),
  /** `num:den`, or null when unknown. */
  sampleAspectRatio: z.string().regex(/^[1-9]\d{0,9}:[1-9]\d{0,9}$/).nullable(),
  rFrameRate: rational.nullable(),
  avgFrameRate: rational.nullable(),
  /** Frames per second: the average rate, else the base rate. */
  fps: z.number().positive().max(10_000).nullable(),
  /** The base and the average frame rate differ by more than 0.5 %. */
  isVfr: z.boolean(),
  /**
   * Clockwise degrees a player turns the picture, from the Display Matrix only: ffmpeg 8's autorotate
   * ignores the legacy `rotate` tag, so reading it would swap the sides the planner scales (design §7b).
   */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  colorPrimaries: token.nullable(),
  colorTransfer: token.nullable(),
  colorSpace: token.nullable(),
  /** `pc` also when unsignalled on a `yuvj*` pixel format. */
  colorRange: z.enum(['tv', 'pc']).nullable(),
  fieldOrder: z.enum(FIELD_ORDERS).nullable(),
  bitRate: bitRate.nullable(),
  durationUs: microseconds.nullable(),
  language: token.nullable(),
  title: label.nullable(),
  default: z.boolean(),
  hdr: hdrInfoSchema,
});
export type VideoStreamInfo = z.infer<typeof videoStreamSchema>;

export const audioStreamSchema = z.strictObject({
  ...streamPosition,
  codec: token,
  profile: token.nullable(),
  channels: z.number().int().min(0).max(1024).nullable(),
  channelLayout: token.nullable(),
  sampleRate: z.number().int().min(0).max(10_000_000).nullable(),
  sampleFormat: token.nullable(),
  bitsPerRawSample: z.number().int().min(1).max(64).nullable(),
  /** The stream bit rate, else the Matroska `BPS` tag. */
  bitRate: bitRate.nullable(),
  bitRateSource: z.enum(['stream', 'tag']).nullable(),
  durationUs: microseconds.nullable(),
  language: token.nullable(),
  title: label.nullable(),
  default: z.boolean(),
  forced: z.boolean(),
});
export type AudioStreamInfo = z.infer<typeof audioStreamSchema>;

export const subtitleStreamSchema = z.strictObject({
  ...streamPosition,
  codec: token,
  kind: z.enum(SUBTITLE_KINDS),
  language: token.nullable(),
  title: label.nullable(),
  default: z.boolean(),
  forced: z.boolean(),
  hearingImpaired: z.boolean(),
  /**
   * ASS/SSA only (null for other codecs): positioning (`\pos`, `\move`, `\an`), several or non-bottom
   * styles, or overlapping events among the first 200. True as well when the events could not be read.
   */
  styled: z.boolean().nullable(),
});
export type SubtitleStreamInfo = z.infer<typeof subtitleStreamSchema>;

/** An `attached_pic` stream: cover art, never the main video. */
export const coverStreamSchema = z.strictObject({
  ...streamPosition,
  codec: token,
  width: z.number().int().min(0).max(65_536),
  height: z.number().int().min(0).max(65_536),
});
export type CoverStreamInfo = z.infer<typeof coverStreamSchema>;

export const mediaInfoSchema = z.strictObject({
  /**
   * `video` with a main video stream; `audio` with audio but no main video. An audio file can still
   * list cover art, and video streams that are not a main video (a `0/0` average rate: a still picture).
   */
  kind: z.enum(['video', 'audio']),
  container: z.strictObject({
    demuxer: mediaDemuxerSchema,
    formatName: z.string().min(1).max(128),
    majorBrand: z.string().min(1).max(8).nullable(),
    matroskaDocType: z.string().min(1).max(32).nullable(),
    /** Lower case, without the dot; empty when the name has none. */
    extension: z.string().max(32),
    identity: containerIdentitySchema,
  }),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** `format.duration`, else a stream `duration`, else a `DURATION` tag; null when none is known. */
  durationUs: microseconds.nullable(),
  durationSource: z.enum(['format', 'stream', 'tag']).nullable(),
  /** `format.start_time`, e.g. the offset of an MPEG-TS; may be negative (encoder priming). */
  startTimeUs: z.number().int().min(-8_640_000_000_000).max(8_640_000_000_000).nullable(),
  /** Total bits per second: `format.bit_rate`, else size × 8 ÷ duration. */
  bitRate: bitRate.nullable(),
  /** Absolute index of the main video stream, chosen like ffmpeg's `V` (no cover art, no `0/0` average rate). */
  primaryVideoIndex: z.number().int().min(0).max(65_535).nullable(),
  video: z.array(videoStreamSchema).max(MAX_STREAMS),
  audio: z.array(audioStreamSchema).max(MAX_STREAMS),
  subtitles: z.array(subtitleStreamSchema).max(MAX_STREAMS),
  covers: z.array(coverStreamSchema).max(MAX_STREAMS),
  attachments: count,
  chapters: count,
  /** Data and unrecognised streams, such as timecode tracks. */
  dataStreams: count,
});
export type MediaInfo = z.infer<typeof mediaInfoSchema>;

// ── Conversion settings ────────────────────────────────────────────────────────────────────────
// module-encode design §1. The renderer keeps them per task; the planner reads them as given.

/** Quality first, balanced, size first; the audio tiers high, standard and small use the same values. */
export const TIERS = ['quality', 'balanced', 'size'] as const;
export const tierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof tierSchema>;

/** The output codec of "compress video", named by purpose: smallest size, Apple and newer devices, widest compatibility. */
export const COMPRESS_CODECS = ['av1', 'hevc', 'h264'] as const;
export const compressCodecSchema = z.enum(COMPRESS_CODECS);
export type CompressCodec = z.infer<typeof compressCodecSchema>;

export const VIDEO_CONTAINERS = ['mp4', 'mkv', 'webm', 'mov'] as const;
export const videoContainerSchema = z.enum(VIDEO_CONTAINERS);
export type VideoContainer = z.infer<typeof videoContainerSchema>;

/** `m4a` is AAC and `alac` is Apple Lossless, both in an .m4a file. */
export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'alac'] as const;
export const audioFormatSchema = z.enum(AUDIO_FORMATS);
export type AudioFormat = z.infer<typeof audioFormatSchema>;

/** Short-side limits of "compress video" in pixels, after rotation; null keeps the source size. */
export const MAX_SHORT_SIDES = [2160, 1440, 1080, 720, 480] as const;
export type MaxShortSide = (typeof MAX_SHORT_SIDES)[number];

export const CONVERSION_TASKS = ['compress', 'convert', 'extract-audio'] as const;
export const conversionTaskSchema = z.enum(CONVERSION_TASKS);
export type ConversionTask = z.infer<typeof conversionTaskSchema>;

export const compressSettingsSchema = z.strictObject({
  task: z.literal('compress'),
  tier: tierSchema,
  codec: compressCodecSchema,
  /** `auto` is MKV for styled ASS/SSA, image subtitles or attachments, else MP4 (AC-ENCODE-01-8). */
  container: z.enum(['auto', 'mp4', 'mkv']),
  maxShortSide: z.literal(MAX_SHORT_SIDES).nullable(),
  useGpuForAv1: z.boolean(),
  /** Publish nothing that is not below 98 % of the source size (AC-ENCODE-06-1). */
  discardIfNotSmaller: z.boolean(),
});
export const convertSettingsSchema = z.strictObject({
  task: z.literal('convert'),
  target: z.enum([...VIDEO_CONTAINERS, ...AUDIO_FORMATS]),
  /** Copy every stream the target can hold; off re-encodes the video (AC-ENCODE-01-7). */
  preferRemux: z.boolean(),
  tier: tierSchema,
});
export const extractAudioSettingsSchema = z.strictObject({
  task: z.literal('extract-audio'),
  /** `copy` keeps the track as it is, in the file type its codec belongs in (AC-ENCODE-04-2). */
  format: z.enum(['copy', ...AUDIO_FORMATS]),
  tier: tierSchema,
  /** One output per audio track instead of the default track only. */
  allTracks: z.boolean(),
});
export const conversionSettingsSchema = z.discriminatedUnion('task', [compressSettingsSchema, convertSettingsSchema, extractAudioSettingsSchema]);
export type CompressSettings = z.infer<typeof compressSettingsSchema>;
export type ConvertSettings = z.infer<typeof convertSettingsSchema>;
export type ExtractAudioSettings = z.infer<typeof extractAudioSettingsSchema>;
export type ConversionSettings = z.infer<typeof conversionSettingsSchema>;

export const DEFAULT_CONVERT_SETTINGS: Readonly<ConvertSettings> = Object.freeze({ task: 'convert', target: 'mp4', preferRemux: true, tier: 'balanced' });
export const DEFAULT_EXTRACT_AUDIO_SETTINGS: Readonly<ExtractAudioSettings> = Object.freeze({ task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: false });

/**
 * The defaults of "compress video" around its codec: `defaultCompressCodec(caps)` (AC-ENCODE-02-7),
 * which depends on the encoders of this computer, or the codec the user chose.
 */
export function defaultCompressSettings(codec: CompressCodec): CompressSettings {
  return { task: 'compress', tier: 'balanced', codec, container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true };
}

export function defaultConversionSettings(task: ConversionTask, compressCodec: CompressCodec): ConversionSettings {
  if (task === 'compress') return defaultCompressSettings(compressCodec);
  return task === 'convert' ? { ...DEFAULT_CONVERT_SETTINGS } : { ...DEFAULT_EXTRACT_AUDIO_SETTINGS };
}

// ── Encoders and outputs ───────────────────────────────────────────────────────────────────────

/** Video encoders the planner can choose, the CPU ones included; the interface maps each to a friendly name. */
export const VIDEO_ENCODERS = [
  'libsvtav1', 'av1_nvenc', 'av1_qsv', 'av1_amf',
  'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'libkvazaar',
  'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264',
] as const;
/** Audio encoders, the PCM ones of WAV output and lossless extraction included. */
export const AUDIO_ENCODERS = ['aac', 'libopus', 'libmp3lame', 'flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'] as const;
/** Text subtitle conversions for MP4/MOV, MKV and WebM. */
export const SUBTITLE_ENCODERS = ['mov_text', 'srt', 'webvtt'] as const;
export const ENCODER_IDS = [...VIDEO_ENCODERS, ...AUDIO_ENCODERS, ...SUBTITLE_ENCODERS] as const;
export const encoderIdSchema = z.enum(ENCODER_IDS);
export type EncoderId = z.infer<typeof encoderIdSchema>;
export type VideoEncoderId = (typeof VIDEO_ENCODERS)[number];
export type AudioEncoderId = (typeof AUDIO_ENCODERS)[number];
export type SubtitleEncoderId = (typeof SUBTITLE_ENCODERS)[number];

/**
 * One detected configuration of a video encoder: its bit depth, with the NVENC `uhq` tune or the
 * default (`hq`) one. `8bit_sw` is the software mode of h264_mf; its plain keys are the hardware mode.
 */
export const VARIANT_KEYS = ['8bit', '10bit', '8bit_uhq', '10bit_uhq', '8bit_sw'] as const;
export const variantKeySchema = z.enum(VARIANT_KEYS);
export type VariantKey = z.infer<typeof variantKeySchema>;

/** What an output is written as. `m4a` holds AAC or ALAC; `mka` holds extracted tracks no other type takes. */
export const OUTPUT_CONTAINERS = ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aiff', 'mka'] as const;
export const outputContainerSchema = z.enum(OUTPUT_CONTAINERS);
export type OutputContainer = z.infer<typeof outputContainerSchema>;

// ── Plan summary ───────────────────────────────────────────────────────────────────────────────
// What the user sees before the start (AC-ENCODE-01-5): the encoders, what happens to each stream,
// what is lost and why, whether only the container changes, and the warnings.

/** Why a source stream is not in an output: the task does not carry it, or the target cannot hold it. */
export const STREAM_DROP_REASONS = ['not_selected', 'subtitle_dropped', 'cover_dropped'] as const;
export const streamDropReasonSchema = z.enum(STREAM_DROP_REASONS);
export type StreamDropReason = z.infer<typeof streamDropReasonSchema>;

const streamIndex = z.number().int().min(0).max(65_535);

export const planStreamSummarySchema = z.strictObject({
  kind: z.enum(['video', 'audio', 'subtitle', 'cover']),
  /** The absolute source index, and the position among the source streams of the same type. */
  index: streamIndex,
  typeIndex: streamIndex,
  /** The source codec. */
  codec: token,
  language: token.nullable(),
  title: label.nullable(),
  action: z.enum(['copy', 'encode', 'drop']),
  /** The encoder and its detected configuration for `encode`; null otherwise. */
  encoder: encoderIdSchema.nullable(),
  variant: variantKeySchema.nullable(),
  /** Why, for `drop`; null otherwise. */
  reason: streamDropReasonSchema.nullable(),
});
export type PlanStreamSummary = z.infer<typeof planStreamSummarySchema>;

export const planOutputSummarySchema = z.strictObject({
  container: outputContainerSchema,
  extension: z.string().regex(/^[a-z0-9]{1,8}$/),
  /** "All tracks" extraction: the 1-based audio track and the language that goes in the file name. */
  track: z.strictObject({ number: z.number().int().min(1).max(65_536), language: z.string().regex(/^[a-z]{2,3}$/).nullable() }).nullable(),
  streams: z.array(planStreamSummarySchema).max(MAX_STREAMS * 4),
  /** Attachments (fonts and the like) of the source, and whether this output keeps them. */
  attachments: z.strictObject({ count, kept: z.boolean() }),
  chapters: z.strictObject({ count, kept: z.boolean() }),
  /** Data streams (timecode, telemetry, chapter text tracks) are never kept (AC-ENCODE-01-2). */
  dataStreamsDropped: count,
});
export type PlanOutputSummary = z.infer<typeof planOutputSummarySchema>;

export const planWarningSchema = z.strictObject({
  code: planWarningCodeSchema,
  /** Absolute indices of the source streams concerned; empty when it is about the whole file. */
  streams: z.array(streamIndex).max(MAX_STREAMS * 4),
  /** How many things it is about: streams, attachments or chapters. */
  count,
  /** `encoder_fallback` only: the encoder that failed and the one used instead. */
  from: encoderIdSchema.optional(),
  to: encoderIdSchema.optional(),
});
export type PlanWarning = z.infer<typeof planWarningSchema>;

export const planSummarySchema = z.strictObject({
  task: conversionTaskSchema,
  /** No audio or video stream is re-encoded: only the container changes (text subtitles may change format). */
  remuxOnly: z.boolean(),
  /** Every encoder the plan uses, in the order of first use, once each. */
  encoders: z.array(z.strictObject({ encoder: encoderIdSchema, variant: variantKeySchema.nullable() })).max(64),
  /** Usually one; one per audio track for "all tracks". */
  outputs: z.array(planOutputSummarySchema).min(1).max(MAX_STREAMS),
  warnings: z.array(planWarningSchema).max(256),
  /** What the user must confirm before the item can start. */
  confirmations: z.array(planConfirmationCodeSchema).max(PLAN_CONFIRMATIONS.length),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

// ── Engine status ──────────────────────────────────────────────────────────────────────────────

/**
 * Why one encoder configuration cannot be used (AC-ENGINE-03-1). The engine keeps only definitive
 * verdicts across restarts (`driver_too_old`, `no_device`, `runtime_missing`, `params_rejected`);
 * `session_limit` and `unknown` (timeouts and the 30 s budget included) hold for the session only.
 */
export const CAPABILITY_FAILURE_CODES = ['driver_too_old', 'no_device', 'runtime_missing', 'session_limit', 'params_rejected', 'unknown'] as const;
export const capabilityFailureCodeSchema = engineReasonCodeSchema.extract(CAPABILITY_FAILURE_CODES);
export type CapabilityFailureCode = z.infer<typeof capabilityFailureCodeSchema>;

/**
 * The i18n key of an encoder's friendly name ("NVIDIA NVENC HEVC", "SVT-AV1 (CPU)"): the encoder id,
 * except h264_mf's software mode, which is a CPU encoder and has a name of its own.
 */
export function encoderNameKey(encoder: EncoderId, variant: VariantKey | null = null): string {
  return `media:encoders.${encoder === 'h264_mf' && variant === '8bit_sw' ? 'h264_mf_sw' : encoder}`;
}

/** The encoder the planner takes for one codec, as `resolvedEncoders` tells the interface. */
export const resolvedEncoderSchema = z.strictObject({
  encoder: z.enum(VIDEO_ENCODERS),
  variant: variantKeySchema,
  /** A graphics card or media engine encodes (not h264_mf's software mode). */
  hardware: z.boolean(),
  /** openh264, h264_mf's software mode or kvazaar: the interface suggests AV1 instead (`cpu_weak_encoder`, AC-WORKBENCH-05-2). */
  weak: z.boolean(),
  nameKey: z.string().regex(/^media:encoders\.[a-z0-9_]{1,32}$/),
});
export type ResolvedEncoder = z.infer<typeof resolvedEncoderSchema>;

const resolvedPairSchema = z.strictObject({
  /** With "use the graphics card" off and on; the switch only changes AV1, HEVC and H.264 use a graphics card whenever one works. Null: no encoder of the chain works. */
  gpuOff: resolvedEncoderSchema.nullable(),
  gpuOn: resolvedEncoderSchema.nullable(),
});
/**
 * What the planner's fallback chains (module-encode design §3) resolve to on this computer, per
 * output codec, for an ordinary SDR picture every encoder takes; the interface shows it without
 * repeating the chains (engine design §8). A source of unusual size or an HDR one may still get
 * another encoder: the plan summary names the one it really uses.
 */
export const resolvedEncodersSchema = z.strictObject({ av1: resolvedPairSchema, hevc: resolvedPairSchema, h264: resolvedPairSchema });
export type ResolvedEncoders = z.infer<typeof resolvedEncodersSchema>;

/** Defaults that depend on this computer: "compress video" takes HEVC when a HEVC hardware encoder works, else H.264 (AC-ENCODE-02-7). */
export const capabilityDefaultsSchema = z.strictObject({ compressCodec: compressCodecSchema });
export type CapabilityDefaults = z.infer<typeof capabilityDefaultsSchema>;

/** Families of hardware encoders; a driver update is suggested per family. */
export const HARDWARE_ENCODER_FAMILIES = ['nvenc', 'qsv', 'amf', 'mf'] as const;
export type HardwareEncoderFamily = (typeof HARDWARE_ENCODER_FAMILIES)[number];

/**
 * The encoder detection part of the engine status (R-ENGINE-03): not run yet; running (files can
 * be added and inspected, nothing can start); done; or unusable, with the reason.
 */
export const capabilityStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unverified') }),
  z.strictObject({ state: z.literal('detecting') }),
  z.strictObject({
    state: z.literal('ready'),
    /** Hardware encoders with a configuration that passed, less those degraded in this session. */
    hardwareEncoders: z.array(z.enum(VIDEO_ENCODERS)).max(VIDEO_ENCODERS.length),
    /** Encoders that failed before their first frame in this session (AC-ENGINE-03-3); "detect again" clears them. */
    degraded: z.array(z.enum(VIDEO_ENCODERS)).max(VIDEO_ENCODERS.length),
    /**
     * Families whose driver is too old for the bundled ffmpeg (`driver_too_old`), with the minimum
     * version when known: NVENC needs 570 or newer (AC-ENGINE-03-4).
     */
    driverUpdates: z.array(z.strictObject({
      family: z.enum(HARDWARE_ENCODER_FAMILIES),
      minimumVersion: z.string().regex(/^\d{1,5}(?:\.\d{1,5}){0,3}$/).nullable(),
    })).max(HARDWARE_ENCODER_FAMILIES.length),
    resolvedEncoders: resolvedEncodersSchema,
    defaults: capabilityDefaultsSchema,
  }),
  z.strictObject({ state: z.literal('unavailable'), code: engineReasonCodeSchema }),
]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const engineStatusSchema = z.strictObject({ runtime: runtimeStatusSchema, capabilities: capabilityStatusSchema });
export type EngineStatus = z.infer<typeof engineStatusSchema>;

// ── Queue ──────────────────────────────────────────────────────────────────────────────────────
// module-engine design §6. The main process owns the queue; the renderer sends commands, reads a
// snapshot and applies the change events whose sequence is newer (AC-ENGINE-05-1).

export const QUEUE_LIMITS = Object.freeze({
  /** Items kept; beyond it the earliest finished ones are removed (R-ENGINE-05). */
  items: 500,
  /** Files one add takes; the rest are not added, only counted (R-ENGINE-07). */
  filesPerAdd: 100,
  /** The redacted log tail an item keeps, in UTF-8 bytes (AC-ENGINE-05-3). */
  logTailBytes: 16 * 1024,
  /** Output folders remembered, most recently used first. */
  outputDirectories: 5,
  /** At most one progress event per item this often: four a second (AC-ENGINE-05-1, FK-PIT-0077). */
  progressIntervalMs: 250,
});

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Milliseconds since the epoch. */
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const displayName = z.string().min(1).max(1024);

/** What the renderer holds instead of a path. */
export const itemIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const itemIdsSchema = z.array(itemIdSchema).min(1).max(QUEUE_LIMITS.items)
  .refine(ids => new Set(ids).size === ids.length, { message: 'An item id is listed twice.' });

/** Kept by the main process only (`state.json`); the renderer reads them from the snapshot and changes them with `set-options` (AC-ENGINE-05-2). */
export const queueOptionsSchema = z.strictObject({
  /** Conversions that run at once; probing never takes a slot. The interface offers 2 from I3. */
  concurrency: z.union([z.literal(1), z.literal(2)]),
  /** Idle priority and about half the logical processors, for every run that starts from now on. */
  lowUsage: z.boolean(),
});
export type QueueOptions = z.infer<typeof queueOptionsSchema>;
export const queueOptionsPatchSchema = queueOptionsSchema.partial();
export type QueueOptionsPatch = z.infer<typeof queueOptionsPatchSchema>;
export const DEFAULT_QUEUE_OPTIONS: Readonly<QueueOptions> = Object.freeze({ concurrency: 1, lowUsage: false });

/** What a running item is doing; I2 adds `analyzing`. */
export const ITEM_PHASES = ['preparing', 'encoding', 'pass1', 'pass2', 'finalizing'] as const;
export const itemPhaseSchema = z.enum(ITEM_PHASES);
export type ItemPhase = z.infer<typeof itemPhaseSchema>;

/** Why an item failed: an engine code, or a plan that could no longer be made when a retry planned it again. */
export const ITEM_FAILURE_CODES = [...ENGINE_REASON_CODES, ...PLAN_NOT_APPLICABLE, ...PLAN_ERRORS] as const;
export const itemFailureCodeSchema = z.enum(ITEM_FAILURE_CODES);
export type ItemFailureCode = z.infer<typeof itemFailureCodeSchema>;

/**
 * `disk_space_low` (AC-ENGINE-06-4): what the output volume needs, the size caps of every output
 * running on it plus this one plus 512 MB, and what it has free, in bytes.
 */
export const diskSpaceSchema = z.strictObject({ requiredBytes: bytes, availableBytes: bytes });
export type DiskSpace = z.infer<typeof diskSpaceSchema>;

/**
 * The state machine of design §6:
 * idle → queued → running{phase} → succeeded | skipped{reason} | failed{code, partial, space?} | cancelled;
 * queued → input_changed | failed{input_missing} (the check before the run);
 * queued/running at quit → interrupted; analyzing → idle | unsupported{code}.
 */
export const itemStateSchema = z.discriminatedUnion('status', [
  /** Being probed: just added, or a retry probes it again. */
  z.strictObject({ status: z.literal('analyzing') }),
  /** The probe failed: the file cannot be converted (AC-ENGINE-02-4). */
  z.strictObject({ status: z.literal('unsupported'), code: probeFailureCodeSchema }),
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({ status: z.literal('queued') }),
  z.strictObject({ status: z.literal('running'), phase: itemPhaseSchema }),
  z.strictObject({ status: z.literal('succeeded') }),
  z.strictObject({ status: z.literal('skipped'), reason: planSkipCodeSchema }),
  /**
   * `partial`: an item with several outputs published some of them ("partly done m/n"). `space`:
   * `disk_space_low` only, the bytes the interface shows (a FAT32 volume's 4 GiB file limit,
   * `file_too_large_for_volume`, is no shortage of space and has none).
   */
  z.strictObject({ status: z.literal('failed'), code: itemFailureCodeSchema, partial: z.boolean(), space: diskSpaceSchema.optional() })
    .refine(state => state.space === undefined || state.code === 'disk_space_low', { message: 'Only disk_space_low carries the space.', path: ['space'] }),
  /** A cancelled item that had published some of its outputs lists them in its result ("all tracks"). */
  z.strictObject({ status: z.literal('cancelled') }),
  /** It was queued or running when the app quit; retry starts it again. */
  z.strictObject({ status: z.literal('interrupted') }),
  /** The file is another one, or was edited, since it was added: it was not run. */
  z.strictObject({ status: z.literal('input_changed') }),
]);
export type ItemState = z.infer<typeof itemStateSchema>;
export type ItemStatus = ItemState['status'];

export const itemProgressSchema = z.strictObject({
  /** Share of the whole item done, 0–1; null for an indeterminate bar (the duration is unknown). */
  fraction: unit.nullable(),
  /** Media time processed in the current pass. */
  processedUs: microseconds.nullable(),
  writtenBytes: bytes.nullable(),
  /** Media seconds per second. */
  speed: z.number().min(0).max(100_000).nullable(),
  fps: z.number().min(0).max(1_000_000).nullable(),
  etaMs: z.number().int().min(0).max(8_640_000_000).nullable(),
  /** The output being written (0-based) and how many the item writes: several when extracting every track. */
  outputIndex: z.number().int().min(0).max(MAX_STREAMS),
  outputCount: z.number().int().min(1).max(MAX_STREAMS),
});
export type ItemProgress = z.infer<typeof itemProgressSchema>;

export const itemOutputSchema = z.strictObject({
  /** The output's position in the plan. */
  index: z.number().int().min(0).max(MAX_STREAMS),
  fileName: displayName,
  folderName: z.string().max(1024),
  sizeBytes: bytes,
  /** A file of that name was moved to the recycle bin for it. */
  replaced: z.boolean(),
});
export type ItemOutput = z.infer<typeof itemOutputSchema>;

/** What an item published: on success, on a failure after some outputs ("partly done"), or before a cancel. */
export const itemResultSchema = z.strictObject({
  /** What was published; fewer than `outputCount` for a partial result. */
  outputs: z.array(itemOutputSchema).max(MAX_STREAMS),
  outputCount: z.number().int().min(1).max(MAX_STREAMS),
  sourceBytes: bytes,
  /** Every published output together. */
  outputBytes: bytes,
  warnings: z.array(planWarningCodeSchema).max(64),
});
export type ItemResult = z.infer<typeof itemResultSchema>;

/** Where outputs go (AC-ENGINE-06-2, AC-ENGINE-06-3): numbered beside an existing file, or replacing it through the recycle bin. */
export const OUTPUT_CONFLICTS = ['number', 'overwrite'] as const;
export const outputConflictSchema = z.enum(OUTPUT_CONFLICTS);
export type OutputConflict = z.infer<typeof outputConflictSchema>;
/** An output folder the main-process dialog returned, by the id the main process gave it. */
export const outputDirectoryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const outputDirectorySchema = z.strictObject({ id: outputDirectoryIdSchema, displayName });
export type OutputDirectory = z.infer<typeof outputDirectorySchema>;
export const outputSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('source'), conflict: outputConflictSchema }),
  z.strictObject({ mode: z.literal('directory'), directoryId: outputDirectoryIdSchema, conflict: outputConflictSchema }),
]);
export type OutputSelection = z.infer<typeof outputSelectionSchema>;

/** What an item was started with: frozen, so a queued or running item never follows later changes of the panel. */
export const itemJobSchema = z.strictObject({
  settings: conversionSettingsSchema,
  plan: planSummarySchema,
  output: z.strictObject({ mode: z.enum(['source', 'directory']), directoryName: z.string().max(1024).nullable(), conflict: outputConflictSchema }),
});
export type ItemJob = z.infer<typeof itemJobSchema>;

/** An item as the renderer sees it: no path anywhere (AC-ENGINE-07-3). */
export const itemSummarySchema = z.strictObject({
  id: itemIdSchema,
  displayName,
  folderName: z.string().max(1024),
  /** Null while analyzing and when the probe failed. */
  media: mediaInfoSchema.nullable(),
  state: itemStateSchema,
  job: itemJobSchema.nullable(),
  /** While running. */
  progress: itemProgressSchema.nullable(),
  result: itemResultSchema.nullable(),
  /** The redacted end of the log of a failure: known paths read `<input>`, `<output>`, `<work>`, others `[path]`. */
  log: z.string().max(QUEUE_LIMITS.logTailBytes).nullable(),
  addedAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

/** From the queue leaving idle until nothing is queued or running (AC-ENGINE-05-5). */
export const batchSummarySchema = z.strictObject({ succeeded: count, failed: count, skipped: count, cancelled: count, savedBytes: bytes });
export type BatchSummary = z.infer<typeof batchSummarySchema>;

/** `state_reset`: `state.json` could not be read; its copy was kept and the queue started empty. Shown once. */
export const QUEUE_NOTICES = ['state_reset'] as const;
export type QueueNotice = (typeof QUEUE_NOTICES)[number];

export const queueSnapshotSchema = z.strictObject({
  /** The sequence of the latest event: apply only events with a larger one. */
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  engine: engineStatusSchema,
  /** In the order the files were added. */
  items: z.array(itemSummarySchema).max(QUEUE_LIMITS.items),
  options: queueOptionsSchema,
  outputDirectories: z.array(outputDirectorySchema).max(QUEUE_LIMITS.outputDirectories),
  notice: z.enum(QUEUE_NOTICES).nullable(),
});
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>;

const eventSequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/**
 * `media-converter:changed`. The sequence is global and strictly increasing. `items` carries the
 * items that changed (new ones go to the end) and the ids removed; `progress` is coalesced to one
 * per item every 250 ms; `batch-finished` comes once per batch.
 */
export const queueEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ sequence: eventSequence, kind: z.literal('items'), items: z.array(itemSummarySchema).max(QUEUE_LIMITS.items), removed: z.array(itemIdSchema).max(QUEUE_LIMITS.items) }),
  z.strictObject({ sequence: eventSequence, kind: z.literal('progress'), itemId: itemIdSchema, progress: itemProgressSchema }),
  z.strictObject({ sequence: eventSequence, kind: z.literal('engine'), engine: engineStatusSchema }),
  z.strictObject({ sequence: eventSequence, kind: z.literal('options'), options: queueOptionsSchema, outputDirectories: z.array(outputDirectorySchema).max(QUEUE_LIMITS.outputDirectories) }),
  z.strictObject({ sequence: eventSequence, kind: z.literal('batch-finished'), batch: batchSummarySchema }),
]);
export type QueueEvent = z.infer<typeof queueEventSchema>;

// Commands. The IPC layer checks them; the queue checks them again before acting.

export const startRequestSchema = z.strictObject({
  itemIds: itemIdsSchema,
  settings: conversionSettingsSchema,
  output: outputSelectionSchema,
  /** Items whose lossy-to-lossless conversion the user accepted, and whether existing files may be replaced. */
  confirmed: z.strictObject({ lossyToLossless: z.array(itemIdSchema).max(QUEUE_LIMITS.items), replaceExisting: z.boolean() }),
});
export type StartRequest = z.infer<typeof startRequestSchema>;

/** "Convert anyway": run a plan that was skipped as `already_target`, or publish whatever size the compression reaches. */
export const retryRequestSchema = z.strictObject({ itemIds: itemIdsSchema, override: planSkipCodeSchema.optional() });
export type RetryRequest = z.infer<typeof retryRequestSchema>;
export const itemIdsRequestSchema = z.strictObject({ itemIds: itemIdsSchema });
/** `finished`: every item that ended; `all_idle`: every item that is not queued, running or being analyzed. */
export const clearRequestSchema = z.strictObject({ scope: z.enum(['finished', 'all_idle']) });

export const startResultSchema = z.strictObject({
  /** Queued, in the order given. */
  started: z.array(itemIdSchema).max(QUEUE_LIMITS.items),
  /** Skipped without running: already in the target format (AC-ENCODE-06-2). */
  skipped: z.array(itemIdSchema).max(QUEUE_LIMITS.items),
  /** Not started; `confirmation_required` for each item awaiting a confirmation. */
  rejected: z.array(z.strictObject({ itemId: itemIdSchema, code: itemFailureCodeSchema })).max(QUEUE_LIMITS.items),
  /** What to confirm; while it is present nothing was started. */
  needsConfirmation: z.strictObject({
    lossyToLossless: z.array(itemIdSchema).max(QUEUE_LIMITS.items),
    /** Existing files the outputs would replace, by name. */
    wouldReplace: z.array(z.strictObject({ itemId: itemIdSchema, fileName: displayName })).max(QUEUE_LIMITS.items * 4),
  }).nullable(),
});
export type StartResult = z.infer<typeof startResultSchema>;

export const addFilesResultSchema = z.strictObject({
  added: z.array(itemIdSchema).max(QUEUE_LIMITS.filesPerAdd),
  /** Files already in the queue (by identity): their existing items. */
  duplicates: z.array(itemIdSchema).max(QUEUE_LIMITS.filesPerAdd),
  rejected: z.array(z.strictObject({
    displayName,
    code: engineReasonCodeSchema.extract(['folder_not_supported', 'not_a_regular_file', 'file_unavailable', 'temporary_copy_unresolved']),
  })).max(QUEUE_LIMITS.filesPerAdd),
  /** Files not added: past the 100 of one add, or beyond the 500 items the queue keeps. */
  truncated: count,
});
export type AddFilesResult = z.infer<typeof addFilesResultSchema>;

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────
// module-engine design §8. One strict request schema per channel of `channels.ts`; the main process
// answers only the main frame of the application window and every result is `{ok: true, value}` or
// `{ok: false, error: {code}}`. Paths never reach the renderer, and the renderer never sends one:
// a drop's paths are taken by the preload from the dropped `File`s, and the dialogs run in the main process.

/** What `pick-files` offers in the main-process dialog. */
export const PICK_FILE_FILTERS = ['video', 'audio', 'all'] as const;
export type PickFileFilter = (typeof PICK_FILE_FILTERS)[number];

/** A path the preload read from a dropped `File`; the main process checks it again (fully qualified, a regular file, not a %TEMP% copy). */
const droppedPathSchema = z.string().min(1).max(32_767).regex(/^[^\0]+$/);

export const mediaConverterRequestSchemas = {
  getSnapshot: z.strictObject({}),
  /** Built by the preload only, from the first 100 files of a drop (R-ENGINE-07). */
  addDroppedFiles: z.strictObject({ paths: z.array(droppedPathSchema).min(1).max(QUEUE_LIMITS.filesPerAdd) }),
  pickFiles: z.strictObject({ filter: z.enum(PICK_FILE_FILTERS) }),
  pickOutputDirectory: z.strictObject({}),
  previewPlan: z.strictObject({ itemId: itemIdSchema, settings: conversionSettingsSchema }),
  start: startRequestSchema,
  cancel: itemIdsRequestSchema,
  remove: itemIdsRequestSchema,
  retry: retryRequestSchema,
  clear: clearRequestSchema,
  /** "Show in folder": an output this tool published, by its item and its position in the plan (0 by default). */
  revealOutput: z.strictObject({ itemId: itemIdSchema, outputIndex: z.number().int().min(0).max(MAX_STREAMS).optional() }),
  setOptions: queueOptionsPatchSchema,
  redetectCapabilities: z.strictObject({}),
} as const;
export type MediaConverterMethod = keyof typeof mediaConverterRequestSchemas;
export type MediaConverterRequest<K extends MediaConverterMethod> = z.infer<(typeof mediaConverterRequestSchemas)[K]>;

/**
 * `get-snapshot`: the queue, with what the planner's encoder chains resolve to on this computer and
 * the defaults that depend on it (CPU encoders until the detection has run).
 */
export const mediaConverterSnapshotSchema = queueSnapshotSchema.extend({ resolvedEncoders: resolvedEncodersSchema, defaults: capabilityDefaultsSchema });
export type MediaConverterSnapshot = z.infer<typeof mediaConverterSnapshotSchema>;

/**
 * `preview-plan`: the plan an idle item would get, or its `already_target` skip with the plan
 * "convert anyway" would run, or `no_encoder_available` with the codecs whose chain would work for
 * this picture instead (module-encode R-ENCODE-02: "use X instead"; possibly none). Other plan
 * errors and not-applicable answers are the request's error code.
 */
export const previewPlanResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), plan: planSummarySchema }),
  z.strictObject({ status: z.literal('skipped'), reason: z.literal('already_target'), plan: planSummarySchema }),
  z.strictObject({
    status: z.literal('error'), reason: z.literal('no_encoder_available'),
    alternatives: z.array(compressCodecSchema).max(COMPRESS_CODECS.length)
      .refine(codecs => new Set(codecs).size === codecs.length, { message: 'A codec is listed twice.' }),
  }),
]);
export type PreviewPlanResult = z.infer<typeof previewPlanResultSchema>;

/** `pick-output-directory`: the folder under the id the main process gave it; null when the dialog was cancelled. */
export const pickOutputDirectoryResultSchema = z.strictObject({ directory: outputDirectorySchema.nullable() });
export type PickOutputDirectoryResult = z.infer<typeof pickOutputDirectoryResultSchema>;

/**
 * Why a request failed: `invalid_request` (malformed, not from the application window's main frame,
 * or naming nothing this tool owns), `platform_unsupported` (every request outside Windows),
 * `busy` (shutting down, a detection that cannot start now), `unknown` (an unexpected error, logged
 * in the main process), or what the queue or planner answered (`preview-plan`'s `task_not_applicable`).
 */
export const mediaConverterErrorCodeSchema = itemFailureCodeSchema;
export type MediaConverterErrorCode = ItemFailureCode;
export interface MediaConverterError { readonly code: MediaConverterErrorCode }
export type MediaConverterResult<T> = { ok: true; value: T } | { ok: false; error: MediaConverterError };

/** The `value` of a successful response, per method. */
export interface MediaConverterValues {
  getSnapshot: MediaConverterSnapshot;
  addDroppedFiles: AddFilesResult;
  /** A cancelled dialog adds nothing. */
  pickFiles: AddFilesResult;
  pickOutputDirectory: PickOutputDirectoryResult;
  previewPlan: PreviewPlanResult;
  start: StartResult;
  cancel: { affected: number };
  remove: { affected: number };
  retry: { affected: number };
  clear: { removed: number };
  revealOutput: Record<string, never>;
  setOptions: QueueOptions;
  redetectCapabilities: Record<string, never>;
}

type MediaConverterInvokers = {
  [K in Exclude<MediaConverterMethod, 'getSnapshot' | 'addDroppedFiles' | 'pickOutputDirectory' | 'redetectCapabilities'>]:
    (request: MediaConverterRequest<K>) => Promise<MediaConverterResult<MediaConverterValues[K]>>;
};

/** `window.mediaConverter`: one method per request channel, the platform flag and the change event subscription. */
export interface MediaConverterApi extends MediaConverterInvokers {
  /** Windows only until I4; elsewhere every request answers `platform_unsupported` (AC-ENGINE-01-3). */
  readonly supported: boolean;
  getSnapshot(): Promise<MediaConverterResult<MediaConverterSnapshot>>;
  /**
   * The files of a drop. The preload reads their paths before anything awaits (the drop owns them)
   * and sends the first 100; the rest count as `truncated`, files without a path on disk are
   * rejected as `file_unavailable`.
   */
  addDroppedFiles(files: readonly File[]): Promise<MediaConverterResult<AddFilesResult>>;
  pickOutputDirectory(): Promise<MediaConverterResult<PickOutputDirectoryResult>>;
  redetectCapabilities(): Promise<MediaConverterResult<Record<string, never>>>;
  /** Events that fail `queueEventSchema` are dropped. Returns the unsubscribe function. */
  onChanged(listener: (event: QueueEvent) => void): () => void;
}
