import type { UpdateInfo } from 'electron-updater';
import { describe, expect, it } from 'vitest';
import { parseUpdateInfo, releaseFingerprint } from '../../electron/main/app-update/provider';
import { latestReleaseFileUrl, manifestWitnessSources, updateSources } from '../../electron/main/app-update/sources';
import { loadElectronUpdater } from '../../electron/main/app-update/updater-runtime';

describe('latest.yml parsing', () => {
  const { parseYaml } = loadElectronUpdater();
  const parse = (text: string) => parseUpdateInfo(text, 'latest.yml', parseYaml);

  it('refuses a file list that is not a list of files, even when the legacy path is there', () => {
    for (const files of ['  -', '  - null', '  - FusionKit_9.9.9_x64.exe', '  - url: 7', '  - sha512: abc']) {
      expect(() => parse(`version: 9.9.9\nfiles:\n${files}\npath: FusionKit_9.9.9_x64.exe\n`), files).toThrow(expect.objectContaining({ code: 'ERR_UPDATER_INVALID_UPDATE_INFO' }));
    }
    expect(() => parse('version: 9.9.9\nfiles: x\npath: FusionKit_9.9.9_x64.exe\n')).toThrow(expect.objectContaining({ code: 'ERR_UPDATER_INVALID_UPDATE_INFO' }));
  });

  it('accepts a regular file list, and the legacy path when there is no list', () => {
    expect(parse('version: 9.9.9\nfiles:\n  - url: FusionKit_9.9.9_x64.exe\n    sha512: abc\n    size: 1\n').files).toHaveLength(1);
    expect(parse('version: 9.9.9\npath: FusionKit_9.9.9_x64.exe\nsha512: abc\n').path).toBe('FusionKit_9.9.9_x64.exe');
    expect(parse('version: 9.9.9\nfiles:\npath: FusionKit_9.9.9_x64.exe\nsha512: abc\n').path).toBe('FusionKit_9.9.9_x64.exe');
    expect(() => parse('version: 9.9.9\nfiles: []\n')).toThrow(expect.objectContaining({ code: 'ERR_UPDATER_NO_FILES_PROVIDED' }));
  });
});

const release = (patch: Partial<UpdateInfo> = {}): UpdateInfo => ({
  version: '0.5.2',
  files: [
    { url: 'FusionKit_0.5.2_x64.exe', sha512: 'aaa', size: 100 },
    { url: 'FusionKit_0.5.2_x64.exe.blockmap', sha512: 'bbb', size: 10 },
  ],
  path: 'FusionKit_0.5.2_x64.exe',
  sha512: 'aaa',
  releaseDate: '2026-10-17T00:00:00.000Z',
  ...patch,
});

describe('release fingerprint (what two mirrors must agree on)', () => {
  it('ignores the release date, notes, file order and the legacy single-file fields', () => {
    const same = release({
      releaseDate: '2030-01-01T00:00:00.000Z',
      releaseNotes: 'other notes',
      files: [...release().files].reverse(),
      path: undefined as never,
      sha512: undefined as never,
    });
    expect(releaseFingerprint(same)).toBe(releaseFingerprint(release()));
  });

  it('differs for another version, file name, SHA-512, size or file list', () => {
    const base = releaseFingerprint(release());
    const [installer, blockmap] = release().files;
    for (const changed of [
      release({ version: '0.5.3' }),
      release({ files: [{ ...installer!, url: 'Evil_0.5.2_x64.exe' }, blockmap!] }),
      release({ files: [{ ...installer!, sha512: 'zzz' }, blockmap!] }),
      release({ files: [{ ...installer!, size: 101 }, blockmap!] }),
      release({ files: [installer!] }),
      release({ files: [installer!, blockmap!, { url: 'extra.exe', sha512: 'ccc', size: 1 }] }),
    ]) expect(releaseFingerprint(changed)).not.toBe(base);
  });

  it('uses the single-file fields when a latest.yml lists no files', () => {
    const legacy = (sha512: string) => release({ files: [] as never, path: 'FusionKit_0.5.2_x64.exe', sha512 });
    expect(releaseFingerprint(legacy('aaa'))).toBe(releaseFingerprint(legacy('aaa')));
    expect(releaseFingerprint(legacy('aaa'))).not.toBe(releaseFingerprint(legacy('zzz')));
  });

  it('only pairs mirrors on different hosts, none of them github.com', () => {
    const file = latestReleaseFileUrl('latest.yml');
    const mirrors = updateSources('auto').filter(source => !source.official);
    const hosts = mirrors.map(source => new URL(source.url(file)).hostname);
    expect(mirrors.map(source => source.id)).toEqual(['ghfast', 'ghproxy']);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts).not.toContain('github.com');
  });

  it('adds gh-proxy.com only as a confirm-only witness, and none in "official only" mode', () => {
    const file = latestReleaseFileUrl('latest.yml');
    const mirrorHosts = updateSources('auto').map(source => new URL(source.url(file)).hostname);
    const witnesses = manifestWitnessSources('auto');
    expect(witnesses.map(source => [source.id, source.official, new URL(source.url(file)).hostname])).toEqual([['gh-proxy', false, 'gh-proxy.com']]);
    expect(mirrorHosts).not.toContain('gh-proxy.com');
    expect(manifestWitnessSources('mirror').map(source => source.id)).toEqual(['gh-proxy']);
    expect(manifestWitnessSources('official')).toEqual([]);
  });
});
