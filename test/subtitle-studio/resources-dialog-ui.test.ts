import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_RESOURCE_UI === '1';
const modelId = 'large-v3-q5_0';
const otherModelId = 'large-v3';
const vadId = 'silero-vad-v6.2.0-ggml';
type Snapshot = { traces: { operation: string; detail?: unknown }[]; shared?: { revision: number; busyResourceIds: string[] } };
async function control(app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> {
  return app.evaluate(async (_electron, value) => (globalThis as any).__studioT06Control(value), command);
}
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
async function settle(page: Page) {
  await page.evaluate(async () => {
    const surface = document.querySelector<HTMLElement>('.studio-transcription-resource-dialog');
    if (!surface) throw new Error('Resources dialog is missing');
    await document.fonts.ready;
    await new Promise<void>((resolve, reject) => {
      const started = performance.now(); let previous = '', stable = 0;
      const sample = () => {
        const rect = surface.getBoundingClientRect();
        const fadeOpacity = [...surface.querySelectorAll('.pointer-events-none')].map(edge => Number(getComputedStyle(edge).opacity).toFixed(3)).join(',');
        const key = [rect.x, rect.y, rect.width, rect.height].map(value => value.toFixed(1)).join(',') + ':' + fadeOpacity;
        stable = key === previous && !surface.querySelector('[data-flow-animating=true]') ? stable + 1 : 0;
        previous = key;
        if (stable >= 8) resolve();
        else if (performance.now() - started > 6000) reject(new Error('Resources dialog did not settle'));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
}
async function geometry(page: Page) {
  return page.locator('.studio-transcription-resource-dialog').evaluate(surface => {
    const viewport = surface.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]')!;
    const body = surface.querySelector<HTMLElement>('[data-dialog-body-measure]')!;
    const header = surface.querySelector<HTMLElement>('[data-dialog-section=header]')!.getBoundingClientRect();
    const footer = surface.querySelector<HTMLElement>('[data-dialog-section=footer]')!.getBoundingClientRect();
    const bodySection = surface.querySelector<HTMLElement>('[data-dialog-section=body]')!;
    // ScrollArea places its children below Viewport's measuring wrapper, so
    // fade layers are descendants of the body rather than its direct children.
    const fades = [...bodySection.querySelectorAll<HTMLElement>('.pointer-events-none[aria-hidden=true]')].map(edge => ({
      top: Math.abs(edge.getBoundingClientRect().top - viewport.getBoundingClientRect().top) < 2,
      bottom: Math.abs(edge.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom) < 2,
      opacity: Number(getComputedStyle(edge).opacity),
      backgroundImage: getComputedStyle(edge).backgroundImage,
      pointerEvents: getComputedStyle(edge).pointerEvents,
    }));
    const rows = [...surface.querySelectorAll<HTMLElement>('[data-resource-id]')].map(row => {
      const rect = row.getBoundingClientRect(), title = row.querySelector('.studio-resource-name')!.getBoundingClientRect();
      const actions = row.querySelector('.studio-resource-actions')!.getBoundingClientRect();
      return { id: row.dataset.resourceId, height: rect.height, actionTopDelta: actions.top - title.top,
        actionGap: actions.left - title.right, actionRightInset: rect.right - actions.right,
        overflow: row.scrollWidth - row.clientWidth, buttonCount: row.querySelectorAll('button').length };
    });
    return { rows, fades, bodyPadding: getComputedStyle(body).padding, viewportOverflow: viewport.scrollWidth - viewport.clientWidth,
      scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight, headerTop: header.top, footerBottom: footer.bottom,
      viewportBottom: viewport.getBoundingClientRect().bottom, viewportHeight: innerHeight };
  });
}

it.runIf(enabled)('keeps local resource information and actions compact through installation, occupancy and deletion', async () => {
  const fixture = await buildTranscriptionUiApp('controlled');
  const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
  const t = locale.transcription;
  let app: ElectronApplication | undefined, page: Page | undefined;
  const errors: string[] = [], captures: Record<string, unknown> = {};
  const logs: string[] = [];
  try {
    app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`,
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion'], cwd: fixture.appRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    app.process().stdout?.on('data', value => logs.push(String(value)));
    app.process().stderr?.on('data', value => logs.push(String(value)));
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const window = await app.browserWindow(page);
    await window.evaluate(win => { win.webContents.setBackgroundThrottling(false); win.setSize(1280, 860); win.show(); win.focus(); });
    await page.evaluate(() => {
      localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
      location.hash = '/tools/subtitle/studio';
    });
    await page.reload(); await ready(page); await page.bringToFront();
    // The isolated native resource adapter owns both the list status and the
    // application-wide status notification boundary in this controlled test.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('speech-resources:status');
      ipcMain.handle('speech-resources:status', async () => (await (globalThis as any).__studioT06Control({ operation: 'snapshot' })).shared
        ?? { shared: true, revision: 0, busyResourceIds: [], migrationIssues: [], cleanupPending: false });
    });
    await page.getByRole('tab', { name: '转写', exact: true }).click();
    const manage = page.getByTestId('studio-transcription-manage-resources');
    await manage.click();
    const dialog = page.locator('.studio-transcription-resource-dialog');
    const model = dialog.locator(`[data-resource-id="${modelId}"]`);
    const otherModel = dialog.locator(`[data-resource-id="${otherModelId}"]`);
    const vad = dialog.locator(`[data-resource-id="${vadId}"]`);
    const refresh = async () => {
      await dialog.getByRole('button', { name: t.check_again, exact: true }).click();
      await uiExpect(dialog.getByRole('button', { name: t.check_again, exact: true })).toBeEnabled();
      await settle(page!);
    };
    const capture = async (name: string) => {
      await window.evaluate(win => { win.show(); win.focus(); }); await page!.bringToFront();
      await settle(page!);
      const value = await geometry(page!); captures[name] = value;
      expect(value.viewportOverflow).toBeLessThanOrEqual(1);
      expect(value.rows.every(row => row.overflow <= 1)).toBe(true);
      expect(value.bodyPadding).toBe('12px');
      expect(value.footerBottom).toBeLessThanOrEqual(value.viewportHeight);
      expect(value.viewportBottom).toBeLessThanOrEqual(value.footerBottom);
      await page!.screenshot({ path: path.join(fixture.artifacts, `${name}.png`) });
      return value;
    };
    await uiExpect(model).toHaveAttribute('data-state', 'not_installed');
    const missing = await capture('resources-01-light-not-installed');
    expect(missing.rows.every(row => row.height <= 64 && Math.abs(row.actionTopDelta) <= 1 && row.actionGap >= 8)).toBe(true);

    await model.getByRole('button', { name: t.download, exact: true }).click();
    await uiExpect(model).toHaveAttribute('data-state', 'installing');
    await uiExpect(model.getByRole('progressbar')).toHaveAttribute('value', '24');
    await capture('resources-02-light-installing');
    await model.getByRole('button', { name: t.cancel_download, exact: true }).click();
    await uiExpect(model).toHaveAttribute('data-state', 'not_installed');
    await model.getByRole('button', { name: t.download, exact: true }).click();
    await control(app, { operation: 'resource-failed', resourceId: modelId }); await refresh();
    await uiExpect(model).toContainText(t.resource_failed);
    await capture('resources-03-light-error');

    await model.getByRole('button', { name: t.download, exact: true }).click();
    await control(app, { operation: 'resource-complete', resourceId: modelId });
    await control(app, { operation: 'resources-ready' }); await refresh();
    const complete = await capture('resources-04-light-ready');
    expect(complete.rows.every(row => row.height <= 64 && row.buttonCount === 1 && Math.abs(row.actionTopDelta) <= 1 && row.actionRightInset <= 9)).toBe(true);
    await model.getByRole('button', { name: t.delete_resource, exact: true }).focus();
    await uiExpect(page.getByRole('tooltip', { name: t.delete_resource, exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    const confirmation = page.getByRole('dialog').filter({ has: page.getByTestId('studio-confirm-delete-resource') });
    await uiExpect(confirmation).toContainText('Large v3 · Q5');
    await confirmation.getByRole('button', { name: locale.cancel, exact: true }).click();
    await uiExpect(confirmation).toHaveCount(0);
    expect((await control(app, { operation: 'snapshot' })).traces.some(trace => trace.operation === 'delete-resource')).toBe(false);

    await control(app, { operation: 'resource-busy', resourceId: modelId, busy: true }); await refresh();
    await uiExpect(model.getByRole('button', { name: t.delete_resource, exact: true })).toBeDisabled();
    await uiExpect(model).toContainText(t.shared_busy);
    await capture('resources-05-light-busy');
    await control(app, { operation: 'resource-busy', resourceId: modelId, busy: false }); await refresh();
    await model.getByRole('button', { name: t.delete_resource, exact: true }).click();
    await page.getByTestId('studio-confirm-delete-resource').click();
    await uiExpect(confirmation).toHaveCount(0);
    await uiExpect(model).toHaveAttribute('data-state', 'not_installed');
    expect((await control(app, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'delete-resource')).toHaveLength(1);

    // Mix busy, failed and ready rows at the application's supported minimum
    // window size; a long unbroken name must wrap within the actual viewport.
    await control(app, { operation: 'resource-name', resourceId: otherModelId, displayName: '超长本地模型资料标识'.repeat(20) });
    await control(app, { operation: 'resource-busy', resourceId: otherModelId, busy: true });
    await model.getByRole('button', { name: t.download, exact: true }).click();
    await control(app, { operation: 'resource-failed', resourceId: modelId });
    await control(app, { operation: 'resource-name', resourceId: vadId, displayName: 'Silero VAD · 语音检测模型' });
    await refresh();
    await uiExpect(otherModel.getByRole('button', { name: t.delete_resource, exact: true })).toBeDisabled();
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await window.evaluate(win => { win.setSize(786, 540); win.show(); win.focus(); });
    await uiExpect(vad).toHaveAttribute('data-state', 'ready');
    const narrow = await capture('resources-06-dark-compact-top');
    expect(narrow.scrollHeight).toBeGreaterThan(narrow.clientHeight + 1);
    expect(narrow.fades.some(edge => edge.bottom && edge.opacity > 0 && edge.backgroundImage.includes('linear-gradient') && edge.pointerEvents === 'none')).toBe(true);
    const viewport = dialog.locator('[data-slot=scroll-area-viewport]');
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bottom = await capture('resources-07-dark-compact-bottom');
    expect(bottom.fades.some(edge => edge.top && edge.opacity > 0 && edge.backgroundImage.includes('linear-gradient') && edge.pointerEvents === 'none')).toBe(true);
    await dialog.getByRole('button', { name: t.close, exact: true }).click();
    await uiExpect(dialog).toHaveCount(0); await uiExpect(manage).toBeFocused();
    expect(errors).toEqual([]);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture.artifacts, 'resources-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await writeFile(path.join(fixture.artifacts, 'resources-geometry.json'), JSON.stringify(captures, null, 2));
    await writeFile(path.join(fixture.artifacts, 'resources-errors.json'), JSON.stringify(errors));
    await writeFile(path.join(fixture.artifacts, 'resources-electron.log'), logs.join(''));
    try { await app?.close(); } finally { await fixture.cleanup(); }
  }
}, 120000);
