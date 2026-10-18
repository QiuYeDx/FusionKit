/**
 * Proxy addresses as people type them. The main process connects through what this accepts and
 * the settings page warns about what it refuses, so the two can never disagree about an address.
 */
export type ProxyServerKind = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyServerAddress {
  readonly kind: ProxyServerKind;
  readonly host: string;
  readonly port: number;
}

/** Why a custom proxy cannot be used: not filled in, carries a password, or not an address. */
export type CustomProxyProblem = 'incomplete' | 'credentials' | 'invalid';

export type CustomProxyCheck =
  | { readonly ok: true; readonly address: ProxyServerAddress }
  | { readonly ok: false; readonly problem: CustomProxyProblem };

export const PROXY_URL_SCHEMES: Readonly<Record<string, ProxyServerKind | undefined>> = Object.freeze({
  http: 'http', https: 'https', socks: 'socks5', socks5: 'socks5', socks5h: 'socks5', socks4: 'socks4', socks4a: 'socks4',
});

/**
 * Checks the custom proxy typed in settings. The host may carry a scheme ("socks5://127.0.0.1")
 * and even the port; an empty port field then takes it from the host. A full-width colon, as an
 * IME types it, counts as a colon.
 */
export function checkCustomProxy(hostInput: string, portInput: string): CustomProxyCheck {
  let host = hostInput.trim().replace(/：/g, ':');
  const portText = portInput.trim();
  let kind: ProxyServerKind = 'http';
  const scheme = /^([a-z0-9]+):\/\//i.exec(host);
  if (scheme) {
    const named = PROXY_URL_SCHEMES[scheme[1]!.toLowerCase()];
    if (!named) return problem('invalid');
    kind = named;
    host = host.slice(scheme[0].length);
  }
  host = host.replace(/\/+$/, '');
  if (!host) return problem('incomplete');
  if (host.includes('@')) return problem('credentials');
  const address = splitHostPort(host);
  if (!address) return problem('invalid');
  if (portText && !/^\d{1,5}$/.test(portText)) return problem('invalid');
  const port = portText ? Number(portText) : address.port;
  if (port === undefined) return problem('incomplete');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return problem('invalid');
  return Object.freeze({ ok: true, address: Object.freeze({ kind, host: address.host, port }) });
}

/** The custom proxy as an address, or undefined when it cannot be used (requests then go direct). */
export function parseCustomProxy(hostInput: string, portInput: string): ProxyServerAddress | undefined {
  const check = checkCustomProxy(hostInput, portInput);
  return check.ok ? check.address : undefined;
}

/**
 * "host", "host:port", "[v6]" or "[v6]:port"; a bare IPv6 address (several colons) has no port.
 * The port is undefined when absent; invalid input yields undefined.
 */
export function splitHostPort(value: string): { host: string; port: number | undefined } | undefined {
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(value);
  let host: string;
  let portText: string | undefined;
  if (bracketed) {
    host = bracketed[1]!;
    portText = bracketed[2];
  } else {
    const colon = value.lastIndexOf(':');
    if (colon > 0 && value.indexOf(':') === colon) {
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
    } else {
      host = value;
    }
  }
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host) || host.length > 253) return undefined;
  if (portText !== undefined && !/^\d{1,5}$/.test(portText)) return undefined;
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && port > 65_535) return undefined;
  return { host, port };
}

function problem(value: CustomProxyProblem): CustomProxyCheck {
  return Object.freeze({ ok: false, problem: value });
}
