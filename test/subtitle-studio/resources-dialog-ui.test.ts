import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_RESOURCE_UI === '1';
const modelId = 'large-v3-q5_0';
const otherModelId = 'large-v3';
const vadId = 'silero-vad-v6.2.0-ggml';
const cudaId = 'whisper-cuda-win32-x64';
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
      env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_TEST_VC_RUNTIME: 'ok', FUSIONKIT_TEST_GPU: 'nvidia' } });
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
    // Plain names, with the catalog's own name kept as a detail; the NVIDIA pack is recommended here.
    await uiExpect(model.locator('.studio-resource-name')).toHaveText(t.resource_name_standard);
    await uiExpect(model.getByTestId('studio-resource-detail')).toHaveText('Large v3 · Q5');
    await uiExpect(otherModel.locator('.studio-resource-name')).toHaveText(t.resource_name_best);
    await uiExpect(vad.locator('.studio-resource-name')).toHaveText(t.resource_name_vad);
    const cuda = dialog.locator(`[data-resource-id="${cudaId}"]`);
    await uiExpect(cuda.locator('.studio-resource-name')).toHaveText(t.resource_name_cuda);
    await uiExpect(cuda.getByTestId('studio-resource-recommended')).toHaveText(t.recommended);
    await uiExpect(dialog.getByTestId('studio-resources-vc-runtime')).toHaveCount(0);
    await uiExpect(dialog.getByTestId('studio-resources-prepare-start')).toBeEnabled();
    const missing = await capture('resources-01-light-not-installed');
    expect(missing.rows.every(row => row.height <= 64 && Math.abs(row.actionTopDelta) <= 1 && row.actionGap >= 8)).toBe(true);
    const installs = async () => (await control(app!, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'install-resource').map(trace => (trace.detail as { resourceId: string }).resourceId);
    // Voice detection's load check runs with the recommended model: before it is installed, the row says to download the model first.
    await vad.getByRole('button', { name: t.download, exact: true }).click();
    await uiExpect(vad.getByTestId('studio-resource-failure')).toHaveText(t.resource_failed_vad_needs_model);
    await uiExpect(vad).toHaveAttribute('data-state', 'not_installed');

    await model.getByRole('button', { name: t.download, exact: true }).click();
    await uiExpect(model).toHaveAttribute('data-state', 'installing');
    await uiExpect(model.getByRole('progressbar')).toHaveAttribute('value', '24');
    await capture('resources-02-light-installing');
    await model.getByRole('button', { name: t.cancel_download, exact: true }).click();
    await uiExpect(model).toHaveAttribute('data-state', 'not_installed');
    await model.getByRole('button', { name: t.download, exact: true }).click();
    await control(app, { operation: 'resource-failed', resourceId: modelId }); await refresh();
    // A download failure names the likely cause (network) and offers the network settings.
    await uiExpect(model).toContainText(t.resource_failed_network);
    await uiExpect(model.getByRole('button', { name: t.open_network_settings, exact: true })).toBeVisible();
    // …and the help on failed downloads.
    await uiExpect(model.getByTestId('studio-resource-failure-help')).toHaveText('查看帮助');
    await capture('resources-03-light-error');

    // One-click prepare starts with the model and stops when it fails: voice detection is not started without it.
    const prepare = dialog.getByTestId('studio-resources-prepare');
    const before = (await installs()).length;
    await prepare.getByTestId('studio-resources-prepare-start').click();
    await uiExpect(prepare).toHaveAttribute('data-phase', 'installing');
    await uiExpect(prepare).toContainText(t.prepare_running.replace('{{name}}', t.resource_name_standard_short).replace('{{current}}', '1').replace('{{total}}', '2'));
    await control(app, { operation: 'resource-failed', resourceId: modelId });
    await uiExpect(prepare).toHaveAttribute('data-phase', 'failed', { timeout: 10_000 });
    await uiExpect(prepare.getByTestId('studio-resources-prepare-outcome')).toHaveText(t.prepare_failed);
    expect((await installs()).slice(before)).toEqual([modelId]);

    await model.getByRole('button', { name: t.download, exact: true }).click();
    await control(app, { operation: 'resource-complete', resourceId: modelId });
    await control(app, { operation: 'resources-ready' }); await refresh();
    const complete = await capture('resources-04-light-ready');
    // Everything installed: one-click prepare has nothing left to do, and its earlier failure no longer shows.
    await uiExpect(dialog.getByTestId('studio-resources-prepare-start')).toBeDisabled();
    await uiExpect(dialog.getByTestId('studio-resources-prepare-start')).toHaveText(t.prepare_ready);
    await uiExpect(prepare.getByTestId('studio-resources-prepare-outcome')).toHaveCount(0);
    await uiExpect(prepare).toContainText(t.prepare_ready_hint);
    expect(complete.rows.every(row => row.height <= 64 && row.buttonCount === 1 && Math.abs(row.actionTopDelta) <= 1 && row.actionRightInset <= 9)).toBe(true);
    await model.getByRole('button', { name: t.delete_resource, exact: true }).focus();
    await uiExpect(page.getByRole('tooltip', { name: t.delete_resource, exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    const confirmation = page.getByRole('dialog').filter({ has: page.getByTestId('studio-confirm-delete-resource') });
    await uiExpect(confirmation).toContainText(t.resource_name_standard);
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

it.runIf(enabled)('repairs the Microsoft runtime, then prepares the recommended model and voice detection in one click', async () => {
  const fixture = await buildTranscriptionUiApp('controlled');
  const studio = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
  const common = JSON.parse(await readFile(path.resolve('src/locales/zh/common.json'), 'utf8'));
  const t = studio.transcription, vc = common.system_setup.vc_runtime;
  let app: ElectronApplication | undefined, page: Page | undefined;
  const errors: string[] = [], logs: string[] = [];
  try {
    // No VC++ runtime and no NVIDIA card; the forced repair succeeds without running anything.
    app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`,
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion'], cwd: fixture.appRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_TEST_VC_RUNTIME: 'missing', FUSIONKIT_TEST_GPU: 'none' } });
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
    await page.reload(); await ready(page);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('speech-resources:status');
      ipcMain.handle('speech-resources:status', async () => (await (globalThis as any).__studioT06Control({ operation: 'snapshot' })).shared
        ?? { shared: true, revision: 0, busyResourceIds: [], migrationIssues: [], cleanupPending: false });
    });
    await page.getByRole('tab', { name: '转写', exact: true }).click();
    const installs = async () => (await control(app!, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'install-resource').map(trace => (trace.detail as { resourceId: string }).resourceId);

    // The workspace says what is missing before anything is downloaded, and why the device is the CPU.
    const workspaceNotice = page.getByTestId('studio-transcription-vc-runtime');
    await uiExpect(workspaceNotice).toContainText(vc.title);
    await uiExpect(workspaceNotice).toContainText(vc.missing);
    await uiExpect(page.getByTestId('studio-transcription-device-hint')).toHaveText(t.device_hint_no_nvidia);
    await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-01-workspace-runtime-missing.png') });

    await page.getByTestId('studio-transcription-manage-resources').click();
    const dialog = page.locator('.studio-transcription-resource-dialog');
    await uiExpect(dialog.getByTestId('studio-resources-vc-runtime')).toContainText(vc.title);
    const prepare = dialog.getByTestId('studio-resources-prepare');
    await uiExpect(prepare).toContainText(t.prepare_title);
    await uiExpect(prepare.getByTestId('studio-resources-prepare-size')).toHaveText(t.prepare_size.replace('{{size}}', '1.0 GB'));
    await uiExpect(prepare.getByTestId('studio-resources-prepare-free')).toContainText(t.prepare_free_space.replace(' {{size}}', ''));

    // A pack for a card this computer does not have is marked and asks before downloading.
    const cuda = dialog.locator(`[data-resource-id="${cudaId}"]`);
    await uiExpect(cuda.getByTestId('studio-resource-not-applicable')).toHaveText(t.not_applicable);
    await uiExpect(cuda.getByTestId('studio-resource-not-applicable-hint')).toHaveText(t.cuda_not_applicable_hint);
    await cuda.getByRole('button', { name: t.download, exact: true }).click();
    const cudaConfirm = page.locator('.studio-cuda-confirm-dialog');
    await uiExpect(cudaConfirm).toContainText(t.cuda_confirm_title);
    await cudaConfirm.getByRole('button', { name: studio.cancel, exact: true }).click();
    await uiExpect(cudaConfirm).toHaveCount(0);

    // A single download waits for the runtime: cancelling it downloads nothing.
    const model = dialog.locator(`[data-resource-id="${modelId}"]`);
    await model.getByRole('button', { name: t.download, exact: true }).click();
    const gate = page.locator('.studio-runtime-gate-dialog');
    await uiExpect(gate).toContainText(t.vc_runtime_download_title);
    await uiExpect(gate.getByTestId('studio-runtime-gate-notice')).toContainText(vc.missing);
    await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-02-download-waits-for-runtime.png') });
    await gate.getByRole('button', { name: studio.cancel, exact: true }).click();
    await uiExpect(gate).toHaveCount(0);
    expect(await installs()).toEqual([]);
    // Downloading anyway is possible; a loading failure is then explained by the missing runtime.
    await model.getByRole('button', { name: t.download, exact: true }).click();
    await gate.getByTestId('studio-runtime-gate-anyway').click();
    await uiExpect(gate).toHaveCount(0);
    await uiExpect.poll(installs).toEqual([modelId]);
    await control(app, { operation: 'resource-failed', resourceId: modelId, code: 'model_incompatible' });
    await dialog.getByRole('button', { name: t.check_again, exact: true }).click();
    await uiExpect(model.getByTestId('studio-resource-failure').locator('.studio-transcription-row-warning')).toHaveText(t.vc_runtime_failure);
    // The help on failed transcriptions explains the runtime further.
    await uiExpect(model.getByTestId('studio-resource-failure-help')).toHaveText(common.action.view_help);

    // One-click prepare checks the runtime first and stops there.
    await prepare.getByTestId('studio-resources-prepare-start').click();
    await uiExpect(prepare).toHaveAttribute('data-phase', 'runtime_needed');
    await uiExpect(prepare.getByTestId('studio-resources-prepare-runtime')).toContainText(t.prepare_runtime_needed);
    // The runtime line above the rows names the missing runtime instead of "ready".
    await uiExpect(dialog.locator('.studio-transcription-runtime.is-ready')).toHaveCount(0);
    expect(await installs()).toEqual([modelId]);
    await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-03-runtime-needed.png') });
    // Waiting can be dismissed (so a repair for something else would not start it); preparing again waits again.
    await prepare.getByTestId('studio-resources-prepare-dismiss').click();
    await uiExpect(prepare).toHaveAttribute('data-phase', 'cancelled');
    await uiExpect(prepare.getByTestId('studio-resources-prepare-outcome')).toHaveText(t.prepare_cancelled);
    await prepare.getByTestId('studio-resources-prepare-start').click();
    await uiExpect(prepare).toHaveAttribute('data-phase', 'runtime_needed');

    // The repair runs from the notice above, every banner clears, and preparing continues by itself:
    // the model, then voice detection (whose load check needs the model).
    await dialog.getByTestId('studio-resources-vc-runtime-repair').click();
    await uiExpect(prepare).toHaveAttribute('data-phase', 'installing');
    await uiExpect(dialog.getByTestId('studio-resources-vc-runtime')).toHaveCount(0);
    await uiExpect(workspaceNotice).toHaveCount(0);
    await uiExpect.poll(installs).toEqual([modelId, modelId]);
    await uiExpect(prepare.getByTestId('studio-resources-prepare-progress')).toBeVisible();
    await uiExpect(prepare).toContainText(t.prepare_running.replace('{{name}}', t.resource_name_standard_short).replace('{{current}}', '1').replace('{{total}}', '2'));
    await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-04-installing-model.png') });
    await control(app, { operation: 'resource-complete', resourceId: modelId });
    await uiExpect.poll(installs, { timeout: 10_000 }).toEqual([modelId, modelId, vadId]);
    await uiExpect(prepare).toContainText(t.prepare_running.replace('{{name}}', t.resource_name_vad_short).replace('{{current}}', '2').replace('{{total}}', '2'));
    await control(app, { operation: 'resource-complete', resourceId: vadId });
    await uiExpect(prepare).toHaveAttribute('data-phase', 'completed', { timeout: 10_000 });
    await uiExpect(prepare.getByTestId('studio-resources-prepare-outcome')).toHaveText(t.prepare_done);
    await uiExpect(prepare.getByTestId('studio-resources-prepare-start')).toBeDisabled();
    await uiExpect(page.getByText(common.local_preparation.done_toast, { exact: true })).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await window.evaluate(win => { win.setSize(786, 540); });
    await settle(page);
    expect(await dialog.evaluate(surface => surface.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]')!.scrollWidth
      - surface.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]')!.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-05-dark-compact-done.png') });

    await dialog.getByRole('button', { name: t.close, exact: true }).click();
    await uiExpect(dialog).toHaveCount(0);

    // An "automatic" task that ran on the CPU says why: this computer has no NVIDIA card.
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await window.evaluate(win => { win.setSize(1280, 860); });
    const media = path.join(fixture.artifacts, 'prepared.wav');
    await writeFile(media, Buffer.alloc(44));
    await app.evaluate(({ dialog: native }, filePaths) => { native.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [media]);
    await page.getByTestId('studio-transcription-picker').getByRole('button', { name: t.choose_media, exact: true }).click();
    await uiExpect(page.getByTestId('studio-transcription-start')).toBeEnabled();
    await page.getByTestId('studio-transcription-start').click();
    const task = page.getByTestId('studio-transcription-task-row').first();
    // Inside the one-line model label, so queue rows keep their two lines.
    await uiExpect(task.locator('.studio-task-model')).toHaveText(`${t.resource_name_standard_short} · CPU · ${t.cpu_reason_no_nvidia}`);
    await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-06-cpu-reason.png') });
    expect(errors).toEqual([]);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture.artifacts, 'prepare-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await writeFile(path.join(fixture.artifacts, 'prepare-errors.json'), JSON.stringify(errors));
    await writeFile(path.join(fixture.artifacts, 'prepare-electron.log'), logs.join(''));
    try { await app?.close(); } finally { await fixture.cleanup(); }
  }
}, 120000);

it.runIf(enabled)('recommends the NVIDIA pack but asks for a driver update first when the driver is too old', async () => {
  const fixture = await buildTranscriptionUiApp('controlled');
  const t = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')).transcription;
  let app: ElectronApplication | undefined, page: Page | undefined;
  const errors: string[] = [];
  try {
    app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_TEST_VC_RUNTIME: 'ok', FUSIONKIT_TEST_GPU: 'nvidia_old_driver' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const window = await app.browserWindow(page);
    await window.evaluate(win => { win.setSize(1280, 860); });
    await page.evaluate(() => {
      localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
      location.hash = '/tools/subtitle/studio';
    });
    await page.reload(); await ready(page);
    await page.getByRole('tab', { name: '转写', exact: true }).click();
    // Nothing is missing, so no runtime banner; the device choice says the driver is old.
    await uiExpect(page.getByTestId('studio-transcription-vc-runtime')).toHaveCount(0);
    await uiExpect(page.getByTestId('studio-transcription-device-hint')).toHaveText(t.device_hint_driver_old);
    await page.getByTestId('studio-transcription-manage-resources').click();
    const cuda = page.locator(`.studio-transcription-resource-dialog [data-resource-id="${cudaId}"]`);
    await uiExpect(cuda.getByTestId('studio-resource-recommended')).toHaveText(t.recommended);
    const driver = cuda.getByTestId('studio-resource-driver-old');
    await uiExpect(driver).toContainText(t.cuda_driver_old.replace('{{version}}', '531.79').replace('{{minimum}}', '551.61'));
    // The update button leads to NVIDIA's driver page (not opened here).
    await uiExpect(driver.getByRole('button', { name: t.cuda_driver_update, exact: true })).toHaveAttribute('data-href', 'https://www.nvidia.cn/drivers/lookup/');
    // With an NVIDIA card the pack downloads without asking.
    await cuda.getByRole('button', { name: t.download, exact: true }).click();
    await uiExpect(cuda).toHaveAttribute('data-state', 'installing');
    await uiExpect(page.locator('.studio-cuda-confirm-dialog')).toHaveCount(0);
    await page.screenshot({ path: path.join(fixture.artifacts, 'driver-old.png') });
    expect(errors).toEqual([]);
  } finally {
    try { await app?.close(); } finally { await fixture.cleanup(); }
  }
}, 120000);
