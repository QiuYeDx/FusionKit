import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_MIRROR_URLS, CHANGELOG_URL, changelogUrls, releasePageUrl, UPDATE_REPOSITORY } from '../../src/app-update/contract';
import { matchDownloadSources } from '../../electron/main/network/download-sources';
import { channelFileName } from '../../electron/main/app-update/provider';
import { isPlainReleaseFileName, latestReleaseFileUrl, manualDownloadLinks, releaseFileUrl, updateSources } from '../../electron/main/app-update/sources';

const builderConfig = JSON.parse(readFileSync('electron-builder.subtitle-studio.json', 'utf8'));

describe('update sources', () => {
  it('reads the repository electron-builder publishes to', () => {
    expect(builderConfig.publish).toMatchObject({ provider: 'github', owner: UPDATE_REPOSITORY.owner, repo: UPDATE_REPOSITORY.repo, releaseType: 'release' });
    expect(latestReleaseFileUrl('latest.yml')).toBe('https://github.com/QiuYeDx/FusionKit/releases/latest/download/latest.yml');
    expect(releaseFileUrl('0.5.2', 'FusionKit_0.5.2_x64.exe')).toBe('https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit_0.5.2_x64.exe');
    expect(releasePageUrl('0.5.2')).toBe('https://github.com/QiuYeDx/FusionKit/releases/tag/v0.5.2');
    expect(releasePageUrl()).toBe('https://github.com/QiuYeDx/FusionKit/releases/latest');
  });

  it('orders github.com and the GitHub download mirrors by the download-source setting', () => {
    const ids = (mode: 'auto' | 'official' | 'mirror') => updateSources(mode).map(source => source.id);
    expect(ids('auto')).toEqual(['official', 'ghfast', 'ghproxy']);
    expect(ids('official')).toEqual(['official']);
    expect(ids('mirror')).toEqual(['ghfast', 'ghproxy', 'official']);
    const [official, ghfast, ghproxy] = updateSources('auto');
    const file = latestReleaseFileUrl('latest.yml');
    expect(official!.url(file)).toBe(file);
    expect(ghfast!.url(file)).toBe('https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/latest/download/latest.yml');
    expect(ghproxy!.url(file)).toBe('https://ghproxy.net/https://github.com/QiuYeDx/FusionKit/releases/latest/download/latest.yml');
    // The same mirrors the CUDA pack downloads use.
    expect(matchDownloadSources(file)?.group).toBe('github-release');
    expect([official!.official, ghfast!.official, ghproxy!.official]).toEqual([true, false, false]);
  });

  it('lets electron-updater find the old blockmap through a mirror by replacing the version in the tag path', () => {
    const [, ghfast] = updateSources('auto');
    const url = new URL(ghfast!.url(releaseFileUrl('0.5.2', 'FusionKit_0.5.2_x64.exe')));
    // electron-updater's Provider.getBlockMapFiles: pathname with the new version replaced by the old one.
    const old = new URL(`${url.pathname.replace(/0\.5\.2/g, '0.5.1')}.blockmap`, url);
    expect(old.href).toBe('https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.1/FusionKit_0.5.1_x64.exe.blockmap');
  });

  it('names the platform channel files like electron-builder', () => {
    expect(channelFileName('win32')).toBe('latest.yml');
    expect(channelFileName('darwin')).toBe('latest-mac.yml');
  });

  it('links macOS to the DMG named like the artifactName, preferring latest-mac.yml', () => {
    expect(builderConfig.mac.artifactName).toBe('${productName}_${version}_${arch}.${ext}');
    expect(builderConfig.mac.target).toContainEqual({ target: 'dmg', arch: ['arm64'] });
    expect(manualDownloadLinks({ version: '0.5.2', mode: 'auto' })).toEqual({
      fileName: 'FusionKit_0.5.2_arm64.dmg',
      officialUrl: 'https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit_0.5.2_arm64.dmg',
      mirrorUrl: 'https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit_0.5.2_arm64.dmg',
    });
    const files = [{ url: 'FusionKit_0.5.2_arm64.zip' }, { url: 'FusionKit 0.5.2 arm64.dmg' }];
    expect(manualDownloadLinks({ version: '0.5.2', files, mode: 'mirror' }).officialUrl)
      .toBe('https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit-0.5.2-arm64.dmg');
    expect(manualDownloadLinks({ version: '0.5.2', files, mode: 'official' }).mirrorUrl).toBeUndefined();
    // An address instead of a file name is not followed.
    expect(manualDownloadLinks({ version: '0.5.2', files: [{ url: 'https://example.com/evil.dmg' }], mode: 'auto' }).fileName).toBe('FusionKit_0.5.2_arm64.dmg');
  });

  it('links Windows to the installer from latest.yml, for when the in-app update fails', () => {
    expect(builderConfig.win.artifactName).toBe('${productName}_${version}_${arch}.${ext}');
    expect(manualDownloadLinks({ version: '0.5.2', platform: 'win32', mode: 'auto' })).toEqual({
      fileName: 'FusionKit_0.5.2_x64.exe',
      officialUrl: 'https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit_0.5.2_x64.exe',
      mirrorUrl: 'https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit_0.5.2_x64.exe',
    });
    const files = [{ url: 'FusionKit_0.5.2_x64.exe.blockmap' }, { url: 'FusionKit_0.5.2_x64.exe' }];
    expect(manualDownloadLinks({ version: '0.5.2', files, platform: 'win32', mode: 'official' })).toEqual({
      fileName: 'FusionKit_0.5.2_x64.exe',
      officialUrl: 'https://github.com/QiuYeDx/FusionKit/releases/download/v0.5.2/FusionKit_0.5.2_x64.exe',
    });
  });

  it('accepts only plain release file names', () => {
    expect(isPlainReleaseFileName('FusionKit_0.5.2_x64.exe')).toBe(true);
    for (const name of ['../x.exe', 'a/b.exe', 'https://x/y.exe', 'a?b.exe', '', '..']) expect(isPlainReleaseFileName(name)).toBe(false);
  });

  it('reads the changelog from the download-source table\'s raw mirrors in the setting\'s order', () => {
    const match = matchDownloadSources(CHANGELOG_URL)!;
    expect(match.group).toBe('github-raw');
    expect(match.candidates.map(candidate => candidate.url)).toEqual([CHANGELOG_URL, ...CHANGELOG_MIRROR_URLS]);
    expect(CHANGELOG_MIRROR_URLS[0]).toBe('https://cdn.jsdelivr.net/gh/QiuYeDx/FusionKit@main/CHANGELOG.md');
    expect(changelogUrls('auto')).toEqual([CHANGELOG_URL, ...CHANGELOG_MIRROR_URLS]);
    expect(changelogUrls('official')).toEqual([CHANGELOG_URL]);
    expect(changelogUrls('mirror')).toEqual([...CHANGELOG_MIRROR_URLS, CHANGELOG_URL]);
  });
});
