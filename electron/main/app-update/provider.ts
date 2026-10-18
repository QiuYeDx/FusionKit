import type { OutgoingHttpHeaders } from 'node:http';
import type { CancellationToken, Provider, ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import type { AppUpdateManifestTrust } from '../../../src/app-update/contract';
import { classifyUpdateError } from './errors';
import { isPlainReleaseFileName, latestReleaseFileUrl, releaseFileUrl, type UpdateSource } from './sources';

/** What the provider needs from electron-updater, so tests can hand it the real classes. */
export interface UpdaterClasses {
  readonly Provider: typeof Provider;
  readonly CancellationToken: typeof CancellationToken;
  /** js-yaml's `load`, resolved next to electron-updater (which parses latest.yml with it too). */
  readonly parseYaml: (text: string) => unknown;
}

/**
 * The provider's view of the update sources, owned by the update service: the order a check
 * tries them in, which one answered, and which one the download uses now.
 */
export interface UpdateSourcePlan {
  readonly platform: NodeJS.Platform;
  readonly checkTimeoutMs: number;
  /**
   * True when FusionKit installs what the check finds (Windows): a latest.yml read from a mirror
   * then needs github.com's own file or a second mirror host to confirm it (see corroborate).
   */
  readonly corroborateMirrors: boolean;
  checkSources(): readonly UpdateSource[];
  /** Extra hosts that may only confirm a mirror's latest.yml (see corroborate); never downloaded from. */
  witnessSources?(): readonly UpdateSource[];
  checkAnswered(source: UpdateSource): void;
  checkFailed(source: UpdateSource, error: unknown): void;
  /** How the update information the check returns was confirmed. */
  checkTrusted(trust: AppUpdateManifestTrust): void;
  downloadSource(): UpdateSource;
}

/** electron-updater hands the setFeedURL options to the provider; the plan travels in them. */
export interface FusionKitProviderOptions {
  readonly provider: 'custom';
  readonly plan?: UpdateSourcePlan;
  readonly [key: string]: unknown;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The channel file electron-builder publishes for a platform (Windows keeps the plain name). */
export function channelFileName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux') return 'latest-linux.yml';
  return 'latest.yml';
}

/**
 * An electron-updater provider (the "custom" kind) for FusionKit's GitHub releases. A check reads
 * latest.yml from each source in the plan's order and stops at the first one that answers with
 * usable update information; every source has its own time limit, so a blocked github.com does
 * not hold up the mirrors. Downloads resolve the files of that version through the plan's current
 * download source, which the service moves to the next source when one fails.
 *
 * electron-updater refuses an installer whose SHA-512 differs from latest.yml. That keeps a mirror
 * from changing the installer only when the latest.yml did not come from that same mirror alone,
 * so a mirror's answer is checked against the other sources before an in-app install may use it
 * (corroborate). A signed latest.yml or a signed installer (D1) would make this unnecessary;
 * releases have neither yet.
 */
export function createFusionKitProviderClass(classes: UpdaterClasses) {
  return class FusionKitUpdateProvider extends classes.Provider<UpdateInfo> {
    private readonly plan: UpdateSourcePlan;

    constructor(options: FusionKitProviderOptions, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
      // GitHub's storage and the mirrors are not known to answer multi-range requests.
      super({ ...runtimeOptions, isUseMultipleRangeRequest: false });
      if (!options.plan) throw new Error('The FusionKit update provider needs a source plan.');
      this.plan = options.plan;
    }

    /** electron-updater's persistent staging id stays on this computer; mirrors are third parties. */
    override setRequestHeaders(value: OutgoingHttpHeaders | null): void {
      if (!value) { super.setRequestHeaders(null); return; }
      const headers = Object.fromEntries(Object.entries(value).filter(([name]) => name.toLowerCase() !== 'x-user-staging-id'));
      super.setRequestHeaders(Object.keys(headers).length > 0 ? headers : null);
    }

    async getLatestVersion(): Promise<UpdateInfo> {
      const channelFile = channelFileName(this.plan.platform);
      const sources = this.plan.checkSources();
      let lastError: unknown = new Error('No update source is configured.');
      for (const [index, source] of sources.entries()) {
        let info: UpdateInfo;
        try {
          info = await this.readChannelFile(source, channelFile);
        } catch (error) {
          lastError = error;
          this.plan.checkFailed(source, error);
          if (classifyUpdateError(error).kind === 'cancelled') throw error;
          continue;
        }
        this.plan.checkAnswered(source);
        if (source.official) {
          this.plan.checkTrusted('official');
          return info;
        }
        if (!this.plan.corroborateMirrors) {
          this.plan.checkTrusted('unverified');
          return info;
        }
        const witnesses = (this.plan.witnessSources?.() ?? []).filter(witness => !sources.some(item => item.id === witness.id));
        return this.corroborate(source, info, [...sources.slice(index + 1), ...witnesses], channelFile);
      }
      throw lastError;
    }

    /**
     * A mirror answered first. Its latest.yml may be used for an in-app install only when
     * github.com's own latest.yml can be read too (which then wins, whatever the mirror said) or
     * a different mirror host serves the same release. The sources not tried yet are asked at
     * once, each within its own time limit, together with the plan's witness hosts (which only
     * confirm, never serve downloads), and the first sufficient answer ends the check;
     * without one, the first mirror's information stands but counts as unverified. Sources that
     * already failed this check are not asked again.
     */
    private corroborate(first: UpdateSource, info: UpdateInfo, others: readonly UpdateSource[], channelFile: string): Promise<UpdateInfo> {
      if (others.length === 0) {
        this.plan.checkTrusted('unverified');
        return Promise.resolve(info);
      }
      const fingerprint = releaseFingerprint(info);
      const tokens = others.map(() => new classes.CancellationToken());
      return new Promise<UpdateInfo>(resolve => {
        let pending = others.length;
        let settled = false;
        const settle = (trust: AppUpdateManifestTrust, result: UpdateInfo) => {
          if (settled) return;
          settled = true;
          // The answers still on their way are no longer needed.
          for (const token of tokens) token.cancel();
          this.plan.checkTrusted(trust);
          resolve(result);
        };
        others.forEach((source, index) => {
          this.readChannelFile(source, channelFile, tokens[index]).then(answer => {
            if (source.official) settle('official', answer);
            else if (source.id !== first.id && sameRelease(answer, fingerprint)) settle('mirrors_agree', info);
          }, error => {
            if (!settled) this.plan.checkFailed(source, error);
          }).catch(() => {
            // Nothing a mirror sends may end in a rejection nobody handles; such an answer just
            // does not count, and the other answers (or the last one finishing) settle the check.
          }).finally(() => {
            pending -= 1;
            if (pending === 0) settle('unverified', info);
          });
        });
      });
    }

    resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
      const source = this.plan.downloadSource();
      const files = updateInfo.files?.length
        ? updateInfo.files
        : updateInfo.path ? [{ url: updateInfo.path, sha512: updateInfo.sha512 }] : [];
      if (files.length === 0) throw updaterError('The update information lists no files.', 'ERR_UPDATER_NO_FILES_PROVIDED');
      return files.map(file => {
        if (typeof file.sha512 !== 'string' || !file.sha512) throw updaterError(`No SHA-512 for ${file.url}.`, 'ERR_UPDATER_NO_CHECKSUM');
        if (!isPlainReleaseFileName(file.url)) throw updaterError(`Unexpected file name ${file.url}.`, 'ERR_UPDATER_INVALID_UPDATE_INFO');
        // FusionKit installs per user (nsis.perMachine false, kept by the packaging contract), so
        // electron-builder never asks for administrator rights in latest.yml; such a request did not
        // come from a FusionKit build, and electron-updater would start the installer through elevate.exe.
        const info = { ...file, isAdminRightsRequired: false };
        return { url: new URL(source.url(releaseFileUrl(updateInfo.version, file.url))), info };
      });
    }

    private async readChannelFile(source: UpdateSource, channelFile: string, token = new classes.CancellationToken()): Promise<UpdateInfo> {
      const url = new URL(source.url(latestReleaseFileUrl(channelFile)));
      // Like electron-updater's generic provider: a CDN or mirror must not answer from its cache.
      url.searchParams.set('noCache', Date.now().toString(32));
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; token.cancel(); }, this.plan.checkTimeoutMs);
      try {
        const raw = await this.httpRequest(url, { accept: 'application/x-yaml, text/yaml, text/plain, */*', 'cache-control': 'no-cache' }, token);
        return parseUpdateInfo(raw, channelFile, classes.parseYaml);
      } catch (error) {
        if (timedOut) throw Object.assign(new Error(`No answer from ${url.host} within ${Math.round(this.plan.checkTimeoutMs / 1000)} s`), { code: 'ETIMEDOUT' });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * What two latest.yml files must share to describe the same release: the version and, for every
 * file electron-updater would download, its name, SHA-512 and size. The release date, the notes,
 * the formatting and the order of the files do not matter.
 */
export function releaseFingerprint(info: UpdateInfo): string {
  const listed: readonly { url: unknown; sha512?: unknown; size?: unknown }[] = info.files?.length
    ? info.files
    : info.path ? [{ url: info.path, sha512: info.sha512 }] : [];
  const files = listed
    .map(file => [String(file.url), typeof file.sha512 === 'string' ? file.sha512 : '', typeof file.size === 'number' ? file.size : null] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify([info.version, files]);
}

/** Whether a second answer describes the release a fingerprint was taken of; never throws. */
function sameRelease(info: UpdateInfo, fingerprint: string): boolean {
  try {
    return releaseFingerprint(info) === fingerprint;
  } catch {
    return false;
  }
}

/** latest.yml as electron-updater expects it, refusing anything that is not update information. */
export function parseUpdateInfo(raw: string | null, channelFile: string, parseYaml: (text: string) => unknown): UpdateInfo {
  let value: unknown;
  try {
    value = raw == null ? null : parseYaml(raw);
  } catch {
    throw updaterError(`${channelFile} is not valid YAML.`, 'ERR_UPDATER_INVALID_UPDATE_INFO');
  }
  const info = value as Partial<UpdateInfo> | null;
  if (!info || typeof info !== 'object' || typeof info.version !== 'string' || !SEMVER.test(info.version)) {
    throw updaterError(`${channelFile} does not describe a release.`, 'ERR_UPDATER_INVALID_UPDATE_INFO');
  }
  // A file list, when there is one, must be a list of files: everything that reads it (the
  // fingerprint, resolveFiles, electron-updater) expects objects with a name.
  const files: unknown = info.files;
  if (files != null && !(Array.isArray(files) && files.every(file => file !== null && typeof file === 'object' && typeof (file as { url?: unknown }).url === 'string'))) {
    throw updaterError(`${channelFile} lists its files in an unexpected form.`, 'ERR_UPDATER_INVALID_UPDATE_INFO');
  }
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (!hasFiles && typeof info.path !== 'string') throw updaterError(`${channelFile} lists no files.`, 'ERR_UPDATER_NO_FILES_PROVIDED');
  return info as UpdateInfo;
}

function updaterError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
