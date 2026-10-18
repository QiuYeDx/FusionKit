import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessMirrorResponse, createHttpsDownloadRequest, createResourceDownloader, DOWNLOAD_TRANSPORT_POLICY, DownloadSourceRouter, fileHasSha256,
  ResourceVerificationError, type RawDownloadRequest, type ResourceDownloaderOptions,
} from '../../electron/main/network/download-transport';
import { ProxyConnectionError } from '../../electron/main/network/tunnel';
import { ProxyAwareHttpsAgent } from '../../electron/main/network/agent';
import { matchDownloadSources } from '../../electron/main/network/download-sources';
import { LocalSubtitleResourceDownloadError, type LocalSubtitleDownloadResponse } from '../../electron/main/speech-resources/engine/resource-download';
import { LOCALHOST_TEST_CERT } from './localhost-test-cert';
import { closeAllServers, startConnectProxy, startHttpsServer } from './local-servers';

const OFFICIAL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3-q5_0.bin?download=true';
const OTHER_OFFICIAL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3.bin?download=true';
const FILE = 'ggml-large-v3-q5_0.bin';
const MS = (owner: string, file = FILE) => `https://www.modelscope.cn/models/${owner}/whisper.cpp/resolve/master/${file}`;
const CJC = MS('cjc1887415157');
const VIGGO = MS('viggocx');
const ICE = MS('iceCream2025');
const HF_MIRROR = OFFICIAL.replace('https://huggingface.co', 'https://hf-mirror.com');
const BYTES = Buffer.from('FusionKit test model bytes: 0123456789abcdefghijklmnopqrstuvwxyz'.repeat(4));
const SHA = createHash('sha256').update(BYTES).digest('hex');

const roots: string[] = [];
afterEach(async () => {
  await closeAllServers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

type Handler = (url: URL, headers: Readonly<Record<string, string>>, call: number) => Reply | Promise<Reply>;
interface Reply {
  readonly status: number;
  readonly headers?: Record<string, string | undefined>;
  readonly chunks?: readonly Buffer[];
  /** Fails the body with ECONNRESET after the chunks. */
  readonly breakAfter?: boolean;
  readonly delayMs?: number;
}

const refused = (): never => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };

/** A file server with Range and If-Range semantics; `ignoreRange` imitates gh-proxy.com. */
function file(options: { bytes?: Buffer; etag?: string; ignoreRange?: boolean; ignoreIfRange?: boolean; delayMs?: number; breakAt?: (call: number) => number | undefined } = {}): Handler {
  const bytes = options.bytes ?? BYTES;
  const etag = options.etag ?? '"etag-1"';
  return (_url, headers, call) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '');
    const validatorMatches = !headers['if-range'] || options.ignoreIfRange || headers['if-range'] === etag;
    let start = 0; let end = bytes.length - 1; let status = 200;
    if (range && !options.ignoreRange && validatorMatches) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      status = 206;
    }
    const breakAt = options.breakAt?.(call);
    const slice = bytes.subarray(start, breakAt !== undefined ? Math.min(end + 1, start + breakAt) : end + 1);
    return {
      status,
      delayMs: options.delayMs,
      headers: {
        etag,
        'content-length': String(end - start + 1),
        ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
      chunks: [slice],
      breakAfter: breakAt !== undefined && start + breakAt <= end,
    };
  };
}

function redirect(location: string): Handler {
  return () => ({ status: 302, headers: { location } });
}

function fakeNetwork(routes: Record<string, Handler>) {
  const log: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const calls = new Map<string, number>();
  const request: RawDownloadRequest = async (url, headers, signal) => {
    log.push({ url: url.href, headers });
    const handler = routes[url.href];
    if (!handler) refused();
    const call = (calls.get(url.href) ?? 0) + 1;
    calls.set(url.href, call);
    const reply = await handler!(url, headers, call);
    if (reply.delayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, reply.delayMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    let discarded = false;
    const chunks = reply.chunks ?? [];
    return {
      statusCode: reply.status,
      headers: { location: undefined, etag: undefined, 'last-modified': undefined, 'content-length': undefined, 'content-range': undefined, ...reply.headers },
      body: (async function* () {
        for (const chunk of chunks) { if (discarded) return; yield chunk; }
        if (reply.breakAfter) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      })(),
      discard: () => { discarded = true; },
    } satisfies LocalSubtitleDownloadResponse;
  };
  const probes = () => log.filter(entry => entry.headers.range === 'bytes=0-0').map(entry => entry.url);
  const downloads = () => log.filter(entry => entry.headers.range !== 'bytes=0-0').map(entry => entry.url);
  return { request, log, probes, downloads };
}

async function fixture(name = 'model') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-net-'));
  roots.push(root);
  return (sourceUrl = OFFICIAL, overrides: Record<string, unknown> = {}) => ({
    sourceUrl,
    allowedHosts: ['huggingface.co', '*.hf.co'],
    expectedBytes: BYTES.length,
    downloadDirectory: root,
    partFileName: `${name}.part`,
    metadataFileName: `${name}.part.json`,
    destinationPath: path.join(root, `${name}-${Math.random().toString(36).slice(2)}.bin`),
    signal: new AbortController().signal,
    ensureCapacity: async () => undefined,
    metadataSyncBytes: 8,
    ...overrides,
  });
}

function downloader(network: ReturnType<typeof fakeNetwork>, options: Partial<ResourceDownloaderOptions> & { router?: DownloadSourceRouter } = {}) {
  const router = options.router ?? new DownloadSourceRouter({ request: network.request, probeTimeoutMs: 1_000 });
  return {
    router,
    download: createResourceDownloader({
      router,
      request: network.request,
      getMode: () => 'auto',
      expectedFile: () => ({ byteSize: BYTES.length, sha256: SHA }),
      transientRetryDelaysMs: [0, 0, 0],
      resumeRoundDelayMs: 0,
      ...options,
    }),
  };
}

describe('automatic download source selection', () => {
  it('measures all sources at once, downloads from the fastest resumable one and reuses the ranking for the group', async () => {
    const network = fakeNetwork({
      [OFFICIAL]: () => refused(),
      [CJC]: () => ({ status: 404 }),
      [VIGGO]: file({ delayMs: 40 }),
      [ICE]: file({ delayMs: 5 }),
      [HF_MIRROR]: file({ ignoreRange: true }),
      [OTHER_OFFICIAL]: () => refused(),
      [MS('iceCream2025', 'ggml-large-v3.bin')]: file(),
    });
    const { router, download } = downloader(network);
    const options = await fixture();
    const result = await download(options(OFFICIAL));
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(result.effectiveUrl).toBe(new URL(OFFICIAL).href);
    expect(network.probes().sort()).toEqual([OFFICIAL, CJC, VIGGO, ICE, HF_MIRROR].map(url => new URL(url).href).sort());
    expect(network.downloads()).toEqual([ICE]);
    // Resumable and fast first; a mirror ignoring Range counts as failed like the unreachable ones.
    expect(router.ranking('huggingface-whisper')).toEqual(['modelscope-icecream2025', 'modelscope-viggocx', 'official', 'modelscope-cjc1887415157', 'hf-mirror']);

    const before = network.probes().length;
    const second = await download((await fixture('other'))(OTHER_OFFICIAL));
    expect(await readFile(second.absolutePath)).toEqual(BYTES);
    expect(network.probes().length).toBe(before);
    expect(network.downloads().at(-1)).toBe(MS('iceCream2025', 'ggml-large-v3.bin'));
  });

  it('hands official redirects to the engine unchanged and fails over when the redirect target breaks', async () => {
    const cdn = 'https://cas-bridge.xethub.hf.co/xet/model.bin';
    const network = fakeNetwork({
      [OFFICIAL]: redirect(cdn),
      // The probe succeeds; the real download's connection to the CDN then fails.
      [cdn]: (url, headers, call) => call === 1 ? file()(url, headers, call) : refused(),
      [CJC]: file({ delayMs: 30 }),
      [VIGGO]: () => ({ status: 503 }),
      [ICE]: () => ({ status: 503 }),
      [HF_MIRROR]: () => ({ status: 503 }),
    });
    const { download } = downloader(network);
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(network.downloads().slice(0, 2)).toEqual([new URL(OFFICIAL).href, cdn]);
    expect(network.downloads()).toContain(CJC);
  });

  it('follows a mirror redirect itself (https only) and skips a mirror that redirects to http', async () => {
    const network = fakeNetwork({
      [CJC]: redirect('http://insecure.example/model.bin'),
      [VIGGO]: redirect('https://cdn.modelscope.example/model.bin'),
      'https://cdn.modelscope.example/model.bin': file(),
    });
    const { download } = downloader(network, { getMode: () => 'mirror' });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    // The engine only ever saw the official address: no mirror host in its allowlist was needed.
    expect(result.effectiveUrl).toBe(new URL(OFFICIAL).href);
    expect(network.downloads()).toEqual([CJC, VIGGO, 'https://cdn.modelscope.example/model.bin']);
    expect(network.probes()).toEqual([]);
  });

  it('uses only the official address, without measuring, in official mode', async () => {
    const network = fakeNetwork({ [OFFICIAL]: file() });
    const { download } = downloader(network, { getMode: () => 'official' });
    await download((await fixture())());
    expect(network.log.map(entry => entry.url)).toEqual([new URL(OFFICIAL).href]);
  });

  it('asks again after a passing proxy refusal in official mode instead of failing at once', async () => {
    const network = fakeNetwork({
      [OFFICIAL]: (url, headers, call) => {
        if (call === 1) throw new ProxyConnectionError('The proxy refused the tunnel (HTTP 502).', 'ERR_PROXY_CONNECT', '127.0.0.1:7890', 502);
        return file()(url, headers, call);
      },
    });
    const { download } = downloader(network, { getMode: () => 'official' });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(network.log.map(entry => entry.url)).toEqual([new URL(OFFICIAL).href, new URL(OFFICIAL).href]);
  });

  it('does not retry a proxy that wants a password', async () => {
    const network = fakeNetwork({
      [OFFICIAL]: () => { throw new ProxyConnectionError('The proxy requires a user name and password.', 'ERR_PROXY_AUTH_REQUIRED', '127.0.0.1:7890', 407); },
    });
    const { download } = downloader(network, { getMode: () => 'official' });
    await expect(download((await fixture())())).rejects.toBeInstanceOf(LocalSubtitleResourceDownloadError);
    expect(network.log).toHaveLength(1);
  });
});

describe('resuming and switching sources', () => {
  it('resumes from the same source inside one download', async () => {
    const network = fakeNetwork({ [CJC]: file({ breakAt: call => (call === 1 ? 50 : undefined) }) });
    const { download } = downloader(network, { getMode: () => 'mirror' });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(network.downloads()).toEqual([CJC, CJC]);
    expect(network.log[1]!.headers).toMatchObject({ range: 'bytes=50-', 'if-range': '"etag-1"' });
  });

  it('never wedges: a mirror that ignores Range or changed its file only makes the file start over', async () => {
    const network = fakeNetwork({
      // First answer breaks half way; then this mirror ignores Range but keeps its validator.
      [CJC]: (url, headers, call) => file({ breakAt: () => (call === 1 ? 40 : undefined), ignoreRange: call > 1, etag: '"a"' })(url, headers, call),
      // Down, so the next one is tried.
      [VIGGO]: () => refused(),
      // A different copy: it honours Range but ignores If-Range and has its own validator.
      [ICE]: file({ etag: '"b"', ignoreIfRange: true }),
    });
    const { download } = downloader(network, { getMode: () => 'mirror' });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    const ice = network.log.filter(entry => entry.url === ICE).map(entry => entry.headers.range ?? 'full');
    // The engine refused to append "b" bytes to an "a" partial file and restarted from zero.
    expect(ice).toEqual(['bytes=40-', 'full']);
    expect(result.resumedBytes).toBe(0);
  });

  it('gives way to the next source when the chosen one keeps adding nothing to the file', async () => {
    // A copy without content length or validator whose body always stops early: every attempt starts over.
    const network = fakeNetwork({
      [CJC]: () => ({ status: 200, chunks: [BYTES.subarray(0, 30)] }),
      [VIGGO]: file(),
    });
    const { download } = downloader(network, { getMode: () => 'mirror' });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(network.downloads().filter(url => url === CJC)).toHaveLength(DOWNLOAD_TRANSPORT_POLICY.maxStalledAttempts);
    expect(network.downloads().at(-1)).toBe(VIGGO);
  });

  it('after a restart, resumes from the source whose validator matches the partial file', async () => {
    const shared = (await fixture())();
    // First launch, mirror mode: cjc is down, viggocx breaks after 60 bytes and no retry is left.
    const firstLaunch = fakeNetwork({
      [CJC]: () => refused(),
      [VIGGO]: file({ etag: '"viggo"', breakAt: call => (call === 1 ? 60 : undefined) }),
    });
    const first = downloader(firstLaunch, { getMode: () => 'mirror', transientRetryDelaysMs: [], maxResumeRounds: 0 });
    await expect(first.download({ ...shared })).rejects.toBeInstanceOf(LocalSubtitleResourceDownloadError);
    // Second launch, auto mode, nothing remembered: viggocx is the slowest, but its validator matches.
    const secondLaunch = fakeNetwork({
      [OFFICIAL]: file({ etag: '"official"', delayMs: 1 }),
      [CJC]: file({ etag: '"cjc"', delayMs: 1 }),
      [VIGGO]: file({ etag: '"viggo"', delayMs: 25 }),
      [ICE]: file({ etag: '"ice"', delayMs: 1 }),
      [HF_MIRROR]: file({ etag: '"official"', delayMs: 1 }),
    });
    // The first 60 bytes came from the earlier launch, so the finished file is read once to check it.
    const hashFile = vi.fn(fileHasSha256);
    const result = await downloader(secondLaunch, { hashFile }).download({ ...shared });
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(hashFile).toHaveBeenCalledOnce();
    expect(result.resumedBytes).toBe(60);
    expect(secondLaunch.downloads()).toEqual([VIGGO]);
    expect(secondLaunch.log.at(-1)!.headers).toMatchObject({ range: 'bytes=60-', 'if-range': '"viggo"' });
  });

  it('removes a mirror file that fails SHA-256 and downloads it again from the next source', async () => {
    const corrupt = Buffer.from(BYTES);
    corrupt[3] ^= 0xff;
    const network = fakeNetwork({ [CJC]: file({ bytes: corrupt }), [VIGGO]: file() });
    // Both files streamed through in one piece, so neither is read a second time.
    const hashFile = vi.fn(fileHasSha256);
    const { router, download } = downloader(network, { getMode: () => 'mirror', hashFile });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(network.downloads()).toEqual([CJC, VIGGO]);
    expect(hashFile).not.toHaveBeenCalled();
    // Later downloads of this file in this launch try the bad copy last.
    const plan = await router.plan(matchDownloadSources(OFFICIAL)!, {
      mode: 'mirror', expectedBytes: BYTES.length, signal: new AbortController().signal,
    });
    expect(plan.at(-1)!.id).toBe('modelscope-cjc1887415157');
  });

  it('downloads each source at most once when every one serves a wrong file, then reports a verification failure', async () => {
    const corrupt = Buffer.from(BYTES);
    corrupt[5] ^= 0xff;
    const network = fakeNetwork(Object.fromEntries([OFFICIAL, CJC, VIGGO, ICE, HF_MIRROR].map(url => [new URL(url).href, file({ bytes: corrupt })])));
    const { download } = downloader(network, { getMode: () => 'mirror', expectedFile: () => ({ byteSize: BYTES.length, sha256: SHA, verificationFailedCode: 'resource_signature_invalid' }) });
    const options = (await fixture())();
    const error = await download(options).catch(failure => failure);
    expect(error).toBeInstanceOf(ResourceVerificationError);
    expect(error.code).toBe('resource_signature_invalid');
    const counts = new Map<string, number>();
    for (const url of network.downloads()) counts.set(url, (counts.get(url) ?? 0) + 1);
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1]);
    await expect(readFile(options.destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks the publisher file as it streams and reports a mismatch at once in official mode', async () => {
    const corrupt = Buffer.from(BYTES);
    corrupt[0] ^= 0xff;
    const network = fakeNetwork({ [OFFICIAL]: file({ bytes: corrupt }) });
    const { download } = downloader(network, { getMode: () => 'official' });
    const error = await download((await fixture())()).catch(failure => failure);
    expect(error).toBeInstanceOf(ResourceVerificationError);
    expect(error.code).toBe('model_corrupt');
    expect(network.log).toHaveLength(1);
  });

  it('keeps going on a poor connection while each attempt still makes progress', async () => {
    // Every answer breaks after 20 more bytes; one engine retry each time, then a fresh attempt.
    const network = fakeNetwork({ [CJC]: file({ breakAt: () => 20 }) });
    const { download } = downloader(network, { getMode: () => 'mirror', transientRetryDelaysMs: [0] });
    const result = await download((await fixture())());
    expect(await readFile(result.absolutePath)).toEqual(BYTES);
    expect(network.downloads().length).toBe(Math.ceil(BYTES.length / 20));
  });

  it('ends with the engine\'s download failure when every source is down', async () => {
    const network = fakeNetwork({});
    const { download } = downloader(network, { transientRetryDelaysMs: [0, 0] });
    const error = await download((await fixture())()).catch(failure => failure);
    expect(error).toBeInstanceOf(LocalSubtitleResourceDownloadError);
    expect(error.code).toBe('model_download_failed');
  });

  it('stops promptly when the download is cancelled while sources are measured', async () => {
    const network = fakeNetwork({ [OFFICIAL]: file({ delayMs: 5_000 }), [CJC]: file({ delayMs: 5_000 }) });
    const { download } = downloader(network);
    const controller = new AbortController();
    const started = Date.now();
    const pending = download({ ...(await fixture())(), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('mirror answer checks', () => {
  const response = (statusCode: number, headers: Record<string, string>): LocalSubtitleDownloadResponse => ({
    statusCode, headers, body: (async function* () { /* empty */ })(), discard: () => undefined,
  });
  it('accepts only the right file and honoured ranges', () => {
    expect(assessMirrorResponse(response(206, { 'content-range': 'bytes 10-99/100' }), { range: 'bytes=10-' }, 100)).toBe(true);
    expect(assessMirrorResponse(response(206, { 'content-range': 'bytes 10-99/120' }), { range: 'bytes=10-' }, 100)).toBe(false);
    expect(assessMirrorResponse(response(200, { 'content-length': '100' }), {}, 100)).toBe(true);
    expect(assessMirrorResponse(response(200, { 'content-length': '99' }), {}, 100)).toBe(false);
    expect(assessMirrorResponse(response(200, { etag: '"x"' }), { range: 'bytes=10-', 'if-range': '"x"' }, 100)).toBe(false);
    expect(assessMirrorResponse(response(200, { etag: '"y"' }), { range: 'bytes=10-', 'if-range': '"x"' }, 100)).toBe(true);
    expect(assessMirrorResponse(response(416, {}), { range: 'bytes=10-' }, 100)).toBe(true);
    expect(assessMirrorResponse(response(404, {}), {}, 100)).toBe(false);
  });
});

describe('https download requests', () => {
  it('download through the proxy-aware agent and cut a body that stops sending', async () => {
    const server = await startHttpsServer((request, response) => {
      if (request.url === '/stall') { response.writeHead(200, { 'content-length': '10' }); response.write('12345'); return; }
      response.end('whole file');
    });
    const proxy = await startConnectProxy();
    const agent = new ProxyAwareHttpsAgent({ routes: { generation: 0, resolve: async () => [{ kind: 'http', host: '127.0.0.1', port: proxy.port }] } }, { ca: LOCALHOST_TEST_CERT });
    const request = createHttpsDownloadRequest({ agent, idleTimeoutMs: 150 });
    try {
      const ok = await request(new URL(`https://localhost:${server.port}/file`), { 'accept-encoding': 'identity' }, new AbortController().signal);
      const chunks: Buffer[] = [];
      for await (const chunk of ok.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('whole file');
      expect(proxy.connects).toEqual([`localhost:${server.port}`]);

      const stalled = await request(new URL(`https://localhost:${server.port}/stall`), {}, new AbortController().signal);
      const started = Date.now();
      const error = await (async () => { for await (const _chunk of stalled.body) { /* drain */ } })().catch(failure => failure);
      expect(error).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(request(new URL('http://localhost/'), {}, new AbortController().signal)).rejects.toMatchObject({ code: 'ERR_INVALID_PROTOCOL' });
    } finally { agent.destroy(); }
  });
});
