import type { DownloadSourceMode } from '../../../src/network/contract';
import { RELEASES_URL, type AppUpdateManualDownload, type AppUpdateSourceId } from '../../../src/app-update/contract';
import { defaultCandidateOrder, matchDownloadSources } from '../network/download-sources';

/**
 * One place the release files can be read from: github.com itself or a GitHub download mirror.
 * Mirrors come from the download-source table ("github-release" group), so the update feed and
 * the CUDA pack downloads use the same mirrors.
 */
export interface UpdateSource {
  readonly id: AppUpdateSourceId;
  readonly official: boolean;
  /** The address of an official release file (under RELEASES_URL) through this source. */
  url(officialUrl: string): string;
}

/** The release file that GitHub serves from the latest (non-draft, non-prerelease) release. */
export function latestReleaseFileUrl(fileName: string): string {
  return `${RELEASES_URL}/latest/download/${encodeFileName(fileName)}`;
}

/**
 * A file of one release. Tags are "v" + version (electron-builder's default, used by every
 * FusionKit release). Downloads use this rather than "latest": electron-updater finds the old
 * version's blockmap by replacing the version in this path, which lets it download only the
 * changed blocks, and the files cannot change under a running download when a newer release is
 * published.
 */
export function releaseFileUrl(version: string, fileName: string): string {
  return `${RELEASES_URL}/download/v${version}/${encodeFileName(fileName)}`;
}

/** The sources a check tries, in the order the download-source setting gives. */
export function updateSources(mode: DownloadSourceMode): readonly UpdateSource[] {
  const match = matchDownloadSources(latestReleaseFileUrl('latest.yml'));
  if (!match) throw new Error('The release address has no download-source group.');
  return defaultCandidateOrder(match, mode).map(candidate => Object.freeze({
    id: candidate.id,
    official: candidate.official,
    url: (officialUrl: string) => sourceUrl(candidate.id, officialUrl),
  }));
}

/**
 * Hosts asked only to confirm a mirror's latest.yml, never to download from. gh-proxy.com ignores
 * Range requests, so it is unfit for installers and blockmaps (and left out of the download-source
 * table), but it serves the small channel file; a third host keeps in-app installs possible when
 * one of the two download mirrors is down. "Official only" asks no mirror at all.
 */
export function manifestWitnessSources(mode: DownloadSourceMode): readonly UpdateSource[] {
  if (mode === 'official') return [];
  return [Object.freeze({ id: 'gh-proxy', official: false, url: (officialUrl: string) => `https://gh-proxy.com/${officialUrl}` })];
}

/** An official release address through one of the download-source table's sources. */
function sourceUrl(id: string, officialUrl: string): string {
  const candidate = matchDownloadSources(officialUrl)?.candidates.find(item => item.id === id);
  if (!candidate) throw new Error(`No ${id} address for ${officialUrl}.`);
  return candidate.url;
}

interface ReleaseFileEntry { readonly url?: unknown }

/**
 * The installer of a version to download by hand: the DMG on macOS, the .exe on Windows, named
 * like electron-builder's artifactName (${productName}_${version}_${arch}.${ext}). The name listed
 * in latest.yml / latest-mac.yml wins when it has one for this architecture; the mirror link is
 * left out in "official only" mode.
 */
export function manualDownloadLinks(input: {
  readonly version: string;
  readonly files?: readonly ReleaseFileEntry[];
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly mode: DownloadSourceMode;
}): AppUpdateManualDownload {
  const mac = input.platform === undefined || input.platform === 'darwin';
  const extension = mac ? '.dmg' : '.exe';
  const arch = input.arch ?? (mac ? 'arm64' : 'x64');
  const listed = (input.files ?? [])
    .map(file => typeof file.url === 'string' ? file.url : '')
    .filter(name => isPlainReleaseFileName(name) && name.toLowerCase().endsWith(extension));
  const fileName = listed.find(name => name.includes(arch)) ?? listed[0] ?? `FusionKit_${input.version}_${arch}${extension}`;
  const officialUrl = releaseFileUrl(input.version, fileName);
  const mirror = input.mode === 'official'
    ? undefined
    : matchDownloadSources(officialUrl)?.candidates.find(candidate => !candidate.official);
  return Object.freeze({ fileName, officialUrl, ...(mirror ? { mirrorUrl: mirror.url } : {}) });
}

/** A release asset name as latest.yml lists it: one path segment, no address of its own. */
export function isPlainReleaseFileName(name: string): boolean {
  return /^[^/\\?#:%]+$/.test(name) && name !== '.' && name !== '..' && name.length <= 255;
}

function encodeFileName(fileName: string): string {
  // Spaces become dashes, as electron-updater's own GitHub provider expects of uploaded assets.
  return encodeURIComponent(fileName.replace(/ /g, '-'));
}
