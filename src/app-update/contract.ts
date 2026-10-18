import type { DownloadSourceMode } from '../network/contract';

/**
 * Checking for, downloading and installing a new FusionKit version. The main process owns the
 * updater: it reads the release's latest.yml from GitHub or a GitHub download mirror, in the
 * order the download-source setting gives, and electron-updater checks every downloaded installer
 * against the SHA-512 listed there before it may run. That check is only as trustworthy as the
 * latest.yml it compares with, so a latest.yml read from a mirror is used for an in-app install
 * only when github.com's own file or a second mirror host confirms it (see
 * AppUpdateManifestTrust); one mirror's word alone gets manual download links. The Windows build
 * installs in the app; macOS builds are not signed (D1), so they get direct links to the new DMG
 * instead.
 */
export const APP_UPDATE_CHANNEL_PREFIX = 'app-update:';
export const APP_UPDATE_CHANNELS = {
  getState: 'app-update:get-state',
  check: 'app-update:check',
  download: 'app-update:download',
  cancel: 'app-update:cancel',
  install: 'app-update:install',
  /** After a failed install: FusionKit already stopped its services, so it starts again. */
  restart: 'app-update:restart',
  /** Main → renderer: every change of the state. */
  state: 'app-update:state',
} as const;

/** The publish target of electron-builder.subtitle-studio.json. */
export const UPDATE_REPOSITORY = Object.freeze({ owner: 'QiuYeDx', repo: 'FusionKit' });
export const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

/** The release page of one version (tags are "v" + version), or of the latest release. */
export function releasePageUrl(version?: string): string {
  return version ? `${RELEASES_URL}/tag/v${version}` : LATEST_RELEASE_URL;
}

/**
 * Where the renderer reads CHANGELOG.md: the official raw address, then its mirrors (the
 * download-source table's "github-raw" group, kept equal to it by a test).
 */
export const CHANGELOG_URL = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/main/CHANGELOG.md`;
export const CHANGELOG_MIRROR_URLS: readonly string[] = Object.freeze([
  `https://cdn.jsdelivr.net/gh/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}@main/CHANGELOG.md`,
  `https://fastly.jsdelivr.net/gh/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}@main/CHANGELOG.md`,
  `https://ghfast.top/${CHANGELOG_URL}`,
]);

/** The addresses to try for CHANGELOG.md, in the order the download-source setting gives. */
export function changelogUrls(mode: DownloadSourceMode): readonly string[] {
  if (mode === 'official') return [CHANGELOG_URL];
  if (mode === 'mirror') return [...CHANGELOG_MIRROR_URLS, CHANGELOG_URL];
  return [CHANGELOG_URL, ...CHANGELOG_MIRROR_URLS];
}

/** "official" is github.com itself; the others are the GitHub download mirrors of the download-source table. */
export type AppUpdateSourceId = 'official' | 'ghfast' | 'ghproxy' | (string & {});

/**
 * in_app: the installed Windows build downloads and installs updates itself. manual: macOS (not
 * signed, so no automatic install) gets links to the new DMG. unsupported: a development build,
 * which never checks.
 */
export type AppUpdateInstallMode = 'in_app' | 'manual' | 'unsupported';

/**
 * Where a check's update information comes from, for an in-app install (Windows builds):
 * "official" when github.com's own latest.yml was read (it wins over any mirror's);
 * "mirrors_agree" when github.com could not be read but two different mirror hosts served the
 * same release (the version and, for every file, its name, SHA-512 and size); "unverified" when
 * only one mirror's latest.yml was there, or the mirrors disagreed. electron-updater checks the
 * installer against the SHA-512 in that very file, so one mirror alone could make FusionKit run a
 * program of its choosing: an unverified update is shown, but only with manual download links.
 * Without code signing (D1) this is the protection; a signed latest.yml is the open follow-up.
 */
export type AppUpdateManifestTrust = 'official' | 'mirrors_agree' | 'unverified';

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

/**
 * Why an update step failed, in the user's terms: no connection to any source (or the sources
 * answered with something else), the new version's files are not published, the download did not
 * match its SHA-512, the file could not be saved, or anything else.
 */
export const APP_UPDATE_ERROR_KINDS = ['network', 'not_found', 'checksum', 'disk', 'unknown'] as const;
export type AppUpdateErrorKind = (typeof APP_UPDATE_ERROR_KINDS)[number];

export interface AppUpdateError {
  readonly kind: AppUpdateErrorKind;
  /** Looking for the new version, downloading it, or starting the installer. */
  readonly during: 'check' | 'download' | 'install';
  /** Whether a mirror was tried too (not in "official only" mode). */
  readonly mirrorsTried: boolean;
  /** Technical detail for "copy": every source tried and what went wrong there, one per line. */
  readonly detail: string;
  /**
   * Installing only: "prepare" when FusionKit could not stop its own services first (local
   * transcription, Subtitle Studio), "start" when the installer did not take over. Either way some
   * of them are already stopped, so FusionKit has to restart before it works fully again.
   */
  readonly installStage?: 'prepare' | 'start';
}

export interface AppUpdateProgress {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

/**
 * The new installer to download by hand (macOS: the DMG, which is the only way; Windows: the
 * .exe, offered when the in-app update fails), on GitHub and, unless the setting is "official
 * only", through a mirror.
 */
export interface AppUpdateManualDownload {
  readonly fileName: string;
  readonly officialUrl: string;
  readonly mirrorUrl?: string;
}

export interface AppUpdateState {
  readonly phase: AppUpdatePhase;
  readonly installMode: AppUpdateInstallMode;
  readonly currentVersion: string;
  /** The newest version a check found. */
  readonly latestVersion?: string;
  /** The installer's size from latest.yml; a download may need less (only changed blocks). */
  readonly downloadSize?: number;
  /** The source that answered the check, or that the download currently uses. */
  readonly source?: AppUpdateSourceId;
  /**
   * In-app installs only (Windows): whether the check's update information was confirmed. An
   * "unverified" one cannot be downloaded in the app; the dialog offers manual links instead.
   */
  readonly manifestTrust?: AppUpdateManifestTrust;
  readonly progress?: AppUpdateProgress;
  readonly error?: AppUpdateError;
  readonly manualDownload?: AppUpdateManualDownload;
  readonly downloadSourceMode: DownloadSourceMode;
  readonly releaseUrl: string;
}

export interface AppUpdateCheckRequest {
  /** A check the user asked for; launch checks are quiet about failures (the renderer decides). */
  readonly manual?: boolean;
}

export interface AppUpdateApi {
  getState(): Promise<AppUpdateState>;
  check(request?: AppUpdateCheckRequest): Promise<AppUpdateState>;
  /** Windows installed builds: starts the download; progress and the end arrive through onState. */
  download(): Promise<AppUpdateState>;
  cancelDownload(): Promise<AppUpdateState>;
  /** Quits and runs the downloaded installer silently; FusionKit opens again afterwards. */
  install(): Promise<AppUpdateState>;
  /** After a failed install (some services are already stopped): quits and starts FusionKit again. */
  restart(): Promise<AppUpdateState>;
  onState(listener: (state: AppUpdateState) => void): () => void;
}
