import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator } from '@playwright/test';
import { knowledgeFixture } from './translation-knowledge/fixtures';
import knowledgeLabels from '../src/locales/zh/knowledge.json';

const artifacts = path.resolve('test-results/dialog-motion');
const dialogSelector = '[role="dialog"][data-animated-dialog="true"]';

/** Geometry, transforms, fixed chrome and exiting content must come from one paint. */
async function startFrames(dialog: Locator) {
  return dialog.evaluateHandle(element => {
    const rectOf = (node: Element | null) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    const read = () => {
      const style = getComputedStyle(element);
      const transform = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
      const natural = element.querySelector('[data-tour-natural-size="true"]');
      const naturalStyle = natural ? getComputedStyle(natural) : null;
      const naturalTransform = new DOMMatrixReadOnly(naturalStyle?.transform && naturalStyle.transform !== 'none' ? naturalStyle.transform : undefined);
      const inertAncestor = element.closest('[inert]');
      const active = <T extends Element>(selector: string) => [...element.querySelectorAll<T>(selector)]
        .find(node => !node.closest('[data-dialog-exiting="true"]')) ?? null;
      const viewport = active<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const exits = [element, ...element.querySelectorAll('[data-dialog-exiting="true"]')]
        .filter(node => node.getAttribute('data-dialog-exiting') === 'true')
        .map(node => ({ inert: node.hasAttribute('inert'), hidden: node.getAttribute('aria-hidden'), text: !!node.textContent?.trim() }));
      return {
        time: performance.now(), attached: element.isConnected, state: element.getAttribute('data-state'),
        box: rectOf(element)!, header: rectOf(active('[data-slot="scrollable-dialog-header"]')),
        footer: rectOf(active('[data-slot="scrollable-dialog-footer"]')),
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scaleX: Math.hypot(transform.a, transform.b), scaleY: Math.hypot(transform.c, transform.d),
        natural: rectOf(natural), naturalScaleX: Math.hypot(naturalTransform.a, naturalTransform.b), naturalScaleY: Math.hypot(naturalTransform.c, naturalTransform.d),
        inertAncestor: inertAncestor ? { hidden: inertAncestor.getAttribute('aria-hidden'), text: !!inertAncestor.textContent?.trim() } : null,
        overflow: element.scrollWidth - element.clientWidth, overflowX: style.overflowX,
        scroller: viewport ? { ...rectOf(viewport)!, top: viewport.scrollTop, overflow: viewport.scrollWidth - viewport.clientWidth, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight } : null,
        title: element.querySelector('[data-slot="dialog-title"]')?.textContent ?? '',
        hasResult: !!element.querySelector('.studio-operation-result'),
        hasSettings: !!active('[data-step="settings"]'), hasText: !!element.textContent?.trim(),
        stageCount: element.querySelectorAll('.dialog-motion-stage').length, exits,
      };
    };
    const frames = [read()];
    let request = 0;
    const tick = () => { frames.push(read()); if (element.isConnected) request = requestAnimationFrame(tick); };
    request = requestAnimationFrame(tick);
    return { stop: () => { cancelAnimationFrame(request); frames.push(read()); return frames; } };
  });
}
type Frame = {
  time: number; attached: boolean; state: string | null;
  box: { x: number; y: number; width: number; height: number; right: number; bottom: number };
  header: Frame['box'] | null; footer: Frame['box'] | null;
  viewportWidth: number; viewportHeight: number; scaleX: number; scaleY: number;
  natural: Frame['box'] | null; naturalScaleX: number; naturalScaleY: number;
  inertAncestor: { hidden: string | null; text: boolean } | null;
  overflow: number; overflowX: string;
  scroller: (Frame['box'] & { top: number; overflow: number; scrollHeight: number; clientHeight: number }) | null;
  title: string; hasResult: boolean; hasSettings: boolean; hasText: boolean; stageCount: number;
  exits: { inert: boolean; hidden: string | null; text: boolean }[];
};

async function settle(dialog: Locator) {
  await uiExpect(dialog).toBeVisible();
  await dialog.evaluate(element => new Promise<void>((resolve, reject) => {
    const started = performance.now();
    let previous: number[] = [], stable = 0;
    const tick = () => {
      const nodes = [element, ...element.querySelectorAll('[data-slot="scrollable-dialog-header"], [data-slot="scrollable-dialog-footer"], [data-slot="scroll-area-viewport"]')];
      const values = nodes.filter(node => !node.closest('[data-dialog-exiting="true"]')).flatMap(node => {
        const rect = node.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
      });
      stable = previous.length === values.length && values.every((value, i) => Math.abs(value - previous[i]) < 0.1) ? stable + 1 : 0;
      previous = values;
      if (stable >= 8 && performance.now() - started > 450) { resolve(); return; }
      if (performance.now() - started > 5000) { reject(new Error('Animated dialog did not settle')); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

function assertFrames(frames: Frame[]) {
  expect(frames.length).toBeGreaterThan(3);
  for (const frame of frames.filter(item => item.attached)) {
    // Translation for centering/entry is allowed; text must never be stretched.
    expect(frame.scaleX).toBeCloseTo(1, 3); expect(frame.scaleY).toBeCloseTo(1, 3);
    expect(frame.hasText).toBe(true);
    if (frame.overflow > 1) expect(['hidden', 'clip']).toContain(frame.overflowX);
    for (const exit of frame.exits) {
      expect(exit.inert).toBe(true); expect(exit.hidden).toBe('true'); expect(exit.text).toBe(true);
    }
  }
}

function assertInterpolated(frames: Frame[], dimension: 'width' | 'height') {
  const connected = frames.filter(frame => frame.attached);
  const from = connected[0].box[dimension], to = connected.at(-1)!.box[dimension];
  expect(Math.abs(to - from), `The fixture must change ${dimension}`).toBeGreaterThan(15);
  const low = Math.min(from, to), high = Math.max(from, to);
  const intermediates = connected.filter(frame => frame.box[dimension] > low + 1 && frame.box[dimension] < high - 1);
  expect(intermediates.length, `${dimension} must interpolate over several requestAnimationFrame paints`).toBeGreaterThanOrEqual(2);
  expect(new Set(intermediates.map(frame => frame.box[dimension].toFixed(1))).size).toBeGreaterThanOrEqual(2);
}

describe.runIf(process.env.FUSIONKIT_DIALOG_MOTION_E2E === '1')('measured dialog motion in native Electron', () => {
  it('interpolates export sizes and editor content, keeps drafts, fixed chrome and readable exit receipts', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-dialog-motion-'));
    const names = ['01-弹窗动画与原文导出验证.srt', '02-第二份真实字幕.srt'];
    const source = '1\n00:00:01,000 --> 00:00:02,000\nA real source subtitle.\n\n2\n00:00:03,000 --> 00:00:04,000\nThe second source line.\n';
    const files = names.map(name => path.join(root, name));
    const fixture = knowledgeFixture(), term = fixture.entries.find(entry => entry.kind === 'term')!;
    const knowledgeFile = path.join(root, 'motion-materials.fktk.json');
    await Promise.all([...files.map(file => writeFile(file, source)), writeFile(knowledgeFile, JSON.stringify(fixture))]);
    let app: ElectronApplication | undefined;
    const errors: string[] = [], evidence: { name: string; frames: Frame[] }[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const nativeWindow = await app.browserWindow(page);
      await nativeWindow.evaluate(win => win.setSize(1280, 1000));
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload();
      const ready = async () => {
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      };
      const dialog = () => page.locator(`${dialogSelector}[data-state="open"]`);
      const trace = async (name: string, action: () => Promise<unknown>, closing = false) => {
        await settle(dialog());
        const sampler = await startFrames(dialog());
        let recorded = false;
        try {
          await action();
          if (closing) await uiExpect(page.locator(dialogSelector)).toHaveCount(0); else await settle(dialog());
          const frames = await sampler.evaluate(probe => probe.stop());
          evidence.push({ name, frames }); recorded = true; assertFrames(frames);
          return frames;
        } finally {
          const frames = await sampler.evaluate(probe => probe.stop());
          if (!recorded) evidence.push({ name: `${name}-interrupted`, frames });
          await sampler.dispose();
        }
      };
      const capture = async (name: string) => {
        await settle(dialog());
        const sampler = await startFrames(dialog());
        const frames = await sampler.evaluate(probe => probe.stop()); await sampler.dispose();
        const frame = frames.at(-1)!;
        expect(frame.box.x).toBeGreaterThanOrEqual(0); expect(frame.box.y).toBeGreaterThanOrEqual(0);
        expect(frame.box.right).toBeLessThanOrEqual(frame.viewportWidth + 1); expect(frame.box.bottom).toBeLessThanOrEqual(frame.viewportHeight + 1);
        expect(frame.overflow).toBeLessThanOrEqual(1);
        expect(frame.header).not.toBeNull(); expect(frame.footer).not.toBeNull();
        expect(frame.header!.y).toBeGreaterThanOrEqual(frame.box.y - 1);
        expect(frame.footer!.bottom).toBeLessThanOrEqual(frame.box.bottom + 1);
        if (frame.scroller) {
          expect(frame.scroller.overflow).toBeLessThanOrEqual(1);
          expect(frame.scroller.y).toBeGreaterThanOrEqual(frame.header!.bottom - 1);
          expect(frame.scroller.bottom).toBeLessThanOrEqual(frame.footer!.y + 1);
        }
        evidence.push({ name, frames });
        await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
        return frame;
      };
      await page.getByTestId('subtitle-studio').waitFor(); await ready();
      await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toBeVisible();
      await dialog().getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(page.locator(dialogSelector)).toHaveCount(0);
      await page.locator('.studio-document').filter({ hasText: names[0] }).click();
      const openExport = async () => {
        await page.getByRole('button', { name: '下载', exact: true }).click();
        await page.getByRole('menuitem', { name: '导出字幕', exact: true }).click();
        await uiExpect(dialog()).toHaveCount(1); await settle(dialog());
      };
      await openExport();
      for (let cycle = 0; cycle < 3; cycle++) {
        const grow = await trace(`export-advanced-grow-${cycle}`, () => dialog().getByTestId('studio-export-advanced').click());
        assertInterpolated(grow, 'height');
        const shrink = await trace(`export-advanced-shrink-${cycle}`, () => dialog().getByTestId('studio-export-advanced').click());
        assertInterpolated(shrink, 'height');
      }
      await trace('export-advanced-interrupted', async () => {
        await dialog().getByTestId('studio-export-advanced').click();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        // Reverse while the parent is moving; locator actionability would wait for it to settle.
        await dialog().getByTestId('studio-export-advanced').evaluate(button => (button as HTMLButtonElement).click());
      });
      await uiExpect(dialog().getByTestId('studio-export-advanced')).toHaveAttribute('aria-expanded', 'false');
      await capture('01-export-settings-light');
      const review = await trace('export-settings-to-review', () => dialog().getByRole('button', { name: '检查导出', exact: true }).click());
      assertInterpolated(review, 'height');
      expect(review.some(frame => frame.exits.length > 0)).toBe(true);
      const details = dialog().getByTestId('studio-export-review-details').locator('[data-slot="accordion-trigger"]').first();
      await trace('export-review-details-grow', () => details.click());
      const preview = dialog().locator('.studio-export-preview').first();
      await trace('export-preview-grow', () => preview.locator('[data-slot="accordion-trigger"]').click());
      await uiExpect(preview.locator('pre')).toContainText('A real source subtitle.');
      await trace('export-preview-shrink', () => preview.locator('[data-slot="accordion-trigger"]').click());
      await trace('export-review-details-shrink', () => details.click());
      const result = await trace('export-review-to-result', () => dialog().getByRole('button', { name: '确认并导出 1 份', exact: true }).click());
      assertInterpolated(result, 'width'); assertInterpolated(result, 'height');
      await uiExpect(page.getByTestId('studio-export-result')).toContainText('已保存 1 份字幕文件');
      await capture('02-export-result-light');
      const close = await trace('export-result-close', () => dialog().getByRole('button', { name: '完成', exact: true }).click(), true);
      const closed = close.filter(frame => frame.attached && frame.state === 'closed');
      expect(closed.length).toBeGreaterThan(0);
      for (const frame of closed) {
        expect(frame.box.width).toBeCloseTo(close[0].box.width, 1);
        expect(frame.box.height).toBeCloseTo(close[0].box.height, 1);
        expect(frame.hasResult).toBe(true); expect(frame.hasSettings).toBe(false);
        expect(frame.title).toBe(close[0].title); expect(frame.exits.length).toBeGreaterThan(0);
      }
      expect(await readFile(files[0].replace(/\.srt$/, ' (1).srt'), 'utf8')).toContain('A real source subtitle.');
      for (const file of files) expect(await readFile(file, 'utf8')).toBe(source);

      // A smaller dark window must keep the same fixed chrome, with only the body scrolling.
      await nativeWindow.evaluate(win => win.setSize(786, 540));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await openExport();
      await dialog().getByTestId('studio-export-advanced').click();
      const narrow = await capture('03-export-settings-narrow-dark');
      expect(narrow.scroller!.scrollHeight).toBeGreaterThan(narrow.scroller!.clientHeight);
      await dialog().locator('[data-slot="scroll-area-viewport"]').first().evaluate(element => { element.scrollTop = element.scrollHeight; });
      const scrolled = await capture('04-export-scrolled-narrow-dark');
      expect(scrolled.scroller!.top).toBeGreaterThan(0);
      expect(scrolled.header!.y).toBeCloseTo(narrow.header!.y, 1); expect(scrolled.footer!.y).toBeCloseTo(narrow.footer!.y, 1);
      await dialog().getByRole('button', { name: '取消', exact: true }).click();
      await uiExpect(page.locator(dialogSelector)).toHaveCount(0);

      // The reduced-motion preference is set before reopening and reload, including Motion's hook initialization.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await nativeWindow.evaluate(win => win.setSize(1280, 1000));
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await ready();
      await page.locator('.studio-document').filter({ hasText: names[0] }).click();
      await openExport();
      const reduced = await trace('export-advanced-reduced-motion', () => dialog().getByTestId('studio-export-advanced').click());
      const low = Math.min(reduced[0].box.height, reduced.at(-1)!.box.height), high = Math.max(reduced[0].box.height, reduced.at(-1)!.box.height);
      expect(high - low).toBeGreaterThan(15);
      expect(reduced.filter(frame => frame.box.height > low + 1 && frame.box.height < high - 1)).toHaveLength(0);
      await dialog().getByRole('button', { name: '取消', exact: true }).click();
      await uiExpect(page.locator(dialogSelector)).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => { location.hash = '/tools/translation-knowledge'; });
      await page.reload(); await page.getByTestId('knowledge-import').waitFor(); await ready();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, knowledgeFile);
      await page.getByTestId('knowledge-import').click();
      await page.getByRole('button', { name: knowledgeLabels.actions.confirm_import, exact: true }).click();
      await uiExpect(page.locator(dialogSelector)).toHaveCount(0);
      const before = await page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });
      await page.getByTestId('knowledge-all').click();
      await page.getByTestId('knowledge-views').getByRole('tab', { name: knowledgeLabels.workspace.terms, exact: true }).click();
      await page.getByTestId(`knowledge-entry-details-${term.id}`).click();
      await page.getByTestId('knowledge-entry-edit').click();
      await uiExpect(page.getByTestId('knowledge-entry-editor')).toBeVisible();
      const rawAliases = 'checkpoint\n\n  save point  \n';
      const aliases = page.getByTestId('knowledge-entry-wording').getByLabel(knowledgeLabels.fields.aliases_lines, { exact: true });
      await aliases.fill(rawAliases);
      for (let cycle = 0; cycle < 2; cycle++) {
        const language = await trace(`knowledge-language-${cycle}`, () => dialog().getByRole('tab', { name: knowledgeLabels.record.tab_language, exact: true }).click());
        assertInterpolated(language, 'height');
        expect(language.some(frame => frame.exits.length > 0)).toBe(true);
        await trace(`knowledge-wording-${cycle}`, () => dialog().getByRole('tab', { name: knowledgeLabels.record.tab_wording, exact: true }).click());
        await uiExpect(aliases).toHaveValue(rawAliases);
      }
      await capture('05-knowledge-editor-draft-light');
      await nativeWindow.evaluate(win => win.setSize(786, 540));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await dialog().getByRole('tab', { name: knowledgeLabels.record.tab_metadata, exact: true }).click();
      const note = page.getByTestId('knowledge-entry-metadata').locator('textarea');
      await note.evaluate(element => { element.style.height = '800px'; });
      const knowledgeNarrow = await capture('06-knowledge-editor-narrow-dark');
      await dialog().locator('[data-slot="scroll-area-viewport"]').first().evaluate(element => { element.scrollTop = element.scrollHeight; });
      const knowledgeScrolled = await capture('07-knowledge-editor-scrolled-dark');
      expect(knowledgeScrolled.scroller!.top).toBeGreaterThan(0);
      expect(knowledgeScrolled.footer!.y).toBeCloseTo(knowledgeNarrow.footer!.y, 1);
      expect(knowledgeScrolled.header!.y).toBeCloseTo(knowledgeNarrow.header!.y, 1);
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.locator(dialogSelector)).toHaveCount(0);
      const after = await page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });
      expect(after).toEqual(before);

      // The real guide uses a separate popover shell, but must obey the same measured-size contract.
      await nativeWindow.evaluate(win => win.setSize(1280, 1000));
      await page.getByTestId('knowledge-tour-trigger').click();
      const tour = page.locator('[role="dialog"][data-tour-measured-size="true"]');
      await settle(tour);
      const tourTrace = async (name: string, action: () => Promise<unknown>, closing = false) => {
        await settle(tour);
        const sampler = await startFrames(tour);
        let recorded = false;
        try {
          await action();
          if (closing) await uiExpect(tour).toHaveCount(0); else await settle(tour);
          const frames = await sampler.evaluate(probe => probe.stop());
          evidence.push({ name, frames }); recorded = true;
          expect(frames.length).toBeGreaterThan(3);
          for (const frame of frames.filter(item => item.attached)) {
            expect(frame.hasText).toBe(true); expect(frame.natural).not.toBeNull();
            expect(frame.scaleX).toBeCloseTo(1, 3); expect(frame.scaleY).toBeCloseTo(1, 3);
            expect(frame.naturalScaleX).toBeCloseTo(1, 3); expect(frame.naturalScaleY).toBeCloseTo(1, 3);
            expect(frame.box.width).toBeCloseTo(360, 0);
            for (const exit of frame.exits) {
              expect(exit.inert).toBe(true); expect(exit.hidden).toBe('true'); expect(exit.text).toBe(true);
            }
            if (frame.inertAncestor) {
              expect(frame.inertAncestor.hidden).toBe('true'); expect(frame.inertAncestor.text).toBe(true);
            }
          }
          return frames;
        } finally {
          const frames = await sampler.evaluate(probe => probe.stop());
          if (!recorded) evidence.push({ name: `${name}-interrupted`, frames });
          await sampler.dispose();
        }
      };
      await uiExpect(tour.getByRole('heading', { name: knowledgeLabels.tour.collection_title, exact: true })).toBeVisible();
      const tourGrow = await tourTrace('knowledge-tour-materials-grow', () => page.getByTestId('knowledge-tour-next').click());
      assertInterpolated(tourGrow, 'height');
      expect(tourGrow.some(frame => frame.exits.length > 0)).toBe(true);
      const tourShrink = await tourTrace('knowledge-tour-collection-shrink', () => page.getByTestId('knowledge-tour-previous').click());
      assertInterpolated(tourShrink, 'height');
      for (const name of ['materials', 'review', 'plans', 'studio'] as const) {
        await tourTrace(`knowledge-tour-step-${name}`, () => page.getByTestId('knowledge-tour-next').click());
        await uiExpect(tour.getByRole('heading', { name: knowledgeLabels.tour[`${name}_title`], exact: true })).toBeVisible();
      }
      await page.screenshot({ path: path.join(artifacts, '08-knowledge-tour-dark.png') });
      const tourClosed = await tourTrace('knowledge-tour-finish-close', () => page.getByTestId('knowledge-tour-next').click(), true);
      expect(tourClosed.some(frame => frame.attached && frame.inertAncestor)).toBe(true);
      await uiExpect(page.locator('body')).not.toHaveCSS('pointer-events', 'none');
      await uiExpect(page.locator('html')).not.toHaveCSS('pointer-events', 'none');
      await uiExpect(page.locator('body')).not.toHaveAttribute('inert');
      await page.getByTestId('knowledge-tour-trigger').click();
      await uiExpect(tour).toBeVisible();
      await tourTrace('knowledge-tour-skip-close', () => page.getByTestId('knowledge-tour-skip').click(), true);
      await uiExpect(page.locator('body')).not.toHaveCSS('pointer-events', 'none');
      await uiExpect(page.getByTestId('knowledge-tour-trigger')).toBeEnabled();
      expect(errors).toEqual([]);
    } catch (error) {
      let state: unknown = null;
      if (app) {
        const page = await app.firstWindow().catch(() => null);
        state = await page?.evaluate(() => ({
          url: location.href,
          activeElement: document.activeElement?.outerHTML.slice(0, 2000),
          bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
          htmlPointerEvents: getComputedStyle(document.documentElement).pointerEvents,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          accordions: [...document.querySelectorAll<HTMLElement>('[data-slot="accordion-content"]')].map(element => {
            const style = getComputedStyle(element);
            return { state: element.getAttribute('data-state'), inlineStyle: element.getAttribute('style'),
              transition: style.transition, animation: style.animation, height: style.height,
              display: style.display, hidden: element.hidden, outerHTML: element.outerHTML.slice(0, 3000) };
          }),
          dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map(dialog => {
            const style = getComputedStyle(dialog), rect = dialog.getBoundingClientRect();
            return {
              outerHTML: dialog.outerHTML.slice(0, 20000),
              state: dialog.getAttribute('data-state'), exiting: dialog.getAttribute('data-dialog-exiting'),
              inert: dialog.inert, ariaHidden: dialog.getAttribute('aria-hidden'),
              opacity: style.opacity, transform: style.transform, pointerEvents: style.pointerEvents,
              display: style.display, visibility: style.visibility,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              animations: dialog.getAnimations({ subtree: true }).map(animation => ({
                state: animation.playState, currentTime: animation.currentTime,
                timing: animation.effect?.getComputedTiming(),
              })),
            };
          }),
        })).catch(failure => ({ inspectionError: String(failure) }));
        await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => undefined);
      }
      await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({
        failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        pageErrors: errors, state,
      }, null, 2));
      throw error;
    } finally {
      await writeFile(path.join(artifacts, 'frames.json'), JSON.stringify(evidence, null, 2));
      try {
        if (app) {
          const child = app.process(); await app.close();
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        }
      } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  }, 180000);
});
