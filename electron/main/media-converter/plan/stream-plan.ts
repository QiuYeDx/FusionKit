import type {
  AudioStreamInfo, CompressCodec, ConversionSettings, ConversionTask, CoverStreamInfo, EncoderId, MediaDemuxer,
  MediaInfo, OutputContainer, PlanErrorCode, PlanStreamSummary, PlanSummary, PlanWarning, PlanWarningCode, StreamDropReason,
  SubtitleStreamInfo, VariantKey, VideoContainer, VideoStreamInfo,
} from '../../../../src/media-converter/contract';
import { outputTagCleanup, planAudioFormat, planExtractCopy, planVideoAudio, trackTagCleanup, type AudioPlan } from './audio';
import { outputCapBytes } from './caps';
import {
  AUDIO_FORMAT_CONTAINERS, CONVERT_VIDEO_CODEC, ENCODER_CODEC, OUTPUT_CONTAINER_SPECS, autoCompressContainer, canCopyVideo,
  isMovFamily, isSameContainer, isVideoContainer, subtitleHandling, taskApplicability,
} from './matrix';
import { isNameLanguage } from './naming';
import { planVideoEncode, type VideoRequest } from './video';
import type {
  ConversionPlan, EncodeSpec, KeptStreamDecision, OptionPair, OutputBaseName, PlanOutcome, PlannedOutput, PlannerCapabilities, StreamDecision,
  StreamRef,
} from './types';

/**
 * `buildPlan` (module-encode design §1, §2, §7): decides for every source stream whether each
 * output copies it, encodes it or drops it (and why), picks the container ("auto" for compress),
 * applies the task matrix, maps explicitly, keeps metadata, chapters and dispositions, sets the
 * byte cap, and answers `already_target` when a conversion would change nothing. Pure: the same
 * media, settings and capabilities always give the same plan.
 */

// ── Encoder choices ────────────────────────────────────────────────────────────────────────────
// The video choice is `planVideoEncode` (video.ts: encoder chains, parameter tables, scaling, and
// the correctness of design §4: colour tags, range, HDR, Dolby Vision, VFR, deinterlacing, chroma).
// A copied video keeps everything as it is, the rotation matrix and the Dolby Vision RPU included;
// only a re-encode can be refused (`dolby_vision_p5_unsupported`).
// The audio choices are audio.ts's (design §5): the passthrough rules of "convert" and "compress"
// for audio inside a video, the audio format tables, the same-codec copy, the extraction types,
// each track's own layout and sample rate filters, the bit depth, and the tags written over the
// copied ones. The same codec is copied unless the target's rate is lower than the source's
// (AC-ENCODE-04-5): then it is re-encoded to shrink it.

/**
 * Raw H.264 and HEVC elementary streams (`.h264`, `.hevc`) carry no timestamps, and the bundled
 * ffmpeg 8.1.2 gives a copy of them none: MP4 writes guessed ones with a warning (B-frames without
 * any presentation time), Matroska refuses the packets, and the progress never leaves `N/A`,
 * whatever `-fflags +genpts`, `-r` or `-framerate` before the input, or a `setts` filter does.
 * Decoding gives the frames their times, so their video is always re-encoded, as a re-encode for
 * the target would be (AC-ENCODE-01-7); raw MPEG-1/2 video (`mpegvideo`) is timed by its parser
 * and copies with `+genpts` (module-encode design §7b, 2026-10-28).
 */
const UNTIMED_VIDEO_DEMUXERS: ReadonlySet<MediaDemuxer> = new Set(['h264', 'hevc']);

/** What a video re-encode is asked for: compress by its settings; convert by the target (AC-ENCODE-01-7) and its tier, never scaled. */
function videoRequest(settings: ConversionSettings, container: VideoContainer): VideoRequest {
  return settings.task === 'compress'
    ? { codec: settings.codec, tier: settings.tier, maxShortSide: settings.maxShortSide, useGpuForAv1: settings.useGpuForAv1 }
    : { codec: CONVERT_VIDEO_CODEC[container], tier: settings.tier, maxShortSide: null, useGpuForAv1: false };
}

/** Cover art goes into MP3 (APIC), M4A and FLAC as it is; Opus, Ogg, WAV, AIFF and Matroska do not get it in I1. */
const COVER_CONTAINERS: ReadonlySet<OutputContainer> = new Set(['mp3', 'm4a', 'flac']);
const COVER_CODECS: ReadonlySet<string> = new Set(['mjpeg', 'png']);
const keepsCover = (container: OutputContainer, cover: CoverStreamInfo) => COVER_CONTAINERS.has(container) && COVER_CODECS.has(cover.codec);

// ── Drafts ─────────────────────────────────────────────────────────────────────────────────────

type Choice =
  | { action: 'copy' }
  | { action: 'encode'; encode: EncodeSpec }
  | { action: 'drop'; reason: StreamDropReason };

interface Entry {
  source: StreamRef;
  choice: Choice;
  /** `-disposition` of a kept stream; null keeps the source flags. */
  disposition: string | null;
}

interface Draft {
  container: OutputContainer;
  baseName: OutputBaseName;
  /** In output order: video, audio, subtitles, cover art. */
  entries: Entry[];
  /** The stream whose duration the output must reach (AC-ENGINE-04-5). */
  mainDurationUs: number | null;
  /** Attachments are part of what this output carries (video outputs), so dropping them is a loss. */
  carriesAttachments: boolean;
  warnings: PlanWarning[];
  /** A lossy track is written losslessly: `lossy_to_lossless` is confirmed before the start (AC-ENCODE-04-5). */
  lossyToLossless: boolean;
}

const ref = (kind: StreamRef['kind'], stream: { index: number; typeIndex: number; codec: string }, language: string | null = null, title: string | null = null): StreamRef =>
  ({ kind, index: stream.index, typeIndex: stream.typeIndex, codec: stream.codec, language, title });
const videoRef = (stream: VideoStreamInfo) => ref('video', stream, stream.language, stream.title);
const audioRef = (stream: AudioStreamInfo) => ref('audio', stream, stream.language, stream.title);
const subtitleRef = (stream: SubtitleStreamInfo) => ref('subtitle', stream, stream.language, stream.title);
const coverRef = (stream: CoverStreamInfo) => ref('cover', stream);

const dropped = (reason: StreamDropReason): Choice => ({ action: 'drop', reason });
const warning = (code: PlanWarningCode, streams: number[], count = streams.length): PlanWarning => ({ code, streams, count });

/**
 * Disposition flags set (`+`) or cleared (`-`) relative to the source's, e.g. `+default-forced`:
 * ffmpeg copies the source flags first, so the ones the probe does not report (commentary, visual
 * impaired, original, descriptions...) stay, where an absolute value would clear them.
 */
function flags(...pairs: [on: boolean, name: string][]): string {
  return pairs.map(([on, name]) => `${on ? '+' : '-'}${name}`).join('');
}
/** Whether a disposition written by {@link flags} sets `name`. */
const raises = (disposition: string | null, name: string) => disposition !== null && disposition.split(/(?=[+-])/).includes(`+${name}`);
const audioFlags = (stream: AudioStreamInfo) => flags([stream.default, 'default'], [stream.forced, 'forced']);
const subtitleFlags = (stream: SubtitleStreamInfo) => flags([stream.default, 'default'], [stream.forced, 'forced'], [stream.hearingImpaired, 'hearing_impaired']);

const primaryVideo = (media: MediaInfo) => media.video.find(stream => stream.index === media.primaryVideoIndex) ?? null;
/**
 * The file's total bit rate when one audio track is all it holds (no video, no cover art, no other
 * track): the track's rate when neither its stream nor a tag states one (AC-ENCODE-04-5). In any
 * other file it would count the rest too, and a too-high source rate would re-encode a track into
 * a larger one.
 */
const soleTrackBitRate = (media: MediaInfo) =>
  media.kind === 'audio' && media.video.length === 0 && media.covers.length === 0 && media.audio.length === 1 ? media.bitRate : null;
/** The default audio track, else the first. */
const defaultAudio = (media: MediaInfo) => media.audio.find(stream => stream.default) ?? media.audio[0] ?? null;

/**
 * A video output: the main video as `videoChoice` says, every audio track, the subtitles the
 * container takes, attachments only in MKV. Other video streams are not carried. Cover art is
 * dropped and said so: the mapping of design §2 has no cover, and Matroska would write it back as
 * a one-frame video track rather than an attachment. Dispositions are written for every audio and
 * subtitle stream, so ffmpeg never marks a default of its own.
 */
function videoDraft(media: MediaInfo, container: VideoContainer, videoChoice: Choice, baseName: OutputBaseName, settings: ConversionSettings, warnings: PlanWarning[]): Draft {
  const primary = primaryVideo(media)!;
  const entries: Entry[] = [];
  for (const stream of media.video) {
    entries.push({ source: videoRef(stream), choice: stream.index === primary.index ? videoChoice : dropped('not_selected'), disposition: null });
  }
  for (const stream of media.audio) {
    const planned = planVideoAudio(container, stream, settings);
    entries.push({ source: audioRef(stream), choice: planned.choice, disposition: audioFlags(stream) });
    warnings.push(...planned.warnings);
  }
  const lostSubtitles: number[] = [], lostStyling: number[] = [];
  for (const stream of media.subtitles) {
    const handling = subtitleHandling(container, stream);
    if (handling.action === 'drop') lostSubtitles.push(stream.index);
    if (handling.action === 'encode' && handling.stylingLost) lostStyling.push(stream.index);
    const choice: Choice = handling.action === 'copy' ? { action: 'copy' } : handling.action === 'drop' ? dropped('subtitle_dropped')
      : { action: 'encode', encode: { encoder: handling.encoder, variant: null, params: [], filters: [], maxBitRate: null, frame: null } };
    entries.push({ source: subtitleRef(stream), choice, disposition: subtitleFlags(stream) });
  }
  for (const stream of media.covers) entries.push({ source: coverRef(stream), choice: dropped('cover_dropped'), disposition: null });
  if (lostStyling.length) warnings.push(warning('subtitle_styling_lost', lostStyling));
  if (lostSubtitles.length) warnings.push(warning('subtitle_dropped', lostSubtitles));
  if (media.covers.length) warnings.push(warning('cover_dropped', media.covers.map(stream => stream.index)));
  return { container, baseName, entries, mainDurationUs: primary.durationUs, carriesAttachments: true, warnings, lossyToLossless: false };
}

/** An audio output of one track as `planned` says: the other streams are not carried; cover art where the type takes it. */
function audioDraft(media: MediaInfo, track: AudioStreamInfo, container: OutputContainer, planned: AudioPlan, baseName: OutputBaseName): Draft {
  const entries: Entry[] = [];
  const warnings: PlanWarning[] = [...planned.warnings];
  for (const stream of media.video) entries.push({ source: videoRef(stream), choice: dropped('not_selected'), disposition: null });
  for (const stream of media.audio) entries.push({ source: audioRef(stream), choice: stream.index === track.index ? planned.choice : dropped('not_selected'), disposition: null });
  for (const stream of media.subtitles) entries.push({ source: subtitleRef(stream), choice: dropped('not_selected'), disposition: null });
  const lostCovers: number[] = [];
  for (const stream of media.covers) {
    const kept = keepsCover(container, stream);
    if (!kept) lostCovers.push(stream.index);
    entries.push({ source: coverRef(stream), choice: kept ? { action: 'copy' } : dropped('cover_dropped'), disposition: kept ? 'attached_pic' : null });
  }
  if (lostCovers.length) warnings.push(warning('cover_dropped', lostCovers));
  return { container, baseName, entries, mainDurationUs: track.durationUs, carriesAttachments: false, warnings, lossyToLossless: planned.lossyToLossless };
}

type Drafts = { ok: true; drafts: Draft[] } | { ok: false; reason: PlanErrorCode; alternatives: CompressCodec[] };

function draftOutputs(media: MediaInfo, settings: ConversionSettings, caps: PlannerCapabilities): Drafts {
  if (settings.task === 'extract-audio') {
    const tracks = settings.allTracks ? media.audio : [defaultAudio(media)!];
    return { ok: true, drafts: tracks.map(track => {
      const planned = settings.format === 'copy' ? planExtractCopy(track)
        : { container: AUDIO_FORMAT_CONTAINERS[settings.format], plan: planAudioFormat(settings.format, track, settings.tier, soleTrackBitRate(media)) };
      const baseName: OutputBaseName = settings.allTracks
        ? { rule: 'track', number: track.typeIndex + 1, language: isNameLanguage(track.language) ? track.language : null } : { rule: 'source' };
      return audioDraft(media, track, planned.container, planned.plan, baseName);
    }) };
  }
  if (settings.task === 'convert' && !isVideoContainer(settings.target)) {
    const track = defaultAudio(media)!;
    const planned = planAudioFormat(settings.target, track, settings.tier, soleTrackBitRate(media));
    return { ok: true, drafts: [audioDraft(media, track, AUDIO_FORMAT_CONTAINERS[settings.target], planned, { rule: 'converted' })] };
  }

  const primary = primaryVideo(media)!;
  const container: VideoContainer = settings.task === 'compress'
    ? (settings.container === 'auto' ? autoCompressContainer(media) : settings.container) : settings.target as VideoContainer;
  const copyVideo = settings.task === 'convert' && settings.preferRemux && canCopyVideo(container, primary.codec)
    && !UNTIMED_VIDEO_DEMUXERS.has(media.container.demuxer);
  let videoChoice: Choice = { action: 'copy' };
  const warnings: PlanWarning[] = [];
  if (!copyVideo) {
    const chosen = planVideoEncode(primary, media, videoRequest(settings, container), caps);
    if (!chosen.ok) return chosen;
    videoChoice = { action: 'encode', encode: chosen.encode };
    warnings.push(...chosen.warnings);
  }
  const baseName: OutputBaseName = settings.task === 'compress' ? { rule: 'compressed' } : { rule: 'converted' };
  return { ok: true, drafts: [videoDraft(media, container, videoChoice, baseName, settings, warnings)] };
}

// ── Assembly ───────────────────────────────────────────────────────────────────────────────────

/**
 * Demuxers whose remux may lack timestamps: AVI and raw MPEG-1/2 video, whose B-frames come
 * without a presentation time. Raw H.264 and HEVC never remux (`UNTIMED_VIDEO_DEMUXERS`).
 */
const GENERATE_PTS: ReadonlySet<MediaDemuxer> = new Set(['avi', 'mpegvideo']);
const TEN_SECONDS_US = 10_000_000;
const OUTPUT_TYPE = { video: 'v', cover: 'v', audio: 'a', subtitle: 's' } as const;

function assemble(draft: Draft, media: MediaInfo, settings: ConversionSettings): PlannedOutput {
  const spec = OUTPUT_CONTAINER_SPECS[draft.container];
  const movFamily = isMovFamily(draft.container);
  const next = { v: 0, a: 0, s: 0 };
  const streams = draft.entries.map(({ source, choice, disposition }): StreamDecision => {
    if (choice.action === 'drop') return { action: 'drop', source, reason: choice.reason };
    const codec = choice.action === 'encode' ? ENCODER_CODEC[choice.encode.encoder] : source.codec;
    // MP4/MOV keep a track title in `handler_name`; Matroska copies the `title` tag by itself. Ogg
    // writes an audio track's tags as comments, without the MP4 track's own (AC-ENCODE-04-3).
    const metadata: OptionPair[] = movFamily && source.title && source.kind !== 'cover' ? [['handler_name', source.title]]
      : source.kind === 'audio' ? [...trackTagCleanup(draft.container)] : [];
    const placed = { source, outputIndex: next[OUTPUT_TYPE[source.kind]]++, disposition, metadata, tag: movFamily && source.kind === 'video' && codec === 'hevc' ? 'hvc1' : null };
    return choice.action === 'copy' ? { ...placed, action: 'copy' } : { ...placed, action: 'encode', encode: choice.encode };
  });
  const kept = streams.filter((decision): decision is KeptStreamDecision => decision.action !== 'drop');
  const remux = kept.every(decision => decision.source.kind === 'subtitle' || decision.action === 'copy');
  const output = {
    streams,
    container: { id: spec.id, muxer: spec.muxer, extension: spec.extension, baseName: draft.baseName, faststart: spec.faststart, options: spec.options },
    expectedDurationUs: draft.mainDurationUs ?? media.durationUs,
    expectedFrom: draft.mainDurationUs !== null ? 'stream' as const : 'container' as const,
    durationLimitUs: media.durationUs === null ? null : Math.max(Math.ceil(media.durationUs * 1.05), media.durationUs + TEN_SECONDS_US),
    attachments: { count: media.attachments, action: spec.attachments && draft.carriesAttachments ? 'copy' as const : 'drop' as const },
    chapters: { count: media.chapters, kept: spec.chapters },
    dataStreams: media.dataStreams,
    // MP3, FLAC, Opus and Ogg do not take the source container's brand tags (AC-ENCODE-04-3).
    metadata: outputTagCleanup(draft.container),
    remux,
    generatePts: remux && GENERATE_PTS.has(media.container.demuxer),
  };
  return { ...output, ...outputCapBytes(output, media, settings) };
}

/** Warnings that come from the assembled output rather than from the stream choices. */
function outputWarnings(output: PlannedOutput, draft: Draft): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  if (draft.carriesAttachments && output.attachments.action === 'drop' && output.attachments.count > 0) warnings.push(warning('attachment_dropped', [], output.attachments.count));
  if (!output.chapters.kept && output.chapters.count > 0) warnings.push(warning('chapters_dropped', [], output.chapters.count));
  // The MOV muxer enables the first track of a type when none is default (AC-ENCODE-01-4): the
  // first subtitle, and in a video output the first audio track (a TS, AVI or FLV source has none).
  const kept = output.streams.filter((decision): decision is KeptStreamDecision => decision.action !== 'drop');
  const forced = (kind: StreamRef['kind'], code: PlanWarningCode) => {
    const ofKind = kept.filter(decision => decision.source.kind === kind);
    if (ofKind.length && !ofKind.some(decision => raises(decision.disposition, 'default'))) warnings.push(warning(code, [ofKind[0].source.index]));
  };
  if (isMovFamily(output.container.id)) {
    if (kept.some(decision => decision.source.kind === 'video')) forced('audio', 'mp4_default_audio_forced');
    forced('subtitle', 'mp4_default_subtitle_forced');
  }
  if (output.expectedDurationUs === null) warnings.push(warning('duration_unverified', []));
  return warnings;
}

// ── Summary ────────────────────────────────────────────────────────────────────────────────────

function streamSummary(decision: StreamDecision): PlanStreamSummary {
  const { kind, index, typeIndex, codec, language, title } = decision.source;
  return {
    kind, index, typeIndex, codec, language, title, action: decision.action,
    encoder: decision.action === 'encode' ? decision.encode.encoder : null,
    variant: decision.action === 'encode' ? decision.encode.variant : null,
    reason: decision.action === 'drop' ? decision.reason : null,
  };
}

/** One entry per code, in the order they first appear: the streams of every output together. */
function mergeWarnings(warnings: PlanWarning[]): PlanWarning[] {
  const merged = new Map<PlanWarningCode, PlanWarning>();
  for (const item of warnings) {
    const known = merged.get(item.code);
    if (!known) { merged.set(item.code, { ...item, streams: [...item.streams] }); continue; }
    for (const index of item.streams) if (!known.streams.includes(index)) known.streams.push(index);
    known.count = known.streams.length ? known.streams.length : Math.max(known.count, item.count);
  }
  return [...merged.values()];
}

function summarize(task: ConversionTask, outputs: PlannedOutput[], warnings: PlanWarning[], isRemuxOnly: boolean, lossyToLossless: boolean): PlanSummary {
  const encoders: { encoder: EncoderId; variant: VariantKey | null }[] = [];
  for (const decision of outputs.flatMap(output => output.streams)) {
    if (decision.action !== 'encode') continue;
    const { encoder, variant } = decision.encode;
    if (!encoders.some(item => item.encoder === encoder && item.variant === variant)) encoders.push({ encoder, variant });
  }
  return {
    task, remuxOnly: isRemuxOnly, encoders,
    outputs: outputs.map(output => ({
      container: output.container.id,
      extension: output.container.extension,
      track: output.container.baseName.rule === 'track' ? { number: output.container.baseName.number, language: output.container.baseName.language } : null,
      streams: output.streams.map(streamSummary),
      attachments: { count: output.attachments.count, kept: output.attachments.action === 'copy' },
      chapters: { count: output.chapters.count, kept: output.chapters.kept },
      dataStreamsDropped: output.dataStreams,
    })),
    warnings: mergeWarnings(warnings),
    // "It will not sound better and the file will be larger" (AC-ENCODE-04-5); the engine starts nothing unconfirmed.
    confirmations: lossyToLossless ? ['lossy_to_lossless'] : [],
  };
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────

export function buildPlan(media: MediaInfo, settings: ConversionSettings, caps: PlannerCapabilities): PlanOutcome {
  const applies = taskApplicability(settings, media);
  if (applies !== 'plan') return { status: 'not_applicable', reason: applies };
  const drafted = draftOutputs(media, settings, caps);
  if (!drafted.ok) return { status: 'error', reason: drafted.reason, alternatives: drafted.alternatives };
  const warnings: PlanWarning[] = [];
  const outputs = drafted.drafts.map(draft => {
    const output = assemble(draft, media, settings);
    warnings.push(...draft.warnings, ...outputWarnings(output, draft));
    return output;
  });
  const isRemuxOnly = outputs.every(output => output.remux);
  const lossyToLossless = drafted.drafts.some(draft => draft.lossyToLossless);
  const plan: ConversionPlan = { outputs, isRemuxOnly, summary: summarize(settings.task, outputs, warnings, isRemuxOnly, lossyToLossless) };
  // AC-ENCODE-06-2: the same container, and every stream copied as it is.
  const unchanged = settings.task === 'convert' && outputs.length === 1 && isSameContainer(media.container, outputs[0].container.id)
    && outputs[0].streams.every(decision => decision.action !== 'encode');
  return unchanged ? { status: 'skipped', reason: 'already_target', plan } : { status: 'ready', plan };
}
