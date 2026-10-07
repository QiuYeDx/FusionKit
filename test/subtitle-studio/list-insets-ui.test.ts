import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';

/** Distances from a row's visible surface to the inner edges of the frame around it. */
async function insets(row: Locator, frame: Locator, top?: Locator) {
  const [rowBox, frameBox, topBox] = await Promise.all([
    row.evaluate(element => element.getBoundingClientRect().toJSON()),
    frame.evaluate(element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { left: rect.left + parseFloat(style.borderLeftWidth), right: rect.right - parseFloat(style.borderRightWidth), top: rect.top }; }),
    top?.evaluate(element => element.getBoundingClientRect().toJSON()),
  ]);
  return { left: rowBox.left - frameBox.left, right: frameBox.right - rowBox.right, top: rowBox.top - (topBox ? topBox.bottom : frameBox.top) };
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('subtitle studio list insets', () => {
  it('keeps list rows equally inset and the export review compact', async () => {
    const artifacts = path.resolve('test-results/studio-list-insets'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const files = await Promise.all(['01-intro.srt', '02-right.srt', '03-left.srt'].map(async (name, index) => {
      const file = path.join(root, name);
      await writeFile(file, Array.from({ length: 4 }, (_, line) => `${line + 1}\n00:00:0${line + 1},000 --> 00:00:0${line + 1},800\nLine ${index + 1}-${line + 1}\n`).join('\n'));
      return file;
    }));
    let app: ElectronApplication | undefined; let server: Server | undefined;
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: `译 ${item.text}` })) }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page: Page = await app.firstWindow();
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'inset-model', name: 'Controlled translation', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-translation', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'inset-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      // Import all three, then translate each through the public API.
      for (const file of files) {
        await app.evaluate(({ dialog }, current) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [current] }); }, file);
        await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
        await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(4);
      }
      await page.evaluate(async port => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        for (const document of listed.value.documents) {
          const config = { model: { profileId: 'inset-model', modelKey: 'controlled-translation', endpoint: `http://127.0.0.1:${port}/v1`, apiFormat: 'chat_completions' as const }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 8 };
          const plan = await window.subtitleStudio.planTranslation({ documentId: document.id, revision: document.revision, config }); if (!plan.ok) throw Error(plan.error);
          const started = await window.subtitleStudio.createTranslation({ documentId: document.id, revision: document.revision, planId: plan.value.planId, apiKey: 'synthetic-test-key' }); if (!started.ok) throw Error(started.error);
          for (let attempt = 0; attempt < 100; attempt++) {
            const tasks = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 20 });
            if (tasks.ok && tasks.value.items.every(item => item.status === 'completed')) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }, port);
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();

      // Cue selection runs edge to edge with square corners.
      const rows = page.locator('.studio-cue-table tbody tr');
      await rows.nth(1).locator('.studio-cue-number').click();
      expect(await rows.nth(1).locator('td').first().evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('0px');

      // Edge-to-edge disclosure bands keep square hover surfaces.
      await page.locator('.studio-preview-panel').getByRole('button', { name: '翻译', exact: true }).click();
      const advanced = page.getByRole('dialog').getByTestId('studio-translation-advanced');
      await advanced.hover();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(artifacts, '00-advanced-hover.png') });
      expect(await advanced.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('0px');
      await page.keyboard.press('Escape');
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);

      // Library rows keep equal side insets, with the scroll gutter counted on the right.
      const library = await insets(page.locator('.studio-library-row').first(), page.locator('.studio-library-panel'));
      expect(Math.abs(library.left - library.right)).toBeLessThanOrEqual(1);

      // Task list inside the overview dialog.
      await page.getByRole('button', { name: '查看全部' }).first().click();
      const overview = page.getByTestId('studio-translation-overview-list');
      await uiExpect(overview.locator('li')).toHaveCount(3);
      await page.waitForTimeout(400);
      const task = await insets(overview.locator('li').first(), overview);
      await page.screenshot({ path: path.join(artifacts, '01-overview.png') });
      expect(Math.abs(task.left - task.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(task.left - task.top)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');

      // Selected documents in the batch export dialog.
      await page.getByTestId('studio-library-select-all').click();
      await page.getByRole('button', { name: '批量下载', exact: true }).click();
      await page.getByRole('menuitem', { name: '批量导出字幕', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const selected = dialog.getByTestId('studio-selected-documents');
      await selected.locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(selected.locator('.studio-document-row')).toHaveCount(3);
      await page.waitForTimeout(400);
      const row = await insets(selected.locator('.studio-document-row').first(), selected, selected.locator('.studio-selected-documents-header'));
      await page.screenshot({ path: path.join(artifacts, '02-batch-export.png') });
      expect(Math.abs(row.left - row.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.left - row.top)).toBeLessThanOrEqual(1);

      // The review step.
      await dialog.getByRole('button', { name: '检查导出', exact: true }).click();
      const review = dialog.getByTestId('studio-batch-plan');
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(artifacts, '03-review.png') });
      await uiExpect(review.locator('.studio-export-summary')).toContainText('12 条字幕');
      const details = dialog.getByTestId('studio-export-review-details');
      await details.locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(details.locator('.studio-document-row')).toHaveCount(3);
      await page.waitForTimeout(400);
      const detail = await insets(details.locator('.studio-document-row').first(), details, details.locator('.studio-selected-documents-header'));
      await page.screenshot({ path: path.join(artifacts, '04-review-details.png') });
      expect(Math.abs(detail.left - detail.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(detail.left - detail.top)).toBeLessThanOrEqual(1);
      // LRC drops end times: the review lists the format changes it accepts.
      await dialog.getByRole('button', { name: '返回设置', exact: true }).click();
      await dialog.getByLabel('字幕格式').click();
      await page.getByRole('option', { name: 'LRC', exact: true }).click();
      await dialog.getByRole('button', { name: '检查导出', exact: true }).click();
      await uiExpect(dialog.locator('[data-issue="end_times_omitted"]')).toContainText('12');
      await uiExpect(dialog.locator('.studio-export-review-changes')).toContainText('确认导出即表示接受');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(artifacts, '05-review-changes.png') });
      await win.evaluate(window => window.setSize(520, 860));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(artifacts, '06-review-narrow.png') });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 120000);
});
