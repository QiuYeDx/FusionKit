import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { MediaRuntime } from '../../electron/main/media-converter/engine/runtime';
import { MediaProber } from '../../electron/main/media-converter/engine/probe';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import { toFfmpegArgs } from '../../electron/main/media-converter/plan/args';
import type { ConversionPlan, PlanOutcome, PlannerCapabilities } from '../../electron/main/media-converter/plan/types';
import type { ConversionSettings, MediaInfo } from '../../src/media-converter/contract';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * V-ENCODE-01-3: the planner's own arguments run by the real bundled ffmpeg. A 2 s lavfi MKV
 * (H.264, two titled AAC tracks with one default and one commentary, a forced SRT, two chapters,
 * global tags and a text attachment) is remuxed to MP4 and to MKV, and ffprobe compares what
 * AC-ENCODE-01-4 names: global metadata and chapters; per track language, title (MKV) or
 * handler_name (MP4), default and forced flags, and the commentary flag the probe does not report. Every ffmpeg runs at idle priority in a run folder under test-results/media-converter;
 * ffprobe runs through the verified runtime, below normal. Skipped when the runtime is not staged.
 */

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
const LIMITS = { timeoutMs: 30_000, stdoutMaxBytes: 4 * 1024 * 1024, stderrMaxBytes: 1024 * 1024 };
const CAPS: PlannerCapabilities = { encoders: {}, degraded: [], nvencMin: { width: 144, height: 120 } };
/** What the engine's process wrapper puts in front (without the progress pipe, which nothing reads here). */
const PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning'];
/** Warnings that mean ffmpeg silently did something other than asked (module-encode tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;

let root: string, runtime: MediaRuntime, prober: MediaProber, ffmpegPath: string, sourcePath: string, source: MediaInfo;

/** Runs the bundled ffmpeg at idle priority; a failure or a silent substitution rejects with the log. */
function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 && !SILENT_SUBSTITUTION.test(stderr) ? resolve(stderr) : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
  });
}

type ProbedStream = { index: number; codec_name?: string; codec_type: string; disposition?: Record<string, number>; tags?: Record<string, string> };
type Probed = { format: { duration?: string; tags?: Record<string, string> }; streams: ProbedStream[]; chapters: { start_time: string; end_time: string; tags?: Record<string, string> }[] };
async function ffprobe(file: string): Promise<Probed> {
  const result = await runtime.run('ffprobe', ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', `file:${file}`], LIMITS);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString('utf8'));
}
async function probed(file: string): Promise<MediaInfo> {
  const outcome = await prober.probe(file);
  if (!outcome.ok) throw new Error(`${path.basename(file)}: ${outcome.code}`);
  return outcome.info;
}

/** Tag names are compared without case (Matroska writes `ARTIST`, MP4 `artist`). */
const tag = (tags: Record<string, string> | undefined, name: string) => Object.entries(tags ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
/** Global tags the muxer writes for itself, not taken from the source. */
const CONTAINER_TAGS = new Set(['encoder', 'major_brand', 'minor_version', 'compatible_brands', 'creation_time']);
const userTags = (tags: Record<string, string> | undefined) => Object.fromEntries(Object.entries(tags ?? {})
  .map(([key, value]) => [key.toLowerCase(), value] as const).filter(([key]) => !CONTAINER_TAGS.has(key)).sort(([a], [b]) => a.localeCompare(b)));
const chaptersOf = (value: Probed) => value.chapters.map(chapter => ({
  start: Number(Number(chapter.start_time).toFixed(3)), end: Number(Number(chapter.end_time).toFixed(3)), title: tag(chapter.tags, 'title'),
}));
const ofType = (value: Probed, type: string) => value.streams.filter(stream => stream.codec_type === type);
/** Default and forced as AC-ENCODE-01-4 names them, and commentary, which the plan must not clear. */
const flags = (stream: ProbedStream) => ({ default: stream.disposition?.default ?? 0, forced: stream.disposition?.forced ?? 0, comment: stream.disposition?.comment ?? 0 });

/** The plan's arguments, run on the source as the engine would: into an extension-less `.partial`, then renamed. */
async function run(plan: ConversionPlan, input: string, info: MediaInfo, name: string): Promise<{ file: string; args: string[] }> {
  const partial = path.join(root, `.fusionkit-media-${name.length.toString(16).padStart(8, '0')}.partial`);
  await writeFile(partial, '', { flag: 'wx' });
  const args = toFfmpegArgs(plan.outputs[0], { inputPath: input, demuxer: info.container.demuxer, partialPath: partial });
  await ffmpeg([...PREFIX, ...args]);
  const file = path.join(root, name);
  await rename(partial, file);
  return { file, args };
}
const convertTo = (target: 'mp4' | 'mkv'): ConversionSettings => ({ task: 'convert', target, preferRemux: true, tier: 'balanced' });
function planOf(outcome: PlanOutcome): ConversionPlan {
  if (outcome.status !== 'ready' && outcome.status !== 'skipped') throw new Error(`no plan: ${outcome.reason}`);
  return outcome.plan;
}

beforeAll(async () => {
  if (!available) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'remux-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'remux-')));
  runtime = new MediaRuntime({ environment, workingDirectory: path.join(root, 'work') });
  prober = new MediaProber({ runtime });
  ffmpegPath = (await runtime.acquire()).ffmpeg;
  await writeFile(path.join(root, 'signs.srt'), '1\n00:00:00,200 --> 00:00:00,900\nSign one\n\n2\n00:00:01,100 --> 00:00:01,800\nSign two\n');
  await writeFile(path.join(root, 'metadata.txt'), ';FFMETADATA1\ntitle=Remux sample\nartist=FusionKit\ncomment=Planner check\n\n' +
    '[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Ending\n');
  await writeFile(path.join(root, 'notes.txt'), 'attached notes');
  sourcePath = path.join(root, 'source.mkv');
  await ffmpeg([...PREFIX, '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2:sample_rate=48000', '-i', path.join(root, 'signs.srt'), '-f', 'ffmetadata', '-i', path.join(root, 'metadata.txt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map_metadata', '4', '-map_chapters', '4',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'title=Main audio', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'title=Commentary', '-metadata:s:a:1', 'language=jpn',
    '-metadata:s:s:0', 'title=Signs', '-metadata:s:s:0', 'language=eng',
    '-disposition:a:0', 'default', '-disposition:a:1', 'comment', '-disposition:s:0', 'forced',
    '-attach', path.join(root, 'notes.txt'), '-metadata:s:t:0', 'mimetype=text/plain', '-metadata:s:t:0', 'filename=notes.txt',
    sourcePath]);
  source = await probed(sourcePath);
}, 120_000);
afterAll(async () => {
  prober?.dispose();
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

describe.skipIf(!available)('remuxing with the planner arguments and the real ffmpeg', () => {
  it('starts from the source the check describes', async () => {
    expect(source).toMatchObject({ kind: 'video', attachments: 1, chapters: 2, container: { identity: 'matroska', demuxer: 'matroska' } });
    expect(source.video[0]).toMatchObject({ codec: 'h264', default: false });
    expect(source.audio.map(stream => [stream.codec, stream.language, stream.title, stream.default])).toEqual([['aac', 'eng', 'Main audio', true], ['aac', 'jpn', 'Commentary', false]]);
    expect(source.subtitles.map(stream => [stream.codec, stream.language, stream.title, stream.default, stream.forced])).toEqual([['subrip', 'eng', 'Signs', false, true]]);
    const raw = await ffprobe(sourcePath);
    expect(userTags(raw.format.tags)).toEqual({ artist: 'FusionKit', comment: 'Planner check', title: 'Remux sample' });
    // The commentary flag is there to be kept: the comparisons below would otherwise pass on zeros.
    expect(ofType(raw, 'audio').map(flags)).toEqual([{ default: 1, forced: 0, comment: 0 }, { default: 0, forced: 0, comment: 1 }]);
    expect(chaptersOf(raw)).toEqual([{ start: 0, end: 1, title: 'Opening' }, { start: 1, end: 2, title: 'Ending' }]);
  });

  it('MKV to MP4 keeps metadata, chapters, languages, forced and default flags, and carries titles in handler_name', async () => {
    const plan = planOf(buildPlan(source, convertTo('mp4'), CAPS));
    expect(plan.isRemuxOnly).toBe(true);
    expect(plan.summary.warnings.map(item => item.code)).toEqual(['attachment_dropped', 'mp4_default_subtitle_forced']);
    const { file, args } = await run(plan, sourcePath, source, 'remux.mp4');
    // Explicit maps only: the video, both audio tracks and the subtitle by index; no `-map 0`, no attachments.
    expect(args.flatMap((arg, i) => arg === '-map' ? [args[i + 1]] : [])).toEqual(['0:0', '0:1', '0:2', '0:3']);
    const [before, after] = await Promise.all([ffprobe(sourcePath), ffprobe(file)]);

    expect(userTags(after.format.tags)).toEqual(userTags(before.format.tags));
    expect(chaptersOf(after)).toEqual(chaptersOf(before));
    expect(ofType(after, 'video').map(stream => stream.codec_name)).toEqual(['h264']);
    const audioBefore = ofType(before, 'audio'), audioAfter = ofType(after, 'audio');
    expect(audioAfter.map(stream => stream.codec_name)).toEqual(['aac', 'aac']);
    expect(audioAfter.map(stream => tag(stream.tags, 'language'))).toEqual(audioBefore.map(stream => tag(stream.tags, 'language')));
    expect(audioAfter.map(stream => tag(stream.tags, 'handler_name'))).toEqual(audioBefore.map(stream => tag(stream.tags, 'title')));
    expect(audioAfter.map(flags)).toEqual(audioBefore.map(flags));
    const subtitlesBefore = ofType(before, 'subtitle'), subtitlesAfter = ofType(after, 'subtitle');
    expect(subtitlesAfter.map(stream => stream.codec_name)).toEqual(['mov_text']);
    expect(subtitlesAfter.map(stream => tag(stream.tags, 'language'))).toEqual(subtitlesBefore.map(stream => tag(stream.tags, 'language')));
    expect(subtitlesAfter.map(stream => tag(stream.tags, 'handler_name'))).toEqual(['Signs']);
    expect(subtitlesAfter.map(stream => flags(stream).forced)).toEqual(subtitlesBefore.map(stream => flags(stream).forced));
    // The source has no default subtitle: MP4 enables the first one, which the summary says beforehand.
    expect(subtitlesBefore.map(stream => flags(stream).default)).toEqual([0]);
    expect(subtitlesAfter.map(stream => flags(stream).default)).toEqual([1]);
    // MP4 holds no attachments; its only data stream is the chapter text track it writes itself.
    expect(ofType(after, 'attachment')).toEqual([]);
    expect(ofType(after, 'data').map(stream => stream.codec_name)).toEqual(['bin_data']);
    expect(Math.abs(Number(after.format.duration) - Number(before.format.duration))).toBeLessThan(0.1);
  }, 60_000);

  it('MKV to MKV ("convert anyway" after already_target) keeps titles, flags, chapters, metadata and the attachment', async () => {
    const outcome = buildPlan(source, convertTo('mkv'), CAPS);
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'already_target' });
    const plan = planOf(outcome);
    expect(plan.summary.warnings).toEqual([]);
    const { file } = await run(plan, sourcePath, source, 'remux.mkv');
    const [before, after] = await Promise.all([ffprobe(sourcePath), ffprobe(file)]);

    expect(userTags(after.format.tags)).toEqual(userTags(before.format.tags));
    expect(chaptersOf(after)).toEqual(chaptersOf(before));
    for (const type of ['audio', 'subtitle']) {
      const was = ofType(before, type), now = ofType(after, type);
      expect(now.map(stream => stream.codec_name)).toEqual(was.map(stream => stream.codec_name));
      expect(now.map(stream => [tag(stream.tags, 'language'), tag(stream.tags, 'title'), flags(stream)]))
        .toEqual(was.map(stream => [tag(stream.tags, 'language'), tag(stream.tags, 'title'), flags(stream)]));
    }
    expect(ofType(after, 'attachment').map(stream => [tag(stream.tags, 'filename'), tag(stream.tags, 'mimetype')])).toEqual([['notes.txt', 'text/plain']]);
    expect(ofType(after, 'data')).toEqual([]);
    expect(Math.abs(Number(after.format.duration) - Number(before.format.duration))).toBeLessThan(0.1);
  }, 60_000);

  it('MP4 back to MKV turns mov_text into SRT and keeps the flags, without the chapter text track', async () => {
    const { file: mp4 } = await run(planOf(buildPlan(source, convertTo('mp4'), CAPS)), sourcePath, source, 'round.mp4');
    const fromMp4 = await probed(mp4);
    expect(fromMp4).toMatchObject({ dataStreams: 1, container: { identity: 'mp4' } });
    const plan = planOf(buildPlan(fromMp4, convertTo('mkv'), CAPS));
    expect(plan.isRemuxOnly).toBe(true);
    expect(plan.outputs[0].streams.filter(decision => decision.action === 'encode').map(decision => decision.action === 'encode' && decision.encode.encoder)).toEqual(['srt']);
    const { file } = await run(plan, mp4, fromMp4, 'round.mkv');
    const [before, after] = await Promise.all([ffprobe(mp4), ffprobe(file)]);
    expect(ofType(after, 'subtitle').map(stream => [stream.codec_name, tag(stream.tags, 'language'), flags(stream)]))
      .toEqual([['subrip', 'eng', { default: 1, forced: 1, comment: 0 }]]);
    expect(ofType(after, 'audio').map(stream => [tag(stream.tags, 'language'), flags(stream)])).toEqual(ofType(before, 'audio').map(stream => [tag(stream.tags, 'language'), flags(stream)]));
    expect(chaptersOf(after)).toEqual(chaptersOf(before));
    expect(userTags(after.format.tags)).toMatchObject({ title: 'Remux sample', artist: 'FusionKit', comment: 'Planner check' });
    expect(ofType(after, 'data')).toEqual([]);
  }, 60_000);

  it('MP4 enables the first audio track when the source marks none default, as the summary says beforehand', async () => {
    const plain = path.join(root, 'no-default.mkv');
    await ffmpeg([...PREFIX, '-y', '-f', 'matroska', '-protocol_whitelist', 'file', '-i', `file:${sourcePath}`, '-map', '0', '-c', 'copy', '-disposition:a:0', '0', plain]);
    const info = await probed(plain);
    expect(info.audio.map(stream => stream.default)).toEqual([false, false]);
    const plan = planOf(buildPlan(info, convertTo('mp4'), CAPS));
    expect(plan.summary.warnings.find(item => item.code === 'mp4_default_audio_forced')).toEqual({ code: 'mp4_default_audio_forced', streams: [1], count: 1 });
    const { file } = await run(plan, plain, info, 'no-default.mp4');
    const after = await ffprobe(file);
    expect(ofType(after, 'audio').map(flags)).toEqual([{ default: 1, forced: 0, comment: 0 }, { default: 0, forced: 0, comment: 1 }]);
  }, 60_000);
});
