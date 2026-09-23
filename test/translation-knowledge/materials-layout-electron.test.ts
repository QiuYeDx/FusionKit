import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('materials selection and reuse layout through native Electron', () => {
  let app: ElectronApplication | undefined, page: Page | undefined, root = '';
  const artifacts = path.resolve('test-results/translation-knowledge-materials-layout');
  afterAll(async () => {
    try {
      const child = app?.process();
      await app?.close();
      if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('keeps selection explicit, reuses only shared settings across documents, and makes library actions reachable', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-materials-layout-'));
    await mkdir(artifacts, { recursive: true });
    const fixture = knowledgeFixture(), term = fixture.entries.find(item => item.kind === 'term')!;
    const context = fixture.entries.find(item => item.kind === 'context')!;
    fixture.collections[0].name = '游戏 X · 系列视频翻译资料与人物固定译法 / Game X terminology and dialogue references';
    const otherCollection = { ...fixture.collections[0], id: '30000000-0000-4000-8000-000000000002', name: '保留但不选用的其他资料集' };
    fixture.collections.push(otherCollection);
    const input = path.join(root, 'materials-layout.fktk.json');
    const subtitleFiles = ['First episode with carefully confirmed cue scope.lrc', 'Second episode requires its own scope confirmations.lrc'].map(name => path.join(root, name));
    await writeFile(input, JSON.stringify(fixture));
    const subtitleLines = ['We reached the checkpoint.', 'She mentioned Mira.',
      'Before we move on, make sure the checkpoint has saved every part of our progress, including the conversation with Mira and the route through the old town, so that we can return here without losing anything.',
      ...Array.from({ length: 9 }, (_, index) => index % 3 === 0 ? 'Ready when you are.' : `Mira reached checkpoint ${index + 2} and waited for the rest of the group.`)];
    for (const filename of subtitleFiles) await writeFile(filename, subtitleLines.map((text, index) => `[00:${String(index * 2 + 1).padStart(2, '0')}]${text}`).join('\n'));
    const en = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8'));
    const zh = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    const enKnowledge = JSON.parse(await readFile(path.resolve('src/locales/en/knowledge.json'), 'utf8'));
    const errors: string[] = [];
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await app.firstWindow();
    const ui = page, nativeWindow = await app.browserWindow(ui);
    await nativeWindow.evaluate(win => { win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
    ui.on('pageerror', error => errors.push(error.message));
    const readLibrary = () => ui.evaluate(async () => {
      const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value;
    });
    const readDocuments = () => ui.evaluate(async () => {
      const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw new Error(listed.error);
      return Promise.all(listed.value.documents.map(async document => {
        const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
        if (!result.ok) throw new Error(result.error); return result.value;
      }));
    });
    const form = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-form') });
    const review = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-review-dialog') });
    const settled = () => ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    const geometry = async (target: Locator) => {
      expect(await target.evaluate(element => {
        const r = element.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
      })).toBe(true);
      expect(await target.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    };
    const visualMeasurements: Array<{ name: string; metrics: unknown }> = [];
    const waitForGeometry = async (target: Locator) => {
      await nativeWindow.evaluate(win => { win.show(); win.focus(); });
      await ui.bringToFront();
      await target.evaluate(element => new Promise<void>((resolve, reject) => {
        let previous: number[] = [], stable = 0;
        const started = performance.now();
        const sample = () => {
          const nodes = [element, element.closest('[role=dialog]')].filter((node): node is Element => !!node);
          const current = nodes.flatMap(node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height, node.scrollHeight]; });
          const moving = [...element.querySelectorAll('[data-flow-animating="true"]')].some(node => node.getClientRects().length > 0);
          stable = !moving && previous.length === current.length && current.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 0;
          previous = current;
          if (stable >= 4) resolve();
          else if (performance.now() - started > 5000) reject(new Error('Dialog geometry did not settle before visual capture'));
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }));
    };
    const capture = async (name: string, target: Locator) => {
      await settled(); await target.scrollIntoViewIfNeeded(); await waitForGeometry(target);
      await geometry(target);
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    };
    const disclosureLayout = async (name: string) => {
      await waitForGeometry(form());
      const metrics = await ui.getByTestId('studio-materials').evaluate(card => {
        const cardBox = card.getBoundingClientRect();
        return ['studio-materials-topics', 'studio-materials-more'].map(id => {
          const panel = card.querySelector(`[data-testid="${id}"]`)!;
          const trigger = panel.querySelector('[data-slot=accordion-trigger]')!;
          const triggerBox = trigger.getBoundingClientRect();
          const title = trigger.querySelector('span')!.getBoundingClientRect();
          const icon = trigger.querySelector('svg')!.getBoundingClientRect();
          const clipClearances: number[] = [];
          for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
            if (!['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) continue;
            const box = parent.getBoundingClientRect(), left = box.left + parent.clientLeft;
            clipClearances.push(title.left - left, left + parent.clientWidth - icon.right);
          }
          return { id, leftInset: triggerBox.left - cardBox.left, rightInset: cardBox.right - triggerBox.right,
            titleInset: title.left - triggerBox.left, iconInset: triggerBox.right - icon.right,
            minimumClipClearance: Math.min(...clipClearances), corner: Number.parseFloat(getComputedStyle(trigger).borderTopLeftRadius) };
        });
      });
      visualMeasurements.push({ name, metrics });
      for (const metric of metrics) {
        expect(metric.leftInset).toBeGreaterThanOrEqual(0); expect(metric.leftInset).toBeLessThanOrEqual(1.5);
        expect(metric.rightInset).toBeGreaterThanOrEqual(0); expect(metric.rightInset).toBeLessThanOrEqual(1.5);
        expect(metric.titleInset).toBeGreaterThanOrEqual(11); expect(metric.titleInset).toBeLessThanOrEqual(13);
        expect(metric.iconInset).toBeGreaterThanOrEqual(11); expect(metric.iconInset).toBeLessThanOrEqual(13);
        expect(metric.minimumClipClearance).toBeGreaterThanOrEqual(8);
        expect(metric.corner).toBe(0);
      }
    };
    const scopeLayout = async (name: string) => {
      const scopes = ui.getByTestId('knowledge-trial-scopes');
      const scroll = scopes.locator('.studio-knowledge-scope-scroll');
      const viewport = scroll.locator('.studio-scroll-fade-viewport');
      await waitForGeometry(form());
      const captureScopeList = async (captureName: string) => {
        // Wait for the disclosure's final footprint before positioning it. A
        // zero-height box during enter scrolls only its heading into view.
        await settled(); await waitForGeometry(form());
        await scroll.evaluate(element => {
          const outer = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
          const actions = element.closest('.studio-knowledge-scope')?.querySelector('.studio-knowledge-scope-actions');
          if (!outer || !actions) throw new Error('Missing actual dialog scroll viewport or scope actions');
          const viewportBox = outer.getBoundingClientRect(), listBox = element.getBoundingClientRect(), actionsBox = actions.getBoundingClientRect();
          // The list and its toolbar form the acceptance region. Scroll only
          // the outer dialog, preserving the inner list's top/middle/end state.
          outer.scrollTo({ top: outer.scrollTop + (listBox.top + actionsBox.bottom) / 2 - (viewportBox.top + outer.clientHeight / 2), behavior: 'instant' });
        });
        await waitForGeometry(scroll);
        const visible = await scroll.evaluate(element => {
          const outer = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
          const actions = element.closest('.studio-knowledge-scope')!.querySelector('.studio-knowledge-scope-actions')!.getBoundingClientRect();
          const outerBox = outer.getBoundingClientRect(), listBox = element.getBoundingClientRect();
          const visibleTop = Math.max(outerBox.top, listBox.top), visibleBottom = Math.min(outerBox.bottom, listBox.bottom);
          const completeRows = [...element.querySelectorAll('.studio-knowledge-cue')].filter(row => {
            const box = row.getBoundingClientRect(); return box.top >= visibleTop - 1 && box.bottom <= visibleBottom + 1;
          }).length;
          return { completeRows, visibleListHeight: visibleBottom - visibleTop, listHeight: listBox.height,
            actionsVisible: actions.top >= outerBox.top - 1 && actions.bottom <= outerBox.bottom + 1,
            top: listBox.top, bottom: listBox.bottom, viewportTop: outerBox.top, viewportBottom: outerBox.bottom, outerScrollTop: outer.scrollTop };
        });
        visualMeasurements.push({ name: `${captureName}-visible-content`, metrics: visible });
        expect(visible.visibleListHeight).toBeGreaterThanOrEqual(visible.listHeight - 1);
        expect(visible.completeRows).toBeGreaterThanOrEqual(2);
        expect(visible.actionsVisible).toBe(true);
        await geometry(form());
        await ui.screenshot({ path: path.join(artifacts, `${captureName}.png`), animations: 'disabled' });
      };
      const metrics = await scopes.evaluate(element => {
        const help = element.querySelector('.studio-knowledge-scope-help')!.getBoundingClientRect();
        const list = element.querySelector('.studio-knowledge-scope-scroll')!.getBoundingClientRect();
        const actions = element.querySelector('.studio-knowledge-scope-actions')!.getBoundingClientRect();
        const rows = [...element.querySelectorAll<HTMLElement>('.studio-knowledge-cue')];
        const first = rows[0], long = rows[2];
        const firstRoles = [...first.querySelectorAll('.studio-knowledge-cue-role')].map(role => role.getBoundingClientRect());
        const trigger = element.querySelector('[data-slot=accordion-trigger]')!;
        const triggerBox = trigger.getBoundingClientRect();
        const panel = element.getBoundingClientRect();
        return { listGapAbove: list.top - help.bottom, listGapBelow: actions.top - list.bottom,
          shortHeight: first.getBoundingClientRect().height, shortTextHeight: first.querySelector('.studio-knowledge-cue-text')!.getBoundingClientRect().height,
          longTextHeight: long.querySelector('.studio-knowledge-cue-text')!.getBoundingClientRect().height,
          roleTopDelta: Math.max(...firstRoles.map(role => role.top)) - Math.min(...firstRoles.map(role => role.top)),
          roleControlHeights: [...first.querySelectorAll('[data-slot=select-trigger]')].map(control => control.getBoundingClientRect().height),
          overflow: rows.some(row => row.scrollWidth > row.clientWidth + 1),
          titleInset: trigger.querySelector('span')!.getBoundingClientRect().left - triggerBox.left,
          iconInset: triggerBox.right - trigger.querySelector('svg')!.getBoundingClientRect().right,
          panelCorner: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius), triggerInset: triggerBox.left - panel.left };
      });
      visualMeasurements.push({ name, metrics });
      expect(metrics.listGapAbove).toBeCloseTo(12, 0); expect(metrics.listGapBelow).toBeCloseTo(12, 0);
      expect(metrics.shortTextHeight).toBeLessThanOrEqual(21); expect(metrics.longTextHeight).toBeGreaterThan(metrics.shortTextHeight);
      expect(metrics.shortHeight).toBeLessThanOrEqual(136); expect(metrics.roleTopDelta).toBeLessThanOrEqual(1);
      expect(metrics.roleControlHeights).toEqual([28, 28, 28]); expect(metrics.overflow).toBe(false);
      expect(metrics.titleInset).toBeGreaterThanOrEqual(11); expect(metrics.iconInset).toBeGreaterThanOrEqual(11);
      expect(metrics.panelCorner).toBeGreaterThan(0); expect(metrics.triggerInset).toBeLessThanOrEqual(1.5);
      expect(await viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
      for (const [position, top, bottom] of [['top', false, true], ['middle', true, true], ['bottom', true, false]] as const) {
        await viewport.evaluate((element, at) => { const max = element.scrollHeight - element.clientHeight; element.scrollTop = at === 'top' ? 0 : at === 'bottom' ? max : max / 2; }, position);
        await uiExpect(scroll).toHaveAttribute('data-fade-top', String(top)); await uiExpect(scroll).toHaveAttribute('data-fade-bottom', String(bottom));
        for (const [edge, shown] of [['top', top], ['bottom', bottom]] as const) {
          const overlay = scroll.locator(`.studio-scroll-fade-edge[data-edge="${edge}"]`);
          await uiExpect(overlay).toHaveCSS('pointer-events', 'none'); await uiExpect(overlay).toHaveAttribute('aria-hidden', 'true');
          await uiExpect.poll(() => overlay.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(shown ? 1 : 0);
        }
        await captureScopeList(`${name}-${position}`);
      }
      await viewport.evaluate(element => { element.scrollTop = 0; });
      await uiExpect(scroll).toHaveAttribute('data-fade-top', 'false');
    };
    const compactLayout = async () => {
      const metrics = await ui.getByTestId('studio-translation-header').evaluate(header => {
        const dialog = header.closest('[role=dialog]')!;
        const title = header.querySelector('[data-slot=dialog-title]')!.getBoundingClientRect();
        const close = dialog.querySelector('[data-slot=dialog-close]')!.getBoundingClientRect();
        const frame = header.parentElement!.parentElement!.getBoundingClientRect();
        const materials = dialog.querySelector('[data-testid=studio-materials]')!.getBoundingClientRect();
        const heading = dialog.querySelector('.studio-materials-title')!.getBoundingClientRect();
        const choose = dialog.querySelector('[data-testid=studio-materials-choose]')!.getBoundingClientRect();
        return { materialsWidth: materials.width, headerHeight: frame.height, centerDelta: Math.abs(title.top + title.height / 2 - close.top - close.height / 2),
          reuseInHeader: header.contains(dialog.querySelector('[data-testid=studio-translation-settings]')),
          titleTopInset: heading.top - materials.top, titleLeftInset: heading.left - materials.left,
          headingButtonTopDelta: Math.abs(heading.top - choose.top) };
      });
      expect(metrics.headerHeight).toBeLessThanOrEqual(60);
      expect(metrics.centerDelta).toBeLessThanOrEqual(2);
      expect(metrics.reuseInHeader).toBe(false);
      expect(Math.abs(metrics.titleTopInset - metrics.titleLeftInset)).toBeLessThanOrEqual(2);
      if (metrics.materialsWidth > 406) expect(metrics.headingButtonTopDelta).toBeLessThanOrEqual(2);
      await uiExpect(ui.getByTestId('studio-translation-form').getByTestId('studio-translation-settings')).toBeVisible();
    };
    const returnToSettings = async () => {
      await ui.getByTestId('studio-translation-review-close').click();
      await uiExpect(review()).toHaveCount(0);
      await uiExpect(form()).toBeVisible();
    };
    const expand = async (testId: string) => {
      const trigger = ui.getByTestId(testId).locator('[data-slot=accordion-trigger]').first();
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    };
    const selectRecipe = async () => {
      await ui.getByTestId('studio-materials-choose').click();
      await ui.getByTestId('studio-materials-recipe').click();
      await ui.getByRole('option', { name: fixture.recipes[0].name, exact: true }).click();
      await ui.getByTestId('studio-materials-done').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
    };
    const closeTranslation = async () => {
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
    };

    try {
      await ui.evaluate(() => {
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'materials-layout', name: 'Local configuration fixture', provider: 'DeepSeek', apiKey: 'synthetic-layout-key', baseUrl: 'http://127.0.0.1:9', modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'materials-layout', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/translation-knowledge';
      });
      await ui.reload(); await nativeWindow.evaluate(win => win.setSize(1280, 860)); await settled();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await ui.getByTestId('knowledge-import').click();
      await ui.getByRole('button', { name: '确认导入', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(read.error);
        let current = read.value;
        for (const entry of read.value.data.entries) {
          const result = await window.translationKnowledge.reviewEntries({ generation: current.generation, ids: [entry.id], action: 'adopt' });
          if (!result.ok) throw new Error(result.error); current = result.value;
        }
      });
      await ui.locator(`[data-collection-id="${fixture.collections[0].id}"]`).click();
      await capture('library-sidebar-zh-light-wide', ui.locator('#knowledge-collection-list'));
      for (const id of ['knowledge-import', 'knowledge-export', 'knowledge-open-studio']) await uiExpect(ui.getByTestId(id)).toBeVisible();
      await ui.getByTestId('knowledge-export').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui).toHaveURL(/#\/tools\/translation-knowledge$/);
      const management = ui.locator('#knowledge-more-management [data-slot=accordion-trigger]').first();
      await management.click(); await uiExpect(management).toHaveAttribute('aria-expanded', 'true');
      await ui.getByTestId('knowledge-history').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1); await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0); await management.click();
      await ui.getByTestId('knowledge-open-studio').click();
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, subtitleFiles);
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await ui.locator('#studio-result-close').click();
      const documents = await readDocuments();
      const first = documents.find(document => document.summary.origin.displayName === path.basename(subtitleFiles[0]))!;
      const second = documents.find(document => document.summary.origin.displayName === path.basename(subtitleFiles[1]))!;
      const showLibrary = async () => {
        // Compact Studio renders its document list in the real library dialog.
        // The document rows are intentionally absent until that dialog opens.
        await uiExpect(ui.getByTestId('subtitle-studio')).toBeVisible();
        const trigger = ui.locator('#studio-library-trigger');
        if (await trigger.isVisible() && !(await ui.locator('.studio-library-dialog').isVisible())) await trigger.click();
      };
      const openDocument = async (id: string) => {
        await showLibrary();
        await ui.locator(`[data-testid="studio-library-row"][data-document-id="${id}"] .studio-document`).click();
        await uiExpect(ui.locator('.studio-library-dialog')).toHaveCount(0);
        await uiExpect(ui.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
      };
      await openDocument(first.summary.id);
      await ui.getByRole('button', { name: '翻译', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(zh.materials.none);
      await capture('single-empty-zh-light-wide', form());
      await compactLayout();

      // A non-modal picker owns Escape. Closing it never closes its parent or
      // navigates, and selections take effect without an extra commit dialog.
      await ui.getByTestId('studio-materials-choose').click();
      const picker = ui.getByTestId('studio-materials-picker');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(2);
      await ui.getByTestId('studio-materials-search').fill('There is no collection with this title');
      await uiExpect(ui.getByTestId('studio-materials-search-empty')).toBeVisible();
      await uiExpect(picker.locator('[data-testid^="studio-materials-collection-"]')).toHaveCount(0);
      await capture('picker-search-empty-zh-light-wide', picker);
      await ui.getByTestId('studio-materials-search-empty').getByRole('button').click();
      await uiExpect(ui.getByTestId('studio-materials-search')).toHaveValue('');
      await ui.getByTestId(`studio-materials-collection-${fixture.collections[0].id}`).check();
      await uiExpect(ui.getByTestId(`studio-materials-collection-${otherCollection.id}`)).not.toBeChecked();
      await ui.keyboard.press('Escape');
      await uiExpect(picker).toHaveCount(0); await uiExpect(form()).toBeVisible();
      await uiExpect(ui).toHaveURL(/#\/tools\/subtitle\/studio$/);
      await uiExpect(ui.getByTestId('studio-materials-choose')).toBeFocused();
      await ui.getByTestId('studio-materials-choose').click();
      await uiExpect(ui.getByTestId(`studio-materials-collection-${fixture.collections[0].id}`)).toBeChecked();
      await capture('picker-selected-zh-light-wide', picker);
      await ui.getByTestId('studio-materials-done').click();
      await ui.getByTestId('studio-materials-clear').click();
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(zh.materials.none);
      await uiExpect(ui.getByTestId('studio-materials-source')).toHaveCount(0);
      // Only this local IPC response is delayed/failed. The actual renderer,
      // preload, modal stack, and subsequent successful planner stay production.
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const channel = 'subtitle-studio:plan-translation', original = handlers.get(channel);
        if (!original) throw new Error('Missing production translation planner');
        let release: () => void = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        handlers.set(channel, async () => { await pending; return { ok: false, error: 'translation_failed' }; });
        (globalThis as typeof globalThis & { __materialsReviewGate?: { release: () => void; restore: () => void } }).__materialsReviewGate = {
          release, restore: () => handlers.set(channel, original),
        };
      });
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(review()).toBeVisible();
      await uiExpect(ui.getByTestId('studio-translation-review-loading')).toBeVisible();
      await capture('review-loading-zh-light-wide', review());
      await ui.keyboard.press('Escape');
      await uiExpect(review()).toHaveCount(0);
      await uiExpect(form()).toBeVisible();
      await app.evaluate(() => { (globalThis as typeof globalThis & { __materialsReviewGate?: { release: () => void } }).__materialsReviewGate!.release(); });
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeEnabled();
      await uiExpect(review()).toHaveCount(0);
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('studio-translation-review-error')).toBeVisible();
      await capture('review-error-zh-light-wide', review());
      await app.evaluate(() => { (globalThis as typeof globalThis & { __materialsReviewGate?: { restore: () => void } }).__materialsReviewGate!.restore(); });
      await ui.getByTestId('studio-translation-review-retry').click();
      await uiExpect(ui.getByTestId('studio-translation-plan')).toBeVisible();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-translation-form').getByTestId('studio-translation-plan')).toHaveCount(0);
      await capture('review-estimate-zh-light-wide', review());
      await ui.keyboard.press('Escape');
      await uiExpect(review()).toHaveCount(0);
      await uiExpect(form()).toBeVisible();
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeFocused();

      await selectRecipe();
      const instructions = 'Keep each subtitle concise and retain all information.';
      const contextText = 'Shared background for this series; scope must be confirmed for each document.';
      await ui.getByTestId('studio-translation-instructions').fill(instructions);
      await expand('studio-materials-more');
      await ui.getByTestId('studio-materials-context').fill(contextText);
      await expand('studio-materials-exclusions');
      await ui.getByTestId(`studio-materials-exclude-${context.id}`).check();
      await expand('studio-materials-topics');
      await ui.getByTestId(`studio-materials-topic-${fixture.subjects[0].id}`).check();
      await disclosureLayout('materials-disclosures-zh-light');
      await capture('materials-disclosures-expanded-zh-light', form());
      const scopes = ui.getByTestId('knowledge-trial-scopes');
      await scopes.locator('[data-slot=accordion-trigger]').first().click();
      await scopeLayout('scope-list-zh-light');
      await ui.getByTestId(`studio-materials-cue-${first.cues[0].id}`).check();
      await ui.getByTestId(`studio-materials-role-${first.cues[0].id}-speaker`).click();
      await ui.getByRole('option', { name: fixture.subjects[1].name, exact: true }).click();
      await uiExpect(ui.getByTestId(`studio-materials-cue-${first.cues[0].id}`)).toBeChecked();
      await ui.getByTestId(`studio-materials-confirm-${first.cues[0].id}-${term.id}`).check();
      await scopes.locator('[data-slot=accordion-trigger]').first().click();
      await ui.getByTestId('studio-translation-settings').click();
      await ui.getByTestId('studio-translation-save-recipe').click();
      const savedName = 'Shared series configuration from the redesigned settings panel';
      await ui.getByTestId('studio-translation-recipe-name').fill(savedName);
      await ui.getByTestId('studio-translation-confirm-recipe').click();
      await uiExpect.poll(async () => (await readLibrary()).data.recipes.some(recipe => recipe.name === savedName)).toBe(true);
      const savedRecipe = (await readLibrary()).data.recipes.find(recipe => recipe.name === savedName)!;
      expect(savedRecipe).toMatchObject({ instructions, context: contextText, readCollectionIds: fixture.recipes[0].readCollectionIds, subjectSuggestions: [] });
      if (await ui.getByTestId('studio-translation-settings').getAttribute('aria-expanded') === 'true') await ui.keyboard.press('Escape');
      await closeTranslation();

      // Cross-document reuse is an explicit action. It carries the shared
      // language, model and writing settings, never the first document's proof.
      await openDocument(second.summary.id);
      await ui.getByRole('button', { name: '翻译', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(zh.materials.none);
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue('');
      await ui.getByTestId('studio-translation-settings').click();
      await uiExpect(ui.getByTestId('studio-translation-reuse')).toBeEnabled();
      await uiExpect(ui.getByTestId('studio-translation-reuse-summary')).toContainText(fixture.collections[0].name);
      await capture('reuse-settings-zh-light-wide', ui.getByTestId('studio-translation-settings-panel'));
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByTestId('studio-translation-settings-panel')).toHaveCount(0);
      await uiExpect(form()).toBeVisible();
      await uiExpect(ui.getByTestId('studio-translation-settings')).toBeFocused();
      await uiExpect(ui).toHaveURL(/#\/tools\/subtitle\/studio$/);
      await ui.getByTestId('studio-translation-settings').click();
      await ui.getByTestId('studio-translation-reuse').click();
      if (await ui.getByTestId('studio-translation-settings').getAttribute('aria-expanded') === 'true') await ui.keyboard.press('Escape');
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(instructions);
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(fixture.recipes[0].name);
      await uiExpect(ui.getByTestId('studio-materials-source')).toHaveText('英语');
      await expand('studio-materials-more');
      await uiExpect(ui.getByTestId('studio-materials-context')).toHaveValue(contextText);
      await expand('studio-materials-exclusions');
      await uiExpect(ui.getByTestId(`studio-materials-exclude-${context.id}`)).not.toBeChecked();
      await expand('studio-materials-topics');
      await uiExpect(ui.getByTestId(`studio-materials-topic-${fixture.subjects[0].id}`)).not.toBeChecked();
      await ui.getByTestId('knowledge-trial-scopes').locator('[data-slot=accordion-trigger]').first().click();
      for (const cue of second.cues) {
        await uiExpect(ui.getByTestId(`studio-materials-cue-${cue.id}`)).not.toBeChecked();
        await uiExpect(ui.getByTestId(`studio-materials-confirm-${cue.id}-${term.id}`)).not.toBeChecked();
        for (const role of ['topic', 'speaker', 'mentioned']) await uiExpect(ui.getByTestId(`studio-materials-role-${cue.id}-${role}`)).toHaveText('未关联对象');
      }
      await ui.getByTestId('knowledge-trial-scopes').locator('[data-slot=accordion-trigger]').first().click();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toBeVisible();
      await uiExpect.poll(() => ui.getByTestId('knowledge-full-preview').locator('[data-issue-code="subject_unbound"]').count()).toBeGreaterThan(0);
      await capture('review-materials-zh-light-wide', review());
      await returnToSettings();
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(instructions);
      await closeTranslation();
      await showLibrary();
      for (const document of documents) await ui.locator(`[data-testid="studio-library-row"][data-document-id="${document.summary.id}"]`).getByRole('checkbox').check();
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: '批量翻译', exact: true }).click();
      await ui.getByTestId('studio-translation-settings').click();
      await ui.getByTestId('studio-translation-reuse').click();
      if (await ui.getByTestId('studio-translation-settings').getAttribute('aria-expanded') === 'true') await ui.keyboard.press('Escape');
      await uiExpect(ui.getByTestId('knowledge-trial-scopes')).toHaveCount(0);
      await capture('batch-selected-zh-light-wide', form());
      await compactLayout();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('knowledge-batch-preview')).toBeVisible();
      await capture('review-batch-zh-light-wide', review());
      await returnToSettings();
      await closeTranslation();

      await ui.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); location.hash = '/tools/translation-knowledge'; });
      await ui.reload(); await nativeWindow.evaluate(win => win.setSize(820, 700)); await settled();
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await capture('library-sidebar-en-dark-narrow', ui.locator('#knowledge-collection-list'));
      const compactManagement = ui.locator('#knowledge-more-management');
      const managementTrigger = compactManagement.locator('[data-slot=accordion-trigger]').first();
      await managementTrigger.click();
      const subjectsTrigger = compactManagement.getByRole('button', { name: enKnowledge.subjects.title, exact: true });
      await subjectsTrigger.click();
      await uiExpect(managementTrigger).toHaveAttribute('aria-expanded', 'true');
      await uiExpect(subjectsTrigger).toHaveAttribute('aria-expanded', 'true');
      for (const subject of fixture.subjects) await uiExpect(compactManagement.getByRole('button', { name: subject.name, exact: true })).toBeVisible();
      // The expanded sidebar can be taller than the window. Verify the actual
      // controls are reachable while scrolling, including fixed navigation.
      for (const id of ['knowledge-history', 'knowledge-import', 'knowledge-export', 'knowledge-open-studio']) {
        const action = ui.getByTestId(id);
        await action.scrollIntoViewIfNeeded(); await uiExpect(action).toBeVisible();
        await action.click({ trial: true }); await geometry(action);
      }
      await capture('library-sidebar-expanded-en-dark-narrow', ui.getByTestId('knowledge-history'));
      const firstCollection = ui.locator(`[data-collection-id="${fixture.collections[0].id}"]`);
      await firstCollection.scrollIntoViewIfNeeded(); await firstCollection.hover();
      const collectionTooltip = ui.locator('[data-slot=tooltip-content]').filter({ hasText: fixture.collections[0].name });
      await uiExpect(collectionTooltip).toBeVisible();
      await uiExpect(collectionTooltip).toContainText(fixture.collections[0].name);
      await uiExpect(collectionTooltip).toContainText(`${enKnowledge.languages.en} → ${enKnowledge.languages['zh-Hans']}`);
      await geometry(collectionTooltip);
      await ui.screenshot({ path: path.join(artifacts, 'library-collection-tooltip-en-dark-narrow.png'), animations: 'disabled' });
      await subjectsTrigger.click(); await uiExpect(collectionTooltip).toHaveCount(0);
      await managementTrigger.click();
      await uiExpect(managementTrigger).toHaveAttribute('aria-expanded', 'false');
      await ui.getByTestId('knowledge-open-studio').click();
      await openDocument(first.summary.id);
      await ui.getByRole('button', { name: en.translation.action, exact: true }).click();
      await ui.getByRole('combobox', { name: 'Target language', exact: true }).click();
      await ui.getByRole('option', { name: 'Simplified Chinese', exact: true }).click();
      await selectRecipe();
      await capture('single-selected-en-dark-narrow', form());
      await compactLayout();
      await expand('studio-materials-topics'); await expand('studio-materials-more');
      await disclosureLayout('materials-disclosures-en-dark');
      await capture('materials-disclosures-expanded-en-dark-narrow', form());
      await expand('knowledge-trial-scopes');
      await scopeLayout('scope-list-en-dark-narrow');
      await ui.getByTestId('knowledge-trial-scopes').locator('[data-slot=accordion-trigger]').first().click();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toBeVisible();
      await capture('review-materials-en-dark-narrow', review());
      await returnToSettings();
      await ui.getByTestId('studio-materials-choose').click();
      await capture('picker-selected-en-dark-narrow', picker);
      await ui.keyboard.press('Escape'); await uiExpect(form()).toBeVisible();
      await closeTranslation();
      await showLibrary();
      for (const document of documents) await ui.locator(`[data-testid="studio-library-row"][data-document-id="${document.summary.id}"]`).getByRole('checkbox').check();
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: en.batch.translation, exact: true }).click();
      await ui.getByTestId('studio-translation-settings').click();
      await ui.getByTestId('studio-translation-reuse').click();
      if (await ui.getByTestId('studio-translation-settings').getAttribute('aria-expanded') === 'true') await ui.keyboard.press('Escape');
      await capture('batch-selected-en-dark-narrow', form());
      await compactLayout();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('knowledge-batch-preview')).toBeVisible();
      await capture('review-batch-en-dark-narrow', review());
      await ui.keyboard.press('Escape');
      await uiExpect(review()).toHaveCount(0);
      await uiExpect(form()).toBeVisible();
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeFocused();
      await closeTranslation();
      const unchanged = await readDocuments();
      for (const document of unchanged) { expect(document.tasks).toHaveLength(0); expect(document.translationTracks).toHaveLength(0); }
      expect(errors).toEqual([]);
      await writeFile(path.join(artifacts, 'visual-metrics.json'), JSON.stringify(visualMeasurements, null, 2));
    } catch (error) {
      await writeFile(path.join(artifacts, 'visual-metrics.json'), JSON.stringify(visualMeasurements, null, 2));
      await ui.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 180000);
});
