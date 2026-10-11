import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { CUE_AUDIO_LIMITS, paddedCueAudioRange, pcm16WavHeader, resolveCueAudioRange, type cueAudioRequestSchemas, type CueAudioResult, type CueAudioTempo, type CueAudioUnavailable } from '../../../src/subtitle-studio/cue-audio';
import type { DocumentRepository } from './document-repository';
import type { CueMediaService } from './cue-media-service';
import { buildLocalSubtitleMediaEnvironment, runLocalSubtitleMediaProcess, type LocalSubtitleMediaProcessRequest, type LocalSubtitleMediaProcessResult } from './transcription/native/media-process';
import { LOCAL_SUBTITLE_MEDIA_POLICY } from './transcription/native/media-normalizer';
import { isLocalSubtitleVerifiedRuntimeBundle, verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment, type LocalSubtitleVerifiedRuntimeBundle } from './transcription/native/resource-path';

/** Mono 16-bit PCM: speech stays clear and a two-minute clip stays near 11.5 MB. */
const CHANNELS = 1;
const TIMEOUT_MS = 20_000;
const seconds = (ms: number) => (ms / 1000).toFixed(3);

/**
 * The verified ffmpeg of a media runtime proof, checked as the transcription
 * normalizer checks it. The normalizer is a frozen copy, so this is not
 * shared with it.
 */
export function selectCueAudioFfmpeg(bundle: LocalSubtitleVerifiedRuntimeBundle): string {
  if (!isLocalSubtitleVerifiedRuntimeBundle(bundle) || (bundle.scope !== 'media' && bundle.scope !== 'all') || bundle.noPathFallback !== true || bundle.ready !== true) {
    throw new Error('The bundled media runtime proof is invalid.');
  }
  const ffmpeg = Object.values(bundle.artifactPaths).filter(artifact => artifact.kind === 'ffmpeg');
  if (ffmpeg.length !== 1 || ffmpeg[0].backend !== 'media' || ffmpeg[0].version !== LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions[bundle.target.platform]) {
    throw new Error('The bundled media runtime does not provide the expected ffmpeg.');
  }
  return ffmpeg[0].absolutePath;
}

type Tools = { ffmpeg: string; environment: Readonly<Record<string, string>>; size: number; mtimeMs: number };
export type CueAudioClipperOptions = {
  environment: LocalSubtitleResourceEnvironment;
  /** Where ffmpeg runs; it writes nothing there. */
  workingDirectory: string;
  verifyRuntime?: typeof verifyLocalSubtitleRuntimeBundle;
  runProcess?: (request: LocalSubtitleMediaProcessRequest) => Promise<LocalSubtitleMediaProcessResult>;
};
export type CueAudioDecoded = { kind: 'wav'; bytes: Uint8Array } | { kind: 'unavailable'; reason: CueAudioUnavailable };

/**
 * Decodes one stretch of a media file with the bundled ffmpeg, straight to
 * memory. The runtime is verified once per session (hashing takes about a
 * second) and verified again only when the executable changes or fails to
 * start. Each window keeps at most one decode per purpose (playback, waveform); a newer one stops it.
 */
export class CueAudioClipper {
  private tools: Promise<Tools> | undefined;
  // Keyed by window and purpose ("12:play", "12:waveform"): a waveform never stops what plays.
  private readonly active = new Map<string, AbortController>();
  private readonly latest = new Map<string, number>();
  private tickets = 0;
  constructor(private readonly options: CueAudioClipperOptions) {}

  private async verify(): Promise<Tools> {
    const bundle = await (this.options.verifyRuntime ?? verifyLocalSubtitleRuntimeBundle)({ environment: this.options.environment, scope: 'media' });
    const ffmpeg = selectCueAudioFfmpeg(bundle);
    await mkdir(this.options.workingDirectory, { recursive: true });
    const stat = await lstat(ffmpeg);
    return { ffmpeg, size: stat.size, mtimeMs: stat.mtimeMs, environment: buildLocalSubtitleMediaEnvironment({
      platform: bundle.target.platform, mediaDirectory: path.dirname(ffmpeg), tempDirectory: this.options.workingDirectory }) };
  }
  private async currentTools(): Promise<Tools> {
    const pending = this.tools ??= this.verify();
    try {
      const tools = await pending;
      const stat = await lstat(tools.ffmpeg).catch(() => null);
      if (stat?.isFile() && stat.size === tools.size && stat.mtimeMs === tools.mtimeMs) return tools;
    } catch { /* Verified again below. */ }
    if (this.tools === pending) this.tools = undefined;
    return this.tools ??= this.verify();
  }

  /**
   * Verifies the runtime in the background, as soon as a document with media is shown, so the
   * first clip does not wait for it. A failure is not reported here: decoding verifies again.
   */
  prewarm() {
    void this.currentTools().catch(() => undefined);
  }

  /**
   * Starts a request for the window: stops its decode in progress, and makes
   * any earlier request that has not started decoding yet end as cancelled.
   */
  claim(owner: string): number {
    this.cancel(owner);
    const ticket = ++this.tickets;
    this.latest.set(owner, ticket);
    return ticket;
  }
  /** Stops the window's decode in progress, if any. */
  cancel(owner: string) {
    this.active.get(owner)?.abort();
    this.active.delete(owner);
  }
  forgetOwner(owner: number) {
    for (const lane of new Set([...this.active.keys(), ...this.latest.keys()])) {
      if (!lane.startsWith(`${owner}:`)) continue;
      this.cancel(lane);
      this.latest.delete(lane);
    }
  }

  /** `audioOrdinal` picks the media's audio stream, from 1; a file without that many falls back to its first. */
  async decode(owner: string, ticket: number, mediaPath: string, clipStartMs: number, clipEndMs: number, tempo: CueAudioTempo = 1,
    sampleRate: number = CUE_AUDIO_LIMITS.sampleRate, audioOrdinal = 1): Promise<CueAudioDecoded> {
    const bytesPerSecond = sampleRate * CHANNELS * 2;
    if (this.latest.get(owner) !== ticket) return { kind: 'unavailable', reason: 'cancelled' };
    const controller = new AbortController();
    this.active.set(owner, controller);
    try {
      let tools: Tools;
      try { tools = await this.currentTools(); }
      catch { return { kind: 'unavailable', reason: 'runtime_unavailable' }; }
      if (controller.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      const durationMs = clipEndMs - clipStartMs;
      let stream = audioOrdinal - 1;
      const run = () => (this.options.runProcess ?? runLocalSubtitleMediaProcess)({
        command: tools.ffmpeg, cwd: this.options.workingDirectory, env: tools.environment, signal: controller.signal, timeoutMs: TIMEOUT_MS,
        stdoutMaxBytes: Math.ceil(durationMs / 1000 / tempo * bytesPerSecond) + bytesPerSecond, stderrMaxBytes: 16 * 1024,
        // -t before -i limits the media read, so a slowed stretch comes out longer instead of cut short.
        // The file: prefix keeps ffmpeg from reading any part of a name as a protocol.
        args: ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-ss', seconds(clipStartMs), '-t', seconds(durationMs), '-i', `file:${mediaPath}`,
          '-map', `0:a:${stream}`, '-vn', '-sn', '-dn', ...(tempo === 1 ? [] : ['-af', `atempo=${tempo}`]),
          '-ac', String(CHANNELS), '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
      });
      let result = await run();
      if (result.status === 'spawn_error' && !controller.signal.aborted) {
        // The executable may have been replaced: verify once more and retry.
        this.tools = undefined;
        try { tools = await this.currentTools(); } catch { return { kind: 'unavailable', reason: 'runtime_unavailable' }; }
        result = await run();
        if (result.status === 'spawn_error') return { kind: 'unavailable', reason: 'runtime_unavailable' };
      }
      const missingStream = (stderr: string) => /matches no streams|does not contain any stream|Output file .* does not contain/i.test(stderr);
      if (stream > 0 && !controller.signal.aborted && result.status === 'closed' && result.exitCode !== 0 && missingStream(result.stderr.toString('utf8'))) {
        // Another file than the one transcribed, with fewer audio tracks: play its first.
        stream = 0;
        result = await run();
      }
      if (controller.signal.aborted || result.aborted || this.latest.get(owner) !== ticket) return { kind: 'unavailable', reason: 'cancelled' };
      const stderr = result.stderr.toString('utf8');
      if (result.status !== 'closed' || result.exitCode !== 0 || result.timedOut || result.outputExceeded) {
        return { kind: 'unavailable', reason: missingStream(stderr) ? 'no_audio' : 'decode_failed' };
      }
      const dataBytes = result.stdout.length - (result.stdout.length % (CHANNELS * 2));
      if (!dataBytes) return { kind: 'unavailable', reason: 'no_audio' };
      const bytes = new Uint8Array(44 + dataBytes);
      bytes.set(pcm16WavHeader(dataBytes, sampleRate, CHANNELS));
      bytes.set(result.stdout.subarray(0, dataBytes), 44);
      return { kind: 'wav', bytes };
    } finally {
      if (this.active.get(owner) === controller) this.active.delete(owner);
    }
  }

  dispose() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.latest.clear();
  }
}

/** Plays a request against the document as it is now: resolves the stretch and the media, then decodes. */
export async function readCueAudio(deps: { repository: DocumentRepository; media: CueMediaService; clipper: CueAudioClipper },
  owner: number, request: z.infer<typeof cueAudioRequestSchemas.readCueAudio>, guard: () => void = () => {}): Promise<CueAudioResult> {
  const lane = `${owner}:${request.purpose ?? 'play'}`;
  const ticket = deps.clipper.claim(lane);
  const doc = (await deps.repository.readSnapshot(request.documentId)).document; guard();
  const range = resolveCueAudioRange(doc, request.target);
  const { clipStartMs, clipEndMs } = paddedCueAudioRange(range, request.padMs);
  const resolved = await deps.media.resolve(request.documentId, guard);
  if (!resolved.media) return { kind: 'unavailable', reason: resolved.status.status === 'missing' ? 'no_media' : 'media_unavailable' };
  const tempo = request.tempo ?? 1;
  const decoded = await deps.clipper.decode(lane, ticket, resolved.media.path, clipStartMs, clipEndMs, tempo, undefined, resolved.media.audioOrdinal); guard();
  return decoded.kind === 'wav' ? { kind: 'clip', bytes: decoded.bytes, mimeType: 'audio/wav', revision: doc.revision, ...range, clipStartMs, clipEndMs, tempo } : decoded;
}
