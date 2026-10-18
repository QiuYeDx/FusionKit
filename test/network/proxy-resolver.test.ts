import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings } from '../../src/network/contract';
import {
  describeRoute, environmentProxyRoute, isLoopbackHost, parseCustomProxy, parseProxyRules, ProxyResolver,
} from '../../electron/main/network/proxy-resolver';
import { checkCustomProxy } from '../../src/network/proxy-address';

const settings = (proxy: Partial<NetworkSettings['proxy']>): NetworkSettings => ({
  ...DEFAULT_NETWORK_SETTINGS, proxy: { ...DEFAULT_NETWORK_SETTINGS.proxy, ...proxy },
});

describe('PAC answer parsing', () => {
  it('keeps the order of a PAC list and maps each keyword like Chromium', () => {
    expect(parseProxyRules('PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7891; DIRECT')).toEqual([
      { kind: 'http', host: '127.0.0.1', port: 7890 },
      { kind: 'socks5', host: '127.0.0.1', port: 7891 },
      { kind: 'direct' },
    ]);
    expect(parseProxyRules('HTTPS proxy.corp:8443;SOCKS socks.corp:1080')).toEqual([
      { kind: 'https', host: 'proxy.corp', port: 8443 },
      { kind: 'socks4', host: 'socks.corp', port: 1080 },
    ]);
  });

  it('fills in default ports, understands IPv6 and skips what it cannot use', () => {
    expect(parseProxyRules('PROXY proxy.corp')).toEqual([{ kind: 'http', host: 'proxy.corp', port: 80 }]);
    expect(parseProxyRules('PROXY [::1]:3128')).toEqual([{ kind: 'http', host: '::1', port: 3128 }]);
    expect(parseProxyRules('QUIC quic.corp:443; PROXY bad host; PROXY ok.corp:99999; SOCKS5 s.corp:1080'))
      .toEqual([{ kind: 'socks5', host: 's.corp', port: 1080 }]);
    expect(parseProxyRules('')).toEqual([{ kind: 'direct' }]);
    expect(parseProxyRules('garbage;;')).toEqual([{ kind: 'direct' }]);
  });

  it('reads a custom proxy with or without scheme and port in the host field', () => {
    expect(parseCustomProxy('127.0.0.1', '7890')).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 });
    expect(parseCustomProxy('http://127.0.0.1:7890/', '')).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 });
    expect(parseCustomProxy('socks5://127.0.0.1', '1080')).toEqual({ kind: 'socks5', host: '127.0.0.1', port: 1080 });
    expect(parseCustomProxy(' proxy.lan:3128 ', '8080')).toEqual({ kind: 'http', host: 'proxy.lan', port: 8080 });
    for (const [host, port] of [['', '7890'], ['127.0.0.1', ''], ['ftp://x', '21'], ['127.0.0.1', '70000'], ['bad host', '1'], ['127.0.0.1', '0']]) {
      expect(parseCustomProxy(host!, port!), `${host}:${port}`).toBeUndefined();
    }
    // A colon typed with a Chinese input method counts.
    expect(parseCustomProxy('127.0.0.1：7890', '')).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 });
  });

  it('says why a custom proxy cannot be used, so the settings page can tell the user', () => {
    expect(checkCustomProxy('', '')).toEqual({ ok: false, problem: 'incomplete' });
    expect(checkCustomProxy('127.0.0.1', '')).toEqual({ ok: false, problem: 'incomplete' });
    expect(checkCustomProxy('socks5://', '1080')).toEqual({ ok: false, problem: 'incomplete' });
    expect(checkCustomProxy('http://user:secret@127.0.0.1:7890', '')).toEqual({ ok: false, problem: 'credentials' });
    for (const [host, port] of [['ss://YWVzLTI1Ni1nY20@1.2.3.4:8388', ''], ['vmess://abc', ''], ['127.0.0.1', '99999'], ['127.0.0.1', '0'], ['bad host', '1']]) {
      expect(checkCustomProxy(host!, port!), `${host}:${port}`).toEqual({ ok: false, problem: 'invalid' });
    }
    expect(checkCustomProxy(' 127.0.0.1 ', '7890')).toEqual({ ok: true, address: { kind: 'http', host: '127.0.0.1', port: 7890 } });
  });

  it('describes routes for the user and recognizes loopback hosts', () => {
    expect(describeRoute({ kind: 'direct' })).toBeNull();
    expect(describeRoute({ kind: 'http', host: '127.0.0.1', port: 7890 })).toBe('127.0.0.1:7890');
    expect(describeRoute({ kind: 'socks5', host: '::1', port: 1080 })).toBe('socks5://[::1]:1080');
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.8.9.1', '[::1]', '::1']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['example.com', '10.0.0.1', '192.168.1.1', 'localhost.example.com']) expect(isLoopbackHost(host), host).toBe(false);
  });
});

describe('proxy resolver modes', () => {
  it('connects directly in "none" mode and through the custom proxy in "custom" mode', async () => {
    let current = settings({ mode: 'none' });
    const system = vi.fn(async () => 'PROXY 10.0.0.1:1');
    const resolver = new ProxyResolver({ getSettings: () => current, resolveSystemProxy: system });
    expect(await resolver.resolve('https://api.deepseek.com/v1')).toEqual([{ kind: 'direct' }]);
    current = settings({ mode: 'custom', host: '127.0.0.1', port: '7890' });
    expect(await resolver.resolve('https://api.deepseek.com/v1')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }]);
    current = settings({ mode: 'custom', host: '127.0.0.1', port: '' });
    expect(await resolver.resolve('https://api.deepseek.com/v1')).toEqual([{ kind: 'direct' }]);
    expect(system).not.toHaveBeenCalled();
  });

  it('asks the operating system per origin in "system" mode and keeps the answer briefly', async () => {
    let now = 1_000;
    const system = vi.fn(async (url: string) => url.includes('huggingface') ? 'PROXY 127.0.0.1:7890' : 'DIRECT');
    const resolver = new ProxyResolver({ getSettings: () => settings({ mode: 'system' }), resolveSystemProxy: system, environment: {}, cacheTtlMs: 10_000, now: () => now });
    expect(await resolver.resolve('https://huggingface.co/ggerganov/whisper.cpp/resolve/x/a.bin')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }]);
    expect(await resolver.resolve('https://huggingface.co/other')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }]);
    expect(await resolver.resolve('https://www.modelscope.cn/models')).toEqual([{ kind: 'direct' }]);
    expect(system.mock.calls.map(call => call[0])).toEqual(['https://huggingface.co/', 'https://www.modelscope.cn/']);
    now += 10_001;
    await resolver.resolve('https://huggingface.co/again');
    expect(system).toHaveBeenCalledTimes(3);
    const generation = resolver.generation;
    resolver.clear();
    expect(resolver.generation).toBe(generation + 1);
    await resolver.resolve('https://huggingface.co/again');
    expect(system).toHaveBeenCalledTimes(4);
  });

  it('never sends loopback targets to a proxy and falls back to DIRECT when the system lookup fails', async () => {
    const system = vi.fn(async () => { throw new Error('no proxy service'); });
    const resolver = new ProxyResolver({ getSettings: () => settings({ mode: 'system' }), resolveSystemProxy: system, environment: {} });
    expect(await resolver.resolve('http://127.0.0.1:11434/v1/models')).toEqual([{ kind: 'direct' }]);
    expect(system).not.toHaveBeenCalled();
    expect(await resolver.resolve('https://api.openai.com/v1')).toEqual([{ kind: 'direct' }]);
    const custom = new ProxyResolver({ getSettings: () => settings({ mode: 'custom', host: '127.0.0.1', port: '7890' }) });
    expect(await custom.resolve('http://localhost:11434/v1')).toEqual([{ kind: 'direct' }]);
    expect(await custom.resolve('not a url')).toEqual([{ kind: 'direct' }]);
  });

  it('does not hold requests when the system proxy lookup hangs', async () => {
    vi.useFakeTimers();
    try {
      const resolver = new ProxyResolver({ getSettings: () => settings({ mode: 'system' }), resolveSystemProxy: () => new Promise(() => undefined), environment: {} });
      const pending = resolver.resolve('https://example.com/');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toEqual([{ kind: 'direct' }]);
    } finally { vi.useRealTimers(); }
  });
});

describe('proxy environment variables', () => {
  it('reads HTTPS_PROXY / HTTP_PROXY / ALL_PROXY like axios did, lower case first', () => {
    const route = (url: string, environment: Record<string, string>) => environmentProxyRoute(new URL(url), environment);
    expect(route('https://api.openai.com/v1', { HTTPS_PROXY: 'http://proxy.corp:3128' })).toEqual({ kind: 'http', host: 'proxy.corp', port: 3128 });
    expect(route('https://api.openai.com/v1', { https_proxy: '127.0.0.1:7890', HTTPS_PROXY: 'http://other:1' })).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 });
    expect(route('http://lan.server:8000/v1', { HTTP_PROXY: 'http://proxy.corp' })).toEqual({ kind: 'http', host: 'proxy.corp', port: 80 });
    expect(route('https://api.openai.com/v1', { HTTP_PROXY: 'http://proxy.corp:3128' })).toBeUndefined();
    expect(route('https://api.openai.com/v1', { ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({ kind: 'socks5', host: '127.0.0.1', port: 1080 });
    expect(route('https://api.openai.com/v1', { HTTPS_PROXY: 'ftp://nope:21' })).toBeUndefined();
  });

  it('honours NO_PROXY: "*", names with their subdomains, and ports', () => {
    const route = (url: string, noProxy: string) => environmentProxyRoute(new URL(url), { HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: noProxy });
    expect(route('https://api.openai.com/', '*')).toBeUndefined();
    expect(route('https://api.corp.example/', '.corp.example')).toBeUndefined();
    expect(route('https://corp.example/', '*.corp.example')).toBeUndefined();
    expect(route('https://git.corp.example/', 'localhost, corp.example')).toBeUndefined();
    expect(route('https://notcorp.example/', 'corp.example')).toMatchObject({ host: 'proxy.corp' });
    expect(route('https://corp.example/', 'corp.example:8443')).toMatchObject({ host: 'proxy.corp' });
    expect(route('https://corp.example:8443/', 'corp.example:8443')).toBeUndefined();
  });

  it('uses them in system mode only when the operating system names no proxy', async () => {
    const environment = { HTTPS_PROXY: 'http://env.proxy:3128', NO_PROXY: 'intranet.example' };
    const direct = new ProxyResolver({ getSettings: () => settings({ mode: 'system' }), resolveSystemProxy: async () => 'DIRECT', environment });
    expect(await direct.resolve('https://api.openai.com/v1')).toEqual([{ kind: 'http', host: 'env.proxy', port: 3128 }]);
    expect(await direct.resolve('https://intranet.example/')).toEqual([{ kind: 'direct' }]);
    const system = new ProxyResolver({ getSettings: () => settings({ mode: 'system' }), resolveSystemProxy: async () => 'PROXY 127.0.0.1:7890; DIRECT', environment });
    expect(await system.resolve('https://api.openai.com/v1')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }, { kind: 'direct' }]);
    const noSession = new ProxyResolver({ getSettings: () => settings({ mode: 'system' }), environment });
    expect(await noSession.resolve('https://api.openai.com/v1')).toEqual([{ kind: 'http', host: 'env.proxy', port: 3128 }]);
    const none = new ProxyResolver({ getSettings: () => settings({ mode: 'none' }), resolveSystemProxy: async () => 'DIRECT', environment });
    expect(await none.resolve('https://api.openai.com/v1')).toEqual([{ kind: 'direct' }]);
  });
});
