import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { MediaRuntime, type MediaTools } from '../../electron/main/media-converter/engine/runtime';
import { MediaProber } from '../../electron/main/media-converter/engine/probe';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import { toFfmpegArgs } from '../../electron/main/media-converter/plan/args';
import type { ConversionPlan, PlannedOutput, PlannerCapabilities } from '../../electron/main/media-converter/plan/types';
import { defaultCompressSettings, type ConversionSettings, type MediaInfo } from '../../src/media-converter/contract';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * V-ENCODE-04-2: the planner's audio arguments run by the real bundled ffmpeg on 2 s lavfi sources.
 * - A FLAC (sine, title/artist/album tags, a PNG cover, two chapters as Vorbis CHAPTER comments)
 *   converted to MP3 (ID3v2.3, APIC, CHAP chapters, the tags), M4A (tags and cover) and Opus (tags
 *   and chapters; the plan says the cover is dropped).
 * - The M4A, which has MP4 brand tags, converted to MP3, FLAC and Opus: none of them carries
 *   `major_brand`, `minor_version` or `compatible_brands`, nor the MP4 track handler in Opus.
 * - "Extract audio" as it is: AAC out of an MKV is copied into .m4a, 24-bit big-endian PCM out of
 *   a MOV into .aiff, packet for packet (the same MD5 of every packet).
 * - Channel layouts: 5.1(side) and 2.1 (and 5.0(side), 7.1(wide), 10 channels, an unspecified
 *   layout) into Opus; 5.1(side) into AAC with the standard channel configuration instead of a
 *   PCE; 7.1 into ALAC keeping 8 channels; 5.1(side) mixed down into MP3. 96 kHz 24-bit audio into
 *   AAC at 48 kHz, ALAC and WAV at 24 bits; floating point into FLAC at 24 bits without a warning.
 * - ALAC of layouts it does not take (batch B): quad, 2.1 and 7.1, each channel a sine of its own
 *   frequency, remixed by position; decoded back, every source channel is found in the output
 *   channel of its position (quad's back pair at the back, never on the centre; 2.1's LFE kept;
 *   7.1's side pair mixed into the back pair, the front-of-centre pair silent).
 * - The same codec at a lower target rate (batch B, AC-ENCODE-04-5): a 320 kbit/s MP3 to standard
 *   MP3 is re-encoded and smaller, a 96 kbit/s one is already the target; Opus in Ogg, which states
 *   no stream rate, is judged by the file's total rate.
 * - What Matroska refuses as it is: big-endian float PCM of a MOV re-encoded when converted to MKV,
 *   SMPTE 302M PCM of an MPEG-TS extracted losslessly into WAV.
 * - A video with a 5.1(side) AC-3 and a 96 kHz FLAC track compressed to MKV (Opus) and MP4 (AAC): both
 *   tracks re-encoded, each with its own `-filter:a:<n>`, channels and rates as designed.
 * Every log is `level+warning` and is checked for silent substitutions. Every ffmpeg runs at idle
 * priority with the runtime's reduced environment, in a run folder under test-results/media-converter
 * removed afterwards; ffprobe runs through the verified runtime, below normal. Skipped when the
 * runtime is not staged.
 */

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
const LIMITS = { timeoutMs: 30_000, stdoutMaxBytes: 4 * 1024 * 1024, stderrMaxBytes: 1024 * 1024 };
const FFMPEG_DEADLINE_MS = 60_000;
const CAPS: PlannerCapabilities = { encoders: {}, degraded: [], nvencMin: { width: 144, height: 120 } };
/** What the engine's process wrapper puts in front (without the progress pipe, which nothing reads here). */
const PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning'];
/** Warnings that mean ffmpeg silently did something other than asked (module-encode tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;
/** What the audio arguments must never cause: a depth ffmpeg picked itself, a layout an encoder refused. */
const AUDIO_WARNINGS = /encoding as 24 bits-per-sample|Invalid channel layout|Unsupported channel layout|not supported by Opus/i;
const BRAND_TAGS = ['major_brand', 'minor_version', 'compatible_brands'];

let root: string, runtime: MediaRuntime, prober: MediaProber, tools: MediaTools;
const report: string[] = [];

type Run = { code: number | null; stdout: string; stderr: string };
/** The bundled ffmpeg at idle priority with the runtime's environment, settled by our own deadline (FK-PIT-0036). */
function ffmpeg(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    // The app augments ProcessEnv with main-process fields; the runtime's reduced environment has none of them (as engine/process.ts).
    const child = spawn(tools.ffmpeg, [...PREFIX, ...args], { cwd: root, env: { ...tools.environment } as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ffmpeg did not finish in ${FFMPEG_DEADLINE_MS} ms: ${stderr}`)); }, FFMPEG_DEADLINE_MS);
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function generate(name: string, args: string[]): Promise<{ path: string; info: MediaInfo }> {
  const file = path.join(root, name);
  const run = await ffmpeg(['-y', ...args, file]);
  if (run.code !== 0) throw new Error(`source ${name}: ${run.stderr}`);
  return { path: file, info: await probed(file) };
}
async function probed(file: string): Promise<MediaInfo> {
  const outcome = await prober.probe(file);
  if (!outcome.ok) throw new Error(`${path.basename(file)}: ${outcome.code}`);
  return outcome.info;
}

type Stream = {
  index: number; codec_type: string; codec_name: string; channels?: number; channel_layout?: string; sample_rate?: string; sample_fmt?: string;
  bits_per_raw_sample?: string; extradata?: string; disposition?: Record<string, number>; tags?: Record<string, string>; duration?: string;
};
type Probed = { format: { duration?: string; tags?: Record<string, string> }; streams: Stream[]; chapters: { start_time: string; tags?: Record<string, string> }[] };
async function ffprobe(file: string, extra: string[] = []): Promise<Probed> {
  const result = await runtime.run('ffprobe', ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-show_chapters', ...extra, '-of', 'json', `file:${file}`], LIMITS);
  expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
  return JSON.parse(result.stdout.toString('utf8'));
}
/** Tag names are compared without case (Vorbis comments are upper case, ID3 and MP4 lower case). */
const lowerTags = (tags: Record<string, string> | undefined) => Object.fromEntries(Object.entries(tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
/** Every tag of the file: the container's and every stream's (Ogg keeps its comments on the stream). */
const allTags = (value: Probed) => ({ ...lowerTags(value.format.tags), ...Object.assign({}, ...value.streams.map(stream => lowerTags(stream.tags))) }) as Record<string, string>;
const ofType = (value: Probed, type: string) => value.streams.filter(stream => stream.codec_type === type);
const chapterTitles = (value: Probed) => value.chapters.map(chapter => [Number(Number(chapter.start_time).toFixed(2)), lowerTags(chapter.tags).title]);
/** The MD5 of every packet of the first audio stream, as `-c copy` hands them on. */
async function packetHash(file: string): Promise<string> {
  const run = await ffmpeg(['-i', `file:${file}`, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-']);
  expect(run.code, run.stderr).toBe(0);
  return run.stdout.trim();
}
/** AudioSpecificConfig's channelConfiguration: 0 means the layout is in a PCE, which many players ignore. */
function aacChannelConfiguration(stream: Stream): number {
  const bytes = Buffer.from((stream.extradata ?? '').split('\n').map(line => line.slice(10, 50)).join('').replace(/\s/g, ''), 'hex');
  return (bytes[1] >> 3) & 0x0f;
}

function planOf(source: MediaInfo, settings: ConversionSettings): ConversionPlan {
  const outcome = buildPlan(source, settings, CAPS);
  if (outcome.status !== 'ready' && outcome.status !== 'skipped') throw new Error(`no plan: ${outcome.status} ${outcome.reason}`);
  return outcome.plan;
}
/** Runs one planned output with exactly the planner's arguments; the log must have no silent substitution. */
async function run(output: PlannedOutput, source: { path: string; info: MediaInfo }, name: string) {
  const file = path.join(root, `${name}.${output.container.extension}`);
  const args = toFfmpegArgs(output, { inputPath: source.path, demuxer: source.info.container.demuxer, partialPath: file });
  const result = await ffmpeg(args);
  if (result.code !== 0) throw new Error(`${name} failed (${result.code}): ${result.stderr}\n${args.join(' ')}`);
  expect(result.stderr, `${name} log`).not.toMatch(SILENT_SUBSTITUTION);
  expect(result.stderr, `${name} log`).not.toMatch(AUDIO_WARNINGS);
  const warnings = result.stderr.split(/\r?\n/).filter(line => /\[(?:warning|error)\]/.test(line));
  if (warnings.length) report.push(`  ${name} log: ${warnings.join(' | ')}`);
  return { file, args, probe: await ffprobe(file, ['-show_data']) };
}
const convertTo = (target: Extract<ConversionSettings, { task: 'convert' }>['target']): ConversionSettings => ({ task: 'convert', target, preferRemux: true, tier: 'balanced' });
const extractCopy: ConversionSettings = { task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: false };
const tone = (channels: number, rate = 48_000) => `aevalsrc=exprs=${Array.from({ length: channels }, (_, i) => `0.2*sin(${220 + 110 * i}*2*PI*t)`).join('|')}:sample_rate=${rate}:duration=2`;
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/** The frequency of channel `i` of `tone()`. */
const toneFrequency = (i: number) => 220 + 110 * i;
/**
 * Each channel's amplitude at each frequency (Goertzel over the decoded 32-bit float samples, in a
 * file of the run folder): `amplitudes[channel][frequency]`, 0.2 for a tone of `tone()` kept whole.
 */
async function channelAmplitudes(file: string, channels: number, frequencies: readonly number[], rate = 48_000): Promise<number[][]> {
  const raw = `${file}.f32`;
  const decoded = await ffmpeg(['-y', '-i', `file:${file}`, '-c:a', 'pcm_f32le', '-f', 'f32le', raw]);
  expect(decoded.code, decoded.stderr).toBe(0);
  const bytes = await readFile(raw);
  const frames = bytes.length / 4 / channels;
  return Array.from({ length: channels }, (_, channel) => frequencies.map(frequency => {
    const k = 2 * Math.cos(2 * Math.PI * frequency / rate);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < frames; i++) { const s0 = bytes.readFloatLE((i * channels + channel) * 4) + k * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2 / frames;
  }));
}

let flac: { path: string; info: MediaInfo };

beforeAll(async () => {
  if (!available) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'encode-audio-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'encode-audio-')));
  runtime = new MediaRuntime({ environment, workingDirectory: path.join(root, 'work') });
  prober = new MediaProber({ runtime });
  tools = await runtime.acquire();
  // FLAC keeps chapters as Vorbis CHAPTER comments, which the FLAC demuxer reads back as chapters.
  await writeFile(path.join(root, 'tags.txt'), ';FFMETADATA1\ntitle=Sine Song\nartist=FusionKit Band\nalbum=Planner Album\n' +
    'CHAPTER001=00:00:00.000\nCHAPTER001NAME=Opening\nCHAPTER002=00:00:01.000\nCHAPTER002NAME=Ending\n');
  const coverRun = await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-update', '1', '-c:v', 'png', path.join(root, 'cover.png')]);
  if (coverRun.code !== 0) throw new Error(coverRun.stderr);
  flac = await generate('source.flac', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-i', path.join(root, 'cover.png'), '-f', 'ffmetadata', '-i', path.join(root, 'tags.txt'),
    '-map', '0:a', '-map', '1:v', '-map_metadata', '2', '-ac', '2', '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)',
  ]);
}, 120_000);
afterAll(async () => {
  if (report.length) console.log(['V-ENCODE-04-2 results', ...report].join('\n'));
  prober?.dispose();
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

describe.skipIf(!available)('audio with the planner arguments and the real ffmpeg', () => {
  let m4a: { path: string; info: MediaInfo };

  it('starts from a tagged FLAC with a PNG cover and two chapters', async () => {
    expect(flac.info).toMatchObject({ kind: 'audio', chapters: 2, container: { identity: 'flac' } });
    expect(flac.info.audio[0]).toMatchObject({ codec: 'flac', channels: 2, sampleRate: 44_100 });
    expect(flac.info.covers.map(item => item.codec)).toEqual(['png']);
    const raw = await ffprobe(flac.path);
    expect(allTags(raw)).toMatchObject({ title: 'Sine Song', artist: 'FusionKit Band', album: 'Planner Album' });
    expect(chapterTitles(raw)).toEqual([[0, 'Opening'], [1, 'Ending']]);
  });

  it('FLAC to MP3: ID3v2.3 with the tags, the cover as APIC and the chapters', async () => {
    const plan = planOf(flac.info, convertTo('mp3'));
    expect(plan.summary.warnings).toEqual([]);
    const { file, probe } = await run(plan.outputs[0], flac, 'to-mp3');
    const bytes = await readFile(file);
    expect([bytes.toString('latin1', 0, 3), bytes[3]]).toEqual(['ID3', 3]);
    expect(bytes.includes(Buffer.from('APIC'))).toBe(true);
    expect(bytes.includes(Buffer.from('CHAP'))).toBe(true);
    expect(allTags(probe)).toMatchObject({ title: 'Sine Song', artist: 'FusionKit Band', album: 'Planner Album' });
    expect(ofType(probe, 'audio').map(stream => [stream.codec_name, stream.channels, stream.sample_rate])).toEqual([['mp3', 2, '44100']]);
    expect(ofType(probe, 'video').map(stream => [stream.codec_name, stream.disposition?.attached_pic])).toEqual([['png', 1]]);
    expect(chapterTitles(probe)).toEqual([[0, 'Opening'], [1, 'Ending']]);
    report.push(`FLAC → MP3: ID3v2.${bytes[3]}, APIC, ${probe.chapters.length} chapters`);
  });

  it('FLAC to M4A: the tags and the cover', async () => {
    const plan = planOf(flac.info, convertTo('m4a'));
    expect(plan.summary.warnings).toEqual([]);
    const { file, probe } = await run(plan.outputs[0], flac, 'to-m4a');
    expect(allTags(probe)).toMatchObject({ title: 'Sine Song', artist: 'FusionKit Band', album: 'Planner Album' });
    expect(ofType(probe, 'audio').map(stream => [stream.codec_name, stream.channels])).toEqual([['aac', 2]]);
    expect(ofType(probe, 'video').map(stream => [stream.codec_name, stream.disposition?.attached_pic])).toEqual([['png', 1]]);
    m4a = { path: file, info: await probed(file) };
    expect(m4a.info).toMatchObject({ container: { identity: 'm4a' } });
    expect(m4a.info.covers).toHaveLength(1);
  });

  it('FLAC to Opus: the tags and the chapters, with the cover dropped as the plan says', async () => {
    const plan = planOf(flac.info, convertTo('opus'));
    expect(plan.summary.warnings).toEqual([{ code: 'cover_dropped', streams: [1], count: 1 }]);
    const { args, probe } = await run(plan.outputs[0], flac, 'to-opus');
    expect(valueAfter(args, '-filter:a:0')).toBe('aresample=48000');
    expect(allTags(probe)).toMatchObject({ title: 'Sine Song', artist: 'FusionKit Band', album: 'Planner Album' });
    expect(chapterTitles(probe)).toEqual([[0, 'Opening'], [1, 'Ending']]);
    expect(probe.streams.map(stream => [stream.codec_type, stream.codec_name, stream.sample_rate])).toEqual([['audio', 'opus', '48000']]);
  });

  it('M4A to MP3, FLAC and Opus: no brand tags of the source container, the user tags kept', async () => {
    expect(m4a, 'the M4A of the test above').toBeDefined();
    const before = allTags(await ffprobe(m4a.path));
    // The check would pass on a source without them.
    for (const name of BRAND_TAGS) expect(before[name], name).toBeTruthy();
    expect(before.handler_name).toBeTruthy();
    for (const target of ['mp3', 'flac', 'opus'] as const) {
      const plan = planOf(m4a.info, convertTo(target));
      if (target === 'flac') expect(plan.summary.confirmations).toEqual(['lossy_to_lossless']);
      const { probe } = await run(plan.outputs[0], m4a, `brand-${target}`);
      const after = allTags(probe);
      for (const name of BRAND_TAGS) expect(after[name], `${target} ${name}`).toBeUndefined();
      expect(after, target).toMatchObject({ title: 'Sine Song', artist: 'FusionKit Band', album: 'Planner Album' });
      // The cover goes on into MP3 and FLAC (AC-ENCODE-04-3); Opus drops it and says so.
      expect(ofType(probe, 'video').map(stream => [stream.codec_name, stream.disposition?.attached_pic]), `${target} cover`).toEqual(target === 'opus' ? [] : [['png', 1]]);
      expect(plan.summary.warnings.some(item => item.code === 'cover_dropped'), `${target} cover_dropped`).toBe(target === 'opus');
      if (target === 'opus') expect(after.handler_name).toBeUndefined();
      report.push(`M4A → ${target}: tags ${Object.keys(after).sort().join(',')}`);
    }
  });

  it('extracts AAC out of an MKV as it is, into .m4a', async () => {
    const source = await generate('aac-film.mkv', [
      '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', tone(2), '-c:v', 'ffv1', '-c:a', 'aac', '-b:a', '128k', '-f', 'matroska',
    ]);
    const plan = planOf(source.info, extractCopy);
    expect(plan.isRemuxOnly).toBe(true);
    expect(plan.outputs[0].container.id).toBe('m4a');
    const { file, probe } = await run(plan.outputs[0], source, 'extract-aac');
    expect(path.extname(file)).toBe('.m4a');
    expect(probe.streams.map(stream => stream.codec_name)).toEqual(['aac']);
    expect(await packetHash(file)).toBe(await packetHash(source.path));
  });

  it('extracts 24-bit big-endian PCM out of a MOV as it is, into .aiff', async () => {
    const source = await generate('pcm-film.mov', [
      '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', tone(2), '-c:v', 'mjpeg', '-c:a', 'pcm_s24be', '-f', 'mov',
    ]);
    expect(source.info.audio[0].codec).toBe('pcm_s24be');
    const plan = planOf(source.info, extractCopy);
    expect(plan.outputs[0].container.id).toBe('aiff');
    expect(plan.outputs[0].streams.find(decision => decision.source.kind === 'audio')?.action).toBe('copy');
    const { file, probe } = await run(plan.outputs[0], source, 'extract-pcm');
    expect(path.extname(file)).toBe('.aiff');
    expect(probe.streams.map(stream => [stream.codec_name, stream.bits_per_raw_sample])).toEqual([['pcm_s24be', '24']]);
    expect(await packetHash(file)).toBe(await packetHash(source.path));
  });

  it.each([
    ['5.1(side)', 6, 6, '5.1'], ['2.1', 3, 3, '3.0'], ['5.0(side)', 5, 5, '5.0'], ['7.1(wide)', 8, 8, '7.1'], ['5.1.4', 10, 8, '7.1'], ['4.0', 4, 4, 'quad'],
  ] as const)('converts %s audio to Opus', async (layout, channels, outChannels, outLayout) => {
    const source = await generate(`layout-${channels}-${layout.replace(/\W/g, '_')}.wav`, ['-f', 'lavfi', '-i', `${tone(channels)}:channel_layout=${layout}`, '-c:a', 'pcm_s16le']);
    expect(source.info.audio[0]).toMatchObject({ channels, channelLayout: layout });
    const { args, probe } = await run(planOf(source.info, convertTo('opus')).outputs[0], source, `opus-${layout.replace(/\W/g, '_')}`);
    const [stream] = ofType(probe, 'audio');
    expect([stream.codec_name, stream.channels, stream.channel_layout, stream.sample_rate]).toEqual(['opus', outChannels, outLayout, '48000']);
    expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(0.05);
    report.push(`${layout} → Opus ${stream.channel_layout} with ${valueAfter(args, '-filter:a:0') ?? 'no filter'}`);
  });

  it('converts audio of an unspecified layout to Opus', async () => {
    await writeFile(path.join(root, 'six.raw'), Buffer.alloc(48_000 * 6 * 2 * 2));
    const source = await generate('unspecified.wav', ['-f', 's16le', '-ar', '48000', '-ch_layout', '6C', '-i', path.join(root, 'six.raw'), '-c:a', 'pcm_s16le']);
    // A WAV without a channel mask: the probe reports no layout.
    expect(source.info.audio[0]).toMatchObject({ channels: 6, channelLayout: null });
    const { probe } = await run(planOf(source.info, convertTo('opus')).outputs[0], source, 'opus-unspecified');
    expect(ofType(probe, 'audio').map(stream => [stream.channels, stream.channel_layout])).toEqual([[6, '5.1']]);
  });

  it('writes 5.1(side) into AAC with the standard channel configuration, 7.1 into ALAC with 8 channels, 5.1(side) into stereo MP3', async () => {
    const side = await generate('side.wav', ['-f', 'lavfi', '-i', `${tone(6)}:channel_layout=5.1(side)`, '-c:a', 'pcm_s16le']);
    const aac = await run(planOf(side.info, convertTo('m4a')).outputs[0], side, 'aac-side');
    const [aacStream] = ofType(aac.probe, 'audio');
    expect([aacStream.channels, aacStream.channel_layout, aacChannelConfiguration(aacStream)]).toEqual([6, '5.1', 6]);

    const wide = await generate('seven.wav', ['-f', 'lavfi', '-i', `${tone(8)}:channel_layout=7.1`, '-c:a', 'pcm_s16le']);
    const alac = await run(planOf(wide.info, convertTo('alac')).outputs[0], wide, 'alac-7_1');
    expect(ofType(alac.probe, 'audio').map(stream => [stream.codec_name, stream.channels, stream.channel_layout])).toEqual([['alac', 8, '7.1(wide)']]);

    const mp3Plan = planOf(side.info, convertTo('mp3'));
    expect(mp3Plan.summary.warnings).toEqual([{ code: 'downmixed_to_stereo', streams: [0], count: 1 }]);
    const mp3 = await run(mp3Plan.outputs[0], side, 'mp3-side');
    expect(ofType(mp3.probe, 'audio').map(stream => [stream.channels, stream.channel_layout])).toEqual([[2, 'stereo']]);
  });

  it.each([
    // Source layout, its channels, the ALAC layout, the output channels in order, where each source channel must be found.
    ['quad', 'quad', 4, '5.0', ['FL', 'FR', 'FC', 'BL', 'BR'], ['FL', 'FR', 'BL', 'BR']],
    ['2_1', '2.1', 3, '5.1', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], ['FL', 'FR', 'LFE']],
    ['7_1', '7.1', 8, '7.1(wide)', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'], ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BL', 'BR']],
  ] as const)('remixes %s into ALAC by position: each channel lands in its place, never on the centre (design §7b)', async (name, layout, channels, outLayout, outChannels, placed) => {
    // Every source channel a sine of its own frequency (FL 220 Hz, FR 330 Hz, then 440, 550...).
    const source = await generate(`alac-${name}.wav`, ['-f', 'lavfi', '-i', `${tone(channels)}:channel_layout=${layout}`, '-c:a', 'pcm_s16le']);
    expect(source.info.audio[0]).toMatchObject({ channels, channelLayout: layout });
    const { args, file, probe } = await run(planOf(source.info, convertTo('alac')).outputs[0], source, `alac-${name}`);
    expect(valueAfter(args, '-filter:a:0')).toBe(`aformat=channel_layouts=${outLayout}`);
    expect(ofType(probe, 'audio').map(stream => [stream.codec_name, stream.channels, stream.channel_layout])).toEqual([['alac', outChannels.length, outLayout]]);
    const frequencies = Array.from({ length: channels }, (_, i) => toneFrequency(i));
    const amplitudes = await channelAmplitudes(file, outChannels.length, frequencies);
    const found: string[] = [];
    for (const [i, position] of placed.entries()) {
      const loudest = amplitudes.map(row => row[i]).reduce((best, value, channel, all) => value > all[best] ? channel : best, 0);
      expect(outChannels[loudest], `${frequencies[i]} Hz (source ${i})`).toBe(position);
      found.push(`${frequencies[i]} Hz → ${outChannels[loudest]} ${amplitudes[loudest][i].toFixed(3)}`);
      // Nothing of it anywhere else.
      for (const [channel, row] of amplitudes.entries()) if (channel !== loudest) expect(row[i], `${frequencies[i]} Hz in ${outChannels[channel]}`).toBeLessThan(0.002);
      // Where every channel has a place of its own, it arrives whole (nothing mixed, no level change).
      if (layout !== '7.1') expect(amplitudes[loudest][i]).toBeCloseTo(0.2, 2);
    }
    // The places nothing goes to are silent: quad's centre, 2.1's centre and back pair, 7.1's front-of-centre pair.
    const order: readonly string[] = outChannels;
    const empty = order.filter(position => !(placed as readonly string[]).includes(position));
    for (const position of empty) expect(Math.max(...amplitudes[order.indexOf(position)]), `${position} is silent`).toBeLessThan(0.002);
    report.push(`${layout} → ALAC ${outLayout}: ${found.join(', ')}; silent ${empty.join(',') || 'none'}`);
  }, 60_000);

  it('re-encodes a 320 kbit/s MP3 to standard MP3, smaller, and takes a 96 kbit/s one as already the target (AC-ENCODE-04-5)', async () => {
    const mp3At = (rate: string) => generate(`mp3-${rate}.mp3`, ['-f', 'lavfi', '-i', tone(2), '-c:a', 'libmp3lame', '-b:a', rate]);
    const loud = await mp3At('320k');
    expect(loud.info.audio[0]).toMatchObject({ codec: 'mp3', bitRate: 320_000, bitRateSource: 'stream' });
    const plan = planOf(loud.info, convertTo('mp3'));
    expect(plan.outputs[0].streams.map(decision => decision.action === 'encode' ? decision.encode.encoder : decision.action)).toEqual(['libmp3lame']);
    expect(plan.isRemuxOnly).toBe(false);
    const { file, probe } = await run(plan.outputs[0], loud, 'mp3-shrunk');
    const [before, after] = [(await stat(loud.path)).size, (await stat(file)).size];
    expect(after).toBeLessThan(before);
    expect(ofType(probe, 'audio').map(stream => stream.codec_name)).toEqual(['mp3']);
    const quiet = await mp3At('96k');
    expect(buildPlan(quiet.info, convertTo('mp3'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    // Opus in Ogg states no stream rate (real ffprobe): the file's total rate stands for it.
    const opusAt = (rate: string) => generate(`cbr-${rate}.opus`, ['-f', 'lavfi', '-i', tone(2), '-c:a', 'libopus', '-b:a', rate, '-vbr', 'off']);
    const rich = await opusAt('192k');
    expect(rich.info.audio[0]).toMatchObject({ codec: 'opus', bitRate: null });
    expect(rich.info.bitRate).toBeGreaterThan(128_000);
    expect(planOf(rich.info, convertTo('opus')).outputs[0].streams.map(decision => decision.action)).toEqual(['encode']);
    const lean = await opusAt('96k');
    expect(lean.info.bitRate).toBeLessThan(128_000);
    expect(buildPlan(lean.info, convertTo('opus'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    report.push(`same codec: MP3 320k ${before} B → standard ${after} B; MP3 96k already the target; Opus total ${rich.info.bitRate} → re-encoded, ${lean.info.bitRate} → already the target`);
  }, 60_000);

  it('takes a file made at a tier\'s own rate as already the target when converted at that tier again, though its measured rate reads higher', async () => {
    // A measured rate reads above the rate the file was made at: Ogg pages count in the total of CBR Opus, and
    // ffmpeg's AAC on noise overshoots a little. Without the 5 % margin both would be re-encoded at the same rate.
    const opus = await generate('tier-opus-128k.opus', ['-f', 'lavfi', '-i', tone(2), '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'off']);
    expect(opus.info.audio[0].bitRate).toBeNull();
    expect(opus.info.bitRate!).toBeGreaterThan(128_000);
    expect(buildPlan(opus.info, convertTo('opus'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    const noise = 'anoisesrc=d=2:c=white:r=48000:a=0.3:seed=7,aformat=channel_layouts=stereo';
    const aac = await generate('tier-aac-256k.m4a', ['-f', 'lavfi', '-i', noise, '-c:a', 'aac', '-b:a', '256k']);
    expect(aac.info.audio[0]).toMatchObject({ codec: 'aac', bitRateSource: 'stream' });
    expect(aac.info.audio[0].bitRate!).toBeGreaterThan(256_000);
    expect(buildPlan(aac.info, { ...convertTo('m4a'), tier: 'quality' }, CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    // One tier down it still shrinks: 192k is below 256k by far more than the margin.
    expect(planOf(aac.info, convertTo('m4a')).outputs[0].streams.map(decision => decision.action === 'encode' ? decision.encode.encoder : decision.action)).toEqual(['aac']);
    report.push(`same codec at its own tier: CBR Opus 128k total ${opus.info.bitRate} bit/s and AAC 256k ${aac.info.audio[0].bitRate} bit/s → already the target`);
  }, 60_000);

  it('brings 96 kHz down to 48 kHz for AAC, and keeps 96 kHz and 24 bits in ALAC, WAV and FLAC (from floating point too)', async () => {
    const hiRes = await generate('hires.flac', ['-f', 'lavfi', '-i', tone(2, 96_000), '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24']);
    expect(hiRes.info.audio[0]).toMatchObject({ sampleRate: 96_000, bitsPerRawSample: 24 });
    const aac = await run(planOf(hiRes.info, convertTo('m4a')).outputs[0], hiRes, 'hires-aac');
    expect(ofType(aac.probe, 'audio').map(stream => stream.sample_rate)).toEqual(['48000']);
    const alac = await run(planOf(hiRes.info, convertTo('alac')).outputs[0], hiRes, 'hires-alac');
    expect(ofType(alac.probe, 'audio').map(stream => [stream.sample_rate, stream.bits_per_raw_sample])).toEqual([['96000', '24']]);
    const wav = await run(planOf(hiRes.info, convertTo('wav')).outputs[0], hiRes, 'hires-wav');
    expect(ofType(wav.probe, 'audio').map(stream => [stream.codec_name, stream.sample_rate])).toEqual([['pcm_s24le', '96000']]);
    const float = await generate('float.wav', ['-f', 'lavfi', '-i', tone(2), '-c:a', 'pcm_f32le']);
    const toFlac = await run(planOf(float.info, convertTo('flac')).outputs[0], float, 'float-flac');
    expect(ofType(toFlac.probe, 'audio').map(stream => [stream.codec_name, stream.bits_per_raw_sample])).toEqual([['flac', '24']]);
  });

  it('converts a MOV with big-endian float PCM to MKV and extracts SMPTE 302M PCM, both of which Matroska refuses as they are', async () => {
    const mov = await generate('float-be.mov', [
      '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', tone(2), '-c:v', 'mjpeg', '-c:a', 'pcm_f32be', '-f', 'mov',
    ]);
    expect(mov.info.audio[0].codec).toBe('pcm_f32be');
    const toMkv = planOf(mov.info, convertTo('mkv'));
    expect(toMkv.outputs[0].streams.map(decision => decision.action === 'encode' ? decision.encode.encoder : decision.action)).toEqual(['copy', 'libopus']);
    const mkv = await run(toMkv.outputs[0], mov, 'float-be-mkv');
    expect(mkv.probe.streams.map(stream => stream.codec_name)).toEqual(['mjpeg', 'opus']);

    const ts = await generate('s302m.ts', [
      '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', tone(2), '-c:v', 'mpeg2video', '-c:a', 's302m', '-strict', '-2', '-f', 'mpegts',
    ]);
    expect(ts.info.audio.map(stream => [stream.codec, stream.bitsPerRawSample])).toEqual([['s302m', 24]]);
    const extracted = planOf(ts.info, extractCopy);
    expect([extracted.outputs[0].container.id, extracted.summary.confirmations]).toEqual(['wav', []]);
    const wav = await run(extracted.outputs[0], ts, 'extract-s302m');
    expect(ofType(wav.probe, 'audio').map(stream => [stream.codec_name, stream.channels, stream.sample_rate])).toEqual([['pcm_s24le', 2, '48000']]);
    report.push('pcm_f32be MOV → MKV: mjpeg copy + opus; s302m TS → extract: pcm_s24le .wav');
  });

  describe('a video with a 5.1(side) AC-3 track and a stereo FLAC track', () => {
    let film: { path: string; info: MediaInfo };
    beforeAll(async () => {
      if (!available) return;
      film = await generate('two-tracks.mkv', [
        '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', `${tone(6, 44_100)}:channel_layout=5.1(side)`, '-f', 'lavfi', '-i', tone(2, 96_000),
        // AC-3 5.1 decodes as 5.1(side), as from most films; Matroska PCM would carry no layout at all.
        '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'ffv1', '-c:a:0', 'ac3', '-b:a:0', '448k', '-c:a:1', 'flac', '-disposition:a:0', 'default',
        '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn', '-f', 'matroska',
      ]);
    }, 60_000);

    it.each([
      ['MKV', 'mkv', 'opus', /^channelmap=map=.+:channel_layout=5\.1,aresample=48000$/, /^aresample=48000$/],
      ['MP4', 'mp4', 'aac', /^channelmap=map=.+:channel_layout=5\.1$/, /^aresample=resampler=soxr:precision=28:osr=48000$/],
    ] as const)('compresses to %s, re-encoding each track with its own filter chain', async (_name, container, codec, first, second) => {
      expect(film.info.audio.map(stream => [stream.codec, stream.channels, stream.channelLayout, stream.sampleRate]))
        .toEqual([['ac3', 6, '5.1(side)', 44_100], ['flac', 2, 'stereo', 96_000]]);
      // 448 kbit/s is above 1.25 × the 5.1 tier rate of either container, and FLAC is always re-encoded.
      expect(film.info.audio[0].bitRate).toBe(448_000);
      const plan = planOf(film.info, { ...defaultCompressSettings('h264'), container });
      const { args, probe } = await run(plan.outputs[0], film, `two-tracks-${container}`);
      expect(args).not.toContain('-af');
      expect(args.filter(arg => arg.startsWith('-filter:a'))).toEqual(['-filter:a:0', '-filter:a:1']);
      expect(valueAfter(args, '-filter:a:0')).toMatch(first);
      expect(valueAfter(args, '-filter:a:1')).toMatch(second);
      const tracks = ofType(probe, 'audio');
      expect(tracks.map(stream => [stream.codec_name, stream.channels, stream.channel_layout, stream.sample_rate, lowerTags(stream.tags).language]))
        .toEqual([[codec, 6, '5.1', container === 'mkv' ? '48000' : '44100', 'eng'], [codec, 2, 'stereo', '48000', 'jpn']]);
      expect(tracks.map(stream => stream.disposition?.default)).toEqual([1, 0]);
      if (codec === 'aac') expect(aacChannelConfiguration(tracks[0])).toBe(6);
      expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(0.1);
      report.push(`two tracks → ${container}: ${tracks.map(stream => `${stream.codec_name} ${stream.channel_layout} ${stream.sample_rate}`).join(' + ')}`);
    }, 60_000);
  });
});
