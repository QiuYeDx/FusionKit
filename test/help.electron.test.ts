import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createTestRun } from './support/testRun';
import { closeAllServers } from './network/local-servers';
import { releaseFiles, startReleaseServer, type ReleaseServer } from './app-update/helpers';

const artifacts = path.resolve('test-results/help');
const skip = process.platform === 'linux' || process.env.CODEX_SANDBOX === 'seatbelt' || process.env.FUSIONKIT_SKIP_E2E === '1';

const SECTIONS = ['quick-start', 'cannot-open', 'models-and-cost', 'download-failed', 'transcription-failed', 'proxy', 'external-agent', 'system-requirements'];
const XATTR = 'xattr -dr com.apple.quarantine /Applications/FusionKit.app';

type Look = { theme: 'light' | 'dark'; size: [number, number]; hash: string };
/** A quiet test build; update checks only reach the local release server the test names. */
async function launch(profile: string, env: Record<string, string | undefined>, look: Look) {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test',
      FUSIONKIT_TEST_UPDATE_SOURCES: undefined, FUSIONKIT_TEST_UPDATE_PLATFORM: undefined, FUSIONKIT_TEST_ONBOARDING: undefined, ...env },
  });
  await app.context().route(/CHANGELOG\.md/, route => route.abort('connectionrefused'));
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setSize(size[0], size[1]); window.webContents.setBackgroundThrottling(false); }, look.size);
  await page.evaluate(({ theme, hash }) => {
    localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    location.hash = hash;
  }, look);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  return { app, page, errors };
}

const sources = (server: ReleaseServer, ids: string[]) => JSON.stringify(ids.map(id => ({ id, base: server.base(id) })));
async function shot(page: Page, name: string) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); }
const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
/** Whether the section's heading is in the visible part of the window, below the title bar. */
const inView = (page: Page, id: string) => page.evaluate(sectionId => {
  const heading = document.querySelector(`#help-${sectionId} h2`);
  if (!heading) return false;
  const box = heading.getBoundingClientRect();
  return box.top >= 40 && box.bottom <= window.innerHeight;
}, id);

afterEach(async () => { await closeAllServers(); });

describe.skipIf(skip)('help page', () => {
  it('lists every section with a stable anchor, jumps to them, copies the macOS command and reopens the setup guide', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined;
    let savedClipboard: string | undefined;
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), {}, { theme: 'light', size: [786, 540], hash: '/' }));
      savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());

      // The main navigation has a Help entry.
      await page.getByRole('button', { name: '帮助', exact: true }).click();
      await uiExpect(page.getByTestId('help-page')).toBeVisible();
      await uiExpect(page.getByRole('heading', { level: 1, name: '帮助' })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe('#/help');
      // Reached from the main navigation: no "back" (that is for help opened from a notice).
      await uiExpect(page.getByTestId('help-back')).toHaveCount(0);
      for (const id of SECTIONS) await uiExpect(page.locator(`section#help-${id}[data-help-section="${id}"]`)).toHaveCount(1);
      await uiExpect(page.getByTestId('help-toc').getByRole('button')).toHaveCount(SECTIONS.length);
      await uiExpect(page.locator('#help-system-requirements')).toContainText('macOS 12 或更新版本，仅支持 Apple 芯片');
      await uiExpect(page.locator('#help-system-requirements')).toContainText('Windows 10 或 11');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '01-help-top-light-786x540');

      // The contents list scrolls to a section and records it in the address.
      await page.getByTestId('help-toc').locator('[data-section="cannot-open"]').click();
      await uiExpect.poll(() => page.evaluate(() => location.hash)).toBe('#/help?section=cannot-open');
      await uiExpect.poll(() => inView(page, 'cannot-open')).toBe(true);
      const cannotOpen = page.locator('#help-cannot-open');
      await uiExpect(cannotOpen).toContainText('隐私与安全性');
      await uiExpect(cannotOpen).toContainText('仍要打开');
      await uiExpect(cannotOpen).toContainText('更多信息');
      await uiExpect(cannotOpen).toContainText('仍要运行');
      await uiExpect(cannotOpen).toContainText('只去掉 FusionKit 的下载标记');
      await uiExpect(page.getByTestId('help-xattr-command')).toHaveText(XATTR);
      await page.getByTestId('help-copy-xattr').click();
      await uiExpect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).trim()).toBe(XATTR);
      await uiExpect(page.getByText('已复制，粘贴到“终端”里按回车')).toBeVisible();
      await shot(page, '02-help-cannot-open-light-786x540');

      // An address with a section opens the page there (what notices link to).
      await page.evaluate(() => { location.hash = '/help?section=proxy'; });
      await uiExpect.poll(() => inView(page, 'proxy')).toBe(true);
      await uiExpect(page.locator('#help-proxy')).toContainText('Clash');
      // An unknown section is simply the page from the top.
      await page.evaluate(() => { location.hash = '/help?section=nope'; });
      await uiExpect(page.getByTestId('help-page')).toBeVisible();

      await page.getByTestId('help-reopen-onboarding').click();
      await uiExpect(page.getByTestId('welcome-wizard')).toBeVisible();
      await page.getByTestId('welcome-skip').click();
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      if (app && savedClipboard !== undefined) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => undefined);
      await app?.close();
    }
  }, 120_000);

  it('is reached from an error guide\'s "view help" and from the macOS update note, at the matching section', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const server = await startReleaseServer(releaseFiles(), { official: { check: 'drop' }, ghfast: { check: 'drop' } });
    let app: ElectronApplication | undefined;
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), { FUSIONKIT_TEST_UPDATE_SOURCES: sources(server, ['official', 'ghfast']) },
        { theme: 'dark', size: [786, 540], hash: '/about' }));
      await page.getByRole('button', { name: '检查更新' }).click();
      const guide = page.getByTestId('update-error-guide');
      await uiExpect(guide).toHaveAttribute('data-kind', 'network', { timeout: 15_000 });
      await guide.locator('[data-action="open_help"]').click();
      await uiExpect(page.getByTestId('update-dialog')).toHaveCount(0);
      await uiExpect.poll(() => page.evaluate(() => location.hash)).toBe('#/help?section=download-failed');
      await uiExpect.poll(() => inView(page, 'download-failed')).toBe(true);
      await uiExpect(page.locator('#help-download-failed')).toHaveAttribute('data-highlighted', 'true');
      await uiExpect(page.locator('#help-download-failed')).toContainText('国内镜像优先');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '03-help-from-update-error-dark-786x540');
      // "Back" returns to the page the notice was on, even after moving through the contents.
      await page.getByTestId('help-toc').locator('[data-section="proxy"]').click();
      await uiExpect.poll(() => page.evaluate(() => location.hash)).toBe('#/help?section=proxy');
      await page.getByTestId('help-back').click();
      await uiExpect.poll(() => page.evaluate(() => location.hash)).toBe('#/about');
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }

    // The macOS replacement note links to the section on opening the app.
    await closeAllServers();
    const macServer = await startReleaseServer(releaseFiles(), {});
    try {
      let page: Page;
      ({ app, page } = await launch(path.join(root, 'profile-mac'), {
        FUSIONKIT_TEST_UPDATE_SOURCES: sources(macServer, ['official']), FUSIONKIT_TEST_UPDATE_PLATFORM: 'darwin',
      }, { theme: 'light', size: [786, 540], hash: '/' }));
      await uiExpect(page.getByTestId('update-dialog')).toHaveAttribute('data-phase', 'available', { timeout: 15_000 });
      await page.getByTestId('update-mac-help').click();
      await uiExpect(page.getByTestId('update-dialog')).toHaveCount(0);
      await uiExpect.poll(() => page.evaluate(() => location.hash)).toBe('#/help?section=cannot-open');
      await uiExpect.poll(() => inView(page, 'cannot-open')).toBe(true);
    } finally {
      await app?.close();
    }
  }, 150_000);
});
