import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator } from '@playwright/test';
import { knowledgeFixture } from './fixtures';
import labels from '../../src/locales/zh/knowledge.json';

const artifacts = path.resolve('test-results/knowledge-entry-scope-motion');
const dialogSelector = '[role="dialog"][data-animated-dialog="true"][data-state="open"]';
const panelKeys = ['wording', 'language', 'scope', 'metadata'] as const;
type PanelKey = typeof panelKeys[number];
type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Frame = {
  time: number; flowHeight: number; naturalHeight: number; bodyHeight: number; shell: Box; shellMaxHeight: number;
  scaleX: number; scaleY: number; viewportWidth: number; viewportHeight: number; overflow: number;
  header: Box; footer: Box; scroller: Box & { top: number; scrollHeight: number; clientHeight: number; overflow: number };
  panels: { key: string; active: boolean; inert: boolean; hidden: boolean; opacity: number; height: number; scaleX: number; scaleY: number }[];
  nested: { height: number; naturalHeight: number; moving: boolean; rendered: boolean }[];
};

/** Sample the actual tab flow as well as its capped shell, in the same paint.
 * A smooth shell alone previously hid the scope panel's near-instant height jump.
 */
async function sampleFrames(dialog: Locator) {
  return dialog.evaluateHandle(element => {
    const panels = element.querySelector('.knowledge-entry-settings-panels');
    const flow = panels?.closest('[data-flow-motion]');
    const body = element.querySelector('[data-dialog-body-measure]');
    const header = element.querySelector('[data-slot="scrollable-dialog-header"]');
    const footer = element.querySelector('[data-slot="scrollable-dialog-footer"]');
    const scroller = element.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!panels || !flow || !body || !header || !footer || !scroller) throw new Error('Missing real editor flow or scrollable dialog geometry');
    const boxOf = (node: Element) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const scaleOf = (node: Element) => {
      const transform = getComputedStyle(node).transform;
      const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
      return { scaleX: Math.hypot(matrix.a, matrix.b), scaleY: Math.hypot(matrix.c, matrix.d) };
    };
    const read = () => ({
      time: performance.now(), flowHeight: boxOf(flow).height, naturalHeight: boxOf(panels).height,
      bodyHeight: boxOf(body).height, shell: boxOf(element), shellMaxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
      ...scaleOf(element), viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: element.scrollWidth - element.clientWidth,
      header: boxOf(header), footer: boxOf(footer),
      scroller: { ...boxOf(scroller), top: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, overflow: scroller.scrollWidth - scroller.clientWidth },
      panels: [...panels.querySelectorAll<HTMLElement>('.knowledge-entry-settings-panel')].map(panel => ({
        key: panel.dataset.testid!.replace('knowledge-entry-', ''), active: panel.getAttribute('aria-hidden') === 'false',
        inert: panel.hasAttribute('inert'), hidden: getComputedStyle(panel).display === 'none',
        opacity: Number(getComputedStyle(panel).opacity), height: boxOf(panel).height, ...scaleOf(panel),
      })),
      nested: [...panels.querySelectorAll('[data-flow-motion]')].map(region => ({
        height: boxOf(region).height, naturalHeight: region.querySelector('[data-flow-motion-inner]')?.getBoundingClientRect().height ?? 0,
        moving: region.getAttribute('data-flow-animating') === 'true', rendered: region.getClientRects().length > 0,
      })),
    });
    const frames = [read()];
    let request = 0;
    const tick = () => { frames.push(read()); request = requestAnimationFrame(tick); };
    request = requestAnimationFrame(tick);
    return { stop: () => { cancelAnimationFrame(request); frames.push(read()); return frames; } };
  });
}

async function settled(dialog: Locator) {
  await uiExpect(dialog).toBeVisible();
  await dialog.evaluate(element => new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const intervals: number[] = [];
    let previousTime = started;
    let previous: number[] = [], stable = 0;
    const tick = () => {
      const now = performance.now(); intervals.push(now - previousTime); previousTime = now;
      const values = [element, ...element.querySelectorAll('[data-flow-motion], [data-flow-motion-inner], .knowledge-entry-settings-panel, [data-dialog-body-measure]')]
        .flatMap(node => { const box = node.getBoundingClientRect(); return [box.height, box.y, Number(getComputedStyle(node).opacity)]; });
      stable = previous.length === values.length && values.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 0;
      previous = values;
      if (stable >= 10 && performance.now() - started > 500) return resolve();
      if (performance.now() - started > 6000) return reject(new Error(`Entry scope motion did not settle: ${JSON.stringify({ visibility: document.visibilityState, focused: document.hasFocus(), stable, intervals })}`));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

function ordinarySteps(frames: Frame[], value: (frame: Frame) => number) {
  return frames.slice(1).flatMap((frame, index) => {
    const before = frames[index], elapsed = frame.time - before.time;
    return elapsed > 0 && elapsed <= 40 ? [Math.abs(value(frame) - value(before))] : [];
  });
}

function assertContinuousHeight(frames: Frame[], value: (frame: Frame) => number, name: string, span?: number) {
  const from = value(frames[0]), to = value(frames.at(-1)!);
  const distance = span ?? Math.abs(to - from);
  expect(distance, `${name}: the fixture must produce a substantial height change`).toBeGreaterThan(20);
  const steps = ordinarySteps(frames, value);
  expect(steps.length).toBeGreaterThan(5);
  expect(Math.max(...steps), `${name}: no ordinary frame may perform most of the full tab height change`)
    .toBeLessThanOrEqual(Math.max(3, distance * 0.42));
  if (span === undefined) {
    const low = Math.min(from, to), high = Math.max(from, to);
    const intermediate = frames.map(value).filter(height => height > low + 0.6 && height < high - 0.6);
    expect(new Set(intermediate.map(height => height.toFixed(1))).size, `${name}: multiple actual flow heights must be painted`).toBeGreaterThanOrEqual(3);
  }
}

function assertReadable(frames: Frame[], selected: PanelKey) {
  expect(frames.length).toBeGreaterThan(8);
  for (const frame of frames) {
    expect(frame.scaleX).toBeCloseTo(1, 3); expect(frame.scaleY).toBeCloseTo(1, 3);
    expect(frame.flowHeight).toBeGreaterThan(0);
    for (const panel of frame.panels) {
      expect(panel.scaleX).toBeCloseTo(1, 3); expect(panel.scaleY).toBeCloseTo(1, 3);
      if (!panel.active) expect(panel.inert).toBe(true);
    }
  }
  const last = frames.at(-1)!;
  expect(last.panels.filter(panel => panel.active).map(panel => panel.key)).toEqual([selected]);
  expect(last.panels.find(panel => panel.key === selected)!.opacity).toBeCloseTo(1, 3);
  expect(last.flowHeight).toBeCloseTo(last.naturalHeight, 0);
  expect(last.nested.filter(region => region.rendered && region.moving), 'Settled live nested content must release its movement marker').toEqual([]);
}

function assertSwap(frames: Frame[], from: PanelKey, to: PanelKey) {
  assertReadable(frames, to);
  assertContinuousHeight(frames, frame => frame.flowHeight, `${from} → ${to} flow`);
  for (const key of [from, to]) {
    const intermediate = frames.map(frame => frame.panels.find(panel => panel.key === key)!.opacity).filter(opacity => opacity > 0.02 && opacity < 0.98);
    expect(new Set(intermediate.map(opacity => opacity.toFixed(3))).size, `${key}: actual panel content must fade over several paints`).toBeGreaterThanOrEqual(2);
  }
  if (Math.abs(frames[0].shell.height - frames.at(-1)!.shell.height) > 20) {
    assertContinuousHeight(frames, frame => frame.shell.height, `${from} → ${to} shell`);
  }
}

function assertChrome(frame: Frame) {
  expect(frame.shell.x).toBeGreaterThanOrEqual(0); expect(frame.shell.y).toBeGreaterThanOrEqual(0);
  expect(frame.shell.right).toBeLessThanOrEqual(frame.viewportWidth + 1); expect(frame.shell.bottom).toBeLessThanOrEqual(frame.viewportHeight + 1);
  expect(frame.overflow).toBeLessThanOrEqual(1); expect(frame.scroller.overflow).toBeLessThanOrEqual(1);
  expect(frame.header.y).toBeGreaterThanOrEqual(frame.shell.y - 1);
  expect(frame.footer.bottom).toBeLessThanOrEqual(frame.shell.bottom + 1);
  expect(frame.scroller.y).toBeGreaterThanOrEqual(frame.header.bottom - 1);
  expect(frame.scroller.bottom).toBeLessThanOrEqual(frame.footer.y + 1);
}

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('entry scope tab flow in native Electron', () => {
  it('keeps scope swaps continuous on first/repeated visits and reversal, with scrollable compact drafts and reduced motion', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-entry-scope-motion-'));
    const fixture = knowledgeFixture();
    const term = fixture.entries.find(entry => entry.kind === 'term' && entry.scope.requiredSubjects.length > 0 && entry.scope.condition.mode !== 'none')!;
    expect(term, 'The regression requires both a subject role and a nested condition field').toBeDefined();
    const materials = path.join(root, 'scope-motion.fktk.json');
    await writeFile(materials, JSON.stringify(fixture));
    let app: ElectronApplication | undefined;
    const errors: string[] = [], evidence: { name: string; frames: Frame[] }[] = [], environment: unknown[] = [];
    try {
      const launchEnv = Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[0] !== 'ELECTRON_RUN_AS_NODE' && typeof entry[1] === 'string'));
      app = await electron.launch({ args: ['.', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(),
        env: { ...launchEnv, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const nativeWindow = await app.browserWindow(page);
      await nativeWindow.evaluate(win => { win.webContents.setBackgroundThrottling(false); win.setSize(1280, 1100); });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/translation-knowledge';
      });
      await page.reload();
      const ready = async () => {
        await page.getByTestId('knowledge-import').waitFor();
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
        await nativeWindow.evaluate(win => { win.show(); win.focus(); });
        await page.bringToFront();
        environment.push({
          native: await nativeWindow.evaluate(win => ({ backgroundThrottling: win.webContents.getBackgroundThrottling(), visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds() })),
          renderer: await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() })),
        });
      };
      const dialog = () => page.locator(dialogSelector);
      const tab = (key: PanelKey) => dialog().getByRole('tab', { name: labels.record[`tab_${key}`], exact: true });
      const switchTo = async (key: PanelKey) => {
        await tab(key).click();
        await uiExpect(tab(key)).toHaveAttribute('aria-selected', 'true');
      };
      const trace = async (name: string, action: () => Promise<unknown>) => {
        await settled(dialog());
        const sampler = await sampleFrames(dialog());
        let recorded = false;
        try {
          await action(); await settled(dialog());
          const frames = await sampler.evaluate(probe => probe.stop());
          evidence.push({ name, frames }); recorded = true;
          return frames;
        } finally {
          if (!recorded) evidence.push({ name: `${name}-interrupted`, frames: await sampler.evaluate(probe => probe.stop()) });
          await sampler.dispose();
        }
      };
      const capture = async (name: string) => {
        await settled(dialog());
        const sampler = await sampleFrames(dialog());
        const frames = await sampler.evaluate(probe => probe.stop()); await sampler.dispose();
        evidence.push({ name, frames }); assertChrome(frames.at(-1)!);
        await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
        return frames.at(-1)!;
      };
      const openDetails = async () => {
        await page.getByTestId('knowledge-all').click();
        await page.getByTestId('knowledge-views').getByRole('tab', { name: labels.workspace.terms, exact: true }).click();
        await page.getByTestId(`knowledge-entry-details-${term.id}`).click(); await settled(dialog());
      };
      const openEditor = async () => {
        await dialog().getByTestId('knowledge-entry-edit').click();
        await uiExpect(page.getByTestId('knowledge-entry-editor')).toBeVisible(); await settled(dialog());
      };
      await ready();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, materials);
      await page.getByTestId('knowledge-import').click();
      await page.getByRole('button', { name: labels.actions.confirm_import, exact: true }).click();
      await uiExpect(page.locator('[role="dialog"]')).toHaveCount(0);
      await openDetails();

      for (const other of ['language', 'wording', 'metadata'] as const) {
        // Each editor starts with scope never visited, preserving the hidden
        // nested-region measurement lifecycle responsible for the regression.
        await openEditor();
        if (other !== 'wording') { await switchTo(other); await settled(dialog()); }
        let scopeHeight = 0;
        for (const visit of ['first', 'repeat']) {
          const enter = await trace(`${other}-to-scope-${visit}`, () => switchTo('scope'));
          assertSwap(enter, other, 'scope'); scopeHeight = enter.at(-1)!.flowHeight;
          expect(enter.at(-1)!.nested.filter(region => region.rendered && region.height > 20).length).toBeGreaterThanOrEqual(2);
          if (other === 'language' && visit === 'first') await capture('01-scope-light');
          const leave = await trace(`scope-to-${other}-${visit}`, () => switchTo(other));
          assertSwap(leave, 'scope', other);
        }
        const before = await dialog().locator('.knowledge-entry-settings-panels').evaluate(element => element.closest('[data-flow-motion]')!.getBoundingClientRect().height);
        const reverseTab = await tab(other).elementHandle();
        if (!reverseTab) throw new Error('Missing reverse tab');
        try {
          const reversal = await trace(`${other}-scope-rapid-reversal`, async () => {
            await switchTo('scope');
            await dialog().evaluate((element, { before, scopeHeight, reverseTab }) => new Promise<void>((resolve, reject) => {
              const started = performance.now();
              const tick = () => {
                const height = element.querySelector('.knowledge-entry-settings-panels')!.closest('[data-flow-motion]')!.getBoundingClientRect().height;
                const progress = (height - before) / (scopeHeight - before);
                if (progress > 0.1 && progress < 0.85) {
                  // Radix Tabs activates on mouse-down; a DOM click alone is
                  // insufficient, while locator actionability would wait for
                  // the moving tab bar and miss the intended interruption.
                  reverseTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: false }));
                  resolve(); return;
                }
                if (performance.now() - started > 3000) { reject(new Error('Scope never painted an interruptible intermediate height')); return; }
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }), { before, scopeHeight, reverseTab });
          });
          assertReadable(reversal, other);
          assertContinuousHeight(reversal, frame => frame.flowHeight, `${other} reversal`, Math.abs(scopeHeight - before));
          expect(Math.max(...reversal.map(frame => Math.abs(frame.flowHeight - before)))).toBeGreaterThan(Math.abs(scopeHeight - before) * 0.1);
          expect(reversal.at(-1)!.flowHeight).toBeCloseTo(before, 0);
        } finally { await reverseTab.dispose(); }
        await dialog().getByTestId('knowledge-record-close').click();
        await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible(); await settled(dialog());
      }

      await openEditor(); await switchTo('scope'); await settled(dialog());
      const requirements = dialog().locator('.knowledge-scope-requirements');
      const requiredSubject = fixture.subjects.find(subject => subject.id === term.scope.requiredSubjects[0].subjectId)!;
      const requiredCheckbox = requirements.getByRole('checkbox', { name: requiredSubject.name });
      await uiExpect(requiredCheckbox).toBeChecked();
      const role = requirements.getByRole('combobox', { name: labels.fields.subject_role, exact: true }).first();
      await role.click(); await page.getByRole('option', { name: labels.role.mentioned, exact: true }).click();
      await uiExpect(role).toContainText(labels.role.mentioned);
      await uiExpect(requiredCheckbox).toBeChecked();

      const optionalSubject = fixture.subjects.find(subject => !term.scope.requiredSubjects.some(required => required.subjectId === subject.id))!;
      const optionalCheckbox = requirements.getByRole('checkbox', { name: optionalSubject.name });
      await uiExpect(optionalCheckbox).not.toBeChecked();
      const languageTab = await tab('language').elementHandle();
      if (!languageTab) throw new Error('Missing language tab for the hidden-completion regression');
      try {
        const hiddenCompletion = await trace('scope-role-expansion-hidden-before-completion', async () => {
          await optionalCheckbox.check();
          await requirements.evaluate((element, languageTab) => new Promise<void>((resolve, reject) => {
            const started = performance.now();
            const tick = () => {
              const growing = [...element.querySelectorAll('[data-flow-animating="true"]')].some(region => {
                const height = region.getBoundingClientRect().height;
                const natural = region.querySelector('[data-flow-motion-inner]')?.getBoundingClientRect().height ?? 0;
                return height > 0.5 && height < natural - 1;
              });
              if (growing) {
                languageTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: false }));
                resolve(); return;
              }
              if (performance.now() - started > 3000) { reject(new Error('The new subject role never painted an intermediate expansion')); return; }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }), languageTab);
        });
        assertSwap(hiddenCompletion, 'scope', 'language');
        const hidden = hiddenCompletion.at(-1)!;
        expect(hidden.panels.find(panel => panel.key === 'scope')!.hidden).toBe(true);
        expect(hidden.nested.filter(region => region.moving), 'Hidden nested regions must release movement markers when their animation completes').toEqual([]);
        const restored = await trace('scope-return-after-hidden-role-completion', () => switchTo('scope'));
        assertSwap(restored, 'language', 'scope');
        await uiExpect(optionalCheckbox).toBeChecked();
        await uiExpect(requiredCheckbox).toBeChecked();
        await uiExpect(role).toContainText(labels.role.mentioned);
      } finally { await languageTab.dispose(); }
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible(); await settled(dialog());

      await openEditor(); await switchTo('scope'); await settled(dialog());
      const longCondition = '该字幕片段必须明确讨论游戏保存进度机制，未确认的解释应保留为草稿，不能自动应用到其他语境。'.repeat(20);
      const conditionField = dialog().getByRole('textbox', { name: labels.fields.condition_text, exact: true });
      await conditionField.fill(longCondition); await settled(dialog());
      const wideConditionHeight = (await conditionField.boundingBox())!.height;
      await switchTo('language'); await settled(dialog());
      // The supported 786px minimum is wider than this dialog's 640px cap.
      // Temporarily lower only this isolated test window's minimum to exercise
      // real text reflow while scope is display:none, then restore it below.
      await nativeWindow.evaluate(win => { win.setMinimumSize(560, 540); win.setSize(560, 720); });
      await settled(dialog());
      const reflow = await trace('hidden-long-condition-reflows-on-scope-return', () => switchTo('scope'));
      assertSwap(reflow, 'language', 'scope');
      await uiExpect(conditionField).toHaveValue(longCondition);
      expect((await conditionField.boundingBox())!.height - wideConditionHeight, 'The hidden-width regression must actually reflow the nested textarea').toBeGreaterThan(20);
      const reflowExit = await trace('reflowed-scope-to-language', () => switchTo('language'));
      assertSwap(reflowExit, 'scope', 'language');
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible(); await settled(dialog());
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.locator('[role="dialog"]')).toHaveCount(0);
      await nativeWindow.evaluate(win => { win.setMinimumSize(786, 540); win.setSize(786, 540); });
      await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await page.reload(); await ready(); await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await openDetails(); await openEditor();
      const senseDraft = 'A draft sense that survives all four tabs.';
      const sourceDraft = 'Unfinished source note\nwith a second line.';
      const conditionDraft = '仅用于本次回归检查的未保存条件。';
      await dialog().getByRole('textbox', { name: labels.fields.sense, exact: true }).fill(senseDraft);
      await switchTo('metadata'); await settled(dialog());
      await dialog().getByRole('textbox', { name: labels.fields.source_note, exact: true }).fill(sourceDraft);
      await switchTo('scope'); await settled(dialog());
      await dialog().getByRole('textbox', { name: labels.fields.condition_text, exact: true }).fill(conditionDraft);
      await dialog().locator('[data-slot="scroll-area-viewport"]').evaluate(element => new Promise<void>(resolve => {
        element.scrollTop = 0;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      const top = await capture('02-scope-dark-compact-top');
      expect(top.scroller.scrollHeight - top.scroller.clientHeight).toBeGreaterThan(100);
      await dialog().locator('[data-slot="scroll-area-viewport"]').evaluate(element => new Promise<void>(resolve => {
        element.scrollTop = element.scrollHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      const bottom = await capture('03-scope-dark-compact-bottom');
      expect(bottom.scroller.top).toBeGreaterThan(100);
      expect(bottom.footer.y).toBeCloseTo(top.footer.y, 0);
      const conditionBox = await dialog().getByRole('textbox', { name: labels.fields.condition_text, exact: true }).boundingBox();
      expect(conditionBox!.y + conditionBox!.height).toBeLessThanOrEqual(bottom.scroller.bottom + 1);
      for (const key of ['language', 'wording', 'metadata', 'scope'] as const) {
        await switchTo(key); await settled(dialog());
        if (key === 'wording') await uiExpect(dialog().getByRole('textbox', { name: labels.fields.sense, exact: true })).toHaveValue(senseDraft);
        if (key === 'metadata') await uiExpect(dialog().getByRole('textbox', { name: labels.fields.source_note, exact: true })).toHaveValue(sourceDraft);
        if (key === 'scope') await uiExpect(dialog().getByRole('textbox', { name: labels.fields.condition_text, exact: true })).toHaveValue(conditionDraft);
      }

      // Reduced motion checks final sizing after the preference is established;
      // it does not change the preference midway through an active transition.
      await page.emulateMedia({ reducedMotion: 'reduce' }); await settled(dialog());
      for (const key of ['language', 'scope', 'metadata', 'scope'] as const) {
        const frames = await trace(`reduced-to-${key}`, () => switchTo(key));
        assertReadable(frames, key); assertChrome(frames.at(-1)!);
      }
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      await dialog().getByTestId('knowledge-record-close').click();
      await uiExpect(page.locator('[role="dialog"]')).toHaveCount(0);
      await uiExpect(page.locator('body')).not.toHaveCSS('pointer-events', 'none');
      expect(errors).toEqual([]);
    } catch (error) {
      const page = await app?.firstWindow().catch(() => null);
      await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => undefined);
      const state = await page?.evaluate(() => ({ url: location.href, body: document.body.innerHTML.slice(-75000) })).catch(() => null);
      const runtime = await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({
        backgroundThrottling: win.webContents.getBackgroundThrottling(), visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds(),
      }))).catch(() => null);
      await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({
        message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null, errors, environment, runtime, state,
      }, null, 2));
      throw error;
    } finally {
      await writeFile(path.join(artifacts, 'frames.json'), JSON.stringify(evidence, null, 2));
      await writeFile(path.join(artifacts, 'environment.json'), JSON.stringify(environment, null, 2));
      try { if (app) { const child = app.process(); await app.close(); expect(child.exitCode !== null || child.signalCode !== null).toBe(true); } }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  }, 120000);
});
