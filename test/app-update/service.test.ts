import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateService, type UpdaterLike } from '../../electron/main/app-update/service';
import { loadElectronUpdater } from '../../electron/main/app-update/updater-runtime';
import { closeAllServers } from '../network/local-servers';
import { cleanupRoots, createHarness, diskFaults, releaseFiles, startReleaseServer } from './helpers';

afterEach(async () => {
  await closeAllServers();
  await cleanupRoots();
});

/** The pending installer electron-updater kept, if any. */
async function pendingInstaller(root: string): Promise<Buffer | undefined> {
  const directory = path.join(root, 'update-cache', 'fusionkit-test-updater', 'pending');
  const names = await readdir(directory).catch(() => [] as string[]);
  const installer = names.find(name => name.endsWith('.exe') && !name.startsWith('temp-'));
  return installer ? readFile(path.join(directory, installer)) : undefined;
}

describe('update service with the real electron-updater', () => {
  it('falls back to a mirror when github.com cannot be reached, then downloads and verifies the installer there', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'drop' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'] });

    const found = await harness.service.check();
    // ghproxy, a second mirror host, served the same release: the in-app update may use it.
    expect(found).toMatchObject({ phase: 'available', installMode: 'in_app', currentVersion: '0.5.1', latestVersion: '9.9.9', source: 'ghfast', manifestTrust: 'mirrors_agree',
      downloadSize: files.installer.length, downloadSourceMode: 'auto', releaseUrl: 'https://github.com/QiuYeDx/FusionKit/releases/tag/v9.9.9' });
    // For when the in-app update fails: the installer named in latest.yml, also through a mirror.
    expect(found.manualDownload).toEqual({
      fileName: files.installerName,
      officialUrl: `https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/${files.installerName}`,
      mirrorUrl: `https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/${files.installerName}`,
    });
    expect(server.requests.filter(line => line.includes('latest.yml'))).toEqual(['official /latest/download/latest.yml', 'ghfast /latest/download/latest.yml', 'ghproxy /latest/download/latest.yml']);
    // The persistent staging id stays on this computer.
    expect(server.headers.get('ghfast /latest/download/latest.yml')?.['x-user-staging-id']).toBeUndefined();

    await harness.service.download();
    const done = await harness.waitFor(state => state.phase !== 'downloading');
    expect(done).toMatchObject({ phase: 'downloaded', source: 'ghfast', progress: { percent: 100 } });
    // Files of that version come from its tag path, where the old version's blockmap can be found too.
    expect(server.requests).toContain(`ghfast /download/v9.9.9/${files.installerName}`);
    expect(server.requests).toContain(`ghfast /download/v9.9.9/${files.installerName}.blockmap`);
    expect(server.requests.some(line => line.startsWith('official /download'))).toBe(false);
    const saved = await pendingInstaller(harness.root);
    expect(saved && createHash('sha512').update(saved).digest('base64')).toBe(files.sha512);
    expect(harness.states.some(state => state.phase === 'downloading' && state.source === 'ghfast')).toBe(true);
  });

  it('reads only github.com in "official only" mode and says the mirrors were not tried', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'drop' } });
    const harness = await createHarness(server, { sources: ['official'], mode: 'official' });
    const state = await harness.service.check();
    expect(state).toMatchObject({ phase: 'error', downloadSourceMode: 'official', error: { kind: 'network', during: 'check', mirrorsTried: false } });
    expect(state.error!.detail).toMatch(/^official \(check\): /);
    expect(server.requests.every(line => line.startsWith('official '))).toBe(true);
  });

  it('asks the mirrors first in "mirror first" mode and downloads from them; github.com only confirms latest.yml', async () => {
    const files = releaseFiles();
    // The second mirror does not answer, so github.com's latest.yml is what confirms the first mirror's.
    const server = await startReleaseServer(files, { ghproxy: { check: 'hang' } });
    const harness = await createHarness(server, { sources: ['ghfast', 'ghproxy', 'official'], mode: 'mirror' });
    const started = Date.now();
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', downloadSourceMode: 'mirror', manifestTrust: 'official' });
    // The first sufficient answer ends the check: it does not wait for the silent mirror.
    expect(Date.now() - started).toBeLessThan(1_500);
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'ghfast' });
    expect(server.requests.filter(line => line.startsWith('official '))).toEqual(['official /latest/download/latest.yml']);
  });

  it('never installs in the app what only one mirror vouched for, and offers the download links instead', async () => {
    const files = releaseFiles();
    // A mirror that serves its own program: a latest.yml with that program's SHA-512, and the program.
    const tampered = releaseFiles(files.version);
    expect(tampered.sha512).not.toBe(files.sha512);
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghfast: { release: tampered }, ghproxy: { check: 'drop' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'] });
    const found = await harness.service.check();
    expect(found).toMatchObject({ phase: 'available', installMode: 'in_app', latestVersion: '9.9.9', source: 'ghfast', manifestTrust: 'unverified' });
    expect(found.manualDownload).toEqual({
      fileName: files.installerName,
      officialUrl: `https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/${files.installerName}`,
      mirrorUrl: `https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/${files.installerName}`,
    });
    // Neither a download nor an install starts, whatever the window asks for.
    expect(await harness.service.download()).toMatchObject({ phase: 'available', manifestTrust: 'unverified' });
    expect(await harness.service.install()).toMatchObject({ phase: 'available' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.requests.some(line => line.includes('/download/v'))).toBe(false);
    expect(await pendingInstaller(harness.root)).toBeUndefined();
    expect(harness.installs).toEqual([]);
  });

  it('does not trust two mirrors that disagree about the release', async () => {
    const files = releaseFiles();
    const tampered = releaseFiles(files.version);
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghfast: { release: tampered } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'] });
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', manifestTrust: 'unverified' });
    expect(await harness.service.download()).toMatchObject({ phase: 'available' });
    expect(server.requests.some(line => line.includes('/download/v'))).toBe(false);
  });

  it('lets a confirm-only witness host stand in for a download mirror that is down, without downloading from it', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghproxy: { check: 'drop' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'], witnesses: ['gh-proxy'] });
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', manifestTrust: 'mirrors_agree' });
    expect(server.requests).toContain('gh-proxy /latest/download/latest.yml');
    await harness.service.download();
    await harness.waitFor(state => state.phase === 'downloaded');
    expect(server.requests.filter(line => line.includes('/download/v')).every(line => !line.startsWith('gh-proxy '))).toBe(true);
  });

  it('does not let a witness host that disagrees confirm a mirror', async () => {
    const files = releaseFiles();
    const tampered = releaseFiles(files.version);
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghfast: { release: tampered }, ghproxy: { check: 'drop' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'], witnesses: ['gh-proxy'] });
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', manifestTrust: 'unverified' });
    expect(await harness.service.download()).toMatchObject({ phase: 'available', manifestTrust: 'unverified' });
  });

  it('counts two mirrors as agreeing when their latest.yml describe the same files, however they are written', async () => {
    const files = releaseFiles();
    // Same version, file names, SHA-512 and sizes; another release date, key order, and no legacy fields.
    const rewritten = { ...files, latestYml: [
      "releaseDate: '2026-10-18T08:00:00.000Z'",
      'files:',
      `  - sha512: ${files.sha512}`,
      `    size: ${files.installer.length}`,
      `    url: ${files.installerName}`,
      `version: ${files.version}`,
      '',
    ].join('\n') };
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghproxy: { release: rewritten } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'] });
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', manifestTrust: 'mirrors_agree' });
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'ghfast' });
  });

  it('treats a malformed latest.yml from the second mirror as no confirmation, without an unhandled rejection', async () => {
    const files = releaseFiles();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      // A file list whose entry is empty, next to a legacy path that alone would look acceptable.
      const broken = { ...files, latestYml: `version: ${files.version}\nfiles:\n  -\npath: ${files.installerName}\n` };
      const server = await startReleaseServer(files, { official: { check: 'drop' }, ghproxy: { release: broken } });
      const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'] });
      expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', manifestTrust: 'unverified' });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(rejections).toEqual([]);
      expect(server.requests.some(line => line.includes('/download/v'))).toBe(false);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it("takes github.com's latest.yml over a tampering mirror's, so the mirror's program never passes the check", async () => {
    const files = releaseFiles();
    const tampered = releaseFiles(files.version);
    const server = await startReleaseServer(files, { ghfast: { release: tampered }, ghproxy: { check: 'hang' } });
    const harness = await createHarness(server, { sources: ['ghfast', 'ghproxy', 'official'], mode: 'mirror' });
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast', manifestTrust: 'official' });
    await harness.service.download();
    // The mirror's program fails github.com's SHA-512; the next source serves the real installer.
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'ghproxy' });
    const saved = await pendingInstaller(harness.root);
    expect(saved && createHash('sha512').update(saved).digest('base64')).toBe(files.sha512);
  });

  it('gives every source its own time limit and treats an HTML page as no answer', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'hang' }, ghfast: { check: 'html' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'], checkTimeoutMs: 300 });
    const started = Date.now();
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghproxy' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a quiet network failure after every source failed, with each attempt in the detail', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghfast: { check: 503 }, ghproxy: { check: 'html' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'] });
    const state = await harness.service.check();
    expect(state).toMatchObject({ phase: 'error', error: { kind: 'network', during: 'check', mirrorsTried: true } });
    expect(state.error!.detail.split('\n')).toEqual([
      expect.stringMatching(/^official \(check\): /),
      'ghfast (check): HTTP 503',
      expect.stringMatching(/^ghproxy \(check\): ERR_UPDATER_INVALID_UPDATE_INFO/),
    ]);
    // Signed query strings never reach the copyable detail.
    expect(state.error!.detail).not.toContain('noCache');
  });

  it('says the release files are missing when every source answers 404', async () => {
    const server = await startReleaseServer(releaseFiles(), { official: { check: 404 }, ghfast: { check: 404 } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast'] });
    expect(await harness.service.check()).toMatchObject({ phase: 'error', error: { kind: 'not_found', during: 'check' } });
  });

  it('still says "not found" when GitHub answered 404 and the last mirror timed out, not "no connection"', async () => {
    const server = await startReleaseServer(releaseFiles(), { official: { check: 404 }, ghfast: { check: 404 }, ghproxy: { check: 'hang' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'], checkTimeoutMs: 300 });
    const state = await harness.service.check();
    expect(state).toMatchObject({ phase: 'error', error: { kind: 'not_found', during: 'check', mirrorsTried: true } });
    expect(state.error!.detail.split('\n')).toEqual(['official (check): HTTP 404', 'ghfast (check): HTTP 404', expect.stringMatching(/^ghproxy \(check\): ETIMEDOUT/)]);
  });

  it('reports "up to date" when the published version is the running one', async () => {
    const server = await startReleaseServer(releaseFiles('0.5.1'), {});
    const harness = await createHarness(server, { sources: ['official'] });
    expect(await harness.service.check()).toMatchObject({ phase: 'up_to_date', latestVersion: '0.5.1', source: 'official' });
    expect(await harness.service.download()).toMatchObject({ phase: 'up_to_date' });
  });

  it('moves to the next source when the installer does not match its SHA-512, and never keeps the wrong file', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { download: 'corrupt' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast'] });
    // github.com answered the check itself: nothing else needs to confirm it.
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'official', manifestTrust: 'official' });
    expect(server.requests.filter(line => line.includes('latest.yml'))).toEqual(['official /latest/download/latest.yml']);
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'ghfast' });
    const saved = await pendingInstaller(harness.root);
    expect(saved && createHash('sha512').update(saved).digest('base64')).toBe(files.sha512);
  });

  it('fails with "checksum" when no source serves the right installer, and a retry starts over', async () => {
    const files = releaseFiles();
    const behaviour = { official: { download: 'corrupt' as const }, ghfast: { download: 'corrupt' as const } };
    const server = await startReleaseServer(files, behaviour);
    const harness = await createHarness(server, { sources: ['official', 'ghfast'] });
    await harness.service.check();
    await harness.service.download();
    const failed = await harness.waitFor(state => state.phase !== 'downloading');
    expect(failed).toMatchObject({ phase: 'error', error: { kind: 'checksum', during: 'download', mirrorsTried: true } });
    expect(failed.error!.detail.split('\n')).toEqual([
      expect.stringMatching(/^official \(download\): ERR_CHECKSUM_MISMATCH/),
      expect.stringMatching(/^ghfast \(download\): ERR_CHECKSUM_MISMATCH/),
    ]);
    expect(await pendingInstaller(harness.root)).toBeUndefined();

    behaviour.official.download = 'ok' as never;
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'official' });
  });

  it('tries the sources before the answering one last, so a github.com that missed the check can still serve the download', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'hang' }, ghfast: { download: 503 }, ghproxy: { download: 503 } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'], checkTimeoutMs: 300 });
    expect(await harness.service.check()).toMatchObject({ phase: 'available', source: 'ghfast' });
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'official' });
    const installerRequests = server.requests.filter(line => line.endsWith(`/download/v9.9.9/${files.installerName}`));
    expect(installerRequests.map(line => line.split(' ')[0])).toEqual(['ghfast', 'ghproxy', 'official']);
  });

  it('reports a file that failed its check over a later connection failure once every source was tried', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { download: 'corrupt' }, ghfast: { download: 503 } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast'] });
    await harness.service.check();
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'error', error: { kind: 'checksum', during: 'download' } });
  });

  it('stops at once on a full disk instead of trying the other sources', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, {});
    const harness = await createHarness(server, { sources: ['official', 'ghfast'] });
    await harness.service.check();
    diskFaults.remaining = 1;
    await harness.service.download();
    const failed = await harness.waitFor(state => state.phase !== 'downloading');
    expect(failed).toMatchObject({ phase: 'error', error: { kind: 'disk', during: 'download', mirrorsTried: false } });
    expect(failed.error!.detail).toMatch(/^official \(download\): ENOSPC/);
    expect(server.requests.some(line => line.startsWith('ghfast /download'))).toBe(false);
    // A retry once there is space again.
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded', source: 'official' });
  });

  it('ignores a latest.yml that asks for administrator rights (the per-user installer never does)', async () => {
    const files = releaseFiles();
    const crafted = { ...files, latestYml: files.latestYml.replace(`    size: ${files.installer.length}\n`, `    size: ${files.installer.length}\n    isAdminRightsRequired: true\n`) };
    expect(crafted.latestYml).toContain('isAdminRightsRequired: true');
    const server = await startReleaseServer(crafted, {});
    const harness = await createHarness(server, { sources: ['official'] });
    await harness.service.check();
    await harness.service.download();
    await harness.waitFor(state => state.phase === 'downloaded');
    const info = JSON.parse(await readFile(path.join(harness.root, 'update-cache', 'fusionkit-test-updater', 'pending', 'update-info.json'), 'utf8'));
    expect(info).toMatchObject({ fileName: files.installerName, isAdminRightsRequired: false });
  });

  it('moves on when a download is cut off or stops sending data', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { download: 'truncate' }, ghfast: { download: 'stall' } });
    const harness = await createHarness(server, { sources: ['official', 'ghfast', 'ghproxy'], stallTimeoutMs: 400 });
    await harness.service.check();
    await harness.service.download();
    const done = await harness.waitFor(state => state.phase !== 'downloading');
    expect(done).toMatchObject({ phase: 'downloaded', source: 'ghproxy' });
    expect(harness.states.map(state => state.source).filter((value, index, all) => value && all.indexOf(value) === index)).toEqual(['official', 'ghfast', 'ghproxy']);
  });

  it('cancels a download without an error and can start it again', async () => {
    const files = releaseFiles();
    const behaviour = { official: { download: 'stall' as const } };
    const server = await startReleaseServer(files, behaviour);
    const harness = await createHarness(server, { sources: ['official'] });
    await harness.service.check();
    await harness.service.download();
    await harness.waitFor(state => state.phase === 'downloading');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await harness.service.cancel()).toMatchObject({ phase: 'available' });
    expect(harness.service.state().error).toBeUndefined();
    (behaviour.official as { download: string }).download = 'ok';
    await harness.service.download();
    expect(await harness.waitFor(state => state.phase !== 'downloading')).toMatchObject({ phase: 'downloaded' });
  });

  it('installs silently and starts FusionKit again, once, after preparing', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, {});
    const order: string[] = [];
    const harness = await createHarness(server, { sources: ['official'], prepareInstall: async () => { order.push('prepare'); } });
    expect(await harness.service.install()).toMatchObject({ phase: 'idle' });
    await harness.service.check();
    await harness.service.download();
    await harness.waitFor(state => state.phase === 'downloaded');
    const installing = await harness.service.install();
    await harness.service.install();
    expect(installing.phase).toBe('installing');
    expect(order).toEqual(['prepare']);
    expect(harness.installs).toEqual([{ isSilent: true, isForceRunAfter: true }]);
  });

  it('offers "restart FusionKit", not a second installer, when FusionKit is still running after the installer was started', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, {});
    const relaunch = vi.fn();
    // The test updater only records the start, so FusionKit "keeps running".
    const harness = await createHarness(server, { sources: ['official'], installTimeoutMs: 150, relaunch, prepareInstall: async () => undefined });
    expect(await harness.service.restart()).toMatchObject({ phase: 'idle' });
    await harness.service.check();
    await harness.service.download();
    await harness.waitFor(state => state.phase === 'downloaded');
    expect(await harness.service.install()).toMatchObject({ phase: 'installing' });
    const failed = await harness.waitFor(state => state.phase === 'error');
    expect(failed.error).toMatchObject({ kind: 'unknown', during: 'install', installStage: 'start' });
    expect(failed.error!.detail).toMatch(/still running/);
    // electron-updater would ignore a second start, so a retry or a new check does nothing; a restart does.
    const requests = server.requests.length;
    expect(await harness.service.install()).toMatchObject({ phase: 'error' });
    expect(await harness.service.check()).toMatchObject({ phase: 'error' });
    expect(server.requests).toHaveLength(requests);
    expect(harness.installs).toEqual([{ isSilent: true, isForceRunAfter: true }]);
    expect(relaunch).not.toHaveBeenCalled();
    await harness.service.restart();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('says when FusionKit could not stop its services first, and lets that be retried', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, {});
    let failures = 1;
    const harness = await createHarness(server, {
      sources: ['official'],
      prepareInstall: async () => { if (failures-- > 0) throw new Error('The local inference runtime did not finish shutting down in time.'); },
    });
    await harness.service.check();
    await harness.service.download();
    await harness.waitFor(state => state.phase === 'downloaded');
    const failed = await harness.service.install();
    expect(failed).toMatchObject({ phase: 'error', error: { during: 'install', installStage: 'prepare' } });
    expect(failed.error!.detail).toContain('did not finish shutting down');
    expect(harness.installs).toEqual([]);
    expect(await harness.service.install()).toMatchObject({ phase: 'installing' });
    expect(harness.installs).toEqual([{ isSilent: true, isForceRunAfter: true }]);
  });

  it('macOS only links to the DMG listed in latest-mac.yml and never downloads', async () => {
    const files = releaseFiles();
    const server = await startReleaseServer(files, {});
    const harness = await createHarness(server, { sources: ['official'], platform: 'darwin' });
    const state = await harness.service.check();
    expect(state).toMatchObject({
      phase: 'available', installMode: 'manual', latestVersion: '9.9.9', downloadSize: files.installer.length + 1,
      manualDownload: {
        fileName: 'FusionKit_9.9.9_arm64.dmg',
        officialUrl: 'https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/FusionKit_9.9.9_arm64.dmg',
        mirrorUrl: 'https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/FusionKit_9.9.9_arm64.dmg',
      },
    });
    expect(server.requests).toEqual(['official /latest/download/latest-mac.yml']);
    // macOS installs by hand either way, so its state carries no trust level.
    expect(state.manifestTrust).toBeUndefined();
    expect(await harness.service.download()).toMatchObject({ phase: 'available' });
    expect(await harness.service.install()).toMatchObject({ phase: 'available' });
    expect(server.requests).toHaveLength(1);
  });
});

describe('update service without an installed build', () => {
  it('never checks or reaches the network in a development build', async () => {
    const updater: UpdaterLike = { setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), on: vi.fn() };
    const service = new AppUpdateService({ updater, classes: loadElectronUpdater(), currentVersion: '0.5.1', platform: 'win32', active: false, getDownloadSourceMode: () => 'auto' });
    expect(await service.check()).toEqual({ phase: 'idle', installMode: 'unsupported', currentVersion: '0.5.1', downloadSourceMode: 'auto', releaseUrl: 'https://github.com/QiuYeDx/FusionKit/releases/latest' });
    await service.download();
    await service.install();
    for (const method of [updater.setFeedURL, updater.checkForUpdates, updater.downloadUpdate, updater.quitAndInstall, updater.on]) expect(method).not.toHaveBeenCalled();
  });
});
