import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import type { DownloadSourceMode } from '../../../src/network/contract';
import {
  downloadLocalSubtitleResource,
  LocalSubtitleResourceDownloadError,
  type LocalSubtitleResourceDownloadErrorCode,
  type DownloadLocalSubtitleResourceOptions,
  type LocalSubtitleDownloadResponse,
  type LocalSubtitleResourceDownloadResult,
  type OpenLocalSubtitleDownloadResponse,
  type OpenLocalSubtitleDownloadResponseOptions,
} from '../speech-resources/engine/resource-download';
import {
  defaultCandidateOrder,
  matchDownloadSources,
  type DownloadCandidate,
  type DownloadSourceGroupId,
  type DownloadSourceMatch,
} from './download-sources';
import { ProxyConnectionError } from './tunnel';

export const DOWNLOAD_TRANSPORT_POLICY = Object.freeze({
  probeTimeoutMs: 6_000,
  responseHeaderTimeoutMs: 30_000,
  /** A body that sends nothing for this long is cut, so the engine resumes instead of hanging. */
  idleTimeoutMs: 60_000,
  maxMirrorRedirects: 5,
  maxHeaderBytes: 16 * 1_024,
  /** A source without ETag or Last-Modified cannot resume, so it ranks as if this much slower. */
  noValidatorPenaltyMs: 1_500,
  /** Replaces the engine's two quick retries for downloads that take minutes. */
  transientRetryDelaysMs: Object.freeze([1_000, 3_000, 8_000, 15_000, 30_000] as const),
  /** Fresh engine attempts allowed after a failed attempt that still grew the partial file. */
  maxResumeRounds: 8,
  resumeRoundDelayMs: 2_000,
  /**
   * Attempts in a row in which the chosen source added nothing to the partial file before it
   * gives way to the next source (a source that cannot resume starts over each time).
   */
  maxStalledAttempts: 2,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Official answers that mean "this source cannot serve it now", so another source is tried. */
const OFFICIAL_FAILURE_STATUSES = new Set([403, 404, 408, 410, 425, 429, 451]);
const PROBE_HEADERS = Object.freeze({
  accept: 'application/octet-stream',
  'accept-encoding': 'identity',
  'user-agent': 'FusionKit-local-subtitle/1',
  range: 'bytes=0-0',
});

/** One GET without following redirects; resolves when the response headers arrive. */
export type RawDownloadRequest = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<LocalSubtitleDownloadResponse>;

export interface HttpsDownloadRequestOptions {
  readonly agent?: https.Agent;
  readonly responseHeaderTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Tests only: extra TLS options such as a private CA. */
  readonly tls?: Pick<https.RequestOptions, 'ca'>;
}

/** HTTPS GET through the given (proxy-aware) agent, with header and idle timeouts. */
export function createHttpsDownloadRequest(options: HttpsDownloadRequestOptions = {}): RawDownloadRequest {
  const headerTimeoutMs = options.responseHeaderTimeoutMs ?? DOWNLOAD_TRANSPORT_POLICY.responseHeaderTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_TRANSPORT_POLICY.idleTimeoutMs;
  return (url, headers, signal) => new Promise((resolve, reject) => {
    if (url.protocol !== 'https:') {
      reject(Object.assign(new Error('Only https downloads are allowed.'), { code: 'ERR_INVALID_PROTOCOL' }));
      return;
    }
    let settled = false;
    const request = https.request(url, {
      method: 'GET',
      headers,
      signal,
      ...(options.agent ? { agent: options.agent } : {}),
      ...options.tls,
      maxHeaderSize: DOWNLOAD_TRANSPORT_POLICY.maxHeaderBytes,
    }, response => {
      settled = true;
      request.setTimeout(idleTimeoutMs, () => request.destroy(
        Object.assign(new Error('The download stopped sending data.'), { code: 'ETIMEDOUT' }),
      ));
      let discarded = false;
      resolve(Object.freeze({
        statusCode: response.statusCode ?? 0,
        headers: Object.freeze({
          location: firstHeader(response.headers.location),
          etag: firstHeader(response.headers.etag),
          'last-modified': firstHeader(response.headers['last-modified']),
          'content-length': firstHeader(response.headers['content-length']),
          'content-range': firstHeader(response.headers['content-range']),
        }),
        body: response,
        discard: () => {
          if (discarded) return;
          discarded = true;
          request.destroy();
          response.destroy();
        },
      }));
    });
    request.setTimeout(headerTimeoutMs, () => request.destroy(
      Object.assign(new Error('The download server did not answer in time.'), { code: 'ETIMEDOUT' }),
    ));
    request.on('error', error => { if (!settled) reject(error); });
    request.end();
  });
}

export interface DownloadProbeResult {
  readonly id: string;
  /** The source answered with the right file size. */
  readonly ok: boolean;
  /** It answered a Range request with 206, so an interrupted download can resume there. */
  readonly rangeSupported: boolean;
  readonly latencyMs: number;
  readonly validator?: string;
  readonly status?: number;
}

export interface DownloadSourceRouterOptions {
  readonly request: RawDownloadRequest;
  readonly probeTimeoutMs?: number;
  readonly now?: () => number;
}

interface PlanInput {
  readonly mode: DownloadSourceMode;
  readonly expectedBytes: number;
  /** The validator of a partial file being resumed. */
  readonly ifRange?: string;
  readonly signal: AbortSignal;
}

/**
 * Remembers, for this launch, which sources work: a measured ranking per group, the source that
 * last served each file (so a resume goes back to it) and sources whose file failed verification.
 */
export class DownloadSourceRouter {
  readonly #request: RawDownloadRequest;
  readonly #probeTimeoutMs: number;
  readonly #now: () => number;
  readonly #rankings = new Map<DownloadSourceGroupId, string[]>();
  readonly #served = new Map<string, string>();
  readonly #rejected = new Map<string, Set<string>>();

  constructor(options: DownloadSourceRouterOptions) {
    this.#request = options.request;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DOWNLOAD_TRANSPORT_POLICY.probeTimeoutMs;
    this.#now = options.now ?? (() => performance.now());
  }

  /** The network path changed (proxy or source setting), so measurements are stale. */
  reset(): void {
    this.#rankings.clear();
  }

  ranking(group: DownloadSourceGroupId): readonly string[] | undefined {
    return this.#rankings.get(group);
  }

  /** The order to try sources in for one file. */
  async plan(match: DownloadSourceMatch, input: PlanInput): Promise<readonly DownloadCandidate[]> {
    let order = [...defaultCandidateOrder(match, input.mode)];
    if (order.length < 2) return order;
    const official = match.candidates[0]!.url;
    const served = this.#served.get(official);
    if (input.mode === 'auto') {
      // A resume after a restart cannot know which source the partial file came from; the
      // validator says it, so measure this file again and look for the source that matches.
      const resumeUnknown = input.ifRange !== undefined && served === undefined;
      let matching: string | undefined;
      if (!this.#rankings.has(match.group) || resumeUnknown) {
        const results = await this.probe(match, input.expectedBytes, input.signal);
        this.#rankings.set(match.group, rankProbeResults(order, results));
        if (resumeUnknown) {
          matching = results.find(result => result.ok && result.rangeSupported && result.validator === input.ifRange)?.id;
        }
      }
      const ranking = this.#rankings.get(match.group)!;
      order.sort((left, right) => rankIndex(ranking, left.id) - rankIndex(ranking, right.id));
      if (matching) order = moveFirst(order, matching);
    }
    if (input.ifRange !== undefined && served) order = moveFirst(order, served);
    for (const id of this.#rejected.get(official) ?? []) order = moveLast(order, id);
    return order;
  }

  /** Measures every source with a one-byte ranged GET, concurrently and within a few seconds. */
  async probe(match: DownloadSourceMatch, expectedBytes: number, signal: AbortSignal): Promise<readonly DownloadProbeResult[]> {
    const timeout = AbortSignal.timeout(this.#probeTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const results = await Promise.all(match.candidates.map(candidate => this.#probeOne(candidate, expectedBytes, combined)));
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return results;
  }

  async #probeOne(candidate: DownloadCandidate, expectedBytes: number, signal: AbortSignal): Promise<DownloadProbeResult> {
    const started = this.#now();
    try {
      const response = await followRedirects(this.#request, new URL(candidate.url), PROBE_HEADERS, signal);
      response.discard();
      const latencyMs = Math.max(0, Math.round(this.#now() - started));
      const validator = response.headers.etag ?? response.headers['last-modified'];
      const range = parseContentRange(response.headers['content-range']);
      const length = parseLength(response.headers['content-length']);
      if (response.statusCode === 206 && range && range.start === 0 && range.total === expectedBytes) {
        return { id: candidate.id, ok: true, rangeSupported: true, latencyMs, validator, status: 206 };
      }
      const whole = response.statusCode === 200 && (length === undefined || length === expectedBytes);
      // A mirror that ignores Range cannot resume; only the official address is used that way.
      return { id: candidate.id, ok: whole && candidate.official, rangeSupported: false, latencyMs, validator, status: response.statusCode };
    } catch {
      return { id: candidate.id, ok: false, rangeSupported: false, latencyMs: Math.max(0, Math.round(this.#now() - started)) };
    }
  }

  served(match: DownloadSourceMatch, id: string): void {
    this.#served.set(match.candidates[0]!.url, id);
  }

  /** A source failed to answer; later files in the group try it last. */
  failed(match: DownloadSourceMatch, id: string): void {
    const ranking = this.#rankings.get(match.group);
    if (!ranking) return;
    this.#rankings.set(match.group, [...ranking.filter(item => item !== id), id]);
  }

  /** A source delivered a file that failed verification; try it last for this file. */
  rejected(match: DownloadSourceMatch, id: string): void {
    const official = match.candidates[0]!.url;
    const set = this.#rejected.get(official) ?? new Set<string>();
    set.add(id);
    this.#rejected.set(official, set);
    if (this.#served.get(official) === id) this.#served.delete(official);
  }
}

/** Working sources that resume first, fastest first; then the rest in their default order. */
export function rankProbeResults(order: readonly DownloadCandidate[], results: readonly DownloadProbeResult[]): string[] {
  const byId = new Map(results.map(result => [result.id, result]));
  const tier = (id: string) => {
    const result = byId.get(id);
    if (!result?.ok) return 2;
    return result.rangeSupported ? 0 : 1;
  };
  const cost = (id: string) => {
    const result = byId.get(id);
    if (!result?.ok) return 0;
    return result.latencyMs + (result.validator ? 0 : DOWNLOAD_TRANSPORT_POLICY.noValidatorPenaltyMs);
  };
  return order
    .map((candidate, index) => ({ id: candidate.id, index }))
    .sort((left, right) => tier(left.id) - tier(right.id) || cost(left.id) - cost(right.id) || left.index - right.index)
    .map(item => item.id);
}

export interface DownloadSourceTransportOptions {
  readonly router: DownloadSourceRouter;
  readonly request: RawDownloadRequest;
  /** The official address the engine downloads, exactly as its manifest lists it. */
  readonly sourceUrl: string;
  readonly expectedBytes: number;
  readonly mode: DownloadSourceMode;
}

/** The SHA-256 of the bytes handed to the engine, while they form the file from byte 0 on. */
interface StreamedHash {
  readonly hash: Hash;
  bytes: number;
  digest?: string;
}

/**
 * The engine's response opener for one download. The official address is returned unchanged,
 * redirects included, so the engine keeps checking every hop against its allowlist. A mirror's
 * redirects are followed here (https only) and the engine receives the final answer as if the
 * official address had sent it; the engine still checks size and the managers SHA-256.
 *
 * Within one download the source that answered stays in use, so resume requests go back to it,
 * unless it keeps adding nothing to the partial file. Switching sources can only make the engine
 * restart that file from zero: another source sends a different validator (If-Range then yields
 * 200, or a 206 the engine refuses to append).
 */
export class DownloadSourceTransport {
  readonly open: OpenLocalSubtitleDownloadResponse;
  readonly #options: DownloadSourceTransportOptions;
  readonly #match: DownloadSourceMatch | undefined;
  readonly #topHref: string;
  readonly #failed = new Set<string>();
  /** Sources whose file failed verification; never used again in this download. */
  readonly #rejected = new Set<string>();
  #chosen: DownloadCandidate | undefined;
  #servedBy: DownloadCandidate | undefined;
  #officialChainPending = false;
  /** The last accepted answer: which source, from which byte, and whether it makes the engine start over. */
  #lastAttempt: { readonly id: string; readonly offset: number; readonly restarts: boolean } | undefined;
  #stalledAttempts = 0;
  #streamed: StreamedHash | undefined;

  constructor(options: DownloadSourceTransportOptions) {
    this.#options = options;
    this.#topHref = new URL(options.sourceUrl).href;
    const match = options.mode === 'official' ? undefined : matchDownloadSources(options.sourceUrl);
    this.#match = match && match.candidates.length > 1 ? match : undefined;
    this.open = request => this.#open(request);
  }

  /** The source of the last response handed to the engine for the official address. */
  get servedBy(): DownloadCandidate | undefined {
    return this.#servedBy;
  }

  /**
   * The SHA-256 of the finished file when all of it went through this transport in order, so it
   * needs no second read; undefined when part of it came from elsewhere (an earlier launch).
   */
  streamedSha256(expectedBytes: number): string | undefined {
    const streamed = this.#streamed;
    if (!streamed || streamed.bytes !== expectedBytes) return undefined;
    streamed.digest ??= streamed.hash.digest('hex');
    return streamed.digest;
  }

  /**
   * Never use this source again in this download, and try it last for this file afterwards.
   * Returns whether another source is left to try.
   */
  reject(id: string): boolean {
    this.#rejected.add(id);
    if (this.#chosen?.id === id) this.#chosen = undefined;
    if (this.#servedBy?.id === id) this.#servedBy = undefined;
    this.#lastAttempt = undefined;
    this.#streamed = undefined;
    if (this.#match) this.#options.router.rejected(this.#match, id);
    return (this.#match?.candidates ?? []).some(candidate => !this.#rejected.has(candidate.id));
  }

  async #open(request: OpenLocalSubtitleDownloadResponseOptions): Promise<LocalSubtitleDownloadResponse> {
    const response = await this.#route(request);
    if (REDIRECT_STATUSES.has(response.statusCode)) return response;
    return this.#counted(response, this.#trackHash(request, response));
  }

  /** Starts, continues or gives up the streamed SHA-256 for the answer the engine is about to read. */
  #trackHash(request: OpenLocalSubtitleDownloadResponseOptions, response: LocalSubtitleDownloadResponse): StreamedHash | undefined {
    const offset = requestOffset(request.headers);
    if (offset === 0 && response.statusCode === 200) return (this.#streamed = { hash: createHash('sha256'), bytes: 0 });
    const streamed = this.#streamed;
    const range = parseContentRange(response.headers['content-range']);
    if (offset > 0 && response.statusCode === 206 && range?.start === offset && streamed && !streamed.digest && streamed.bytes === offset) {
      return streamed;
    }
    // The engine starts over (and asks from byte 0 again) or appends to bytes not seen here.
    return (this.#streamed = undefined);
  }

  #counted(response: LocalSubtitleDownloadResponse, streamed: StreamedHash | undefined): LocalSubtitleDownloadResponse {
    const body = response.body;
    const count = (chunk: Uint8Array) => {
      if (streamed && this.#streamed === streamed && !streamed.digest) {
        streamed.hash.update(chunk);
        streamed.bytes += chunk.byteLength;
      }
    };
    return Object.freeze({
      statusCode: response.statusCode,
      headers: response.headers,
      body: {
        [Symbol.asyncIterator]() {
          const iterator = body[Symbol.asyncIterator]();
          return {
            next: async () => {
              const result = await iterator.next();
              if (!result.done) count(result.value);
              return result;
            },
            ...(iterator.return ? { return: (value?: unknown) => iterator.return!(value) } : {}),
          };
        },
      },
      discard: () => response.discard(),
    });
  }

  async #route(request: OpenLocalSubtitleDownloadResponseOptions): Promise<LocalSubtitleDownloadResponse> {
    if (!this.#match) {
      const response = await this.#requestOrBusy(request.url, request.headers, request.signal);
      if (request.url.href === this.#topHref && !REDIRECT_STATUSES.has(response.statusCode)) this.#servedBy = officialOf(this.#options.sourceUrl);
      return response;
    }
    return request.url.href === this.#topHref ? this.#openTop(this.#match, request) : this.#openHop(this.#match, request);
  }

  /**
   * One request whose passing proxy refusal (a busy proxy node answering CONNECT with 502, a SOCKS
   * server that could not connect this once) reads as a busy server, so the engine waits and asks
   * again instead of failing at once. A proxy that wants a password is not retried.
   */
  async #requestOrBusy(url: URL, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<LocalSubtitleDownloadResponse> {
    try {
      return await this.#options.request(url, headers, signal);
    } catch (error) {
      if (!signal.aborted && error instanceof ProxyConnectionError && error.code !== 'ERR_PROXY_AUTH_REQUIRED') return unavailableResponse();
      throw error;
    }
  }

  /** A redirect hop of the official address: hand it over, but fail over if the chain breaks. */
  async #openHop(match: DownloadSourceMatch, request: OpenLocalSubtitleDownloadResponseOptions): Promise<LocalSubtitleDownloadResponse> {
    if (!this.#officialChainPending) return this.#requestOrBusy(request.url, request.headers, request.signal);
    const official = match.candidates[0]!;
    let response: LocalSubtitleDownloadResponse;
    try {
      response = await this.#options.request(request.url, request.headers, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      this.#markFailed(match, official);
      return unavailableResponse();
    }
    if (REDIRECT_STATUSES.has(response.statusCode)) return response;
    if (response.statusCode >= 500 || OFFICIAL_FAILURE_STATUSES.has(response.statusCode)) {
      response.discard();
      this.#markFailed(match, official);
      return unavailableResponse();
    }
    this.#accept(match, official, request.headers, response);
    return response;
  }

  async #openTop(match: DownloadSourceMatch, request: OpenLocalSubtitleDownloadResponseOptions): Promise<LocalSubtitleDownloadResponse> {
    const { headers, signal } = request;
    this.#officialChainPending = false;
    this.#noteProgress(match, requestOffset(headers));
    const planned = await this.#options.router.plan(match, {
      mode: this.#options.mode,
      expectedBytes: this.#options.expectedBytes,
      ifRange: headers['if-range'],
      signal,
    });
    const sticky = this.#chosen;
    const preferred = (sticky ? [sticky, ...planned.filter(candidate => candidate.id !== sticky.id)] : [...planned])
      .filter(candidate => !this.#rejected.has(candidate.id));
    const order = [
      ...preferred.filter(candidate => !this.#failed.has(candidate.id)),
      ...preferred.filter(candidate => this.#failed.has(candidate.id)),
    ];
    for (const [index, candidate] of order.entries()) {
      throwIfAborted(signal);
      const last = index === order.length - 1;
      try {
        if (candidate.official) {
          const response = await this.#options.request(request.url, headers, signal);
          if (REDIRECT_STATUSES.has(response.statusCode)) {
            this.#officialChainPending = true;
            return response;
          }
          if (last || !(response.statusCode >= 500 || OFFICIAL_FAILURE_STATUSES.has(response.statusCode))) {
            this.#accept(match, candidate, headers, response);
            return response;
          }
          response.discard();
        } else {
          const response = await followRedirects(this.#options.request, new URL(candidate.url), headers, signal);
          if (assessMirrorResponse(response, headers, this.#options.expectedBytes)) {
            this.#accept(match, candidate, headers, response);
            return withoutLocation(response);
          }
          response.discard();
        }
      } catch (error) {
        if (signal.aborted) throw error;
      }
      this.#markFailed(match, candidate);
    }
    // Every source failed: answer like a busy server so the engine waits and asks again.
    return unavailableResponse();
  }

  /**
   * Called each time the engine asks for the file. When the chosen source's last answer added
   * nothing that lasted (the engine asks from the same byte again and was not told to start
   * over), that attempt stalled; after a few stalled attempts in a row the next source gets a turn.
   */
  #noteProgress(match: DownloadSourceMatch, offset: number): void {
    const last = this.#lastAttempt;
    const chosen = this.#chosen;
    if (!last || !chosen || last.id !== chosen.id) return;
    if (offset > last.offset || last.restarts) {
      this.#stalledAttempts = 0;
      return;
    }
    this.#stalledAttempts += 1;
    if (this.#stalledAttempts < DOWNLOAD_TRANSPORT_POLICY.maxStalledAttempts) return;
    this.#stalledAttempts = 0;
    this.#lastAttempt = undefined;
    this.#markFailed(match, chosen);
  }

  #accept(
    match: DownloadSourceMatch,
    candidate: DownloadCandidate,
    headers: Readonly<Record<string, string>>,
    response: LocalSubtitleDownloadResponse,
  ): void {
    this.#officialChainPending = false;
    if (this.#chosen?.id !== candidate.id) this.#stalledAttempts = 0;
    this.#chosen = candidate;
    this.#servedBy = candidate;
    this.#failed.delete(candidate.id);
    this.#options.router.served(match, candidate.id);
    const offset = requestOffset(headers);
    const validator = response.headers.etag ?? response.headers['last-modified'];
    const range = parseContentRange(response.headers['content-range']);
    // A ranged request answered in full, or with another copy's bytes, makes the engine start over.
    const restarts = offset > 0 && (response.statusCode !== 206 || range?.start !== offset || validator !== headers['if-range']);
    this.#lastAttempt = { id: candidate.id, offset, restarts };
  }

  #markFailed(match: DownloadSourceMatch, candidate: DownloadCandidate): void {
    this.#officialChainPending = false;
    this.#failed.add(candidate.id);
    if (this.#chosen?.id === candidate.id) this.#chosen = undefined;
    this.#options.router.failed(match, candidate.id);
  }
}

/**
 * True when a mirror's answer can go to the engine: the right file, honouring Range when asked.
 * A 200 to a ranged request whose validator still equals If-Range means the mirror ignores Range;
 * with a different validator the file changed there and the engine restarts it from zero.
 */
export function assessMirrorResponse(
  response: LocalSubtitleDownloadResponse,
  requestHeaders: Readonly<Record<string, string>>,
  expectedBytes: number,
): boolean {
  const ranged = requestHeaders.range !== undefined;
  if (response.statusCode === 206) {
    const range = parseContentRange(response.headers['content-range']);
    return !!range && range.total === expectedBytes;
  }
  if (response.statusCode === 200) {
    const length = parseLength(response.headers['content-length']);
    if (length !== undefined && length !== expectedBytes) return false;
    if (!ranged) return true;
    const ifRange = requestHeaders['if-range'];
    const validator = response.headers.etag ?? response.headers['last-modified'];
    return ifRange !== undefined && validator !== undefined && validator !== ifRange;
  }
  return response.statusCode === 416 && ranged;
}

export interface ExpectedResourceFile {
  readonly byteSize: number;
  readonly sha256: string;
  /** What the resource's own manager calls a file that fails verification. */
  readonly verificationFailedCode?: ResourceVerificationErrorCode;
}

export type ResourceVerificationErrorCode = 'model_corrupt' | 'resource_signature_invalid';

/**
 * Every source that could be tried served a file whose SHA-256 differs from the catalog. It is a
 * download error so the managers keep its code, which is the one they use themselves for a file
 * that fails verification (the engine's own download error type has no such code).
 */
export class ResourceVerificationError extends LocalSubtitleResourceDownloadError {
  constructor(readonly verificationCode: ResourceVerificationErrorCode) {
    super(verificationCode as unknown as LocalSubtitleResourceDownloadErrorCode, 'Every download source served a file that failed verification.');
  }
}

export interface ResourceDownloaderOptions {
  readonly router: DownloadSourceRouter;
  readonly request: RawDownloadRequest;
  readonly getMode: () => DownloadSourceMode;
  /** The size and SHA-256 the catalog fixes for an official address, if it is one. */
  readonly expectedFile?: (sourceUrl: string) => ExpectedResourceFile | undefined;
  readonly download?: typeof downloadLocalSubtitleResource;
  /** Reads a finished file to check it; only needed when it did not stream through in one piece. */
  readonly hashFile?: typeof fileHasSha256;
  readonly transientRetryDelaysMs?: readonly number[];
  readonly maxResumeRounds?: number;
  readonly resumeRoundDelayMs?: number;
}

export type ResourceDownloader = (options: DownloadLocalSubtitleResourceOptions) => Promise<LocalSubtitleResourceDownloadResult>;

/**
 * Wraps the engine download with download sources and the proxy. It also keeps going on a poor
 * connection: more spaced-out retries, and a fresh (resuming) attempt after one that failed but
 * left a longer partial file (bytes that were thrown away again do not count). A finished file is checked against the catalog's SHA-256 before the manager sees
 * it (from the bytes as they streamed through, or by reading a mirror's file again); a mismatch
 * removes it and downloads it again from a source not tried yet.
 */
export function createResourceDownloader(options: ResourceDownloaderOptions): ResourceDownloader {
  const download = options.download ?? downloadLocalSubtitleResource;
  const hashFile = options.hashFile ?? fileHasSha256;
  const maxResumeRounds = options.maxResumeRounds ?? DOWNLOAD_TRANSPORT_POLICY.maxResumeRounds;
  const resumeRoundDelayMs = options.resumeRoundDelayMs ?? DOWNLOAD_TRANSPORT_POLICY.resumeRoundDelayMs;
  return async input => {
    // An explicit opener (tests, diagnostics) is used exactly as given.
    if (input.openResponse) return download(input);
    const transport = new DownloadSourceTransport({
      router: options.router,
      request: options.request,
      sourceUrl: input.sourceUrl,
      expectedBytes: input.expectedBytes,
      mode: options.getMode(),
    });
    const catalog = options.expectedFile?.(input.sourceUrl);
    const expected = catalog && catalog.byteSize === input.expectedBytes ? catalog : undefined;
    let rounds = 0;
    while (true) {
      const before = await partialBytes(input);
      let result: LocalSubtitleResourceDownloadResult;
      try {
        result = await download({
          ...input,
          openResponse: transport.open,
          transientRetryDelaysMs: input.transientRetryDelaysMs
            ?? options.transientRetryDelaysMs ?? DOWNLOAD_TRANSPORT_POLICY.transientRetryDelaysMs,
        });
      } catch (error) {
        const resumable = error instanceof LocalSubtitleResourceDownloadError && error.code === 'model_download_failed';
        if (input.signal.aborted || !resumable || rounds >= maxResumeRounds || await partialBytes(input) <= before) throw error;
        rounds += 1;
        await delay(resumeRoundDelayMs, input.signal);
        continue;
      }
      if (!expected) return result;
      const servedBy = transport.servedBy;
      const streamed = transport.streamedSha256(input.expectedBytes);
      // The publisher's own file that did not stream through in one piece is left to the manager's check.
      const verified = streamed !== undefined
        ? streamed === expected.sha256.toLowerCase()
        : !servedBy || servedBy.official || await hashFile(input.destinationPath, expected.sha256, input.signal);
      if (verified) return result;
      await rm(input.destinationPath, { force: true });
      if (!servedBy || !transport.reject(servedBy.id)) {
        throw new ResourceVerificationError(expected.verificationFailedCode ?? 'model_corrupt');
      }
    }
  };
}

export async function fileHasSha256(filePath: string, sha256: string, signal: AbortSignal): Promise<boolean> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024, signal })) hash.update(chunk as Buffer);
  return hash.digest('hex') === sha256.toLowerCase();
}

async function followRedirects(
  request: RawDownloadRequest,
  start: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<LocalSubtitleDownloadResponse> {
  let url = start;
  for (let hop = 0; ; hop += 1) {
    const response = await request(url, headers, signal);
    if (!REDIRECT_STATUSES.has(response.statusCode)) return response;
    const location = response.headers.location;
    response.discard();
    if (!location || hop >= DOWNLOAD_TRANSPORT_POLICY.maxMirrorRedirects) throw new Error('The download source redirected too often.');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password) throw new Error('The download source redirected to an unsafe address.');
    url = next;
  }
}

function withoutLocation(response: LocalSubtitleDownloadResponse): LocalSubtitleDownloadResponse {
  return Object.freeze({
    statusCode: response.statusCode,
    headers: Object.freeze({ ...response.headers, location: undefined }),
    body: response.body,
    discard: () => response.discard(),
  });
}

function unavailableResponse(): LocalSubtitleDownloadResponse {
  return Object.freeze({
    statusCode: 503,
    headers: Object.freeze({ 'content-length': '0' }),
    body: (async function* () { /* empty */ })(),
    discard: () => undefined,
  });
}

function officialOf(sourceUrl: string): DownloadCandidate {
  return { id: 'official', url: sourceUrl, official: true, domestic: false };
}

function moveFirst(order: readonly DownloadCandidate[], id: string): DownloadCandidate[] {
  const found = order.find(candidate => candidate.id === id);
  return found ? [found, ...order.filter(candidate => candidate.id !== id)] : [...order];
}

function moveLast(order: readonly DownloadCandidate[], id: string): DownloadCandidate[] {
  const found = order.find(candidate => candidate.id === id);
  return found ? [...order.filter(candidate => candidate.id !== id), found] : [...order];
}

function rankIndex(ranking: readonly string[], id: string): number {
  const index = ranking.indexOf(id);
  return index < 0 ? ranking.length : index;
}

function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![start, end, total].every(Number.isSafeInteger) || end < start || total <= end) return undefined;
  return { start, end, total };
}

function parseLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value[0] : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** How much of the file the engine has kept for resuming (its partial file), 0 when none. */
async function partialBytes(input: DownloadLocalSubtitleResourceOptions): Promise<number> {
  try {
    const stats = await lstat(path.join(input.downloadDirectory, input.partFileName));
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

/** The byte a request starts at: N for "Range: bytes=N-", otherwise 0. */
function requestOffset(headers: Readonly<Record<string, string>>): number {
  const match = /^bytes=(\d+)-$/.exec(headers.range ?? '');
  return match ? Number(match[1]) : 0;
}
