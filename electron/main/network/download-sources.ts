import type { DownloadSourceMode } from '../../../src/network/contract';

/**
 * Where else a published file can be fetched. Mirrors never enter the frozen resource manifests:
 * the official address, size and SHA-256 stay fixed and every download is still verified, so a
 * mirror can only make a download faster, never change what is installed. The ModelScope copies
 * and the other mirrors below were checked on 2026-10-17 to serve identical bytes (size and
 * SHA-256) for the speech resources; gh-proxy.com is left out because it ignores Range requests.
 * Models from other Hugging Face repositories (added 2026-10-22) have only hf-mirror.com, which
 * copies the whole site under the same path.
 */
export interface DownloadCandidate {
  /** Stable id, such as "official" or "modelscope-viggocx". */
  readonly id: string;
  readonly url: string;
  readonly official: boolean;
  /** A domestic mirror (reachable from mainland China without a proxy). */
  readonly domestic: boolean;
}

export interface DownloadSourceMatch {
  /** Mirrors in one group serve the same kind of files, so their ranking is shared. */
  readonly group: DownloadSourceGroupId;
  /** The official address first, then mirrors in their default order. */
  readonly candidates: readonly DownloadCandidate[];
}

export type DownloadSourceGroupId = 'huggingface-whisper' | 'huggingface' | 'github-raw' | 'github-release';

interface DownloadSourceGroup {
  readonly id: DownloadSourceGroupId;
  readonly match: (url: URL) => RegExpExecArray | null;
  readonly mirrors: readonly ((url: URL, match: RegExpExecArray) => Omit<DownloadCandidate, 'official'>)[];
}

const MODELSCOPE_WHISPER_OWNERS = ['cjc1887415157', 'viggocx', 'iceCream2025'] as const;

export const DOWNLOAD_SOURCE_GROUPS: readonly DownloadSourceGroup[] = Object.freeze([
  {
    // https://huggingface.co/ggerganov/whisper.cpp/resolve/<revision>/<file>
    id: 'huggingface-whisper',
    match: url => url.hostname === 'huggingface.co'
      ? /^\/ggerganov\/whisper\.cpp\/resolve\/([^/]+)\/([^/]+)$/.exec(url.pathname) : null,
    mirrors: [
      ...MODELSCOPE_WHISPER_OWNERS.map(owner => (_url: URL, match: RegExpExecArray) => ({
        id: `modelscope-${owner.toLowerCase()}`,
        url: `https://www.modelscope.cn/models/${owner}/whisper.cpp/resolve/master/${match[2]}`,
        domestic: true,
      })),
      (url: URL) => ({ id: 'hf-mirror', url: `https://hf-mirror.com${url.pathname}${url.search}`, domestic: true }),
    ],
  },
  {
    // https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file> in any other model repository
    id: 'huggingface',
    match: url => url.hostname === 'huggingface.co'
      ? /^\/[^/]+\/[^/]+\/resolve\/[^/]+\/.+$/.exec(url.pathname) : null,
    mirrors: [
      (url: URL) => ({ id: 'hf-mirror', url: `https://hf-mirror.com${url.pathname}${url.search}`, domestic: true }),
    ],
  },
  {
    // https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
    id: 'github-raw',
    match: url => url.hostname === 'raw.githubusercontent.com'
      ? /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname) : null,
    mirrors: [
      (_url: URL, match: RegExpExecArray) => ({ id: 'jsdelivr', url: `https://cdn.jsdelivr.net/gh/${match[1]}/${match[2]}@${match[3]}/${match[4]}`, domestic: true }),
      (_url: URL, match: RegExpExecArray) => ({ id: 'jsdelivr-fastly', url: `https://fastly.jsdelivr.net/gh/${match[1]}/${match[2]}@${match[3]}/${match[4]}`, domestic: true }),
      (url: URL) => ({ id: 'ghfast', url: `https://ghfast.top/${url.href}`, domestic: true }),
    ],
  },
  {
    // https://github.com/<owner>/<repo>/releases/download/<tag>/<file> (also releases/latest/download)
    id: 'github-release',
    match: url => url.hostname === 'github.com'
      ? /^\/[^/]+\/[^/]+\/releases\/(?:latest\/)?download\/.+$/.exec(url.pathname) : null,
    mirrors: [
      (url: URL) => ({ id: 'ghfast', url: `https://ghfast.top/${url.href}`, domestic: true }),
      (url: URL) => ({ id: 'ghproxy', url: `https://ghproxy.net/${url.href}`, domestic: true }),
    ],
  },
]);

/** The official address and its known mirrors, or undefined for an address without mirrors. */
export function matchDownloadSources(address: string | URL): DownloadSourceMatch | undefined {
  let url: URL;
  try { url = new URL(address); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined;
  for (const group of DOWNLOAD_SOURCE_GROUPS) {
    const match = group.match(url);
    if (!match) continue;
    url.hash = '';
    return Object.freeze({
      group: group.id,
      candidates: Object.freeze([
        Object.freeze({ id: 'official', url: url.href, official: true, domestic: false }),
        ...group.mirrors.map(mirror => Object.freeze({ ...mirror(url, match), official: false })),
      ]),
    });
  }
  return undefined;
}

/** The fixed order a mode tries sources in when nothing has been measured. */
export function defaultCandidateOrder(match: DownloadSourceMatch, mode: DownloadSourceMode): readonly DownloadCandidate[] {
  const [official, ...mirrors] = match.candidates;
  if (mode === 'official') return [official!];
  if (mode === 'mirror') return [...mirrors, official!];
  return match.candidates;
}
