import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DocumentPage, DocumentSummary } from '../../src/subtitle-studio/ipc-contract';

// The root task owns the real development server. This test owns only its
// isolated Electron profile and loopback model fixture.
const devUrl = process.env.FUSIONKIT_STUDIO_DEV_URL;
const artifacts = path.resolve('test-results/studio-library');
type ModelRequest = { messages: { content: string }[]; model: string };

async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
}

async function listDocuments(page: Page): Promise<DocumentSummary[]> {
  return page.evaluate(async () => {
    const documents = [];
    for (let offset = 0; ; ) {
      const result = await window.subtitleStudio.listDocuments({ offset });
      if (!result.ok) throw new Error(result.error);
      documents.push(...result.value.documents);
      offset += result.value.documents.length;
      if (offset >= result.value.total || result.value.documents.length === 0) return documents;
    }
  });
}

async function documentPage(page: Page, id: string): Promise<DocumentPage> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const documents = await listDocuments(page);
    const document = documents.find(item => item.id === id);
    if (!document) throw new Error('Missing library fixture');
    const result = await page.evaluate(document => window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 }), document);
    if (result.ok) return result.value;
    if (result.error !== 'revision_conflict') throw new Error(result.error);
  }
  throw new Error('Library fixture kept changing while taking an observation');
}

async function capture(page: Page, name: string) {
  await ready(page);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('.studio, .studio-main, .studio-reader').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
}

async function selectionAlignment(page: Page) {
  // Sample one frame: dialog entry transforms move every checkbox together.
  const { origin, search, header, label, rows } = await page.getByTestId('studio-library').evaluate(library => {
    const measure = (item: Element) => { const bounds = item.getBoundingClientRect(); return { x: bounds.x, width: bounds.width }; };
    return { origin: measure(library).x, search: measure(library.querySelector('[data-testid="studio-library-search"]')!),
      header: measure(library.querySelector('[data-testid="studio-library-select-all"]')!),
      label: measure(library.querySelector('.studio-library-selection label > span')!),
      rows: [...library.querySelectorAll('[data-testid="studio-library-row"]')].map(row => ({
        frame: measure(row), checkbox: measure(row.querySelector('[role="checkbox"]')!), name: measure(row.querySelector('.studio-file-name')!),
      })) };
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(Math.abs(search.x - origin - 12)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(header.x - origin - 20)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(label.x - origin - 44)).toBeLessThanOrEqual(0.5);
  for (const row of rows) {
    expect(Math.abs(row.frame.x - search.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(row.checkbox.x - header.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(row.checkbox.width - header.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(row.name.x - label.x)).toBeLessThanOrEqual(0.5);
  }
  return { searchInset: search.x - origin, checkboxInset: header.x - origin, labelInset: label.x - origin, headerX: header.x, rowX: rows[0].checkbox.x, width: header.width };
}

async function footerGeometry(page: Page) {
  const geometry = await page.getByTestId('studio-library').evaluate(library => {
    const measure = (element: Element) => { const frame = element.getBoundingClientRect(); return { x: frame.x, y: frame.y, width: frame.width, height: frame.height }; };
    const footer = library.querySelector('.studio-library-footer')!;
    const scroll = library.querySelector('.studio-library-scroll')!;
    const controls = [...footer.querySelectorAll('button, input')].map(measure);
    return { footer: measure(footer), scroll: measure(scroll), scrollTop: scroll.scrollTop, controls,
      noOverflow: footer.scrollWidth <= footer.clientWidth + 1 };
  });
  expect(geometry.noOverflow).toBe(true);
  expect(geometry.footer.height).toBeLessThanOrEqual(48);
  expect(geometry.controls.length).toBeGreaterThanOrEqual(2);
  const center = geometry.controls[0].y + geometry.controls[0].height / 2;
  for (const control of geometry.controls) {
    expect(Math.abs(control.y + control.height / 2 - center)).toBeLessThanOrEqual(0.5);
    expect(control.y).toBeGreaterThanOrEqual(geometry.footer.y);
    expect(control.y + control.height).toBeLessThanOrEqual(geometry.footer.y + geometry.footer.height);
  }
  return geometry;
}

function expectStableFooter(before: Awaited<ReturnType<typeof footerGeometry>>, after: Awaited<ReturnType<typeof footerGeometry>>) {
  for (const area of ['footer', 'scroll'] as const) {
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(before[area][dimension] - after[area][dimension])).toBeLessThanOrEqual(0.5);
    }
  }
  expect(after.scrollTop).toBe(before.scrollTop);
}

function respond(response: ServerResponse, body: ModelRequest) {
  if (response.destroyed) return;
  const payload = JSON.parse(body.messages[1].content) as { items: { id: string; text: string }[] };
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `译文：${item.text}` })) }),
  } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
}

it.runIf(Boolean(devUrl))('manages a paginated subtitle library and batch work through the real development renderer', async () => {
  const messages = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')) as Record<string, unknown>;
  const label = (key: string) => {
    const value = key.split('.').reduce<unknown>((value, segment) => (value as Record<string, unknown>)[segment], messages);
    if (typeof value !== 'string') throw new Error(`Missing library UI label: ${key}`);
    return value;
  };
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'studio-library-ui-')));
  const profile = path.join(root, 'profile');
  const sources = path.join(root, 'sources');
  const outputs = path.join(root, 'outputs');
  await Promise.all([mkdir(sources, { recursive: true }), mkdir(outputs, { recursive: true }), mkdir(artifacts, { recursive: true })]);
  const brokenId = randomUUID();
  const broken = path.join(profile, 'subtitle-studio', 'documents', brokenId);
  await mkdir(broken, { recursive: true });
  const generation = randomUUID();
  const pointer = JSON.stringify({ schemaVersion: 1, generation });
  const incompatible = JSON.stringify({ schemaVersion: 1, document: { legacy: true }, tasks: [] });
  await writeFile(path.join(broken, 'current.json'), pointer);
  await writeFile(path.join(broken, `${generation}.json`), incompatible);
  const originals = new Map<string, string>();
  for (let index = 1; index <= 41; index++) {
    const name = index === 41 ? '41-全库搜索-音轨.lrc' : `${String(index).padStart(2, '0')}-字幕工作台-批量字幕.srt`;
    const content = index === 41 ? '[00:01.00]Library scene 41.\r\n'
      : `1\r\n00:00:01,000 --> 00:00:02,000\r\nLibrary scene ${index}.\r\n${index === 2 || index === 22 ? `\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nLibrary continuation ${index}.\r\n` : ''}`;
    const file = path.join(sources, name);
    await writeFile(file, content);
    originals.set(file, content);
  }
  const invalid = path.join(sources, '无效字幕.srt');
  await writeFile(invalid, '1\n00:00:03,000 --> 00:00:01,000\nInvalid timing\n');
  const chosen = [...originals.keys()];
  chosen.splice(17, 0, invalid);
  let application: ElectronApplication | undefined;
  let server: Server | undefined;
  const errors: string[] = [];
  const requests: ModelRequest[] = [];
  const held: { response: ServerResponse; body: ModelRequest }[] = [];
  let modelMode: 'success' | 'hold-continuations' | 'hold-all' = 'success';
  try {
    server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk.toString();
      const body = JSON.parse(text) as ModelRequest;
      requests.push(body);
      const payload = JSON.parse(body.messages[1].content) as { items: { text: string }[] };
      // Future-context text may already mention the next cue. Delay only the
      // actual items in a later batch, after the first batch has committed.
      if (modelMode === 'hold-all' || modelMode === 'hold-continuations' && payload.items.some(item => item.text.startsWith('Library continuation '))) held.push({ response, body });
      else respond(response, body);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const launch = async (configure = false) => {
      application = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(),
        env: { ...process.env, VITE_DEV_SERVER_URL: devUrl!, NODE_ENV: 'development' }, timeout: 60000 });
      const page = await application.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(({ port, configure }) => {
        if (configure) {
          localStorage.setItem('lang', 'zh');
          localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
          localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{
            id: 'studio-library-fixture', name: 'Library loopback model', provider: 'DeepSeek',
            apiKey: 'synthetic-library-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash',
            apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 },
          }], assignment: { taskExecution: 'studio-library-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        }
        location.hash = '/tools/subtitle/studio';
      }, { port, configure });
      if (configure) await page.reload();
      await ready(page);
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 860); });
      expect(new URL(page.url()).origin).toBe(new URL(devUrl!).origin);
      return page;
    };
    let page = await launch(true);
    await uiExpect(page.getByTestId('studio-recovery-warning')).toBeVisible();
    await uiExpect(page.getByRole('alert')).toHaveCount(0);
    await page.getByTestId('studio-recovery-warning').getByRole('button', { name: '关闭提示', exact: true }).click();
    await uiExpect(page.getByTestId('studio-recovery-warning')).toHaveCount(0);
    expect(await readFile(path.join(broken, 'current.json'), 'utf8')).toBe(pointer);
    expect(await readFile(path.join(broken, `${generation}.json`), 'utf8')).toBe(incompatible);
    await application!.close(); application = undefined;
    page = await launch();
    await uiExpect(page.getByTestId('studio-recovery-warning')).toHaveCount(0);
    await uiExpect(page.locator('aside').getByTestId('studio-recovery-manage')).toBeVisible();
    await application!.evaluate(({ shell }) => {
      const fixture = globalThis as typeof globalThis & { studioRevealed?: string[] };
      fixture.studioRevealed = [];
      shell.showItemInFolder = selected => { fixture.studioRevealed!.push(selected); };
    });
    await page.locator('aside').getByTestId('studio-recovery-manage').click();
    await uiExpect(page.getByTestId('studio-recovery-dialog')).toContainText(broken);
    await page.locator('.studio-recovery-item-heading').getByRole('button').first().click();
    expect(await application!.evaluate(() => (globalThis as typeof globalThis & { studioRevealed?: string[] }).studioRevealed)).toEqual([broken]);
    await capture(page, 'recovery-management-desktop');
    await page.getByRole('button', { name: '清除残留文档', exact: true }).click();
    await uiExpect(page.getByRole('button', { name: '确认清除', exact: true })).toBeVisible();
    expect(await readFile(path.join(broken, 'current.json'), 'utf8')).toBe(pointer);
    await page.getByRole('button', { name: '确认清除', exact: true }).click();
    await uiExpect(page.locator('.studio-recovery-item')).toHaveCount(0);
    await uiExpect.poll(async () => readdir(broken).then(() => true).catch(() => false)).toBe(false);
    await page.locator('#studio-recovery-close').click();

    // Control only native dialog responses. The actual visible import button,
    // preload, validation, persistence and per-file error isolation still run.
    await application!.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    expect(await listDocuments(page)).toHaveLength(0);
    await application!.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1) as { properties?: string[] };
        (globalThis as typeof globalThis & { studioPickerProperties?: string[] }).studioPickerProperties = options.properties;
        return { canceled: false, filePaths: files };
      };
    }, chosen);
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect.poll(async () => (await listDocuments(page)).length, { timeout: 30000 }).toBe(41);
    await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(20);
    expect(await application!.evaluate(() => (globalThis as typeof globalThis & { studioPickerProperties?: string[] }).studioPickerProperties)).toContain('multiSelections');
    await uiExpect(page.getByTestId('studio-library-result')).toContainText('无效字幕.srt');
    await uiExpect(page.getByTestId('studio-library-result').locator('li')).toHaveCount(42);
    await page.getByRole('dialog', { name: label('library.import_result'), exact: true }).getByRole('button', { name: label('recovery.close'), exact: true }).click();
    const documents = await listDocuments(page);
    expect(documents.map(document => document.origin.displayName).sort()).toEqual([...originals.keys()].map(file => path.basename(file)).sort());
    let library = page.getByTestId('studio-library');
    let search = page.getByTestId('studio-library-search');
    let rows = page.getByTestId('studio-library-row');
    let pagination = page.getByTestId('studio-library-pagination');
    const selectionMenu = async () => library.getByRole('button', { name: label('library.selection_options'), exact: true }).click();
    const clearSelection = async () => {
      if (!await page.getByTestId('studio-batch-toolbar').count()) return;
      await selectionMenu();
      await page.getByRole('menuitem', { name: label('library.clear_selection'), exact: true }).click();
    };
    const batchMenu = async () => page.getByTestId('studio-batch-toolbar').getByRole('button', { name: label('library.batch_actions'), exact: true }).click();
    const batchAction = async (key: string) => {
      await batchMenu();
      await page.getByRole('menuitem', { name: label(key), exact: true }).click();
    };
    const libraryOption = async (field: string, choice: string) => {
      await library.getByRole('button', { name: label('library.options'), exact: true }).click();
      await page.getByRole('combobox', { name: label(field), exact: true }).click();
      await page.getByRole('option', { name: choice, exact: true }).click();
      await page.keyboard.press('Escape');
    };
    await libraryOption('library.sort', label('library.name_asc'));
    await uiExpect(rows.first()).toContainText('01-字幕工作台-批量字幕.srt');
    await uiExpect(rows.filter({ hasText: '41-全库搜索-音轨.lrc' })).toHaveCount(0);
    await search.fill('41-全库搜索');
    await uiExpect(rows).toHaveCount(1);
    await uiExpect(rows.first()).toContainText('41-全库搜索-音轨.lrc');
    await search.fill('');
    await uiExpect(rows).toHaveCount(20);
    await libraryOption('library.format', 'LRC');
    await uiExpect(rows).toHaveCount(1);
    await uiExpect(rows.first()).toContainText('41-全库搜索-音轨.lrc');
    await libraryOption('library.format', label('library.all_formats'));
    await libraryOption('library.sort', label('library.name_desc'));
    await uiExpect(rows.first()).toContainText('41-全库搜索-音轨.lrc');
    await libraryOption('library.sort', label('library.name_asc'));
    await uiExpect(rows.first()).toContainText('01-字幕工作台-批量字幕.srt');
    await pagination.getByRole('spinbutton', { name: '页码', exact: true }).fill('3');
    await pagination.getByRole('spinbutton', { name: '页码', exact: true }).press('Enter');
    await uiExpect(rows).toHaveCount(1);
    await uiExpect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await pagination.getByRole('spinbutton', { name: '页码', exact: true }).fill('1');
    await pagination.getByRole('spinbutton', { name: '页码', exact: true }).press('Enter');
    await uiExpect(rows).toHaveCount(20);
    const desktopAlignment = await selectionAlignment(page);
    const allCheckbox = page.getByTestId('studio-library-select-all');
    await rows.first().locator('.studio-document').click();
    await ready(page);
    const footerEmpty = await footerGeometry(page);
    await rows.first().getByRole('checkbox').check();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 1 份');
    await uiExpect(page.getByTestId('studio-batch-toolbar').getByRole('button')).toHaveCount(3);
    const footerOne = await footerGeometry(page);
    expectStableFooter(footerEmpty, footerOne);
    await rows.nth(1).getByRole('checkbox').check();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 2 份');
    const footerTwo = await footerGeometry(page);
    expectStableFooter(footerEmpty, footerTwo);
    // Current preview + multi-selection + an adjacent hover must each paint
    // one complete row. The inner preview button may not create another card.
    await uiExpect(rows.first()).toHaveAttribute('data-current', 'true');
    await rows.nth(2).hover({ position: { x: 6, y: 14 } });
    const surfaceState = async () => rows.evaluateAll(elements => elements.slice(0, 3).map(row => {
      const inner = row.querySelector('.studio-document')!;
      return { background: getComputedStyle(row).backgroundColor, innerBackground: getComputedStyle(inner).backgroundColor,
        innerShadow: getComputedStyle(inner).boxShadow, current: row.hasAttribute('data-current'), selected: row.hasAttribute('data-selected') };
    }));
    await uiExpect.poll(async () => (await surfaceState()).every(row => row.background !== 'rgba(0, 0, 0, 0)' && row.innerBackground === 'rgba(0, 0, 0, 0)' && row.innerShadow === 'none')).toBe(true);
    const rowSurfaces = await surfaceState();
    expect(rowSurfaces.map(row => [row.current, row.selected])).toEqual([[true, true], [false, true], [false, false]]);
    await capture(page, 'library-unified-row-states-desktop');
    await batchMenu();
    await uiExpect(page.getByRole('menuitem', { name: label('library.delete_selected'), exact: true })).toBeEnabled();
    await uiExpect(page.getByRole('menuitem', { name: label('library.resume_selected'), exact: true })).toBeDisabled();
    await capture(page, 'library-fixed-footer-menu-desktop');
    await page.getByRole('menuitem', { name: label('library.clear_selection'), exact: true }).click();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toHaveCount(0);
    expectStableFooter(footerEmpty, await footerGeometry(page));
    await allCheckbox.click();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 41 份');
    const footerAll = await footerGeometry(page);
    expectStableFooter(footerEmpty, footerAll);
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await uiExpect(rows.first()).toContainText('21-字幕工作台-批量字幕.srt');
    await uiExpect(rows.locator('[role="checkbox"][data-state="checked"]')).toHaveCount(20);
    await allCheckbox.focus();
    await page.keyboard.press('Space');
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toHaveCount(0);
    await allCheckbox.click();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 41 份');
    await rows.first().getByRole('checkbox').uncheck();
    await uiExpect(allCheckbox).toHaveAttribute('data-state', 'indeterminate');
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 40 份');
    await allCheckbox.click();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 41 份');
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await uiExpect(rows).toHaveCount(1);
    await uiExpect(rows.first().getByRole('checkbox')).toBeChecked();
    await pagination.getByRole('spinbutton', { name: '页码', exact: true }).fill('1');
    await pagination.getByRole('spinbutton', { name: '页码', exact: true }).press('Enter');
    await uiExpect(rows).toHaveCount(20);
    await capture(page, 'selection-all-pages-desktop');
    await selectionMenu();
    await capture(page, 'selection-options-desktop');
    await page.keyboard.press('Escape');
    await uiExpect(library.getByRole('button', { name: label('library.selection_options'), exact: true })).toBeFocused();
    await allCheckbox.uncheck();
    await selectionMenu();
    await page.getByRole('menuitem').filter({ hasText: label('library.select_page') }).click();
    await uiExpect(rows.locator('[role="checkbox"][data-state="checked"]')).toHaveCount(20);
    await uiExpect(allCheckbox).toHaveAttribute('data-state', 'indeterminate');
    await selectionMenu();
    await page.getByRole('menuitem').filter({ hasText: label('library.select_page') }).click();
    await uiExpect(rows.locator('[role="checkbox"][data-state="checked"]')).toHaveCount(20);
    await clearSelection();
    const firstId = documents.find(document => document.origin.displayName.startsWith('01-'))!.id;
    const secondId = documents.find(document => document.origin.displayName.startsWith('21-'))!.id;
    await page.locator(`[data-testid="studio-library-row"][data-document-id="${firstId}"]`).getByRole('checkbox').check();
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await uiExpect(rows.first()).toContainText('21-字幕工作台-批量字幕.srt');
    await page.locator(`[data-testid="studio-library-row"][data-document-id="${secondId}"]`).getByRole('checkbox').check();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('2');
    await pagination.getByRole('button', { name: '上一页', exact: true }).click();
    await uiExpect(page.locator(`[data-testid="studio-library-row"][data-document-id="${firstId}"]`).getByRole('checkbox')).toBeChecked();
    await capture(page, 'library-cross-page-selection-desktop');
    expect(requests).toHaveLength(0);
    await page.getByTestId('studio-batch-toolbar').getByRole('button', { name: label('batch.translation'), exact: true }).click();
    const translation = page.getByRole('dialog', { name: label('batch.translation'), exact: true });
    await translation.getByRole('button', { name: '计算用量', exact: true }).click();
    await uiExpect(translation.getByTestId('studio-batch-plan').locator('[data-state="ready"]')).toHaveCount(2);
    expect(requests).toHaveLength(0);
    await capture(page, 'batch-translation-plan-desktop');
    await translation.getByRole('button', { name: label('batch.start_ready').replace('{{count}}', '2'), exact: true }).click();
    await uiExpect(translation.getByTestId('studio-batch-result').locator('[data-state="success"]')).toHaveCount(2);
    await translation.getByRole('button', { name: label('batch.close'), exact: true }).click();
    await uiExpect.poll(async () => (await listDocuments(page)).filter(document => document.id === firstId || document.id === secondId).map(document => document.task?.status), { timeout: 30000 }).toEqual(['completed', 'completed']);
    expect(requests).toHaveLength(2);
    for (const [id, scene] of [[firstId, 1], [secondId, 21]] as const) {
      const snapshot = await documentPage(page, id);
      expect(snapshot.translationTracks).toHaveLength(1);
      expect(snapshot.translationTracks[0].entries[snapshot.cues[0].id].text.plain).toBe(`译文：Library scene ${scene}.`);
    }
    await libraryOption('status', label('library.translated'));
    await uiExpect(rows).toHaveCount(2);
    // A changed search/filter is a new selection scope; pagination alone keeps
    // selection. Select every matching translated document explicitly again.
    await uiExpect(rows.locator('[role="checkbox"][data-state="checked"]')).toHaveCount(0);
    await library.getByRole('checkbox', { name: label('library.select_matches'), exact: true }).click();
    await uiExpect(rows.locator('[role="checkbox"][data-state="checked"]')).toHaveCount(2);
    const previewHeader = page.locator('.studio-preview-panel > [data-slot="tool-panel-header"]');
    const actionStyles = await previewHeader.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      return { width: style.width, height: style.height, border: style.borderWidth, shadow: style.boxShadow,
        visibleText: button.textContent?.trim(), label: button.getAttribute('aria-label') };
    }));
    expect(actionStyles).toHaveLength(3);
    expect(new Set(actionStyles.map(({ width, height, border, shadow }) => JSON.stringify({ width, height, border, shadow }))).size).toBe(1);
    expect(actionStyles.every(style => style.visibleText === '' && !!style.label)).toBe(true);
    await previewHeader.screenshot({ path: path.join(artifacts, 'preview-actions-desktop.png'), animations: 'disabled' });
    await page.getByRole('button', { name: label('batch.download_single'), exact: true }).click();
    await uiExpect(page.getByTestId('studio-download-menu').getByRole('menuitem')).toHaveCount(2);
    await capture(page, 'unified-download-menu-desktop');
    await page.keyboard.press('Escape');

    await page.getByTestId('studio-batch-toolbar').getByRole('button', { name: label('batch.download'), exact: true }).click();
    await page.getByTestId('studio-download-menu').getByRole('menuitem', { name: label('batch.export'), exact: true }).click();
    const exporting = page.getByRole('dialog', { name: label('batch.export'), exact: true });
    await exporting.getByRole('combobox', { name: '导出内容', exact: true }).click();
    await page.getByRole('option', { name: '仅译文', exact: true }).click();
    await exporting.getByRole('combobox', { name: '字幕格式', exact: true }).click();
    await page.getByRole('option', { name: 'SRT', exact: true }).click();
    await exporting.getByRole('button', { name: '检查导出', exact: true }).click();
    await uiExpect(exporting.getByTestId('studio-batch-plan').locator('[data-state="ready"]')).toHaveCount(2);
    const acceptLosses = exporting.getByRole('checkbox', { name: '接受以上格式变化', exact: true });
    if (await acceptLosses.count()) await acceptLosses.check();
    const save = exporting.getByRole('button', { name: label('batch.export_ready').replace('{{count}}', '2'), exact: true });
    await application!.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await save.click();
    await uiExpect(save).toBeEnabled();
    expect(await readdir(outputs)).toHaveLength(0);
    const proposed = (await exporting.getByTestId('studio-batch-plan').locator('.studio-export-note').first().textContent())!.split(' · ')[0];
    expect(proposed).toMatch(/\.srt$/);
    const collision = path.join(outputs, proposed);
    await writeFile(collision, 'Existing output must survive.');
    await application!.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1) as { properties?: string[] };
        (globalThis as typeof globalThis & { studioDirectoryProperties?: string[] }).studioDirectoryProperties = options.properties;
        return { canceled: false, filePaths: [directory] };
      };
    }, outputs);
    await capture(page, 'batch-export-plan-desktop');
    await save.click();
    await uiExpect(exporting.getByTestId('studio-batch-result').locator('[data-state="success"]')).toHaveCount(2);
    await application!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(786, 540); });
    await uiExpect(exporting.getByTestId('studio-batch-result').locator('[data-state="success"]')).toHaveCount(2);
    await capture(page, 'batch-export-results-after-narrow-switch');
    await application!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 860); });
    await uiExpect(exporting.getByTestId('studio-batch-result').locator('[data-state="success"]')).toHaveCount(2);
    expect(await application!.evaluate(() => (globalThis as typeof globalThis & { studioDirectoryProperties?: string[] }).studioDirectoryProperties)).toContain('openDirectory');
    const outputNames = (await readdir(outputs)).filter(name => name !== proposed);
    expect(outputNames).toHaveLength(2);
    expect(await readFile(collision, 'utf8')).toBe('Existing output must survive.');
    const exported = await Promise.all(outputNames.map(name => readFile(path.join(outputs, name), 'utf8')));
    expect(exported.some(text => text.includes('译文：Library scene 1.'))).toBe(true);
    expect(exported.some(text => text.includes('译文：Library scene 21.'))).toBe(true);
    await capture(page, 'batch-export-results-desktop');
    await exporting.getByRole('button', { name: label('batch.close'), exact: true }).click();
    expect(requests).toHaveLength(2);

    await batchAction('library.delete_selected');
    const removing = page.getByRole('dialog', { name: label('library.delete_selected'), exact: true });
    expect(await listDocuments(page)).toHaveLength(41);
    await removing.getByRole('button', { name: label('library.confirm_delete'), exact: true }).click();
    await uiExpect(page.getByTestId('studio-library-result').locator('li')).toHaveCount(2);
    await page.getByRole('dialog', { name: label('library.delete_result'), exact: true }).getByRole('button', { name: label('recovery.close'), exact: true }).click();
    expect(await listDocuments(page)).toHaveLength(39);
    expect((await listDocuments(page)).some(document => document.id === firstId || document.id === secondId)).toBe(false);
    expect(await readFile(collision, 'utf8')).toBe('Existing output must survive.');
    expect(await readdir(outputs)).toHaveLength(3);

    const selectDocuments = async (ids: string[]) => {
      await libraryOption('status', label('library.all_status'));
      await libraryOption('library.sort', label('library.name_asc'));
      await clearSelection();
      for (const id of ids) {
        const jump = pagination.getByRole('spinbutton', { name: '页码', exact: true });
        if (await jump.count()) { await jump.fill('1'); await jump.press('Enter'); }
        await ready(page);
        const target = page.locator(`[data-testid="studio-library-row"][data-document-id="${id}"]`);
        for (let attempt = 0; !await target.count() && attempt < 3; attempt++) {
          await pagination.getByRole('button', { name: '下一页', exact: true }).click();
          await ready(page);
        }
        await target.getByRole('checkbox').check();
      }
    };
    const startBatch = async () => {
      await page.getByTestId('studio-batch-toolbar').getByRole('button', { name: label('batch.translation'), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: label('batch.translation'), exact: true });
      await dialog.locator('.studio-translation-advanced summary').click();
      await dialog.getByRole('spinbutton', { name: '每批字幕上限', exact: true }).fill('1');
      await dialog.getByRole('button', { name: '计算用量', exact: true }).click();
      await uiExpect(dialog.getByTestId('studio-batch-plan').locator('[data-state="ready"]')).toHaveCount(2);
      await dialog.getByRole('button', { name: label('batch.start_ready').replace('{{count}}', '2'), exact: true }).click();
      await uiExpect(dialog.getByTestId('studio-batch-result').locator('[data-state="success"]')).toHaveCount(2);
      await dialog.getByRole('button', { name: label('batch.close'), exact: true }).click();
    };
    const resumeIds = ['02-', '22-'].map(prefix => documents.find(document => document.origin.displayName.startsWith(prefix))!.id);
    await selectDocuments(resumeIds);
    modelMode = 'hold-continuations';
    await startBatch();
    await uiExpect.poll(() => held.length, { timeout: 15000 }).toBeGreaterThan(0);
    await uiExpect.poll(async () => (await Promise.all(resumeIds.map(id => documentPage(page, id))))
      .reduce((count, snapshot) => count + snapshot.tasks.reduce((sum, task) => sum + task.completedBatchIds.length, 0), 0), { timeout: 15000 }).toBeGreaterThan(0);
    const beforeRestart = await Promise.all(resumeIds.map(id => documentPage(page, id)));
    const committedTexts = beforeRestart.flatMap(snapshot => snapshot.cues.filter(cue => snapshot.translationTracks.some(track => track.entries[cue.id])).map(cue => cue.source.plain));
    expect(committedTexts.length).toBeGreaterThan(0);
    const remainingTexts = beforeRestart.flatMap(snapshot => snapshot.cues.filter(cue => !snapshot.translationTracks.some(track => track.entries[cue.id])).map(cue => cue.source.plain));
    const requestCountAtRestart = requests.length;
    await capture(page, 'batch-before-restart');
    const crashedProcess = application!.process();
    const crashed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Owned Electron process did not close')), 10000);
      crashedProcess.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    if (process.platform === 'win32') {
      expect(crashedProcess.pid).toBeGreaterThan(0);
      execFileSync('taskkill.exe', ['/PID', String(crashedProcess.pid), '/T', '/F'], { windowsHide: true });
    } else expect(crashedProcess.kill('SIGKILL')).toBe(true);
    await crashed;
    application = undefined;
    modelMode = 'success';
    page = await launch();
    library = page.getByTestId('studio-library');
    search = page.getByTestId('studio-library-search');
    rows = page.getByTestId('studio-library-row');
    pagination = page.getByTestId('studio-library-pagination');
    await uiExpect(page.getByTestId('studio-recovery-warning')).toHaveCount(0);
    expect(requests).toHaveLength(requestCountAtRestart);
    await libraryOption('status', label('library.attention'));
    await uiExpect(rows).toHaveCount(2);
    await library.getByRole('checkbox', { name: label('library.select_matches'), exact: true }).click();
    await batchAction('library.resume_selected');
    const resuming = page.getByRole('dialog', { name: label('library.resume_selected'), exact: true });
    await uiExpect(resuming).toContainText(label('library.resume_uncertain'));
    expect(requests).toHaveLength(requestCountAtRestart);
    await capture(page, 'batch-resume-confirmation');
    await resuming.getByRole('button', { name: label('library.confirm_resume'), exact: true }).click();
    await uiExpect(page.getByTestId('studio-library-result').locator('li')).toHaveCount(2);
    await page.getByRole('dialog', { name: label('library.resume_result'), exact: true }).getByRole('button', { name: label('recovery.close'), exact: true }).click();
    await uiExpect.poll(async () => (await listDocuments(page)).filter(document => resumeIds.includes(document.id)).map(document => document.task?.status), { timeout: 30000 }).toEqual(['completed', 'completed']);
    const resumedTexts = requests.slice(requestCountAtRestart).flatMap(request => (JSON.parse(request.messages[1].content) as { items: { text: string }[] }).items.map(item => item.text));
    expect(resumedTexts.sort()).toEqual(remainingTexts.sort());
    expect(resumedTexts.some(text => committedTexts.includes(text))).toBe(false);
    for (const previous of beforeRestart) {
      const after = await documentPage(page, previous.summary.id);
      for (const track of previous.translationTracks) for (const [cueId, entry] of Object.entries(track.entries)) {
        expect(after.translationTracks.find(item => item.id === track.id)?.entries[cueId]).toEqual(entry);
      }
    }

    const cancelIds = ['03-', '23-'].map(prefix => documents.find(document => document.origin.displayName.startsWith(prefix))!.id);
    await selectDocuments(cancelIds);
    modelMode = 'hold-all';
    const beforeCancelRequests = requests.length;
    await startBatch();
    await uiExpect.poll(() => requests.length, { timeout: 15000 }).toBeGreaterThan(beforeCancelRequests);
    await batchAction('library.cancel_selected');
    await uiExpect(page.getByTestId('studio-library-result').locator('li')).toHaveCount(2);
    await page.getByRole('dialog', { name: label('library.cancel_result'), exact: true }).getByRole('button', { name: label('recovery.close'), exact: true }).click();
    await uiExpect.poll(async () => (await listDocuments(page)).filter(document => cancelIds.includes(document.id)).map(document => document.task?.status)).toEqual(['cancelled', 'cancelled']);
    const cancelled = await Promise.all(cancelIds.map(id => documentPage(page, id)));
    for (const pending of held.splice(0)) respond(pending.response, pending.body);
    await page.waitForTimeout(300);
    for (const snapshot of cancelled) {
      const after = await documentPage(page, snapshot.summary.id);
      expect(after.translationTracks).toEqual(snapshot.translationTracks);
      expect(after.tasks).toEqual(snapshot.tasks);
    }
    await capture(page, 'batch-cancelled-desktop');

    await application!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(786, 540); });
    await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
    await page.reload(); await ready(page);
    await uiExpect(page.locator('html')).toHaveClass(/dark/);
    await capture(page, 'library-narrow-dark-workspace');
    await page.getByRole('button', { name: label('library.open'), exact: true }).click();
    await uiExpect(page.getByTestId('studio-library')).toBeVisible();
    // Finish the narrow-dialog entrance before comparing separate layout
    // snapshots. Checkbox alignment itself is still sampled in one frame.
    await capture(page, 'library-narrow-dark-empty-selection');
    const narrowAlignment = await selectionAlignment(page);
    const narrowFooterEmpty = await footerGeometry(page);
    await page.getByTestId('studio-library-select-all').click();
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 39 份');
    const narrowFooterSelected = await footerGeometry(page);
    expectStableFooter(narrowFooterEmpty, narrowFooterSelected);
    await capture(page, 'library-narrow-dark-management');
    await batchMenu();
    await capture(page, 'library-fixed-footer-menu-narrow');
    await page.keyboard.press('Escape');
    await uiExpect(page.getByTestId('studio-batch-toolbar').getByRole('button', { name: label('library.batch_actions'), exact: true })).toBeFocused();
    for (const [file, content] of originals) expect(await readFile(file, 'utf8')).toBe(content);
    const finalDocuments = (await listDocuments(page)).length;
    // The real batch contract is bounded; exceeding it must explain the limit
    // inside the narrow library, without clearing or truncating the selection.
    const limitFiles = await Promise.all(Array.from({ length: 62 }, async (_, index) => {
      const file = path.join(sources, `limit-${index}.srt`);
      await writeFile(file, '1\n00:00:01,000 --> 00:00:02,000\nSelection limit fixture\n');
      return file;
    }));
    await application!.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, limitFiles);
    const extra = await page.evaluate(() => window.subtitleStudio.importSubtitles({ encoding: 'utf-8' }));
    expect(extra.ok && extra.value?.items.filter(item => item.ok).length).toBe(62);
    await uiExpect(page.locator('.studio-library-selection-scope')).toHaveText('101 份');
    await page.getByTestId('studio-library-select-all').click();
    await uiExpect(page.getByTestId('studio-library-selection-limit')).toContainText('100');
    await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 39 份');
    await capture(page, 'selection-limit-narrow');
    await page.getByTestId('studio-library-selection-limit').getByRole('button', { name: label('dismiss'), exact: true }).click();
    await uiExpect(page.getByTestId('studio-library-selection-limit')).toHaveCount(0);
    await writeFile(path.join(artifacts, 'evidence.json'), JSON.stringify({ imported: 41, rejected: 1, libraryPages: 3,
      exportedFiles: outputNames, existingOutputPreserved: true, bulkDeleted: 2, finalDocuments,
      recoveryDismissedAcrossRestart: true, recoveryResidueRemoved: true, sourceFilesPreserved: originals.size,
      resumedDocuments: resumeIds.length, committedCuesNotResent: committedTexts.length, cancelledDocuments: cancelIds.length,
      modelRequests: requests.length, selection: { allPages: 41, deselectedOne: 40, pageOnly: 20, narrowAllPages: 39, limitFixtureTotal: 101, limitSelectionPreserved: 39, desktopAlignment, narrowAlignment },
      layout: { footerEmpty, footerOne, footerTwo, footerAll, narrowFooterEmpty, narrowFooterSelected, rowSurfaces }, errors }, null, 2));
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(path.join(artifacts, 'failure.txt'), String(error));
    try {
      const window = await application?.firstWindow();
      if (window) {
        await window.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' });
        await writeFile(path.join(artifacts, 'failure-dom.txt'), await window.locator('body').innerText());
      }
    } catch { /* A deliberate crash can close the renderer before diagnostics. */ }
    throw error;
  } finally {
    try { await application?.close(); }
    finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}, 360000);
