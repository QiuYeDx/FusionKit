import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import type { TranscriptionTaskSummary } from '../../src/subtitle-studio/transcription/task-contract';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_I6_QUEUE_UI === '1';
type Snapshot = { tasks: TranscriptionTaskSummary[]; traces: { operation: string; detail?: unknown }[] };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> =>
  app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
const modelLabel = `queue-visual-model-${'long-name-'.repeat(8)}`;
const taskNames = ['01-baseline.wav', `02-${'较长的访谈文件名称-'.repeat(8)}.wav`, '03-zero.wav',
  '04-full.wav', '05-linked.wav', '06-recovery.wav', '07-cleanup.wav'];

async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
async function drop(page: Page, filePaths: string[]) {
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
    input.dataset.i6QueueDrop = ''; document.body.append(input);
  });
  await page.locator('[data-i6-queue-drop]').setInputFiles(filePaths);
  await page.evaluate(() => {
    const input = document.querySelector('[data-i6-queue-drop]') as HTMLInputElement, transfer = new DataTransfer();
    Array.from(input.files!).forEach(file => transfer.items.add(file));
    const target = document.querySelector('[data-testid=studio-transcription-picker]')!;
    for (const type of ['dragenter', 'dragover', 'drop'])
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    input.remove();
  });
}

/** Observe real rasterized colors, including the native progress pseudo elements. */
async function pixels(app: ElectronApplication, row: Locator) {
  const geometry = await row.evaluate(element => {
    const bounds = element.getBoundingClientRect(), progress = element.querySelector('progress')!.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, points: {
      row: { x: 6, y: bounds.height / 2 },
      start: { x: progress.left - bounds.left + progress.width * .1, y: progress.top - bounds.top + progress.height / 2 },
      end: { x: progress.left - bounds.left + progress.width * .9, y: progress.top - bounds.top + progress.height / 2 },
    } };
  });
  const png = await row.screenshot({ animations: 'disabled' });
  return app.evaluate(({ nativeImage }, { encoded, geometry }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')), size = image.getSize(), bytes = image.toBitmap();
    const colors = Object.fromEntries(Object.entries(geometry.points).map(([key, point]) => {
      const x = Math.min(size.width - 1, Math.floor(point.x * size.width / geometry.width));
      const y = Math.min(size.height - 1, Math.floor(point.y * size.height / geometry.height));
      const offset = (y * size.width + x) * 4;
      return [key, [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]]];
    }));
    return { ...geometry, rasterSize: size, colors };
  }, { encoded: png.toString('base64'), geometry });
}
const colorDistance = (left: number[], right: number[]) => Math.max(...left.slice(0, 3).map((value, index) => Math.abs(value - right[index])));

describe.runIf(enabled)('I6 actual Electron queue presentation', () => {
  it('keeps two information lines and a distinct progress trough in wide light and exact small dark windows', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')), t = locale.transcription;
    const files = taskNames.map(name => path.join(fixture.artifacts, name));
    await Promise.all(files.map(file => writeFile(file, Buffer.alloc(44))));
    const evidence: Record<string, unknown> = {
      boundary: 'Queue visual acceptance only. Existing controlled native runtime; real main owner checks, IPC, preload, renderer and document sink. The original list handler runs first; its real summaries receive only explicit model/automatic-status/durability decorations. No automatic-translation business or native ASR quality claim.',
      themes: {},
    };
    const logs: string[] = [], pageErrors: string[] = [];
    let app: ElectronApplication | undefined, page: Page | undefined, passed = false, closeSucceeded = false, cleanupSucceeded = false;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
      page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message));
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await ready(page);
      // Keep the trusted owner/frame validation and all production requests intact.
      await app.evaluate(({ ipcMain }) => {
        const channel = 'subtitle-studio:list-transcription-tasks', handlers = (ipcMain as any)._invokeHandlers as Map<string, any>;
        const original = handlers.get(channel); if (typeof original !== 'function') throw new Error('Production task list handler is absent.');
        const fixture = { decorations: {} as Record<string, Partial<TranscriptionTaskSummary>>, restore: () => handlers.set(channel, original) };
        handlers.set(channel, async (...args: unknown[]) => {
          const result = await original(...args);
          if (!result.ok) return result;
          return { ...result, value: result.value.map((task: TranscriptionTaskSummary) => ({ ...task, ...fixture.decorations[task.taskId] })) };
        });
        (globalThis as any).__studioI6Queue = fixture;
      });
      for (const theme of ['light', 'dark'] as const) {
        if (theme === 'dark') {
          await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
          await page.reload(); await ready(page); await uiExpect(page.locator('html')).toHaveClass(/dark/);
        }
        const window = await app.browserWindow(page);
        await window.evaluate(window => { if (window.isMaximized()) window.unmaximize(); if (window.isMinimized()) window.restore(); });
        // Apply the requested geometry after reload as well as waiting for the renderer;
        // Windows can defer a resize while the native window is transitioning.
        await uiExpect.poll(async () => {
          await window.evaluate((window, theme) => window.setSize(theme === 'light' ? 1281 : 787, theme === 'light' ? 860 : 540), theme);
          return page!.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        })
          .toEqual(theme === 'light' ? { width: 1280, height: 860 } : { width: 786, height: 540 });
        await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
        await control(app, { operation: 'resources-ready' });
        await page.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
        await uiExpect(page.locator('#studio-transcription-auto-translation')).toHaveAttribute('aria-checked', 'false');
        await drop(page, files); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(files.length);
        await page.getByTestId('studio-transcription-start').click();
        const snapshot = await control(app, { operation: 'snapshot' }), tasks = snapshot.tasks;
        expect(tasks.map(task => task.displayName)).toEqual(taskNames);
        for (const index of [0, 1]) await control(app, { operation: 'task-state', taskId: tasks[index].taskId, status: 'transcribing', progress: 37 });
        await control(app, { operation: 'task-state', taskId: tasks[3].taskId, status: 'post_processing', progress: 100 });
        for (const index of [4, 5]) await control(app, { operation: 'complete', taskId: tasks[index].taskId, cueCount: 1 });
        await control(app, { operation: 'task-state', taskId: tasks[6].taskId, status: 'failed', cleanupPending: true });
        const decorations: Record<string, Partial<TranscriptionTaskSummary>> = {
          [tasks[1].taskId]: { automaticTranslation: { status: 'pending' }, modelId: modelLabel },
          [tasks[4].taskId]: { automaticTranslation: { status: 'admitted' } },
          [tasks[5].taskId]: { automaticTranslation: { status: 'needs_configuration' }, documentDurability: 'uncertain' },
        };
        await app.evaluate((_, decorations) => { (globalThis as any).__studioI6Queue.decorations = decorations; }, decorations);
        const rows = tasks.map(task => page!.locator(`[data-testid=studio-transcription-task-row][data-task-id="${task.taskId}"]`));
        await uiExpect(rows[1].locator('.studio-transcription-auto-label')).toHaveText(t.auto_translation_pending_short);
        await uiExpect(rows[3].locator('progress')).toHaveAttribute('value', '100');
        await uiExpect(rows[6]).toHaveAttribute('data-state', 'failed');
        const geometry = await page.getByTestId('studio-transcription-task-row').evaluateAll(elements => elements.map(element => {
          const row = element.getBoundingClientRect(), heading = element.querySelector('.studio-transcription-task-heading')!.getBoundingClientRect();
          const meta = element.querySelector('.studio-transcription-task-meta')!, metadata = meta.getBoundingClientRect();
          const rects = Array.from(meta.children).map(child => child.getBoundingClientRect());
          return { height: row.height, headingHeight: heading.height, metaHeight: metadata.height,
            metaSingleLine: rects.every(rect => Math.abs(rect.top + rect.height / 2 - metadata.top - metadata.height / 2) < 1),
            noOverflow: element.scrollWidth <= element.clientWidth + 1 && rects.every(rect => rect.left >= row.left && rect.right <= row.right + 1),
            buttons: Array.from(element.querySelectorAll('.studio-transcription-task-heading button')).map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
            standaloneHelp: element.querySelectorAll(':scope > .studio-transcription-help').length };
        }));
        expect(geometry[0].height).toBe(geometry[1].height); expect(geometry[1].height).toBeLessThanOrEqual(82);
        expect(geometry[4].height).toBeLessThanOrEqual(62);
        expect(await page.locator('.studio-transcription-session-note').count()).toBe(0);
        for (const entry of geometry) {
          expect(entry.metaHeight).toBe(18); expect(entry.metaSingleLine).toBe(true); expect(entry.noOverflow).toBe(true); expect(entry.standaloneHelp).toBe(0);
          expect(entry.buttons.every(button => button.width === 28 && button.height === 28)).toBe(true);
        }
        expect(await page.locator('.studio-transcription-layout, .studio-transcription-workspace, .studio-transcription-task-list').evaluateAll(elements =>
          elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
        await uiExpect(rows[5].locator('.studio-transcription-row-warning')).toHaveText(t.durability_uncertain);
        await uiExpect(rows[6].locator('.studio-transcription-row-warning')).toHaveText([t.task_failed, t.task_cleanup_pending]);
        await uiExpect(rows[6].getByRole('button', { name: t.remove_task, exact: true })).toBeDisabled();
        const tooltips: Record<string, string> = {};
        for (const [index, description] of [[1, t.auto_translation_pending], [4, t.auto_translation_admitted], [5, t.auto_translation_recovery]] as const) {
          const tag = rows[index].locator('.studio-transcription-auto-label');
          await tag.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await tag.focus();
          const tooltip = page.getByRole('tooltip', { name: description, exact: true });
          await uiExpect(tooltip).toHaveText(description); tooltips[String(index)] = description;
          await page.keyboard.press('Escape'); await tag.evaluate(element => (element as HTMLElement).blur());
          await uiExpect(tooltip).toHaveCount(0);
        }
        const longModel = rows[1].locator('.studio-transcription-task-model'); await longModel.scrollIntoViewIfNeeded(); await longModel.focus();
        await uiExpect(page.getByRole('tooltip')).toHaveText(`${modelLabel} · CPU`);
        await page.keyboard.press('Escape'); await longModel.evaluate(element => (element as HTMLElement).blur());
        const progress: Record<string, unknown> = {};
        for (const [index, value] of [[2, 0], [0, 37], [3, 100]] as const) {
          // Center each sample away from the list's intentional edge fade overlays.
          await rows[index].evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
          await page.mouse.move(0, 0);
          await uiExpect(rows[index].locator('progress')).toHaveAttribute('value', String(value));
          await uiExpect(rows[index].locator('.studio-transcription-task-percentage')).toHaveText(`${value}%`);
          const idle = await pixels(app, rows[index]);
          await rows[index].hover({ position: { x: 6, y: 6 } }); const hover = await pixels(app, rows[index]);
          expect(colorDistance(idle.colors.row, hover.colors.row)).toBeGreaterThan(3);
          expect(colorDistance(hover.colors.row, hover.colors.end)).toBeGreaterThan(12);
          if (value < 100) expect(colorDistance(idle.colors.row, idle.colors.end)).toBeGreaterThan(12);
          if (value === 0 || value === 100) expect(colorDistance(hover.colors.start, hover.colors.end)).toBeLessThan(3);
          else expect(colorDistance(hover.colors.start, hover.colors.end)).toBeGreaterThan(12);
          progress[String(value)] = { idle, hover };
        }
        await rows[4].scrollIntoViewIfNeeded();
        const viewButton = rows[4].getByRole('button', { name: t.open_document, exact: true });
        await app.evaluate(({ shell }) => { (globalThis as any).__i8QueueReveal = []; shell.showItemInFolder = file => { (globalThis as any).__i8QueueReveal.push(file); }; });
        await rows[4].getByTestId('studio-reveal-source').click();
        await uiExpect.poll(() => app!.evaluate(() => (globalThis as any).__i8QueueReveal)).toEqual([files[4]]);
        await viewButton.hover();
        await uiExpect(page.getByRole('tooltip')).toHaveText(t.open_document);
        expect(await viewButton.getAttribute('data-variant')).toBe('ghost');
        expect(await viewButton.innerText()).toBe('');
        expect(await viewButton.evaluate(element => getComputedStyle(element).backgroundColor !== getComputedStyle(element.closest('li')!).backgroundColor)).toBe(true);
        await page.screenshot({ path: path.join(fixture.artifacts, `i8-queue-completed-hover-${theme}.png`), animations: 'disabled' });
        await rows[1].scrollIntoViewIfNeeded(); await rows[1].hover({ position: { x: 6, y: 6 } });
        await page.screenshot({ path: path.join(fixture.artifacts, `i6-queue-${theme}.png`), animations: 'disabled' });
        const stop = rows[1].locator('.studio-transcription-stop'); await stop.hover();
        await uiExpect(page.getByRole('tooltip')).toHaveText(t.cancel_task);
        await stop.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
        const stopHover = await stop.evaluate(element => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!; context.fillStyle = getComputedStyle(element).backgroundColor; context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        });
        expect(stopHover[3]).toBeGreaterThan(20); expect(stopHover[0] - stopHover[1]).toBeGreaterThan(30);
        await page.screenshot({ path: path.join(fixture.artifacts, `i6-queue-stop-${theme}.png`), animations: 'disabled' });
        await stop.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        expect(await stop.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
        await app.evaluate((_, id) => { delete (globalThis as any).__studioI6Queue.decorations[id]; }, tasks[1].taskId);
        await page.keyboard.press('Enter'); await uiExpect(rows[1]).toHaveAttribute('data-state', 'cancelled');
        await rows[1].getByRole('button', { name: t.remove_task, exact: true }).click(); await uiExpect(rows[1]).toHaveCount(0);
        const final = await control(app, { operation: 'snapshot' });
        expect(final.traces.some(trace => trace.operation === 'cancel-task')).toBe(true);
        expect(final.traces.some(trace => trace.operation === 'remove-task')).toBe(true);
        expect(final.traces.some(trace => trace.operation === 'automatic-handoff')).toBe(false);
        await rows[6].scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(fixture.artifacts, `i6-queue-warnings-${theme}.png`), animations: 'disabled' });
        (evidence.themes as Record<string, unknown>)[theme] = { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), geometry, tooltips, progress, stopHover, keyboardCancelAndRemove: true, automaticHandoffRequests: 0 };
      }
      expect(pageErrors).toEqual([]); passed = true;
    } catch (error) {
      evidence.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
      await page?.screenshot({ path: path.join(fixture.artifacts, 'i6-queue-failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    } finally {
      await app?.evaluate(() => (globalThis as any).__studioI6Queue?.restore()).catch(() => undefined);
      try { await app?.close(); closeSucceeded = true; } finally {
        try { await fixture.cleanup(); cleanupSucceeded = true; } finally {
          await writeFile(path.join(fixture.artifacts, 'i6-queue-result.json'), JSON.stringify({ outcome: passed && closeSucceeded && cleanupSucceeded ? 'passed' : 'failed', ...evidence, pageErrors, closeSucceeded, cleanupSucceeded }, null, 2));
          await writeFile(path.join(fixture.artifacts, 'i6-queue-electron.log'), logs.join(''));
        }
      }
    }
  }, 180000);
});
