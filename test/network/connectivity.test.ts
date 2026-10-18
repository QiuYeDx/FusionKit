import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NETWORK_SETTINGS, type DownloadSourceMode, type NetworkSettings } from '../../src/network/contract';
import { createReachabilityProbe, testNetworkTargets, type ReachabilityProbe } from '../../electron/main/network/connectivity';
import { ProxyAwareHttpAgent, ProxyAwareHttpsAgent } from '../../electron/main/network/agent';
import { recommendedSpeechModelUrl } from '../../electron/main/network/speech-downloads';
import { closeAllServers, startConnectProxy, startHttpServer } from './local-servers';

afterEach(closeAllServers);

const MODEL_URL = recommendedSpeechModelUrl();
const settings = (downloadSource: DownloadSourceMode, mode: NetworkSettings['proxy']['mode'] = 'system'): NetworkSettings => ({
  ...DEFAULT_NETWORK_SETTINGS, downloadSource, proxy: { mode, host: '', port: '' },
});

describe('network test targets', () => {
  it('tests configured model services, the current download source and GitHub, through the resolved route', async () => {
    const probe = vi.fn<ReachabilityProbe>(async url => {
      if (url.hostname === 'huggingface.co') throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      return { status: url.hostname === 'api.deepseek.com' ? 401 : 200 };
    });
    const result = await testNetworkTargets({
      modelEndpoints: [
        'https://api.deepseek.com/v1',
        'https://api.deepseek.com/v1/chat/completions',
        'https://user:secret@evil.example/v1',
        'ftp://files.example/v1',
        'http://127.0.0.1:11434/v1',
        '',
      ],
    }, {
      settings: settings('auto'),
      probe,
      resolveRoutes: async url => (url.includes('127.0.0.1') ? [{ kind: 'direct' }] : [{ kind: 'http', host: '127.0.0.1', port: 7890 }]),
      modelDownloadUrl: MODEL_URL,
    });
    expect(probe.mock.calls.map(([url]) => url.href)).toEqual([
      'https://api.deepseek.com/v1/models',
      'http://127.0.0.1:11434/v1/models',
      new URL(MODEL_URL).href,
      `https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-large-v3-q5_0.bin`,
      'https://github.com/',
    ]);
    expect(result.proxyMode).toBe('system');
    expect(result.targets).toEqual([
      expect.objectContaining({ kind: 'model_api', host: 'api.deepseek.com', ok: true, status: 401, via: '127.0.0.1:7890' }),
      expect.objectContaining({ kind: 'model_api', host: '127.0.0.1:11434', ok: true, via: null }),
      expect.objectContaining({ kind: 'model_download', source: 'official', host: 'huggingface.co', ok: false, category: 'dns' }),
      expect.objectContaining({ kind: 'model_download', source: 'mirror', host: 'www.modelscope.cn', ok: true }),
      expect.objectContaining({ kind: 'github', host: 'github.com', ok: true }),
    ]);
  });

  it('tests only the sources the download setting uses, and limits the number of model services', async () => {
    const probe = vi.fn<ReachabilityProbe>(async () => ({ status: 200 }));
    const run = (source: DownloadSourceMode, modelEndpoints: string[] = []) => testNetworkTargets({ modelEndpoints }, {
      settings: settings(source), probe, resolveRoutes: async () => [{ kind: 'direct' }], modelDownloadUrl: MODEL_URL,
    });
    expect((await run('official')).targets.map(target => target.source ?? target.kind)).toEqual(['official', 'github']);
    expect((await run('mirror')).targets.map(target => target.source ?? target.kind)).toEqual(['mirror', 'github']);
    const many = await run('official', Array.from({ length: 10 }, (_, index) => `https://m${index}.example/v1`));
    expect(many.targets.filter(target => target.kind === 'model_api')).toHaveLength(6);
  });

  it('reports a test that ran out of time as a timeout', async () => {
    const probe: ReachabilityProbe = (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const result = await testNetworkTargets({}, {
      settings: settings('official', 'none'), probe, resolveRoutes: async () => [{ kind: 'direct' }], modelDownloadUrl: MODEL_URL, timeoutMs: 30,
    });
    expect(result.targets.every(target => !target.ok && target.category === 'timeout')).toBe(true);
  });
});

describe('reachability probe', () => {
  it('counts any HTTP answer as reachable, sends no credentials and goes through the proxy agents', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = await startHttpServer((request, response) => { seen.push(request.headers); response.statusCode = 401; response.end('{"error":"no key"}'); });
    const proxy = await startConnectProxy();
    const routes = { generation: 0, resolve: async () => [{ kind: 'http' as const, host: '127.0.0.1', port: proxy.port }] };
    const agents = { http: new ProxyAwareHttpAgent({ routes }), https: new ProxyAwareHttpsAgent({ routes }) };
    try {
      const answer = await createReachabilityProbe(agents)(new URL(`http://localhost:${server.port}/v1/models`), AbortSignal.timeout(5_000));
      expect(answer).toEqual({ status: 401 });
      expect(proxy.forwards).toEqual([`http://localhost:${server.port}/v1/models`]);
      expect(seen[0]!.authorization).toBeUndefined();
      expect(seen[0]!.range).toBe('bytes=0-0');
    } finally { agents.http.destroy(); agents.https.destroy(); }
  });
});
