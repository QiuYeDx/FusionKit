import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator } from '@playwright/test';
import labels from '../src/locales/zh/knowledge.json';

const artifacts = path.resolve('test-results/dialog-content-motion');
const dialogSelector = '[role="dialog"][data-animated-dialog="true"][data-state="open"]';

type Frame = {
  time: number; connected: boolean; expanded: string | null;
  height: number; opacity: number; innerHeight: number; siblingY: number;
  bodyHeight: number; shellHeight: number; shellMaxHeight: number;
  scaleX: number; scaleY: number; hidden: boolean; inert: boolean;
  rows: { id: string | null; y: number; scaleX: number; scaleY: number; opacity: number; inert: boolean }[];
};

/** Read the changing content and a real downstream sibling in the SAME paint.
 * Coordinates are relative to the body, so a centered dialog's own translation
 * cannot masquerade as smooth document flow. Keep the original content node
 * reference as well, so removing it before its exit finishes is observable.
 */
async function sampleFrames(disclosure: Locator, following: Locator, followingEdge: 'top' | 'bottom' = 'top', conditional = false) {
  const followingNode = await following.elementHandle();
  if (!followingNode) throw new Error('The regression fixture needs a real following element');
  try {
    return await disclosure.evaluateHandle((element, { sibling, followingEdge, conditional }) => {
      const content = element.matches('[data-slot="accordion-content"]') ? element : element.querySelector('[data-slot="accordion-content"]') ?? element;
      const originalFlow = content?.matches('[data-flow-motion]') ? content : content?.querySelector('[data-flow-motion]');
      const dialog = element.closest('[role="dialog"]');
      const body = element.closest('[data-dialog-body-measure]');
      if ((!conditional && !originalFlow?.querySelector('[data-flow-motion-inner]')) || !dialog || !body) throw new Error('Missing measured content motion contract in the real disclosure');
      const trigger = element.querySelector('[data-slot="accordion-trigger"]');
      const read = () => {
        const flow = conditional ? element.querySelector('[data-flow-motion]') : originalFlow;
        const inner = flow?.querySelector('[data-flow-motion-inner]');
        const fadingContent = conditional ? inner?.querySelector('.dialog-motion-stage') : inner;
        const innerStyle = fadingContent && getComputedStyle(fadingContent);
        const transform = new DOMMatrixReadOnly(!innerStyle || innerStyle.transform === 'none' ? undefined : innerStyle.transform);
        let opacity = fadingContent?.isConnected ? 1 : 0;
        for (let node: Element | null = fadingContent ?? null; node && node !== element.parentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        return {
          time: performance.now(), connected: !!flow?.isConnected, expanded: trigger?.getAttribute('aria-expanded') ?? null,
          height: flow?.getBoundingClientRect().height ?? 0, innerHeight: inner?.getBoundingClientRect().height ?? 0, opacity,
          siblingY: sibling.getBoundingClientRect()[followingEdge === 'bottom' ? 'bottom' : 'y'] - body.getBoundingClientRect().y,
          bodyHeight: body.getBoundingClientRect().height, shellHeight: dialog.getBoundingClientRect().height,
          shellMaxHeight: Number.parseFloat(getComputedStyle(dialog).maxHeight),
          scaleX: Math.hypot(transform.a, transform.b), scaleY: Math.hypot(transform.c, transform.d),
          hidden: !!inner?.closest('[aria-hidden="true"]'), inert: !!inner?.closest('[inert]'),
          rows: [...(flow?.querySelectorAll('[data-paste-row]') ?? [])].map(row => {
            const style = getComputedStyle(row), matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
            return { id: row.getAttribute('data-paste-row'), y: row.getBoundingClientRect().y - body.getBoundingClientRect().y,
              scaleX: Math.hypot(matrix.a, matrix.b), scaleY: Math.hypot(matrix.c, matrix.d), opacity: Number(style.opacity), inert: row.hasAttribute('inert') };
          }),
        };
      };
      const frames = [read()];
      let request = 0;
      const tick = () => { frames.push(read()); request = requestAnimationFrame(tick); };
      request = requestAnimationFrame(tick);
      return { stop: () => { cancelAnimationFrame(request); frames.push(read()); return frames; } };
    }, { sibling: followingNode, followingEdge, conditional });
  } finally { await followingNode.dispose(); }
}

async function settled(dialog: Locator) {
  await uiExpect(dialog).toBeVisible();
  await dialog.evaluate(element => new Promise<void>((resolve, reject) => {
    let previous: number[] = [], stable = 0;
    const start = performance.now();
    const tick = () => {
      const values = [element, ...element.querySelectorAll('[data-flow-motion], [data-flow-motion-inner], [data-dialog-body-measure]')]
        .flatMap(node => { const box = node.getBoundingClientRect(); return [box.height, box.y, Number(getComputedStyle(node).opacity)]; });
      stable = previous.length === values.length && values.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 0;
      previous = values;
      if (stable >= 10 && performance.now() - start > 500) return resolve();
      if (performance.now() - start > 6000) return reject(new Error('Content flow did not settle'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

function interpolates(frames: Frame[], key: 'height' | 'siblingY' | 'opacity', minimumSpan: number) {
  const first = frames[0][key], last = frames.at(-1)![key], span = Math.abs(last - first);
  expect(span, `${key}: fixture must change`).toBeGreaterThan(minimumSpan);
  const low = Math.min(first, last), high = Math.max(first, last), epsilon = key === 'opacity' ? 0.02 : 0.5;
  const intermediate = frames.filter(frame => frame[key] > low + epsilon && frame[key] < high - epsilon);
  expect(new Set(intermediate.map(frame => frame[key].toFixed(key === 'opacity' ? 3 : 1))).size,
    `${key}: content itself and downstream layout must traverse several painted positions`).toBeGreaterThanOrEqual(3);
  const shortFrames = frames.slice(1).flatMap((frame, index) => {
    const before = frames[index], elapsed = frame.time - before.time;
    return elapsed > 0 && elapsed <= 40 ? [Math.abs(frame[key] - before[key])] : [];
  });
  expect(shortFrames.length).toBeGreaterThan(4);
  expect(Math.max(...shortFrames), `${key}: no single ordinary frame may perform most of the movement`)
    .toBeLessThanOrEqual(Math.max(key === 'opacity' ? 0.12 : 3, span * 0.42));
}

function readable(frames: Frame[], conditional = false) {
  expect(frames.length).toBeGreaterThan(8);
  for (const frame of frames) {
    if (!conditional) expect(frame.connected, 'The natural content must survive its closing animation').toBe(true);
    expect(frame.scaleX).toBeCloseTo(1, 3); expect(frame.scaleY).toBeCloseTo(1, 3);
    for (const row of frame.rows) { expect(row.scaleX).toBeCloseTo(1, 3); expect(row.scaleY).toBeCloseTo(1, 3); }
    expect(frame.height).toBeGreaterThanOrEqual(0);
    if (frame.expanded === 'false') { expect(frame.inert).toBe(true); expect(frame.hidden).toBe(true); }
  }
}

function followsContentWithoutASecondChase(frames: Frame[]) {
  // A capped dialog has intentionally stopped growing; test uncapped captures.
  if (frames.some(frame => frame.shellHeight >= frame.shellMaxHeight - 2)) return;
  const last = frames.at(-1)!;
  const settledIndex = frames.findIndex((frame, index) => Math.abs(frame.bodyHeight - last.bodyHeight) < 0.6
    && frames.slice(index).every(later => Math.abs(later.bodyHeight - last.bodyHeight) < 0.6));
  expect(settledIndex).toBeGreaterThanOrEqual(0);
  // ResizeObserver delivery and Motion's render flush may follow the RAF
  // geometry read by up to two paints. At a nested scroll clamp, the body can
  // reach its final height while the inner disclosure is still expanding.
  // Allow only that propagation window, not another duration-based tween.
  const tail = frames.slice(settledIndex + 2);
  expect(tail.length, 'Keep observing after the permitted geometry propagation window').toBeGreaterThanOrEqual(5);
  expect(Math.max(...tail.map(frame => Math.abs(frame.shellHeight - last.shellHeight))),
    'After at most two propagation paints the shell must not keep chasing an independent spring').toBeLessThanOrEqual(3);
}

describe.runIf(process.env.FUSIONKIT_DIALOG_CONTENT_MOTION_E2E === '1')('dialog content flow in native Electron', () => {
  it('fades and resizes actual disclosures while their siblings move continuously, including nesting and reversals', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-dialog-content-motion-'));
    const names = ['01-内容与文档流过渡.srt', '02-用于观察被动位移.srt'];
    const source = '1\n00:00:01,000 --> 00:00:02,000\nA real source subtitle.\n\n2\n00:00:03,000 --> 00:00:04,000\nA second line for the nested preview.\n';
    const files = names.map(name => path.join(root, name));
    await Promise.all(files.map(file => writeFile(file, source)));
    let app: ElectronApplication | undefined;
    const errors: string[] = [], evidence: { name: string; frames: Frame[] }[] = [];
    try {
      const launchEnv = Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[0] !== 'ELECTRON_RUN_AS_NODE' && typeof entry[1] === 'string'));
      app = await electron.launch({ args: ['.', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(),
        env: { ...launchEnv, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => { win.webContents.setBackgroundThrottling(false); win.setSize(1280, 1100); });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload();
      const ready = async () => {
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
        await nativeWindow.evaluate(win => { win.show(); win.focus(); });
        await page.bringToFront();
      };
      const dialog = () => page.locator(dialogSelector);
      const trace = async (name: string, disclosure: Locator, sibling: Locator, action?: () => Promise<unknown>, followingEdge: 'top' | 'bottom' = 'top', conditional = false) => {
        // Native DOM clicks do not activate an occluded Windows test window.
        // Keep RAF sampling foregrounded without changing production motion.
        await nativeWindow.evaluate(win => { win.show(); win.focus(); });
        await page.bringToFront();
        await settled(dialog());
        const sampler = await sampleFrames(disclosure, sibling, followingEdge, conditional);
        let recorded = false;
        try {
          // Native click avoids Playwright waiting for the animated target to stop.
          await (action ? action() : disclosure.locator('[data-slot="accordion-trigger"]').first().evaluate(button => (button as HTMLButtonElement).click()));
          await settled(dialog());
          const frames = await sampler.evaluate(probe => probe.stop()); evidence.push({ name, frames }); recorded = true;
          readable(frames, conditional); followsContentWithoutASecondChase(frames);
          return frames;
        } finally {
          if (!recorded) evidence.push({ name: `${name}-interrupted`, frames: await sampler.evaluate(probe => probe.stop()) });
          await sampler.dispose();
        }
      };
      const fullTransition = async (name: string, disclosure: Locator, sibling: Locator) => {
        const frames = await trace(name, disclosure, sibling);
        interpolates(frames, 'height', 20); interpolates(frames, 'opacity', 0.8); interpolates(frames, 'siblingY', 20);
        return frames;
      };
      const captureMidExpansion = async (name: string, disclosure: Locator) => {
        const before = await disclosure.evaluate(element => new Promise<{ height: number; natural: number; opacity: number }>((resolve, reject) => {
          const started = performance.now();
          const tick = () => {
            const flow = element.querySelector('[data-flow-motion]'), inner = flow?.querySelector('[data-flow-motion-inner]');
            const height = flow?.getBoundingClientRect().height ?? 0, natural = inner?.getBoundingClientRect().height ?? 0;
            if (inner && height > natural * 0.1 && height < natural * 0.8) {
              resolve({ height, natural, opacity: Number(getComputedStyle(inner).opacity) }); return;
            }
            if (performance.now() - started > 3000) { reject(new Error('No intermediate expansion frame was available for visual review')); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }));
        // Native capture avoids screenshot actionability/animation settling.
        // This separate visual cycle does not disturb quantitative RAF traces.
        const png = await nativeWindow.evaluate(async win => (await win.capturePage()).toPNG().toString('base64'));
        const after = await disclosure.evaluate(element => {
          const flow = element.querySelector('[data-flow-motion]'), inner = flow?.querySelector('[data-flow-motion-inner]');
          return { height: flow?.getBoundingClientRect().height ?? 0, natural: inner?.getBoundingClientRect().height ?? 0,
            opacity: inner ? Number(getComputedStyle(inner).opacity) : 0 };
        });
        await Promise.all([
          writeFile(path.join(artifacts, `${name}.png`), Buffer.from(png, 'base64')),
          writeFile(path.join(artifacts, `${name}.json`), JSON.stringify({ before, after }, null, 2)),
        ]);
      };
      await page.getByTestId('subtitle-studio').waitFor(); await ready();
      await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toBeVisible();
      await dialog().getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(page.locator('[role="dialog"]')).toHaveCount(0);
      for (const name of names) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check();
      await page.getByRole('button', { name: '批量下载', exact: true }).click();
      await page.getByRole('menuitem', { name: '批量导出字幕', exact: true }).click();
      await settled(dialog());

      const selected = dialog().getByTestId('studio-selected-documents');
      const footer = dialog().locator('.studio-export-footer');
      await fullTransition('studio-selected-grow-pushes-footer', selected, footer);
      await fullTransition('studio-selected-shrink-pulls-footer', selected, footer);
      await selected.locator('[data-slot="accordion-trigger"]').first().evaluate(button => (button as HTMLButtonElement).click());
      await captureMidExpansion('00-studio-content-mid-expansion', selected); await settled(dialog());
      await selected.locator('[data-slot="accordion-trigger"]').first().evaluate(button => (button as HTMLButtonElement).click());
      await settled(dialog());
      const reversal = await trace('studio-selected-reverse-mid-expansion', selected, footer, async () => {
        await selected.locator('[data-slot="accordion-trigger"]').first().evaluate(button => (button as HTMLButtonElement).click());
        await selected.evaluate(element => new Promise<void>((resolve, reject) => {
          const start = performance.now();
          const tick = () => {
            const content = element.querySelector<HTMLElement>('[data-flow-motion]');
            const inner = content?.querySelector<HTMLElement>('[data-flow-motion-inner]');
            const current = content?.getBoundingClientRect().height ?? 0, natural = inner?.getBoundingClientRect().height ?? 0;
            if (current > 4 && current < natural - 3) {
              (element.querySelector('[data-slot="accordion-trigger"]') as HTMLButtonElement).click(); resolve(); return;
            }
            if (performance.now() - start > 3000) { reject(new Error('No interruptible intermediate content height was painted')); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }));
      });
      expect(Math.max(...reversal.map(frame => frame.height))).toBeGreaterThan(4);
      expect(reversal.at(-1)!.height).toBeLessThan(0.6);
      expect(reversal.at(-1)!.opacity).toBeLessThan(0.02);
      await uiExpect(selected.locator('[data-slot="accordion-trigger"]').first()).toHaveAttribute('aria-expanded', 'false');

      await dialog().getByRole('button', { name: '检查导出', exact: true }).click(); await settled(dialog());
      const review = dialog().getByTestId('studio-export-review-details');
      await review.locator('[data-slot="accordion-trigger"]').first().click(); await settled(dialog());
      const rows = review.locator('.studio-document-row'); await uiExpect(rows).toHaveCount(2);
      const preview = rows.nth(0).locator('.studio-export-preview');
      await fullTransition('studio-nested-preview-grow-pushes-next-document', preview, rows.nth(1));
      await uiExpect(preview.locator('pre')).toContainText('A real source subtitle.');
      await page.screenshot({ path: path.join(artifacts, '01-studio-nested-preview.png') });
      await fullTransition('studio-nested-preview-shrink-pulls-next-document', preview, rows.nth(1));
      const parentClose = await trace('studio-parent-close-during-nested-preview-expansion', review, dialog().locator('[data-slot="scrollable-dialog-footer"]'), async () => {
        await preview.locator('[data-slot="accordion-trigger"]').first().evaluate(button => (button as HTMLButtonElement).click());
        await preview.evaluate(element => new Promise<void>((resolve, reject) => {
          const start = performance.now();
          const tick = () => {
            const flow = element.querySelector('[data-flow-motion]'), inner = flow?.querySelector('[data-flow-motion-inner]');
            const current = flow?.getBoundingClientRect().height ?? 0, natural = inner?.getBoundingClientRect().height ?? 0;
            if (current > 4 && current < natural - 3) {
              (element.closest('[data-testid="studio-export-review-details"]')!.querySelector('[data-slot="accordion-trigger"]') as HTMLButtonElement).click();
              resolve(); return;
            }
            if (performance.now() - start > 3000) { reject(new Error('Nested preview never painted an intermediate height')); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }));
      });
      interpolates(parentClose, 'height', 20); interpolates(parentClose, 'opacity', 0.8);
      await dialog().getByRole('button', { name: '取消', exact: true }).click();
      await uiExpect(page.locator('[role="dialog"]')).toHaveCount(0);

      await page.evaluate(() => { location.hash = '/tools/translation-knowledge'; }); await page.reload();
      await page.getByTestId('knowledge-new-collection').waitFor(); await ready();
      // Choosing a custom language reveals its tag field: a genuine absent -> present -> absent lifecycle.
      await page.getByTestId('knowledge-new-collection').click(); await settled(dialog());
      const language = dialog().getByTestId('knowledge-collection-form').locator('.grid > div').first();
      const chooseSource = async (name: string) => {
        await language.getByRole('combobox', { name: labels.collection.source_language, exact: true }).click();
        await page.getByRole('option', { name, exact: true }).click();
      };
      const languageGrow = await trace('knowledge-custom-language-field-grow-including-trailing-gap', language, language,
        () => chooseSource(labels.languages.custom), 'bottom', true);
      interpolates(languageGrow, 'height', 20); interpolates(languageGrow, 'opacity', 0.8); interpolates(languageGrow, 'siblingY', 20);
      await uiExpect(language.getByRole('textbox', { name: labels.languages.custom_tag })).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '02-knowledge-custom-language.png') });
      const languageShrink = await trace('knowledge-custom-language-field-shrink-including-trailing-gap', language, language,
        () => chooseSource(labels.languages.en), 'bottom', true);
      interpolates(languageShrink, 'height', 20); interpolates(languageShrink, 'opacity', 0.8); interpolates(languageShrink, 'siblingY', 20);
      await uiExpect(language.getByRole('textbox', { name: labels.languages.custom_tag })).toHaveCount(0);
      // Parent grid gaps/padding must disappear as part of the same flow. A gap
      // removed only when an exit unmounts produces a visible last-frame jump.
      for (const frames of [languageGrow, languageShrink]) {
        const offsets = frames.map(frame => frame.siblingY - frame.height);
        expect(Math.max(...offsets) - Math.min(...offsets), 'The language field must not add/remove an external gap at animation boundaries').toBeLessThanOrEqual(1.5);
      }

      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await trace('knowledge-custom-language-reduced-motion', language, language, () => chooseSource(labels.languages.custom), 'bottom', true);
      const low = Math.min(reduced[0].height, reduced.at(-1)!.height), high = Math.max(reduced[0].height, reduced.at(-1)!.height);
      expect(high - low).toBeGreaterThan(20);
      expect(reduced.filter(frame => frame.height > low + 0.6 && frame.height < high - 0.6)).toHaveLength(0);
      expect(reduced.filter(frame => frame.opacity > 0.02 && frame.opacity < 0.98)).toHaveLength(0);
      await dialog().getByRole('button', { name: labels.actions.close, exact: true }).click();
      await uiExpect(page.locator('[role="dialog"]')).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      expect(await page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value.data.collections.length; })).toBe(0);
      await uiExpect(page.locator('body')).not.toHaveCSS('pointer-events', 'none');
      expect(errors).toEqual([]);
    } catch (error) {
      const page = await app?.firstWindow().catch(() => null);
      await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => undefined);
      const state = await page?.evaluate(() => ({ url: location.href, body: document.body.innerHTML.slice(-75000) })).catch(() => null);
      await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({
        message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null, errors, state,
      }, null, 2));
      throw error;
    } finally {
      await writeFile(path.join(artifacts, 'frames.json'), JSON.stringify(evidence, null, 2));
      try { if (app) { const child = app.process(); await app.close(); expect(child.exitCode !== null || child.signalCode !== null).toBe(true); } }
      finally {
        expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
        expect(path.basename(root)).toMatch(/^fusionkit-dialog-content-motion-/);
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 150000);
});
