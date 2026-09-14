import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeFixture } from './fixtures';
import { parseKnowledgePackage } from '../../src/translation-knowledge/validation';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('translation knowledge in Electron', () => {
  let application: ElectronApplication | undefined;
  let page: Page;
  let root: string;
  const screenshots = path.resolve('test-results/translation-knowledge');
  const errors: string[] = [];
  afterAll(async () => {
    try {
      const process = application?.process();
      await application?.close();
      if (process) {
        expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
      }
    }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  const read = () => page.evaluate(async () => {
    const result = await window.translationKnowledge.read();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
  const capture = async (name: string) => {
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' });
  };

  it('uses native import, explicit review, structured editing, export and isolated restore', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-e2e-'));
    await mkdir(screenshots, { recursive: true });
    const fixture = knowledgeFixture();
    const input = path.join(root, 'all-types.fktk.json');
    const output = path.join(root, 'backup.fktk.json');
    await writeFile(input, JSON.stringify(fixture));
    application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/translation-knowledge'; });
    await page.reload();
    const window = await application.browserWindow(page);
    await window.evaluate(win => win.setSize(1280, 860));
    await uiExpect(page.getByTestId('knowledge-import')).toBeEnabled();
    await capture('empty-light');
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
    await page.getByTestId('knowledge-import').click();
    await uiExpect(page.getByRole('dialog')).toBeVisible();
    await capture('import-preview');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);
    let stored = await read();
    expect(stored.data.entries).toHaveLength(5);
    expect(Object.keys(stored.approvals)).toHaveLength(0);
    const term = stored.data.entries.find(entry => entry.kind === 'term')!;
    await page.locator(`[data-entry-id="${term.id}"]`).click();
    await uiExpect(page.getByRole('button', { name: '采纳此条', exact: true })).toBeVisible();
    await capture('review-detail');
    await page.getByRole('button', { name: '采纳此条', exact: true }).click();
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);
    stored = await read(); expect(stored.approvals[term.id]?.method).toBe('human');

    await page.getByTestId('knowledge-new-entry').click();
    const editor = page.getByRole('dialog');
    await capture('editor-empty');
    await editor.getByRole('textbox', { name: '原文', exact: true }).fill('starport');
    await editor.getByRole('textbox', { name: '译文', exact: true }).fill('星际港口');
    await uiExpect(editor.getByRole('combobox', { name: '原文语言', exact: true })).toContainText('英语');
    await editor.getByLabel('标题（可选）', { exact: true }).fill('星际港口 · 跨语言内容与来源范围示例');
    await capture('editor-light');
    await editor.getByRole('button', { name: '保存为待审核', exact: true }).click();
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);
    stored = await read(); expect(stored.data.entries).toHaveLength(6);
    expect(stored.data.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'starport')?.state).toBe('candidate');
    await capture('library-light');

    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await page.getByTestId('knowledge-export').click();
    await page.getByRole('dialog').getByRole('combobox').click();
    await page.getByRole('option', { name: '备份全部翻译资料', exact: true }).click();
    await capture('export-backup');
    await page.getByRole('button', { name: '选择保存位置', exact: true }).click();
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);
    const bytes = await readFile(output, 'utf8');
    const validated = parseKnowledgePackage(bytes);
    expect(validated.valid, JSON.stringify(validated.errors)).toBe(true);
    expect(validated.data!.entries).toHaveLength(6);
    const restored = new KnowledgeService(path.join(root, 'restore'));
    try {
      const plan = await restored.planImport('restore-owner', bytes);
      await restored.commitImport('restore-owner', { planId: plan.planId, decisions: [], adoptReady: false });
      const roundtrip = await restored.read();
      expect(roundtrip.data.entries).toEqual(validated.data!.entries);
      expect(roundtrip.data.styles).toEqual(validated.data!.styles);
      expect(Object.keys(roundtrip.approvals)).toHaveLength(0);
    } finally { await restored.dispose(); }

    const invalid = path.join(root, 'invalid.fktk.json');
    await writeFile(invalid, '{"schemaVersion":1,"schemaVersion":2}');
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, invalid);
    await page.getByTestId('knowledge-import').click();
    await uiExpect(page.getByRole('alert')).toBeVisible();
    expect((await read()).data.entries).toHaveLength(6);
    await capture('invalid-import');

    await window.evaluate(win => win.setSize(820, 700));
    await capture('library-narrow');
    await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
    await page.reload();
    await uiExpect(page.getByTestId('knowledge-import')).toBeEnabled();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await capture('library-dark-narrow');
    const columns = await page.locator('.translation-knowledge').evaluate(element => {
      const aside = element.querySelector('aside')!.getBoundingClientRect();
      const main = element.querySelector('main')!.getBoundingClientRect();
      return { asideRight: aside.right, mainLeft: main.left, asideTop: aside.top, mainTop: main.top };
    });
    expect(columns.mainLeft).toBeGreaterThan(columns.asideRight);
    expect(Math.abs(columns.mainTop - columns.asideTop)).toBeLessThan(2);
    await page.getByTestId('knowledge-new-entry').click();
    await capture('editor-dark-narrow');
    const geometry = await page.getByRole('dialog').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, bottom: element.getBoundingClientRect().bottom, height: innerHeight }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => { localStorage.setItem('lang', 'en'); });
    await page.reload();
    await uiExpect(page.getByTestId('knowledge-import')).toBeEnabled();
    await capture('library-english-narrow');
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-translator-tour-done', '1'); });
    await page.reload();
    for (const tool of ['studio', 'translator']) {
      await page.evaluate(route => { location.hash = route; }, `/tools/subtitle/${tool}`);
      const link = page.getByRole('link', { name: '翻译资料', exact: true });
      await uiExpect(link).toBeVisible();
      await capture(`${tool}-knowledge-entry-narrow`);
      await link.click();
      await uiExpect(page.getByTestId('knowledge-import')).toBeEnabled();
    }
    expect(errors).toEqual([]);
  }, 120000);
});
