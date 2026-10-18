import type { NetworkErrorCategory } from '../../../src/network/contract';
import type { AppUpdateErrorKind } from '../../../src/app-update/contract';
import { classifyNetworkError } from '../network/errors';

export interface UpdateFailure {
  /** "cancelled" is the user's cancel (or the stall watchdog's, which the service relabels). */
  readonly kind: AppUpdateErrorKind | 'cancelled';
  readonly networkCategory?: NetworkErrorCategory;
  readonly status?: number;
}

/** electron-updater's codes for update information that is missing or not usable. */
const NOT_FOUND_CODES = new Set(['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS']);
/**
 * A source answered, but not with update information (an HTML page from a mirror or an
 * intercepting network, a truncated file): for the user this is "the network did not get
 * through", and another source may well answer correctly.
 */
const INVALID_INFO_CODES = new Set([
  'ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_NO_FILES_PROVIDED', 'ERR_UPDATER_NO_CHECKSUM',
  'ERR_UPDATER_INVALID_VERSION', 'ERR_UPDATER_INVALID_RELEASE_FEED',
]);
const CHECKSUM_CODES = new Set(['ERR_CHECKSUM_MISMATCH', 'ERR_UPDATER_INVALID_SIGNATURE']);
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE']);
/** Statuses where the source cannot serve the file right now, so another source should be tried. */
const UNAVAILABLE_STATUSES = new Set([403, 408, 425, 429, 451]);

/**
 * Says in the user's terms why an electron-updater check or download failed. Looks through
 * wrappers (`cause`, AggregateError) like the network classifier, which decides what counts as
 * "no connection" (DNS, timeouts, refused or reset connections, proxies, TLS, Chromium's
 * net::ERR_* messages).
 */
export function classifyUpdateError(error: unknown): UpdateFailure {
  const chain = errorChain(error);
  if (chain.some(isCancellation)) return { kind: 'cancelled' };
  for (const item of chain) {
    const status = httpStatus(item);
    if (status === undefined) continue;
    if (status === 404 || status === 410) return { kind: 'not_found', status };
    if (status >= 500 || UNAVAILABLE_STATUSES.has(status)) return { kind: 'network', status };
    if (status === 407) return { kind: 'network', status, networkCategory: 'proxy_auth' };
    return { kind: 'unknown', status };
  }
  for (const item of chain) {
    const code = typeof item.code === 'string' ? item.code : '';
    if (CHECKSUM_CODES.has(code) || /checksum mismatch/i.test(String(item.message ?? ''))) return { kind: 'checksum' };
    if (NOT_FOUND_CODES.has(code)) {
      // "Unable to find latest version on GitHub (…): net::ERR_…" wraps a connection failure.
      const category = classifyNetworkError(item);
      return isConnection(category) ? { kind: 'network', networkCategory: category } : { kind: 'not_found' };
    }
    if (INVALID_INFO_CODES.has(code)) return { kind: 'network' };
    if (DISK_CODES.has(code)) return { kind: 'disk' };
  }
  const category = classifyNetworkError(error);
  if (isConnection(category)) return { kind: 'network', networkCategory: category };
  if (chain.some(item => /aborted by the server|Too many redirects|socket hang up/i.test(String(item.message ?? '')))) {
    return { kind: 'network', networkCategory: 'reset' };
  }
  return { kind: 'unknown' };
}

/** One source's failed check or download. */
export interface UpdateAttempt {
  readonly official: boolean;
  readonly failure: UpdateFailure;
}

/**
 * What to tell the user after every source failed. A source that answered (the file is not
 * published there, or what it served failed the SHA-512 check) says more than one that could not
 * be reached, and github.com's own answer counts most; "network" only when no source answered
 * like that. So a release whose files are still uploading reads as "not found" even when the last
 * mirror timed out.
 */
export function mostTellingFailure(attempts: readonly UpdateAttempt[]): UpdateFailure | undefined {
  const answered = (attempt: UpdateAttempt) => attempt.failure.kind === 'not_found' || attempt.failure.kind === 'checksum';
  const pick = attempts.find(attempt => attempt.official && answered(attempt))
    ?? attempts.find(answered)
    ?? [...attempts].reverse().find(attempt => attempt.failure.kind === 'network')
    ?? attempts[attempts.length - 1];
  return pick?.failure;
}

/**
 * One line of technical detail for "copy diagnostics": the code, the status or the first line of
 * the message. Query strings are cut (GitHub's download redirects carry signed tokens) and so are
 * response headers and raw file contents that electron-updater appends.
 */
export function describeUpdateError(error: unknown): string {
  const item = (errorChain(error)[0] ?? { message: String(error) }) as ErrorLike;
  const status = httpStatus(item);
  const code = typeof item.code === 'string' && !/^HTTP_ERROR_/.test(item.code) ? item.code : '';
  const message = String(item.message ?? '').split(/\r?\n/)[0]!
    .replace(/,?\s*rawData:.*$/s, '')
    .replace(/(https?:\/\/[^\s?#"'()]+)[?#][^\s"'()]*/g, '$1')
    .trim();
  const parts = [status !== undefined ? `HTTP ${status}` : '', code, status !== undefined ? '' : message].filter(Boolean);
  const text = parts.join(' · ') || 'unknown error';
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function isConnection(category: NetworkErrorCategory): boolean {
  return category !== 'unknown';
}

function isCancellation(item: ErrorLike): boolean {
  return item.name === 'CancellationError' || item.constructor?.name === 'CancellationError'
    || (item.message === 'cancelled' && Object.keys(item).length === 0);
}

function httpStatus(item: ErrorLike): number | undefined {
  if (item.name === 'HttpError' && typeof item.statusCode === 'number') return item.statusCode;
  const match = typeof item.code === 'string' ? /^HTTP_ERROR_(\d{3})$/.exec(item.code) : null;
  if (match) return Number(match[1]);
  // A download answered with an error status: `Cannot download "<url>", status 404: Not Found`.
  const download = typeof item.message === 'string' ? /^Cannot download ".*", status (\d{3})\b/.exec(item.message) : null;
  return download ? Number(download[1]) : undefined;
}

type ErrorLike = Record<string, unknown> & {
  name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown; constructor?: { name?: string };
};

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
