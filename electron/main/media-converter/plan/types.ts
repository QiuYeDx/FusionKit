import type {
  CompressCodec, EncoderId, OutputContainer, PlanErrorCode, PlanNotApplicableCode, PlanSummary, StreamDropReason, VariantKey, VideoEncoderId,
} from '../../../../src/media-converter/contract';

/**
 * The plan of one conversion (module-encode design §1): for every output, what happens to each
 * source stream, the filters, the container, the byte cap, and from that the full ffmpeg
 * arguments (`toFfmpegArgs`). Plans are made by pure functions from the media information, the
 * settings and the capability table, so the same inputs always give the same plan.
 */

/** An encoder option and its value, without the leading dash or a stream specifier: `['crf', '32']`. */
export type OptionPair = readonly [name: string, value: string];

/**
 * What the engine measured on this computer (engine design §3); the planner only reads it.
 * An encoder or variant that is missing was not found or did not pass the detection. The CPU
 * encoders of the bundled runtime (libsvtav1, libkvazaar, libopenh264) are not probed: they count
 * as present unless a variant of theirs is listed as `false` (or they are degraded).
 */
export interface PlannerCapabilities {
  encoders: Partial<Record<VideoEncoderId, {
    /** Whether each configuration passed a real encode with the production parameters. */
    variants: Partial<Record<VariantKey, boolean>>;
    /** NVENC: some `uhq` configuration passed; the planner itself reads the `*_uhq` variants. */
    uhq?: boolean;
  }>>;
  /** Encoders that failed before their first frame in this session; they are passed over. */
  degraded: VideoEncoderId[];
  /**
   * The NVENC minimum of engine design §3 (144 wide, 120 high, from three size samples). The planner
   * does not read it: AC-ENCODE-02-2 and design §7b replaced it with the range measured per codec
   * (`VIDEO_TABLE.hardwareFrame`: H.264 145–4096 wide and at least 49 high, HEVC from 129×33, AV1
   * from 129×65), which alone decides, so this older, narrower value cannot keep NVENC off pictures
   * the AC gives it. Kept for the engine's capability snapshot until T-ENGINE-03 retires it.
   */
  nvencMin: { width: number; height: number };
}

export type StreamKind = 'video' | 'audio' | 'subtitle' | 'cover';

/** A source stream: `-map 0:<index>`. */
export interface StreamRef {
  kind: StreamKind;
  index: number;
  /** Among the source streams of the same type (covers count as video, as ffmpeg counts them). */
  typeIndex: number;
  codec: string;
  language: string | null;
  title: string | null;
}

export interface EncodeSpec {
  encoder: EncoderId;
  /** Video: the configuration (bit depth, NVENC tune, MF mode) the parameters were chosen for; null for audio and subtitles. */
  variant: VariantKey | null;
  /**
   * Encoder options in order, then the other per-stream output options the stream needs (video:
   * `-dolbyvision 0`, `-fps_mode passthrough`; audio: `-ac 2`, `-sample_fmt`, `-bits_per_raw_sample`);
   * `toFfmpegArgs` adds the output stream specifier to each name.
   */
  params: readonly OptionPair[];
  /**
   * Filters in order, joined into this stream's own `-filter:<type>:<n>`; empty for none. A video
   * encode follows design §4: [bwdif] → [zscale tone mapping] → [scale] → format → setparams; an
   * audio encode design §5: [channelmap or aformat layout] → [aresample].
   */
  filters: readonly string[];
  /** Bits per second the encoder reaches at most, for the output cap; null when unknown. */
  maxBitRate: number | null;
  /** Video: the encoded picture after rotation and scaling, for the output cap; null otherwise. */
  frame: { width: number; height: number; fps: number | null } | null;
}

/** A source stream that goes into the output. */
interface KeptStream {
  source: StreamRef;
  /** Its position among the output streams of its type: `-c:v:<n>`, `-c:a:<n>`, `-c:s:<n>`. */
  outputIndex: number;
  /**
   * `-disposition:<type>:<n>`: flags set or cleared relative to the source's (`+default-forced`),
   * so the source's other flags stay, or an absolute value (`attached_pic`); null keeps the source flags.
   */
  disposition: string | null;
  /**
   * `-metadata:s:<type>:<n> name=value`, e.g. the MP4 `handler_name` that carries a track title; an
   * empty value removes a copied tag (the MP4 handler of a track written to Opus, audio.ts).
   */
  metadata: readonly OptionPair[];
  /** `-tag:<type>:<n>`, e.g. `hvc1` for HEVC in MP4/MOV. */
  tag: string | null;
}

export type StreamDecision =
  | (KeptStream & { action: 'copy' })
  | (KeptStream & { action: 'encode'; encode: EncodeSpec })
  | { action: 'drop'; source: StreamRef; reason: StreamDropReason };
export type KeptStreamDecision = Extract<StreamDecision, { action: 'copy' | 'encode' }>;

/** How the output file is named from the source name once its folder is known (design §6, `naming.ts`). */
export type OutputBaseName =
  /** `{name}-compressed` */
  | { rule: 'compressed' }
  /** `{name}`, or `{name}-converted` beside the source when the extension would not change. */
  | { rule: 'converted' }
  /** `{name}`: one extracted track; `-converted` too beside the source when the extension would not change (an Ogg video's Vorbis). */
  | { rule: 'source' }
  /** `{name}.track{number}[.{language}]`: "all tracks" extraction; `language` is null unless it matches `^[a-z]{2,3}$`. */
  | { rule: 'track'; number: number; language: string | null };

export interface PlannedOutput {
  streams: StreamDecision[];
  container: {
    id: OutputContainer;
    /** The ffmpeg muxer, always given with `-f`. */
    muxer: string;
    extension: string;
    baseName: OutputBaseName;
    /** `-movflags +faststart`. */
    faststart: boolean;
    /** Muxer options, e.g. `id3v2_version 3` or `rf64 auto`. */
    options: readonly OptionPair[];
  };
  /** The hard byte limit of the output (`-fs`), and what reaching it means (design §7). */
  capBytes: number;
  capSemantics: 'not_smaller' | 'output_cap_exceeded';
  /** The duration the output must reach for success: the main stream's, else the source's; null when unknown. */
  expectedDurationUs: number | null;
  /**
   * Where `expectedDurationUs` came from, so the engine compares like with like: the source's main
   * stream (against the output's main stream), or the source container (the main stream had no
   * duration; against the output's container). `container` as well when no duration is known.
   */
  expectedFrom: 'stream' | 'container';
  /** `-t`: max(duration × 1.05, duration + 10 s) of the probed source duration; null when unknown. */
  durationLimitUs: number | null;
  /** Fonts and other attachments of the source: `copy` maps them all (`-map 0:t?`, MKV only). */
  attachments: { count: number; action: 'copy' | 'drop' };
  /** `-map_chapters 0`, or `-1` when the target cannot hold chapters. */
  chapters: { count: number; kept: boolean };
  /** Data streams of the source; never mapped. */
  dataStreams: number;
  /**
   * Global metadata written over the copied source metadata (`-metadata name=value`; an empty value
   * removes the tag): the source container's brand tags for MP3, FLAC, Opus and Ogg (AC-ENCODE-04-3).
   */
  metadata: readonly OptionPair[];
  /** Every audio and video stream is copied: `-avoid_negative_ts make_zero`. */
  remux: boolean;
  /** `-fflags +genpts` before the input: a remux of AVI or of raw MPEG-1/2 video, which may lack timestamps (raw H.264/HEVC is never remuxed). */
  generatePts: boolean;
}

export interface ConversionPlan {
  /** Usually one; one per audio track for "all tracks". */
  outputs: PlannedOutput[];
  summary: PlanSummary;
  /** No audio or video stream of any output is re-encoded. */
  isRemuxOnly: boolean;
}

/**
 * What `buildPlan` answers. A skipped plan is still complete: "convert anyway" (`override`) runs it.
 * Not-applicable and error answers produce no arguments; an error can suggest other codecs.
 */
export type PlanOutcome =
  | { status: 'ready'; plan: ConversionPlan }
  | { status: 'skipped'; reason: 'already_target'; plan: ConversionPlan }
  | { status: 'not_applicable'; reason: PlanNotApplicableCode }
  | { status: 'error'; reason: PlanErrorCode; alternatives: readonly CompressCodec[] };
