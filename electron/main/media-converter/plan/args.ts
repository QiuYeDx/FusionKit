import type { EncoderId, MediaDemuxer, VariantKey, VideoEncoderId } from '../../../../src/media-converter/contract';
import type { KeptStreamDecision, OptionPair, PlannedOutput, StreamKind } from './types';
import { SVT_LOW_USAGE_PARAMS, probeEncodeSpec } from './video';

/**
 * The ffmpeg arguments of one planned output (module-encode design §2, engine design §4/§7):
 * the input pinned to its demuxer and the file protocol, explicit maps, per-stream codecs,
 * filters, dispositions and metadata, the byte and duration caps, and the output pinned to its
 * muxer. The process wrapper puts its common prefix (`-hide_banner -nostdin -nostats -loglevel
 * level+warning -stats_period 0.5 -progress pipe:1`) in front and moves a filter over 8 KB to a file.
 */

export interface FfmpegIo {
  inputPath: string;
  /** The demuxer the probe found; ffmpeg never guesses again. */
  demuxer: MediaDemuxer;
  /** The `.partial` file the engine created with `wx`; ffmpeg writes it with `-y`. */
  partialPath: string;
  /** Two-pass log files (I2). */
  passLogPrefix?: string;
  /** Low-usage mode, a queue option of the engine read when the item starts: SVT-AV1 also gets `lp=1` (engine design §4). */
  lowUsage?: boolean;
}

/** ffmpeg's letter for an output stream of this kind: cover art is a video stream. */
const TYPE: Readonly<Record<StreamKind, 'v' | 'a' | 's'>> = { video: 'v', audio: 'a', subtitle: 's', cover: 'v' };
export const streamSpecifier = (decision: KeptStreamDecision) => `${TYPE[decision.source.kind]}:${decision.outputIndex}`;

/** Each option of `params` for one output stream: `['crf', '32']` → `-crf:v:0 32`. */
const perStream = (params: readonly OptionPair[], specifier: string) => params.flatMap(([name, value]) => [`-${name}:${specifier}`, value]);

/** ffmpeg's name of an encoder where it differs from ours: `srt` is a deprecated alias of the SubRip encoder (design §7a). */
const FFMPEG_ENCODER_NAMES: Readonly<Partial<Record<EncoderId, string>>> = { srt: 'subrip' };
export const ffmpegEncoderName = (encoder: EncoderId) => FFMPEG_ENCODER_NAMES[encoder] ?? encoder;

/** Copy, or the encoder with its options (and `extra` after them) and the stream's own filter chain. */
function codecArgs(decision: KeptStreamDecision, extra: readonly OptionPair[] = []): string[] {
  const specifier = streamSpecifier(decision);
  if (decision.action === 'copy') return [`-c:${specifier}`, 'copy'];
  const { encoder, params, filters } = decision.encode;
  return [
    `-c:${specifier}`, ffmpegEncoderName(encoder), ...perStream([...params, ...extra], specifier),
    ...(filters.length ? [`-filter:${specifier}`, filters.join(',')] : []),
  ];
}

/**
 * The main video's codec arguments: the encoder, its table parameters and its filter chain from the
 * `EncodeSpec` (video.ts), plus what only the run decides: SVT-AV1's `lp=1` in low-usage mode.
 */
export function videoArgs(decision: KeptStreamDecision, io: FfmpegIo): string[] {
  const lowUsage = decision.action === 'encode' && decision.encode.encoder === 'libsvtav1' && io.lowUsage === true;
  return codecArgs(decision, lowUsage ? SVT_LOW_USAGE_PARAMS : []);
}

/**
 * The arguments the capability probe puts between its lavfi input (`PROBE_PICTURE`, 3 frames) and
 * its output (engine design §3): exactly what `toFfmpegArgs` writes for this configuration's video
 * stream, from the same tables, for that picture at the balanced tier. Throws for a configuration
 * the tables do not have.
 */
export function probeArgs(encoder: VideoEncoderId, variant: VariantKey): string[] {
  const encode = probeEncodeSpec(encoder, variant);
  const source = { kind: 'video' as const, index: 0, typeIndex: 0, codec: 'rawvideo', language: null, title: null };
  return codecArgs({ action: 'encode', source, outputIndex: 0, disposition: null, metadata: [], tag: null, encode });
}

/**
 * One audio stream's codec arguments from its `EncodeSpec` (audio.ts): the encoder, the table
 * options and the per-track ones (`-ac:a:<n> 2`, `-sample_fmt:a:<n>`), and the track's own
 * `-filter:a:<n>` chain (layout, then sample rate). Never `-af`: a global audio filter would apply
 * to every track, and repeating it keeps only the last (AC-ENCODE-04-4).
 */
export const audioArgs = (decision: KeptStreamDecision, _io: FfmpegIo): string[] => codecArgs(decision);

/** Seconds with microsecond precision, without float rounding: 12500000 → `12.500000`. */
export const ffmpegSeconds = (microseconds: number) => `${Math.trunc(microseconds / 1e6)}.${String(microseconds % 1e6).padStart(6, '0')}`;

export function toFfmpegArgs(output: PlannedOutput, io: FfmpegIo): string[] {
  const kept = output.streams.filter((decision): decision is KeptStreamDecision => decision.action !== 'drop');
  const args: string[] = [];
  if (output.generatePts) args.push('-fflags', '+genpts');
  args.push('-f', io.demuxer, '-protocol_whitelist', 'file', '-i', `file:${io.inputPath}`);

  // Every stream by its absolute index, never the default selection or `-map 0` (AC-ENCODE-01-2).
  for (const decision of kept) args.push('-map', `0:${decision.source.index}`);
  if (output.attachments.action === 'copy' && output.attachments.count > 0) args.push('-map', '0:t?');
  args.push('-map_metadata', '0', '-map_chapters', output.chapters.kept ? '0' : '-1');

  for (const decision of kept) {
    if (decision.source.kind === 'video') args.push(...videoArgs(decision, io));
    else if (decision.source.kind === 'audio') args.push(...audioArgs(decision, io));
    else args.push(...codecArgs(decision));
  }
  if (output.attachments.action === 'copy' && output.attachments.count > 0) args.push('-c:t', 'copy');

  for (const decision of kept) {
    const specifier = streamSpecifier(decision);
    if (decision.disposition !== null) args.push(`-disposition:${specifier}`, decision.disposition);
    for (const [name, value] of decision.metadata) args.push(`-metadata:s:${specifier}`, `${name}=${value}`);
    if (decision.tag !== null) args.push(`-tag:${specifier}`, decision.tag);
  }
  for (const [name, value] of output.metadata) args.push('-metadata', `${name}=${value}`);

  args.push('-max_muxing_queue_size', '4096');
  if (output.remux) args.push('-avoid_negative_ts', 'make_zero');
  if (output.container.faststart) args.push('-movflags', '+faststart');
  for (const [name, value] of output.container.options) args.push(`-${name}`, value);
  args.push('-fs', String(output.capBytes));
  if (output.durationLimitUs !== null) args.push('-t', ffmpegSeconds(output.durationLimitUs));
  args.push('-f', output.container.muxer, '-y', `file:${io.partialPath}`);
  return args;
}
