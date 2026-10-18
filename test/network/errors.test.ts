import { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';
import { classifyNetworkError, isConnectivityFailure } from '../../electron/main/network/errors';
import { ProxyConnectionError } from '../../electron/main/network/tunnel';

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('network error classification', () => {
  it('maps Node socket and DNS codes to categories', () => {
    const cases: [string, string][] = [
      ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'],
      ['ETIMEDOUT', 'timeout'], ['ECONNABORTED', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['ERR_TLS_HANDSHAKE_TIMEOUT', 'timeout'],
      ['ECONNREFUSED', 'refused'],
      ['ECONNRESET', 'reset'], ['EPIPE', 'reset'],
      ['ENETUNREACH', 'network_unreachable'], ['EHOSTUNREACH', 'network_unreachable'],
      ['CERT_HAS_EXPIRED', 'tls'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'], ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'], ['EPROTO', 'tls'],
      ['ERR_CANCELED', 'aborted'],
    ];
    for (const [code, category] of cases) expect(classifyNetworkError(coded(code)), code).toBe(category);
  });

  it('looks through axios wrappers, causes and AggregateError', () => {
    const axiosError = AxiosError.from(coded('ENOTFOUND'), 'ENOTFOUND');
    expect(classifyNetworkError(axiosError)).toBe('dns');
    expect(classifyNetworkError(new Error('request failed', { cause: coded('ECONNRESET') }))).toBe('reset');
    expect(classifyNetworkError(new AggregateError([coded('ETIMEDOUT'), coded('ENETUNREACH')], 'all attempts failed'))).toBe('timeout');
    expect(classifyNetworkError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe('aborted');
    expect(classifyNetworkError(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))).toBe('timeout');
  });

  it('blames the proxy whenever the failure happened at or through it', () => {
    const refused = new ProxyConnectionError('down', 'ECONNREFUSED', '127.0.0.1:7890', undefined, { cause: coded('ECONNREFUSED') });
    // axios copies the code to its own error; the proxy error is still found in the chain.
    expect(classifyNetworkError(AxiosError.from(refused, 'ECONNREFUSED'))).toBe('proxy_failed');
    expect(classifyNetworkError(new ProxyConnectionError('407', 'ERR_PROXY_AUTH_REQUIRED', 'p:1', 407))).toBe('proxy_auth');
    expect(classifyNetworkError(Object.assign(new Error('Proxy Authentication Required'), { response: { status: 407 } }))).toBe('proxy_auth');
  });

  it('understands Chromium net errors as electron-updater reports them', () => {
    expect(classifyNetworkError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toBe('proxy_failed');
    expect(classifyNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('dns');
    expect(classifyNetworkError(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toBe('timeout');
    expect(classifyNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('network_unreachable');
    expect(classifyNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('tls');
    expect(classifyNetworkError(new Error('socket hang up'))).toBe('reset');
  });

  it('treats a server answer or a non-network error as unknown', () => {
    const answered = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });
    expect(classifyNetworkError(answered)).toBe('unknown');
    expect(classifyNetworkError(new TypeError('bad input'))).toBe('unknown');
    expect(classifyNetworkError(undefined)).toBe('unknown');
    expect(classifyNetworkError('ECONNRESET')).toBe('unknown');
    expect(isConnectivityFailure('dns')).toBe(true);
    expect(isConnectivityFailure('aborted')).toBe(false);
    expect(isConnectivityFailure('unknown')).toBe(false);
  });

  it('stops on cyclic causes', () => {
    const first: Error & { cause?: unknown } = new Error('first');
    const second: Error & { cause?: unknown } = new Error('second', { cause: first });
    first.cause = second;
    expect(classifyNetworkError(first)).toBe('unknown');
  });
});
