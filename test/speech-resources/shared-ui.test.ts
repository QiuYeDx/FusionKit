import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { buildSharedResourceUiApp } from './helpers/shared-ui-build';
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from '../../src/constants/router';

const enabled = process.env.FUSIONKIT_STUDIO_T09_UI === '1';
type Fixture = Awaited<ReturnType<typeof buildSharedResourceUiApp>>;
async function control(app: ElectronApplication, operation: string, resourceId?: string) {
  return app.evaluate(async (_electron, command) => (globalThis as any).__speechT09Control(command), { operation, resourceId });
}
async function settled(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('.studio-workspace-tabs')?.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
}
async function capture(page: Page, fixture: Fixture, name: string, app: ElectronApplication) {
  const size = name.includes('dark') ? [786, 540] : [1280, 860];
  const win = await app.browserWindow(page);
  await win.evaluate((win, size) => win.setSize(size[0], size[1]), size);
  expect(await win.evaluate(win => win.getSize())).toEqual(size);
  await settled(page);
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
    dialogs: [...document.querySelectorAll('[role=dialog]')].map(element => { const box = element.getBoundingClientRect(); return { width: box.width, left: box.left, right: box.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; }),
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 }));
  expect(geometry.documentOverflow).toBe(false);
  for (const dialog of geometry.dialogs) { expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1); expect(dialog.left).toBeGreaterThanOrEqual(0); expect(dialog.right).toBeLessThanOrEqual(geometry.viewport.width + 1); }
  await writeFile(path.join(fixture.artifacts, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: path.join(fixture.artifacts, `${name}.png`), animations: 'disabled' });
}

describe.runIf(enabled)('shared speech resources in the actual Electron window', () => {
  it('migrates once, shares resource jobs and deletion across tools, and enforces busy protection', async () => {
    const fixture = await buildSharedResourceUiApp();
    const studio = JSON.parse(await readFile('src/locales/zh/studio.json', 'utf8'));
    const legacy = JSON.parse(await readFile('src/locales/zh/subtitle.json', 'utf8')).local_transcriber;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    const logs: string[] = [], errors: string[] = [];
    const q5 = 'large-v3-q5_0', f16 = 'large-v3';
    try {
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      env.NODE_ENV = 'test'; delete env.VITE_DEV_SERVER_URL;
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot,
        env });
      for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 200) logs.shift(); });
      page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('local-subtitle-transcriber-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await settled(page);
      const win = await app.browserWindow(page); await win.evaluate(win => win.setSize(1280, 860));
      const toStudio = async () => {
        await page!.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
        await page!.getByTestId('subtitle-studio').waitFor();
        if (!await page!.getByTestId('studio-transcription').isVisible()) await page!.getByRole('tab', { name: '转写', exact: true }).click();
        await page!.getByTestId('studio-transcription').waitFor();
        await page!.getByTestId('studio-transcription-manage-resources').click();
        await page!.getByTestId('studio-transcription-resources').waitFor();
      };
      const toLegacy = async () => {
        await page!.keyboard.press('Escape');
        await page!.evaluate(route => { location.hash = route; }, LOCAL_SUBTITLE_TRANSCRIBER_ROUTE);
        const toggle = page!.getByRole('button', { name: legacy.resources.title, exact: true });
        await toggle.waitFor();
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await page!.getByTestId('local-subtitle-environment-manager').waitFor();
      };
      const studioRow = (id: string) => page!.getByTestId('studio-transcription-resources').locator(`[data-resource-id="${id}"]`);
      const legacyRow = (id: string) => page!.getByTestId(`local-subtitle-resource-${id}`);
      await toStudio();
      await uiExpect(studioRow(q5)).toHaveAttribute('data-state', 'ready');
      await uiExpect(page.getByTestId('studio-shared-resource-hint')).toBeVisible();
      // Resource readiness is independent from the intentionally absent bundled runtime.
      await uiExpect(page.getByTestId('studio-transcription-resources')).toContainText(studio.transcription.runtime_unavailable);
      const snapshot = await control(app, 'snapshot');
      expect(snapshot.status.migrationIssues).toContainEqual(expect.objectContaining({ code: 'invalid_source', resourceId: f16 }));
      await uiExpect(page.getByTestId('studio-transcription-resources')).toContainText(studio.transcription.migration_issues);
      const installed = path.join(snapshot.managedResourceRoot, 'models', q5, fixture.model.fileName);
      const installedIdentity = await lstat(installed);
      expect([installedIdentity.dev, installedIdentity.ino]).toEqual([fixture.sourceIdentity.dev, fixture.sourceIdentity.ino]);
      await expect(lstat(fixture.sourceModel)).rejects.toMatchObject({ code: 'ENOENT' });
      await capture(page, fixture, '01-light-studio-shared', app);

      await studioRow(f16).getByRole('button', { name: studio.transcription.download, exact: true }).click();
      await uiExpect(studioRow(f16)).toHaveAttribute('data-state', 'installing');
      await toLegacy();
      await uiExpect(legacyRow(q5)).toContainText(legacy.resources.status.ready);
      const cancel = legacyRow(f16).getByRole('button', { name: new RegExp(legacy.actions.cancel_resource.replace('{{name}}', '.*')) });
      await uiExpect(cancel).toBeVisible();
      await legacyRow(f16).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      expect(await legacyRow(f16).evaluate(element => element.getBoundingClientRect().bottom < innerHeight - 90)).toBe(true);
      await capture(page, fixture, '02-light-legacy-shared-job', app);
      await cancel.click();
      await uiExpect.poll(async () => (await control(app!, 'snapshot')).gates.length).toBe(0);
      await toStudio(); await uiExpect(studioRow(f16)).toHaveAttribute('data-state', 'not_installed');
      await studioRow(f16).getByRole('button', { name: studio.transcription.download, exact: true }).click();
      await uiExpect.poll(async () => (await control(app!, 'snapshot')).gates).toContain(f16);
      await toLegacy(); await control(app, 'complete', f16);
      await uiExpect(legacyRow(f16)).toContainText(legacy.resources.status.ready);
      await toStudio(); await uiExpect(studioRow(f16)).toHaveAttribute('data-state', 'ready');

      await control(app, 'busy', q5);
      await uiExpect(studioRow(q5).getByRole('button', { name: studio.transcription.delete_resource, exact: true })).toBeDisabled();
      const refused = await page.evaluate(id => window.subtitleStudio.deleteTranscriptionResource({ resourceId: id }), q5);
      expect(refused).toEqual({ ok: false, error: 'resource_busy' });
      await capture(page, fixture, '03-light-studio-busy', app);
      await toLegacy();
      await uiExpect(legacyRow(q5).getByRole('button', { name: new RegExp(legacy.actions.delete_named_resource.replace('{{name}}', '.*')) })).toBeDisabled();
      const refusedLegacy = await page.evaluate(id => window.localSubtitleApi.deleteManagedResource(id), q5);
      expect(refusedLegacy.ok).toBe(false); if (!refusedLegacy.ok) expect(refusedLegacy.error.code).toBe('resource_busy');
      await control(app, 'release');

      await toStudio();
      const deleteButton = studioRow(q5).getByRole('button', { name: studio.transcription.delete_resource, exact: true });
      await uiExpect(deleteButton).toBeEnabled(); await deleteButton.focus(); await page.keyboard.press('Enter');
      await uiExpect(page.getByRole('dialog').last()).toContainText('本地字幕转写和字幕工作室');
      await capture(page, fixture, '04-light-shared-delete-confirmation', app);
      await page.getByTestId('studio-confirm-delete-resource').click(); await uiExpect(studioRow(q5)).toHaveAttribute('data-state', 'not_installed');
      await toLegacy(); await uiExpect(legacyRow(q5)).toContainText(legacy.resources.status.not_installed);
      await legacyRow(f16).getByRole('button', { name: new RegExp(legacy.actions.delete_named_resource.replace('{{name}}', '.*')) }).click();
      await uiExpect(page.getByRole('dialog')).toContainText('本地字幕转写和字幕工作室');
      await page.getByRole('dialog').getByRole('button', { name: legacy.actions.delete_resource, exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      await toStudio(); await uiExpect(studioRow(f16)).toHaveAttribute('data-state', 'not_installed');

      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
      await win.evaluate(win => win.setSize(786, 540));
      await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await toStudio(); await capture(page, fixture, '05-dark-narrow-studio-shared', app);
      await studioRow(f16).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await uiExpect(studioRow(f16).getByRole('button', { name: studio.transcription.download, exact: true })).toBeInViewport();
      await capture(page, fixture, '05b-dark-narrow-resource-actions', app);
      await page.keyboard.press('Escape'); await uiExpect(page.getByTestId('studio-transcription-manage-resources')).toBeFocused();
      await toLegacy();
      await legacyRow(f16).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      expect(await legacyRow(f16).evaluate(element => element.getBoundingClientRect().bottom < innerHeight - 90)).toBe(true);
      await capture(page, fixture, '06-dark-narrow-legacy-shared', app);
      const final = await control(app, 'snapshot');
      expect(final.gates).toEqual([]); expect(final.status.busyResourceIds).toEqual([]);
      expect(final.traces.some((trace: any) => trace.operation === 'synthetic-native-model-smoke')).toBe(true);
      expect(final.traces.some((trace: any) => trace.operation === 'download-cancel')).toBe(true);
      await writeFile(path.join(fixture.artifacts, 'fixture-trace.json'), JSON.stringify({ ...final, installedIdentity: { dev: installedIdentity.dev, ino: installedIdentity.ino }, syntheticUiOnly: true }, null, 2));
      expect(errors).toEqual([]);
    } finally {
      if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture.artifacts, 'final-window.png'), animations: 'disabled' }).catch(() => {});
      await writeFile(path.join(fixture.artifacts, 'renderer-errors.json'), JSON.stringify(errors));
      await writeFile(path.join(fixture.artifacts, 'electron.log'), logs.join(''));
      if (app) await control(app, 'release').catch(() => {});
      try { await app?.close(); } finally { await fixture.cleanup(); }
      await writeFile(path.join(fixture.artifacts, 'cleanup.json'), JSON.stringify({ profileRemoved: true, applicationRemoved: true }));
    }
  }, 120000);
});
