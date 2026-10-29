import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_SUBTITLE_MEDIA_POLICY } from '../../electron/main/subtitle-studio/transcription/native/media-normalizer';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { MediaRuntime, MediaRuntimeError, type MediaRuntimeOptions, type MediaSpawn } from '../../electron/main/media-converter/engine/runtime';
import { ALLOWED_DEMUXERS, MediaProber, probeArgs } from '../../electron/main/media-converter/engine/probe';
import type { MediaInfo } from '../../src/media-converter/contract';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * The real bundled runtime and the real ffprobe. Every tool runs below normal priority (the
 * runtime sets it) and every fixture is a lavfi sample of at most 1 s at 320×180 or smaller,
 * generated at idle priority in a run folder under test-results/media-converter. Skipped when the
 * runtime has not been staged (build/subtitle-studio-resources/transcription).
 */

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const STAGED = path.join(process.cwd(), 'build', 'subtitle-studio-resources', 'transcription');
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
const LIMITS = { timeoutMs: 30_000, stdoutMaxBytes: 4 * 1024 * 1024, stderrMaxBytes: 1024 * 1024 };

let root: string, work: string, media: string, ffmpeg: string;
const runtimeOf = (options: Partial<MediaRuntimeOptions> = {}) => new MediaRuntime({ environment, workingDirectory: work, ...options });
const nodeSpawn: MediaSpawn = (command, args, options) => spawn(command, [...args], options);

/** Warnings that mean ffmpeg silently did something other than asked (module-engine tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;

/** Runs the bundled ffmpeg at idle priority to make a fixture; a silent substitution fails it like an error. */
function make(output: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'level+warning', '-y', ...args, output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 && !SILENT_SUBSTITUTION.test(stderr) ? resolve(output) : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
  });
}
const ASS_HEADER = '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n\n[V4+ Styles]\n' +
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\n' +
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

/** A copy of the staged runtime's manifest and licences, with `executables` written in place of the real ones. */
async function mirror(name: string, executables: Record<string, Buffer>) {
  const appRoot = path.join(root, name);
  const runtimeRoot = path.join(appRoot, 'build', 'subtitle-studio-resources', 'transcription');
  for (const folder of ['manifests', 'licenses']) {
    await mkdir(path.join(runtimeRoot, folder), { recursive: true });
    for (const entry of await readdir(path.join(STAGED, folder))) await copyFile(path.join(STAGED, folder, entry), path.join(runtimeRoot, folder, entry));
  }
  for (const [relative, bytes] of Object.entries(executables)) {
    await mkdir(path.dirname(path.join(runtimeRoot, relative)), { recursive: true });
    await writeFile(path.join(runtimeRoot, relative), bytes);
  }
  return { mode: 'development', appRoot } as const;
}
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { if (error instanceof MediaRuntimeError) return error.code; throw error; }
  throw new Error('expected a runtime failure');
}
const probed = async (prober: MediaProber, file: string): Promise<MediaInfo> => {
  const outcome = await prober.probe(file);
  if (!outcome.ok) throw new Error(`${path.basename(file)}: ${outcome.code}`);
  return outcome.info;
};
/** ffprobe's own record of what it opened, with the production arguments and `-v debug`. */
async function debugLog(runtime: MediaRuntime, file: string, withFormatWhitelist = true) {
  const args = probeArgs(file, 'debug');
  if (!withFormatWhitelist) args.splice(args.indexOf('-format_whitelist'), 2);
  return (await runtime.run('ffprobe', args, LIMITS)).stderr.toString('utf8');
}

beforeAll(async () => {
  if (!available) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'runtime-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'runtime-')));
  work = path.join(root, 'work');
  media = path.join(root, 'media');
  await mkdir(media, { recursive: true });
  ffmpeg = (await runtimeOf().acquire()).ffmpeg;
  const video = ['-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1:r=25'];
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000'];
  await writeFile(path.join(media, 'styled.ass'), `${ASS_HEADER}Dialogue: 0,0:00:00.00,0:00:00.40,Default,,0,0,0,,Hello\n` +
    'Dialogue: 0,0:00:00.50,0:00:00.90,Default,,0,0,0,,{\\pos(10,10)}A sign\n');
  await writeFile(path.join(media, 'plain.ass'), `${ASS_HEADER}Dialogue: 0,0:00:00.00,0:00:00.40,Default,,0,0,0,,Hello\n` +
    'Dialogue: 0,0:00:00.50,0:00:00.90,Default,,0,0,0,,{\\i1}Goodbye{\\i0}\n');
  // One at a time, at idle priority.
  await make(path.join(media, 'clip.mp4'), ...video, ...tone, '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest');
  await make(path.join(media, 'clip.webm'), ...video, ...tone, '-c:v', 'libsvtav1', '-preset', '12', '-c:a', 'libopus', '-shortest');
  await make(path.join(media, 'subs.mkv'), ...video, '-i', path.join(media, 'styled.ass'), '-i', path.join(media, 'plain.ass'),
    '-map', '0:v', '-map', '1:s', '-map', '2:s', '-c:v', 'mpeg4', '-c:s', 'copy');
  await make(path.join(media, 'cover.mp3'), ...tone, '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-map', '0:a', '-map', '1:v', '-frames:v', '1',
    '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-c:a', 'libmp3lame');
  await make(path.join(media, 'hdr.mkv'), ...tone, ...video, '-map', '0:a', '-map', '1:v', '-c:a', 'libopus',
    '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le', '-c:v', 'libsvtav1', '-preset', '12',
    '-svtav1-params', 'mastering-display=G(0.265,0.69)B(0.15,0.06)R(0.68,0.32)WP(0.3127,0.329)L(1000,0.005):content-light=1000,400');
}, 120_000);
afterAll(async () => { if (root && !keepAllTestRuns()) await removeTestRun(root); });

describe.skipIf(!available)('the bundled media runtime', () => {
  it('verifies once, reuses the result, and verifies again when an executable changes', async () => {
    let verified = 0, shift = 0;
    const runtime = runtimeOf({
      verifyRuntime: async input => { verified++; return verifyLocalSubtitleRuntimeBundle(input); },
      statFile: async file => { const stats = await lstat(file); return { size: stats.size, mtimeMs: stats.mtimeMs + shift, isFile: () => stats.isFile() }; },
    });
    expect(runtime.status()).toEqual({ state: 'unverified' });
    const tools = await runtime.acquire();
    const mediaDirectory = path.join(STAGED, 'win-x64', 'media');
    expect([tools.ffmpeg, tools.ffprobe]).toEqual([path.join(mediaDirectory, 'ffmpeg.exe'), path.join(mediaDirectory, 'ffprobe.exe')]);
    expect(tools.version).toBe(LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions.win32);
    expect(runtime.status()).toEqual({ state: 'ready', version: LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions.win32 });
    await runtime.acquire();
    await Promise.all([runtime.acquire(), runtime.acquire(), runtime.acquire()]);
    expect(verified).toBe(1);
    shift = 1;   // Both executables now report another modification time.
    await runtime.acquire();
    expect(verified).toBe(2);
    await runtime.acquire();
    expect(verified).toBe(2);
  }, 60_000);

  it('does not keep a failed verification, so the next use verifies again', async () => {
    let verified = 0;
    const runtime = runtimeOf({ verifyRuntime: async input => {
      if (verified++ === 0) throw Object.assign(new Error('hash mismatch'), { code: 'media_runtime_invalid' });
      return verifyLocalSubtitleRuntimeBundle(input);
    } });
    expect(await failure(runtime.acquire())).toBe('runtime_invalid');
    expect(runtime.status()).toEqual({ state: 'unavailable', code: 'runtime_invalid' });
    await runtime.acquire();
    expect(verified).toBe(2);
    expect(runtime.status().state).toBe('ready');
  }, 60_000);

  it('reports a missing runtime as runtime_missing', async () => {
    const empty = path.join(root, 'no-runtime');
    await mkdir(empty, { recursive: true });
    const runtime = runtimeOf({ environment: { mode: 'development', appRoot: empty } });
    expect(await failure(runtime.acquire())).toBe('runtime_missing');
    expect(runtime.status()).toEqual({ state: 'unavailable', code: 'runtime_missing' });
    // The manifest and licences are there, the executables are not.
    expect(await failure(runtimeOf({ environment: await mirror('no-executables', {}) }).acquire())).toBe('runtime_missing');
  });

  it('reports a damaged executable as runtime_invalid, whether its size or only its hash is wrong', async () => {
    const damaged = await mirror('damaged', { 'win-x64/media/ffmpeg.exe': Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4094)]) });
    const runtime = runtimeOf({ environment: damaged });
    expect(await failure(runtime.acquire())).toBe('runtime_invalid');
    expect(runtime.status()).toEqual({ state: 'unavailable', code: 'runtime_invalid' });
    // Both executables present at their exact sizes, one byte of ffmpeg changed: only the sha256 can tell.
    const staged = path.join(STAGED, 'win-x64', 'media');
    const ffmpegBytes = await readFile(path.join(staged, 'ffmpeg.exe'));
    ffmpegBytes[ffmpegBytes.length >> 1] ^= 0xff;
    const tampered = await mirror('tampered', { 'win-x64/media/ffmpeg.exe': ffmpegBytes, 'win-x64/media/ffprobe.exe': await readFile(path.join(staged, 'ffprobe.exe')) });
    let started = 0;
    const tamperedRuntime = runtimeOf({ environment: tampered, spawn: (command, args, options) => { started++; return nodeSpawn(command, args, options); } });
    expect(await failure(tamperedRuntime.acquire())).toBe('runtime_invalid');
    expect(started).toBe(0);   // Refused before anything ran.
    await rm(tampered.appRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  it('reports another version as runtime_version_mismatch, from the manifest and from the executable itself', async () => {
    const pinned = runtimeOf({ pinnedVersions: { win32: 'n9.9.9-1-gdeadbeef00-20270101', darwin: '9.9.9' } });
    expect(await failure(pinned.acquire())).toBe('runtime_version_mismatch');
    expect(pinned.status()).toEqual({ state: 'unavailable', code: 'runtime_version_mismatch' });
    // An executable that passes the hash check yet reports another version on `-version`.
    const impostor: MediaSpawn = (command, _args, options) => spawn(process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(path.basename(command, '.exe'))} + ' version n7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\\n')`], options);
    expect(await failure(runtimeOf({ spawn: impostor }).acquire())).toBe('runtime_version_mismatch');
  }, 60_000);

  it('reports an executable that cannot start as runtime_spawn_failed', async () => {
    const runtime = runtimeOf({ spawn: (command, args, options) => spawn(`${command}.blocked`, [...args], options) });
    expect(await failure(runtime.acquire())).toBe('runtime_spawn_failed');
    expect(runtime.status()).toEqual({ state: 'unavailable', code: 'runtime_spawn_failed' });
  }, 60_000);

  it('verifies again and retries once when a run cannot start, and gives up after the second failure', async () => {
    let verified = 0, refuse = 0;
    const runtime = runtimeOf({
      verifyRuntime: async input => { verified++; return verifyLocalSubtitleRuntimeBundle(input); },
      spawn: (command, args, options) => refuse > 0 && args.includes('-show_streams') ? (refuse--, spawn(`${command}.blocked`, [...args], options)) : nodeSpawn(command, args, options),
    });
    const prober = new MediaProber({ runtime });
    refuse = 1;
    expect((await prober.probe(path.join(media, 'clip.mp4'))).ok).toBe(true);
    expect(verified).toBe(2);
    refuse = 2;
    expect(await prober.probe(path.join(media, 'clip.webm'))).toEqual({ ok: false, code: 'runtime_spawn_failed' });
    expect(runtime.status()).toEqual({ state: 'unavailable', code: 'runtime_spawn_failed' });
  }, 60_000);

  it('never runs an ffmpeg or ffprobe found on PATH', async () => {
    const fake = path.join(root, 'fake-path');
    const sentinel = path.join(root, `path-ffmpeg-ran-${randomUUID()}.txt`);
    await mkdir(fake, { recursive: true });
    for (const name of ['ffmpeg.cmd', 'ffprobe.cmd', 'ffmpeg.bat', 'ffprobe.bat']) await writeFile(path.join(fake, name), `@echo off\r\necho %0 > "${sentinel}"\r\n`);
    const previous = process.env.PATH;
    process.env.PATH = `${fake}${path.delimiter}${previous ?? ''}`;
    try {
      const commands = new Set<string>();
      const runtime = runtimeOf({ spawn: (command, args, options) => { commands.add(command); return nodeSpawn(command, args, options); } });
      const tools = await runtime.acquire();
      const info = await probed(new MediaProber({ runtime }), path.join(media, 'clip.mp4'));
      expect(info.kind).toBe('video');
      expect([...commands].sort()).toEqual([tools.ffmpeg, tools.ffprobe].sort());
      expect(tools.environment.PATH.split(';')).toEqual([path.dirname(tools.ffmpeg), path.join(process.env.SystemRoot!, 'System32')]);
      expect(tools.environment.PATH).not.toContain(fake);
      // Nor does a missing runtime fall back to them: it is runtime_missing and nothing starts.
      const empty = path.join(root, 'no-runtime-with-path');
      await mkdir(empty, { recursive: true });
      let started = 0;
      const missing = runtimeOf({ environment: { mode: 'development', appRoot: empty }, spawn: (command, args, options) => { started++; return nodeSpawn(command, args, options); } });
      expect(await failure(missing.acquire())).toBe('runtime_missing');
      expect(await new MediaProber({ runtime: missing }).probe(path.join(media, 'clip.mp4'))).toEqual({ ok: false, code: 'runtime_missing' });
      expect(started).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
    } finally { process.env.PATH = previous; }
  }, 60_000);
});

describe.skipIf(!available)('probing real files', () => {
  let runtime: MediaRuntime, prober: MediaProber;
  beforeAll(() => { runtime = runtimeOf(); prober = new MediaProber({ runtime }); });

  it('describes an MP4 and a WebM, telling the containers apart', async () => {
    const mp4 = await probed(prober, path.join(media, 'clip.mp4'));
    expect(mp4).toMatchObject({ kind: 'video', primaryVideoIndex: 0, container: { demuxer: 'mov', majorBrand: 'isom', identity: 'mp4', extension: 'mp4' } });
    expect(mp4.video[0]).toMatchObject({ codec: 'h264', width: 320, height: 180, fps: 25, isVfr: false, bitDepth: 8, chromaSubsampling: '420', rotation: 0,
      hdr: { format: 'none', dolbyVision: null } });
    expect(mp4.audio[0]).toMatchObject({ codec: 'aac', channels: 1, sampleRate: 48000, bitRateSource: 'stream' });
    expect(Math.abs(mp4.durationUs! - 1_000_000)).toBeLessThan(100_000);
    expect(mp4.sizeBytes).toBe((await lstat(path.join(media, 'clip.mp4'))).size);

    const webm = await probed(prober, path.join(media, 'clip.webm'));
    expect(webm.container).toMatchObject({ demuxer: 'matroska', formatName: 'matroska,webm', matroskaDocType: 'webm', identity: 'webm' });
    expect(webm.video[0]).toMatchObject({ codec: 'av1', width: 320, height: 180 });
    expect(webm.audio[0].codec).toBe('opus');
    expect(webm.durationSource).toBe('format');
  }, 60_000);

  it('takes the rotation from the Display Matrix only: a Matroska ROTATE=90 tag probes as 0, a display matrix as its turn', async () => {
    // ffmpeg 8 writes `-metadata:s:v:0 ROTATE=90` into Matroska as a plain tag, and its autorotate ignores it.
    const tagged = await make(path.join(media, 'rotate-tag.mkv'), '-i', path.join(media, 'clip.mp4'), '-map', '0:v', '-c', 'copy', '-metadata:s:v:0', 'ROTATE=90');
    const raw = JSON.parse((await runtime.run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', `file:${tagged}`], LIMITS)).stdout.toString('utf8'));
    // The check would pass on a file without the tag: it is there, and no display matrix is.
    expect(raw.streams[0].tags.ROTATE).toBe('90');
    expect(raw.streams[0].side_data_list ?? []).toEqual([]);
    expect((await probed(prober, tagged)).video[0]).toMatchObject({ rotation: 0, width: 320, height: 180 });
    // A real display matrix (counter-clockwise 90°, written by -display_rotation) is a clockwise 270°.
    const turned = await make(path.join(media, 'turned.mp4'), '-display_rotation', '90', '-i', path.join(media, 'clip.mp4'), '-map', '0:v', '-c', 'copy');
    expect((await probed(prober, turned)).video[0]).toMatchObject({ rotation: 270, width: 320, height: 180 });
  }, 60_000);

  it('reads the ASS events of each stream to tell styled from plain subtitles', async () => {
    const subs = await probed(prober, path.join(media, 'subs.mkv'));
    expect(subs.container).toMatchObject({ matroskaDocType: 'matroska', identity: 'matroska' });
    expect(subs.subtitles.map(stream => [stream.index, stream.typeIndex, stream.codec, stream.kind, stream.styled])).toEqual([
      [1, 0, 'ass', 'text', true], [2, 1, 'ass', 'text', false]]);
  }, 60_000);

  it('takes an MP3 with cover art for an audio file', async () => {
    const cover = await probed(prober, path.join(media, 'cover.mp3'));
    expect(cover).toMatchObject({ kind: 'audio', primaryVideoIndex: null, video: [], container: { demuxer: 'mp3', identity: 'mp3' } });
    expect(cover.covers).toEqual([{ index: 1, typeIndex: 0, codec: 'mjpeg', width: 64, height: 64 }]);
  }, 60_000);

  it('reads HDR10 static metadata from the first frame', async () => {
    const hdr = await probed(prober, path.join(media, 'hdr.mkv'));
    const video = hdr.video.find(stream => stream.index === hdr.primaryVideoIndex)!;
    expect(video).toMatchObject({ index: 1, codec: 'av1', bitDepth: 10, colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc' });
    expect(video.hdr.format).toBe('hdr10');
    expect(video.hdr.masteringDisplay?.luminance).toEqual({ min: 0.005, max: 1000 });
    // AV1 stores chromaticity in steps of 1/65536.
    expect(video.hdr.masteringDisplay?.primaries?.red.x).toBeCloseTo(0.68, 4);
    expect(video.hdr.masteringDisplay?.primaries?.red.y).toBeCloseTo(0.32, 4);
    expect(video.hdr.masteringDisplay?.primaries?.whitePoint.x).toBeCloseTo(0.3127, 4);
    expect(video.hdr.contentLight).toEqual({ maxCll: 1000, maxFall: 400 });
  }, 60_000);

  it('refuses playlists without opening the files they reference', async () => {
    // A sentinel outside the run folder; the playlists below point at it.
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'media-converter-sentinel-')));
    try {
      const sentinelName = `sentinel-${randomUUID()}.ts`;
      const sentinel = await make(path.join(outside, sentinelName), '-f', 'lavfi', '-i', 'testsrc=s=160x120:d=1:r=10', '-c:v', 'mpeg2video', '-f', 'mpegts');
      const folder = path.join(root, 'playlists');
      await mkdir(folder, { recursive: true });
      const hls = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\n${sentinel}\n#EXT-X-ENDLIST\n`;
      const m3u8 = path.join(folder, 'outside.m3u8');
      const renamedHls = path.join(folder, 'outside-hls.mp4');
      await writeFile(m3u8, hls);
      await writeFile(renamedHls, hls);
      // The concat demuxer only opens plain relative names, so its sentinel sits next to the list.
      const siblingName = `sibling-${randomUUID()}.ts`;
      await copyFile(sentinel, path.join(folder, siblingName));
      const renamedConcat = path.join(folder, 'concat.mp4');
      await writeFile(renamedConcat, `ffconcat version 1.0\nfile ${siblingName}\n`);

      let started = 0;
      const counting = runtimeOf({ spawn: (command, args, options) => { started++; return nodeSpawn(command, args, options); } });
      await counting.acquire();
      const before = started;
      const playlistProber = new MediaProber({ runtime: counting });
      expect(await playlistProber.probe(m3u8)).toEqual({ ok: false, code: 'container_not_allowed' });
      expect(started).toBe(before);   // Refused by extension: ffprobe never started.
      expect(await playlistProber.probe(renamedHls)).toEqual({ ok: false, code: 'container_not_allowed' });
      expect(await playlistProber.probe(renamedConcat)).toEqual({ ok: false, code: 'container_not_allowed' });

      for (const file of [m3u8, renamedHls, renamedConcat]) {
        const log = await debugLog(counting, file);
        expect(log).toContain(`Opening 'file:${file}' for reading`);
        expect(log).not.toContain(sentinelName);
        expect(log).not.toContain(siblingName);
      }
      expect(await debugLog(counting, renamedConcat)).toMatch(/Format not on whitelist/);
      // Without the format whitelist the same playlists do open the sentinels, so the log would show it.
      expect(await debugLog(counting, m3u8, false)).toContain(sentinelName);
      expect(await debugLog(counting, renamedConcat, false)).toContain(siblingName);
      expect(ALLOWED_DEMUXERS).not.toContain('hls');
    } finally { await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }, 60_000);

  it('runs at most four probes at once out of 100, below normal priority, and settles each file on its own', async () => {
    const folder = path.join(root, 'many');
    await mkdir(folder, { recursive: true });
    const files = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const target = path.join(folder, `clip-${String(i).padStart(3, '0')}.mp4`);
      await copyFile(path.join(media, 'clip.mp4'), target);
      return target;
    }));
    let live = 0, peak = 0, probes = 0, lastStart = 0;
    const priorities: number[] = [];
    const runtime = runtimeOf({ spawn: (command, args, options) => {
      const child: ChildProcess = nodeSpawn(command, args, options);
      if (args.includes('-show_streams')) { probes++; lastStart = performance.now(); }
      peak = Math.max(peak, ++live);
      child.once('close', () => { live--; });
      // Read back the priority the runtime set right after spawning.
      setImmediate(() => { try { priorities.push(os.getPriority(child.pid!)); } catch { /* Already exited. */ } });
      return child;
    } });
    await runtime.acquire();
    peak = 0;
    const prober = new MediaProber({ runtime });
    const settled: number[] = [];
    const outcomes = await Promise.all(files.map(file => prober.probe(file).then(outcome => { settled.push(performance.now()); return outcome; })));
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(100);
    expect(probes).toBe(100);
    expect(peak).toBe(4);
    // The first results arrived while later files had not even started.
    expect(Math.min(...settled)).toBeLessThan(lastStart);
    expect(priorities.length).toBeGreaterThan(0);
    expect(new Set(priorities)).toEqual(new Set([os.constants.priority.PRIORITY_BELOW_NORMAL]));
  }, 120_000);
});
