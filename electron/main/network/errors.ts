import type { NetworkErrorCategory } from '../../../src/network/contract';
import { ProxyConnectionError } from './tunnel';

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA', 'EAI_ADDRFAMILY']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_TLS_HANDSHAKE_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'ERR_HTTP2_STREAM_ERROR']);
const UNREACHABLE_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'ENONET']);
const TLS_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'HOSTNAME_MISMATCH', 'EPROTO',
]);
const ABORT_CODES = new Set(['ERR_CANCELED', 'ABORT_ERR']);
/** Chromium net errors, as electron-updater and `net` report them in messages. */
const CHROMIUM_ERRORS: readonly (readonly [RegExp, NetworkErrorCategory])[] = [
  [/net::ERR_(PROXY_AUTH_REQUESTED|PROXY_AUTH_UNSUPPORTED)/, 'proxy_auth'],
  [/net::ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|PROXY_CERTIFICATE_INVALID|SOCKS_CONNECTION_FAILED|MANDATORY_PROXY_CONFIGURATION_FAILED|PAC_SCRIPT_FAILED)/, 'proxy_failed'],
  [/net::ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)/, 'dns'],
  [/net::ERR_(CONNECTION_TIMED_OUT|TIMED_OUT)/, 'timeout'],
  [/net::ERR_CONNECTION_REFUSED/, 'refused'],
  [/net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|CONNECTION_ABORTED)/, 'reset'],
  [/net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED)/, 'network_unreachable'],
  [/net::ERR_(CERT_|SSL_|BAD_SSL_)/, 'tls'],
  [/net::ERR_ABORTED/, 'aborted'],
];

/**
 * Says why a request could not reach its server: DNS, timeout, refused, reset, no network,
 * the proxy, TLS (certificates, often an intercepting network), or aborted by the caller. Looks
 * through wrappers (axios errors, `cause`, AggregateError). A server that answered, with any HTTP
 * status, is not a network error and yields "unknown"; callers check the status first.
 */
export function classifyNetworkError(error: unknown): NetworkErrorCategory {
  const chain = errorChain(error);
  for (const item of chain) {
    if (item instanceof ProxyConnectionError || item.name === 'ProxyConnectionError') {
      return item.code === 'ERR_PROXY_AUTH_REQUIRED' ? 'proxy_auth' : 'proxy_failed';
    }
    const response = item.response as { status?: unknown } | undefined;
    if (response?.status === 407 || item.status === 407) return 'proxy_auth';
  }
  for (const item of chain) {
    const code = typeof item.code === 'string' ? item.code : '';
    if (item.name === 'AbortError' || ABORT_CODES.has(code)) return 'aborted';
    if (item.name === 'TimeoutError') return 'timeout';
    if (DNS_CODES.has(code)) return 'dns';
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (code === 'ECONNREFUSED') return 'refused';
    if (RESET_CODES.has(code)) return 'reset';
    if (UNREACHABLE_CODES.has(code)) return 'network_unreachable';
    if (TLS_CODES.has(code) || /^(CERT_|ERR_TLS_|ERR_SSL_)/.test(code)) return 'tls';
  }
  for (const item of chain) {
    const message = typeof item.message === 'string' ? item.message : '';
    for (const [pattern, category] of CHROMIUM_ERRORS) if (pattern.test(message)) return category;
    if (/timed? ?out/i.test(message)) return 'timeout';
    if (/socket hang up/i.test(message)) return 'reset';
  }
  return 'unknown';
}

/** True for categories where trying another route or download source can help. */
export function isConnectivityFailure(category: NetworkErrorCategory): boolean {
  return category !== 'aborted' && category !== 'unknown';
}

type ErrorLike = Record<string, unknown> & { name?: unknown; code?: unknown; message?: unknown; status?: unknown };

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return;
    seen.add(value);
    const item = value as ErrorLike;
    chain.push(item);
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) for (const nested of item.errors) visit(nested, depth + 1);
  };
  visit(error, 0);
  return chain;
}
