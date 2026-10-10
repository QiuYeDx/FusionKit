import { isIP } from 'node:net';

export class WebLookupError extends Error {
  constructor(public readonly code: 'web_lookup_blocked' | 'web_lookup_failed' | 'web_lookup_timeout' | 'web_lookup_not_found' | 'invalid_input') { super(code); }
}

/** Resolves a host name to every address it has. */
export type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** A URL a lookup may request: http(s), no credentials, the default ports. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebLookupError('invalid_input'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebLookupError('web_lookup_blocked');
  if (url.username || url.password) throw new WebLookupError('web_lookup_blocked');
  if (url.port && url.port !== '80' && url.port !== '443') throw new WebLookupError('web_lookup_blocked');
  url.hash = '';
  return url;
}

/**
 * 198.18.0.0/15 (benchmarking) is deliberately not refused: proxy clients in fake-IP mode, common where
 * these sites are reached through a proxy, answer every public name with an address from it and carry the
 * connection to the real site. No local network uses that range.
 */
function ipv4Private(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0);
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses, IPv4 and IPv6. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Private(address);
  if (kind !== 6) return true;
  const value = address.toLowerCase();
  // Everything under ::/8 (unspecified, loopback, IPv4-compatible and IPv4-mapped in either notation, as
  // URL parsing rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1), unique local, link-local, multicast,
  // NAT64, documentation, 6to4 and Teredo, any of which can reach a private IPv4 address.
  return value.startsWith('::') || /^0{0,4}:/.test(value) || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)
    || value.startsWith('64:ff9b:') || value.startsWith('100:') || value.startsWith('2001:db8') || value.startsWith('2002:') || /^2001:0{0,4}:/.test(value);
}

/** Refuses a URL whose host is, or resolves to, an address that is not public. */
export async function assertPublicHost(url: URL, lookup: LookupAll): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new WebLookupError('web_lookup_blocked');
  if (isIP(host)) { if (isPrivateAddress(host)) throw new WebLookupError('web_lookup_blocked'); return; }
  let addresses: { address: string }[];
  try { addresses = await lookup(host); } catch { throw new WebLookupError('web_lookup_failed'); }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new WebLookupError('web_lookup_blocked');
}
