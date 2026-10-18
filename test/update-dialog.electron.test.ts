import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createTestRun } from './support/testRun';
import { closeAllServers } from './network/local-servers';
import { releaseFiles, startReleaseServer, type ReleaseServer } from './app-update/helpers';

const artifacts = path.resolve('test-results/update-dialog');
const skip = process.platform === 'linux' || process.env.CODEX_SANDBOX === 'seatbelt' || process.env.FUSIONKIT_SKIP_E2E === '1';

const CHANGELOG = ['# Changelog', '', '## [9.9.9] - 2026-10-20', '', '### 新功能', '- 应用内下载并安装更新', '- 连不上 GitHub 时自动改用国内镜像', ''].join('\n');

type Look = { theme: 'light' | 'dark'; size: [number, number]; changelog?: 'ok' | 'unreachable' };
/**
 * A test build whose updater talks to local stand-ins for github.com and its mirrors; the
 * changelog requests (Chromium) are answered locally too, so nothing reaches the internet.
 */
async function launch(profile: string, env: Record<string, string | undefined>, look: Look) {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test',
      FUSIONKIT_TEST_UPDATE_SOURCES: undefined, FUSIONKIT_TEST_UPDATE_PLATFORM: undefined, FUSIONKIT_TEST_UPDATE_INSTALL_TIMEOUT_MS: undefined,
      FUSIONKIT_TEST_ONBOARDING: undefined, ...env },
  });
  await app.context().route(/CHANGELOG\.md/, route => look.changelog === 'unreachable'
    ? route.abort('connectionrefused')
    : route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: CHANGELOG }));
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setSize(size[0], size[1]); window.webContents.setBackgroundThrottling(false); }, look.size);
  await page.evaluate(({ theme }) => {
    localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    location.hash = '/';
  }, look);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  return { app, page, errors };
}

const sources = (server: ReleaseServer, ids: string[]) => JSON.stringify(ids.map(id => ({ id, base: server.base(id) })));
const dialog = (page: Page) => page.getByTestId('update-dialog');
async function shot(page: Page, name: string) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); }
const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function checkFromAbout(page: Page) {
  await page.evaluate(() => { location.hash = '/about'; });
  await page.getByRole('button', { name: '检查更新' }).click();
}

afterEach(async () => { await closeAllServers(); });

describe.skipIf(skip)('update dialog', () => {
  it('finds a new version through a mirror at launch, downloads it with progress and restarts into the installer', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const files = releaseFiles('9.9.9', 3 * 1024 * 1024);
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghfast: { download: 'slow', slowMs: 6_000 } });
    let app: ElectronApplication | undefined;
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), { FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official', 'ghfast', 'ghproxy']) }, { theme: 'light', size: [786, 540] }));

      // The launch check found it on the mirror (github.com dropped the connection) and opened the dialog;
      // the second mirror served the same release, so it may be installed in the app.
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available', { timeout: 15_000 });
      await uiExpect(dialog(page)).toHaveAttribute('data-trust', 'mirrors_agree');
      await uiExpect(page.getByTestId('update-unverified')).toHaveCount(0);
      await uiExpect(dialog(page)).toContainText('发现新版本 v9.9.9');
      await uiExpect(page.getByTestId('update-size')).toContainText('安装包约 3.00 MB');
      await uiExpect(dialog(page)).toContainText('应用内下载并安装更新');
      await uiExpect(page.getByTestId('update-open-releases')).toHaveAttribute('href', 'https://github.com/QiuYeDx/FusionKit/releases/tag/v9.9.9');
      expect(server.requests).toContain('official /latest/download/latest.yml');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '01-available-light-786x540');

      await page.getByTestId('update-download').click();
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'downloading');
      await uiExpect(page.getByTestId('update-source')).toHaveText('下载来源：国内镜像（ghfast.top）');
      await uiExpect(page.getByTestId('update-cancel')).toBeVisible();
      await uiExpect.poll(async () => Number(await page.getByTestId('update-progress').getAttribute('data-percent').catch(() => '0'))).toBeGreaterThan(0);
      await shot(page, '02-downloading-light-786x540');

      // Closed during the download: the About page shows how far it is, and the end opens the dialog again.
      await page.keyboard.press('Escape');
      await uiExpect(dialog(page)).toHaveCount(0);
      await page.evaluate(() => { location.hash = '/about'; });
      await uiExpect(page.getByTestId('about-update-badge')).toHaveAttribute('data-phase', 'downloading');
      await uiExpect(page.getByTestId('about-update-badge')).toContainText('正在下载');
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'downloaded', { timeout: 15_000 });
      await uiExpect(page.getByTestId('update-downloaded')).toContainText('已通过完整性检查');
      await uiExpect(page.getByTestId('update-downloaded')).toContainText('正在进行的转写或翻译会被中断');
      await uiExpect(page.getByTestId('about-update-badge')).toHaveText('已下载，重启即可安装');
      expect(server.requests).toContain(`ghfast /download/v9.9.9/${files.installerName}`);
      await shot(page, '03-downloaded-light-786x540');

      await page.getByTestId('update-install').click();
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'installing');
      await uiExpect(page.getByTestId('update-installing')).toContainText('请不要手动打开 FusionKit');
      expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__fusionkitTestUpdateInstalls)).toEqual([{ isSilent: true, isForceRunAfter: true }]);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('offers only the download links, with the reason, when a single mirror vouches for the new version', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    // github.com and the second mirror do not answer; the one that does serves its own program.
    const files = releaseFiles();
    const server = await startReleaseServer(files, { official: { check: 'drop' }, ghfast: { release: releaseFiles(files.version) }, ghproxy: { check: 'drop' } });
    let app: ElectronApplication | undefined;
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), { FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official', 'ghfast', 'ghproxy']) }, { theme: 'dark', size: [786, 540] }));
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available', { timeout: 15_000 });
      await uiExpect(dialog(page)).toHaveAttribute('data-trust', 'unverified');
      const note = page.getByTestId('update-unverified');
      await uiExpect(note).toContainText('这次不能在应用内安装');
      await uiExpect(note).toContainText('为了安全，镜像来源无法互相印证时不会自动安装');
      // The mirror link is offered too, so the note says its installer is not checked either.
      await uiExpect(note).toContainText('“国内镜像下载安装包”拿到的文件同样没有经过核对');
      // No in-app download; the download page and the mirror link instead (not clicked: they open the browser).
      await uiExpect(page.getByTestId('update-download')).toHaveCount(0);
      await uiExpect(page.getByTestId('update-manual-releases')).toHaveAttribute('href', 'https://github.com/QiuYeDx/FusionKit/releases/tag/v9.9.9');
      await uiExpect(page.getByTestId('update-manual-mirror')).toHaveAttribute('href', `https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/${files.installerName}`);
      await uiExpect(page.getByTestId('update-check-again')).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '10-unverified-mirror-dark-786x540');
      expect(server.requests.some(line => line.includes('/download/v'))).toBe(false);

      // "View help" leads to the help on downloads.
      await page.getByTestId('update-unverified-help').click();
      await uiExpect(dialog(page)).toHaveCount(0);
      await uiExpect.poll(() => page.evaluate(() => location.hash)).toBe('#/help?section=download-failed');
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('stays quiet when nothing answers at launch, and explains a failed manual check with a way to the network settings', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const server = await startReleaseServer(releaseFiles(), { official: { check: 'drop' }, ghfast: { check: 'drop' } });
    let app: ElectronApplication | undefined;
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), { FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official', 'ghfast']) }, { theme: 'dark', size: [786, 540] }));
      await uiExpect.poll(() => server.requests.filter(line => line.startsWith('ghfast ')).length, { timeout: 15_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(800);
      await uiExpect(dialog(page)).toHaveCount(0);

      // Nothing answered, so the About page claims nothing about being up to date.
      await page.evaluate(() => { location.hash = '/about'; });
      await uiExpect(page.getByRole('button', { name: '检查更新' })).toBeVisible();
      await uiExpect(page.getByTestId('about-update-badge')).toHaveCount(0);
      await checkFromAbout(page);
      const guide = page.getByTestId('update-error-guide');
      await uiExpect(guide).toHaveAttribute('data-kind', 'network');
      await uiExpect(guide).toContainText('检查更新失败');
      await uiExpect(guide).toContainText('网络不通：连不上 GitHub，国内镜像也没有回应。');
      await uiExpect(guide).toContainText('可以稍后再试，或在“网络”设置中换下载源、开代理。');
      // The technical detail is folded away until asked for.
      const detail = page.getByTestId('update-error-detail');
      await uiExpect(detail.locator('pre')).toBeHidden();
      await detail.locator('summary').click();
      await uiExpect(detail.locator('pre')).toContainText('official (check)');
      await uiExpect(detail.locator('pre')).toContainText('ghfast (check)');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '04-check-failed-dark-786x540');

      await guide.locator('[data-action="open_network_settings"]').click();
      await uiExpect(dialog(page)).toHaveCount(0);
      await uiExpect(page.getByTestId('setting-tab-proxy')).toHaveAttribute('aria-current', 'page');
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('explains a download that fails its integrity check and offers a retry', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const behaviour = { official: { download: 'corrupt' as 'corrupt' | 'ok' } };
    const server = await startReleaseServer(releaseFiles(), behaviour);
    let app: ElectronApplication | undefined;
    try {
      let page: Page;
      ({ app, page } = await launch(path.join(root, 'profile'), { FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official']) }, { theme: 'light', size: [786, 540] }));
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available', { timeout: 15_000 });
      await page.getByTestId('update-download').click();
      const guide = page.getByTestId('update-error-guide');
      await uiExpect(guide).toHaveAttribute('data-kind', 'checksum', { timeout: 15_000 });
      await uiExpect(guide).toContainText('下载更新失败');
      await uiExpect(guide).toContainText('没有通过完整性检查');
      // The manual way out: the download page and the installer through a mirror (not clicked: it opens the browser).
      await uiExpect(guide.locator('[data-action="open_releases"]')).toHaveText('打开下载页面');
      await uiExpect(guide.locator('[data-action="open_mirror_download"]')).toHaveText('国内镜像下载安装包');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '05-download-checksum-light-786x540');
      behaviour.official.download = 'ok';
      await guide.locator('[data-action="retry"]').click();
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'downloaded', { timeout: 15_000 });
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('links macOS to the new DMG on GitHub and the mirror, with the Privacy & Security note, and never downloads', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const server = await startReleaseServer(releaseFiles(), {});
    let app: ElectronApplication | undefined;
    try {
      let page: Page;
      ({ app, page } = await launch(path.join(root, 'profile'), {
        FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official']), FUSIONKIT_TEST_UPDATE_PLATFORM: 'darwin',
      }, { theme: 'light', size: [786, 540] }));
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available', { timeout: 15_000 });
      await uiExpect(dialog(page)).toHaveAttribute('data-install-mode', 'manual');
      await uiExpect(page.getByTestId('update-mac-dmg')).toHaveAttribute('href', 'https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/FusionKit_9.9.9_arm64.dmg');
      await uiExpect(page.getByTestId('update-mac-mirror')).toHaveAttribute('href', 'https://ghfast.top/https://github.com/QiuYeDx/FusionKit/releases/download/v9.9.9/FusionKit_9.9.9_arm64.dmg');
      await uiExpect(page.getByTestId('update-mac-note')).toContainText('隐私与安全性');
      // Quit first, replace, and the one command for "is damaged", ready to copy.
      await uiExpect(page.getByTestId('update-mac-note')).toContainText('选“退出”');
      await uiExpect(page.getByTestId('update-mac-note')).toContainText('已损坏');
      await uiExpect(page.getByTestId('update-mac-command')).toHaveText('xattr -dr com.apple.quarantine /Applications/FusionKit.app');
      await uiExpect(page.getByTestId('update-mac-copy')).toBeVisible();
      await uiExpect(page.getByTestId('update-download')).toHaveCount(0);
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '06-mac-light-786x540');
      expect(server.requests.every(line => line.endsWith('latest-mac.yml'))).toBe(true);
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('waits for the welcome wizard before showing a version found at launch, and the About page opens it again', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const server = await startReleaseServer(releaseFiles(), {});
    let app: ElectronApplication | undefined;
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), {
        FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official']), FUSIONKIT_TEST_ONBOARDING: '1',
      }, { theme: 'light', size: [786, 540], changelog: 'unreachable' }));
      await uiExpect(page.locator('[data-testid="welcome-wizard"][data-step="choose"]')).toBeVisible();
      await uiExpect.poll(() => server.requests.filter(line => line.endsWith('latest.yml')).length, { timeout: 15_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(800);
      await uiExpect(dialog(page)).toHaveCount(0);

      await page.getByTestId('welcome-skip').click();
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available');
      // The changelog could not be fetched: said in a line, not a silent gap.
      await uiExpect(page.getByTestId('update-changelog-failed')).toContainText('更新内容暂时获取不到');
      await shot(page, '07-after-wizard-changelog-failed-light-786x540');

      await page.keyboard.press('Escape');
      await uiExpect(dialog(page)).toHaveCount(0);
      const checks = server.requests.length;
      await page.evaluate(() => { location.hash = '/about'; });
      const badge = page.getByTestId('about-update-badge');
      await uiExpect(badge).toHaveText('有新版本 v9.9.9');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '09-about-badge-light-786x540');
      await badge.click();
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available');
      expect(server.requests.length).toBe(checks);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('offers "restart FusionKit" when the installer did not take over', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const server = await startReleaseServer(releaseFiles(), {});
    let app: ElectronApplication | undefined;
    try {
      let page: Page;
      ({ app, page } = await launch(path.join(root, 'profile'), {
        FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official']), FUSIONKIT_TEST_UPDATE_INSTALL_TIMEOUT_MS: '1500',
      }, { theme: 'dark', size: [786, 540] }));
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'available', { timeout: 15_000 });
      await page.getByTestId('update-download').click();
      await uiExpect(dialog(page)).toHaveAttribute('data-phase', 'downloaded', { timeout: 15_000 });
      await page.getByTestId('update-install').click();
      const guide = page.getByTestId('update-error-guide');
      await uiExpect(guide).toHaveAttribute('data-during', 'install', { timeout: 15_000 });
      await uiExpect(guide).toContainText('安装程序没有启动');
      await uiExpect(guide).toContainText('本地转写等功能已经停下了');
      await uiExpect(guide.locator('[data-action="retry"]')).toHaveCount(0);
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '08-install-failed-dark-786x540');
      await guide.locator('[data-action="restart_app"]').click();
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as Record<string, unknown>).__fusionkitTestUpdateRestarts)).toBe(1);
      expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__fusionkitTestUpdateInstalls)).toEqual([{ isSilent: true, isForceRunAfter: true }]);
    } finally {
      await app?.close();
    }
  }, 120_000);

  it('tells a development build that it does not check for updates, and stays quiet at launch', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined;
    try {
      let page: Page;
      ({ app, page } = await launch(path.join(root, 'profile'), {}, { theme: 'light', size: [786, 540] }));
      await page.waitForTimeout(2_000);
      await uiExpect(dialog(page)).toHaveCount(0);
      await checkFromAbout(page);
      await uiExpect(page.getByTestId('update-dev-build')).toContainText('开发版本不检查更新');
    } finally {
      await app?.close();
    }
  }, 120_000);
});
