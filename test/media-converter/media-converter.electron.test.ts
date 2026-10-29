import { afterEach, describe, expect, it } from 'vitest';
import { expect as uiExpect, type Locator, type Page } from 'playwright/test';
import { access, copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddFilesResult, ConversionSettings, ItemSummary, MediaInfo, PlanSummary, PreviewPlanResult } from '../../src/media-converter/contract';
import { formatBytes, formatSizeChange } from '../../src/pages/Tools/Media/MediaConverter/format';
import {
  createMediaRun, describeMediaUi, dialogCalls, dropFiles, dropVirtualFiles, hasHorizontalOverflow, launchMediaApp, lavfi, makeMedia, makeSample,
  mediaEnv, notifications, openRoute, recordNotifications, revealedFiles, setAppearance, setWindowSize, settle, shellCalls, shoot, stubDialogs, waitForApp,
  type Language, type LaunchOptions, type MediaApp, type Theme,
} from './helpers/media-ui';

/**
 * The media converter page in the real app, quiet (module-workbench tasks, 通用验证约定). Each task
 * adds its scenarios here; run after `pnpm run pretest` with FUSIONKIT_MEDIA_E2E=1.
 */

const ROUTE = '/tools/media/converter';

const COPY = {
  zh: {
    section: '媒体工具', sectionDescription: '处理音视频文件的工具，全程在本机运行。', count: 'FusionKit · 9 个工具', countWithout: 'FusionKit · 8 个工具',
    title: '音视频转换', description: '压缩视频、转换音视频格式、提取音频，全程在本机完成，不上传文件', chips: ['压缩 · 转换 · 提取音频', '本机处理 · 不上传'],
    pageDescription: '压缩视频、转换格式、提取音频，全程在本机完成，文件不会上传。', back: '返回',
    unsupported: '暂不支持此平台', unsupportedBody: '音视频转换目前只能在 Windows 上使用。',
  },
  en: {
    section: 'Media tools', sectionDescription: 'Tools for audio and video files that run entirely on this computer.', count: 'FusionKit · 9 tools',
    countWithout: 'FusionKit · 8 tools', title: 'Media Converter',
    description: 'Compress videos, convert audio and video formats or extract audio, all on this computer with nothing uploaded',
    chips: ['Compress · Convert · Extract audio', 'On this computer · No upload'],
    pageDescription: 'Compress videos, convert formats and extract audio, all on this computer. Files are never uploaded.', back: 'Back',
    unsupported: 'Not available on this platform', unsupportedBody: 'The media converter currently runs on Windows only.',
  },
} satisfies Partial<Record<Language, Record<string, string | string[]>>>;

/** An `oklch(L C H)` value of src/index.css, as the built stylesheet writes it (`oklch(62% .15 335)`). */
type Oklch = { l: number; c: number; h: number };
const parseOklch = (value: string): Oklch => {
  const match = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
  if (!match) throw new Error(`Not an oklch() value: ${value}`);
  return { l: Math.round(Number(match[1]) / (match[2] ? 100 : 1) * 1000) / 1000, c: Number(match[3]), h: Number(match[4]) };
};
const hueDistance = (a: Oklch, b: Oklch) => { const d = Math.abs(a.h - b.h) % 360; return Math.min(d, 360 - d); };
/** Euclidean distance in OKLab (a just noticeable difference is about 0.02). */
const deltaE = (a: Oklch, b: Oklch) => {
  const lab = ({ l, c, h }: Oklch) => [l, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)];
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** The computed colour of `css` (any colour expression), the way an element using it would get it. */
const resolvedColor = (page: Page, css: string) => page.evaluate(css => {
  const probe = document.createElement('span');
  probe.style.color = css;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, css);

const scrollViewport = (page: Page) => page.locator('.app > [data-slot=scroll-area] [data-slot=scroll-area-viewport]').first();

/** Scrolls the app's own scroll area so `target` is in view (the window never scrolls, FK-PIT-0009). */
async function bringIntoView(page: Page, target: Locator) {
  await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await settle(page);
}

const toolNameInBottomBar = (page: Page, name: string) => page.locator('div.fixed.bottom-0 button', { hasText: name });

/**
 * A failure line next to the media tile, for comparing the tool's tone with the destructive colour
 * (V-WORKBENCH-01-3 a): the tile's own icon in a badge of the tone, and a failure badge and text in
 * `--destructive`, both mixed as ToolBadge mixes its tone. Test-only markup, removed after the screenshot.
 */
async function showFailureSample(page: Page, label: string) {
  await page.locator('[data-testid=tools-media-grid]').evaluate((grid, label) => {
    const badge = (tone: string, icon: string) => `<span style="display:inline-flex;width:36px;height:36px;align-items:center;justify-content:center;border:1px solid color-mix(in oklch, ${tone} 32%, transparent);border-radius:10px;background:color-mix(in oklch, ${tone} 14%, transparent);color:${tone}">${icon}</span>`;
    const svg = (paths: string) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const toolIcon = grid.querySelector('.qy-spotlight-tile-icon svg')!.cloneNode(true) as SVGElement;
    toolIcon.setAttribute('width', '17');
    toolIcon.setAttribute('height', '17');
    const sample = document.createElement('div');
    sample.dataset.reviewSample = '';
    sample.style.cssText = 'grid-column:span 3;display:flex;flex-direction:column;gap:12px;justify-content:center;padding:16px;border:1px dashed var(--border);border-radius:16px;font-size:13px';
    sample.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">${badge('var(--tool-media)', toolIcon.outerHTML)}<span>--tool-media</span></div>
      <div style="display:flex;align-items:center;gap:10px">${badge('var(--destructive)', svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'))}<span style="color:var(--destructive)">${label}</span></div>`;
    grid.append(sample);
  }, label);
}

describe('media UI helpers', () => {
  it('pass the test build and the switches to the app, and refuse switches the app would ignore', () => {
    const env = mediaEnv({ caps: 'detecting_ms:1500', fail: 'no_device:first_attempt', reveal: 'record' });
    expect(env).toMatchObject({
      NODE_ENV: 'test', VITE_DEV_SERVER_URL: '',
      FUSIONKIT_TEST_MEDIA_CAPS: 'detecting_ms:1500', FUSIONKIT_TEST_MEDIA_FAIL: 'no_device:first_attempt', FUSIONKIT_TEST_MEDIA_REVEAL: 'record',
    });
    expect(env.FUSIONKIT_TEST_WINDOW).toBe(process.env.FUSIONKIT_TEST_WINDOW);
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(mediaEnv()).not.toHaveProperty('FUSIONKIT_TEST_MEDIA_CAPS');
    expect(() => mediaEnv({ caps: 'unavailable:not_a_code' as never })).toThrow(/would be ignored/);
    expect(() => mediaEnv({ fail: 'no_device:always' as never })).toThrow(/would be ignored/);
  });

  it('refuse to drop a file from %TEMP%, under its short name as under its long one', async () => {
    // Refused before the page is touched, so no page is needed.
    const page = {} as Page;
    const folders = new Set([os.tmpdir(), await realpath(os.tmpdir())]);
    for (const folder of folders) await expect(dropFiles(page, 'main', [path.join(folder, 'clip.mp4')])).rejects.toThrow(/is in %TEMP%/);
  });
});

describeMediaUi('Media converter in Electron', () => {
  let media: MediaApp | undefined;

  // Before the run folder of a passed test is cleaned (onTestFinished comes after afterEach), and
  // whether the test passed or not: no app outlives its test.
  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  // T-WORKBENCH-01: AC-WORKBENCH-01-1, AC-WORKBENCH-01-3 (V-WORKBENCH-01-3 a, b).
  it('lists the converter in its own catalog section, opens it and goes back with Escape and Back', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } });
    const { page } = media;
    expect(await page.evaluate(() => window.mediaConverter?.supported)).toBe(true);
    const evidence: Record<string, unknown> = {};

    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const copy = COPY[language];
      const label = `${theme}-${language}`;
      await setAppearance(page, { theme, language, route: '/tools' });
      const viewport = await setWindowSize(media, { width: 1280, height: 800 });
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });

      // The section: heading, count, description, between the classic and the experimental tools.
      const section = page.locator('section[aria-labelledby="media-tools-title"]');
      await uiExpect(section).toHaveCount(1);
      await uiExpect(page.getByTestId('tools-media-heading')).toHaveText(copy.section);
      await uiExpect(section.locator('.tools-count')).toHaveText('01');
      await uiExpect(section.locator('#media-tools-title-description')).toHaveText(copy.sectionDescription);
      await uiExpect(page.locator('.tools-eyebrow')).toHaveText(copy.count);
      const tile = section.locator('[data-tool-card=mediaConverter]');
      await uiExpect(tile).toHaveCount(1);
      await uiExpect(page.locator('[data-tool-card=mediaConverter]')).toHaveCount(1);
      await uiExpect(tile.locator('#tool-title-mediaConverter')).toHaveText(copy.title);
      await uiExpect(tile).toContainText(copy.description);
      for (const chip of copy.chips) await uiExpect(tile).toContainText(chip);
      await uiExpect(tile.locator('svg').first()).toBeVisible();

      const layout = await page.evaluate(() => {
        const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top;
        const rows = (selector: string) => new Set([...document.querySelectorAll(`${selector} [data-tool-card]`)].map(card => Math.round(card.getBoundingClientRect().top))).size;
        const tile = document.querySelector('[data-tool-card=mediaConverter]')!.parentElement!.getBoundingClientRect();
        const grid = document.querySelector('[data-testid=tools-media-grid]')!.getBoundingClientRect();
        const style = getComputedStyle(document.documentElement);
        return {
          classicTop: top('#classic-tools-title'), mediaTop: top('#media-tools-title'), experimentalTop: top('#experimental-tools-title'),
          classicRows: rows('[data-testid=tools-classic-grid]'),
          experimentalCards: [...document.querySelectorAll('section[aria-labelledby="experimental-tools-title"] [data-tool-card]')].map(card => card.getAttribute('data-tool-card')),
          tileWidthShare: Math.round(tile.width / grid.width * 100) / 100,
          tileHeight: Math.round(tile.height),
          iconColor: getComputedStyle(document.querySelector('[data-tool-card=mediaConverter] .qy-spotlight-tile-icon')!).color,
          media: style.getPropertyValue('--tool-media').trim(),
          destructive: style.getPropertyValue('--destructive').trim(),
          rename: style.getPropertyValue('--tool-rename').trim(),
          translator: style.getPropertyValue('--tool-translator').trim(),
        };
      });
      expect(layout.classicTop).toBeLessThan(layout.mediaTop);
      expect(layout.mediaTop).toBeLessThan(layout.experimentalTop);
      // The classic tools still fill two rows, and the experimental section still holds only the long text translator.
      expect(layout.classicRows).toBe(2);
      expect(layout.experimentalCards).toEqual(['textTranslator']);
      // Half a row, like the experimental tile.
      expect(layout.tileWidthShare).toBeGreaterThan(0.45);
      expect(layout.tileWidthShare).toBeLessThan(0.55);
      expect(layout.iconColor).toBe(await resolvedColor(page, 'var(--tool-media)'));
      const tone = parseOklch(layout.media);
      expect(tone).toEqual(theme === 'light' ? { l: 0.62, c: 0.15, h: 335 } : { l: 0.72, c: 0.15, h: 335 });
      // Far from the failure red, and apart from the nearest tool tones.
      const destructive = parseOklch(layout.destructive);
      const contrast = {
        hueFromDestructive: hueDistance(tone, destructive), deltaEFromDestructive: Math.round(deltaE(tone, destructive) * 1000) / 1000,
        hueFromRename: hueDistance(tone, parseOklch(layout.rename)), hueFromTranslator: hueDistance(tone, parseOklch(layout.translator)),
      };
      expect(contrast.hueFromDestructive).toBeGreaterThanOrEqual(45);
      // About five times a just noticeable difference at least (the tones measure 0.198 light, 0.143 dark).
      expect(contrast.deltaEFromDestructive).toBeGreaterThan(0.1);
      expect(contrast.hueFromRename).toBeGreaterThanOrEqual(45);
      expect(contrast.hueFromTranslator).toBeGreaterThanOrEqual(45);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      // The overflow check sees what the app's clipping hides from the window: a probe wider than the window.
      await page.getByTestId('tools-catalog').evaluate(main => {
        const probe = document.createElement('div');
        probe.dataset.overflowProbe = '';
        probe.style.cssText = 'width:4000px;height:1px';
        main.append(probe);
      });
      const overflowProbe = { detected: await hasHorizontalOverflow(page), windowScrolls: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) };
      await page.locator('[data-overflow-probe]').evaluate(element => element.remove());
      expect(overflowProbe.detected).toBe(true);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      evidence[`catalog-${label}`] = { viewport, ...layout, contrast, overflowProbe };

      await bringIntoView(page, section);
      await shoot(page, run, `T-WORKBENCH-01-catalog-${label}-1280x800`);
      await showFailureSample(page, language === 'zh' ? '失败 · 编码出错' : 'Failed · Encoding error');
      const box = (await section.boundingBox())!;
      await shoot(page, run, `T-WORKBENCH-01-tone-vs-failure-${label}`, { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: box.height + 24 });
      await page.locator('[data-review-sample]').evaluate(element => element.remove());

      // The tile opens the tool; the bottom bar names it; Escape goes back, and only once.
      await tile.locator('#tool-title-mediaConverter').click();
      await uiExpect(page).toHaveURL(new RegExp(`#${ROUTE}$`));
      await page.locator('[data-testid=media-converter][data-platform=supported]').waitFor();
      // The app keeps the catalog's scroll offset across the route change, and the page (with its settings
      // since T-WORKBENCH-02) is taller than the window: measure the header from the top, as the user scrolls to it.
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
      // The engine's first check (verifying the runtime) ends before the screenshot, so both themes show the same settled header.
      await uiExpect(page.getByTestId('media-engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await settle(page);
      await uiExpect(page.locator('h1')).toHaveCount(1);
      await uiExpect(page.locator('h1')).toHaveText(copy.title);
      await uiExpect(page.locator('[data-slot=tool-detail-layout]')).toContainText(copy.pageDescription);
      await uiExpect(toolNameInBottomBar(page, copy.title)).toBeVisible();
      const header = await page.evaluate(() => {
        const h1 = document.querySelector('h1')!;
        const badge = h1.closest('.mb-5')!.firstElementChild as HTMLElement;
        return { top: h1.getBoundingClientRect().top, expectedTop: 40 + (innerHeight <= 650 ? 20 : 24), badgeColor: getComputedStyle(badge).color };
      });
      expect(header.top).toBeCloseTo(header.expectedTop, 0);
      expect(header.badgeColor).toBe(await resolvedColor(page, 'var(--tool-media)'));
      expect(await hasHorizontalOverflow(page)).toBe(false);
      evidence[`page-${label}`] = header;
      await shoot(page, run, `T-WORKBENCH-01-page-${label}-1280x800`);
      await page.locator('h1').click();
      await page.keyboard.press('Escape');
      await uiExpect(page).toHaveURL(/#\/tools$/);
      await uiExpect(page.locator('[data-slot=tool-detail-layout]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      expect(new URL(page.url()).hash).toBe('#/tools');

      // Back in the bottom bar does the same.
      await settle(page);
      await page.locator('[data-tool-card=mediaConverter] #tool-title-mediaConverter').click();
      await uiExpect(page).toHaveURL(new RegExp(`#${ROUTE}$`));
      await settle(page);
      await page.locator('div.fixed.bottom-0').getByRole('button', { name: copy.back, exact: true }).click();
      await uiExpect(page).toHaveURL(/#\/tools$/);
      await uiExpect(page.locator('[data-slot=tool-detail-layout]')).toHaveCount(0);
    }

    // Japanese and Traditional Chinese, spot-checked: the tile and the section have their own wording.
    for (const [language, section, title] of [['ja', 'メディアツール', '音声・動画変換'], ['zh-Hant', '媒體工具', '影音轉換']] as const) {
      await setAppearance(page, { theme: 'light', language, route: '/tools' });
      await uiExpect(page.getByTestId('tools-media-heading')).toHaveText(section);
      await uiExpect(page.locator('#tool-title-mediaConverter')).toHaveText(title);
      if (language === 'ja') {
        const media = page.locator('section[aria-labelledby="media-tools-title"]');
        await bringIntoView(page, media);
        const box = (await media.boundingBox())!;
        await shoot(page, run, 'T-WORKBENCH-01-catalog-light-ja-section', { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: box.height + 24 });
      }
    }

    // The smallest window: the section fits without sideways scrolling.
    await setAppearance(page, { theme: 'light', language: 'zh', route: '/tools' });
    const small = await setWindowSize(media, { width: 786, height: 540 });
    await bringIntoView(page, page.locator('section[aria-labelledby="media-tools-title"]'));
    expect(await hasHorizontalOverflow(page)).toBe(false);
    evidence['catalog-light-zh-786x540'] = { viewport: small, tile: await page.locator('[data-tool-card=mediaConverter]').evaluate(card => card.getBoundingClientRect().toJSON()) };
    await shoot(page, run, 'T-WORKBENCH-01-catalog-light-zh-786x540');

    await writeFile(path.join(run, 'T-WORKBENCH-01-catalog.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    // Closed here, before the passed run's folders (the profile among them) are removed.
    await media.close();
    media = undefined;
  }, 180_000);

  // T-WORKBENCH-01: the UI test helpers themselves (media made in the run folder, a simulated drop, the stubbed dialog).
  it('makes media in the run folder and hands it over by drop and by the stubbed dialog', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' } });
    const { app, page } = media;
    const [dropped, picked] = await Promise.all([makeSample(run, 'h264-aac.mp4', 'dropped clip.mp4'), makeSample(run, 'h264-aac.mp4', 'picked.mp4')]);
    expect(path.relative(run, dropped).startsWith('media')).toBe(true);
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });

    // The page takes drops itself since T-WORKBENCH-03: drop on it, then read the queue the main process keeps.
    const names = () => page.evaluate(async () => {
      const snapshot = await window.mediaConverter!.getSnapshot();
      return snapshot.ok ? snapshot.value.items.map(item => item.displayName) : [];
    });
    await dropFiles(page, '[data-testid=media-converter]', [dropped]);
    await uiExpect.poll(names, { timeout: 30_000 }).toEqual(['dropped clip.mp4']);

    await stubDialogs(app, { files: [picked] });
    const pickedOutcome = await page.evaluate(() => window.mediaConverter!.pickFiles({ filter: 'video' }));
    expect(pickedOutcome.ok && pickedOutcome.value.added).toHaveLength(1);
    const [call] = await dialogCalls(app);
    expect(call.properties).toEqual(['openFile', 'multiSelections']);
    expect(call.filters).toHaveLength(1);
    expect(call.filters[0].extensions).toContain('mp4');

    // The shell stub deletes for good, so only inside the media test runs: a path elsewhere (one that does not
    // exist, should the guard ever fail) is refused, a file of the run is gone.
    const outside = path.join(path.dirname(path.dirname(run)), `media-ui-trash-probe-${path.basename(run)}.txt`);
    await expect(app.evaluate(({ shell }, target) => shell.trashItem(target), outside)).rejects.toThrow(/refuses to delete/);
    const scratch = path.join(run, 'trash-probe.txt');
    await writeFile(scratch, 'probe');
    await app.evaluate(({ shell }, target) => shell.trashItem(target), scratch);
    await expect(access(scratch)).rejects.toThrow();

    // The same file again is recognised by identity, not added twice: the page says it is in the list already.
    await dropFiles(page, '[data-testid=media-converter]', [dropped]);
    await uiExpect(page.getByTestId('media-add-notice-duplicate')).toContainText('dropped clip.mp4');
    expect(await names()).toEqual(['dropped clip.mp4', 'picked.mp4']);

    // Both are probed as the 2 s 320×180 clips they are; no path reaches the page.
    await uiExpect.poll(async () => {
      const snapshot = await page.evaluate(() => window.mediaConverter!.getSnapshot());
      return snapshot.ok ? snapshot.value.items.map(item => [item.displayName, item.state.status, item.media?.kind]) : snapshot.error.code;
    }, { timeout: 30_000 }).toEqual([['dropped clip.mp4', 'idle', 'video'], ['picked.mp4', 'idle', 'video']]);
    const snapshot = await page.evaluate(() => window.mediaConverter!.getSnapshot());
    expect(JSON.stringify(snapshot)).not.toContain(run.replaceAll('\\', '\\\\'));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 120_000);

  // T-WORKBENCH-01: AC-WORKBENCH-01-2 (V-WORKBENCH-01-3 d).
  it('explains the platform instead of showing the tool where the converter is not supported', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, platform: 'unsupported', size: { width: 1280, height: 800 } });
    const { page } = media;
    expect(await page.evaluate(() => window.mediaConverter?.supported)).toBe(false);
    const evidence: Record<string, unknown> = {};

    for (const [theme, language, width, height] of [['light', 'zh', 1280, 800], ['dark', 'en', 786, 540]] as [Theme, 'zh' | 'en', number, number][]) {
      const copy = COPY[language];
      const label = `${theme}-${language}-${width}x${height}`;
      await setAppearance(page, { theme, language, route: '/tools' });
      await setWindowSize(media, { width, height });
      // No section, no tile, and the count leaves the tool out.
      await uiExpect(page.locator('[data-testid=tools-classic-grid] [data-tool-card]')).toHaveCount(5);
      await uiExpect(page.locator('section[aria-labelledby="media-tools-title"]')).toHaveCount(0);
      await uiExpect(page.locator('[data-tool-card=mediaConverter]')).toHaveCount(0);
      await uiExpect(page.locator(`a[href$="${ROUTE}"]`)).toHaveCount(0);
      await uiExpect(page.locator('.tools-eyebrow')).toHaveText(copy.countWithout);

      // The route itself still answers: the header, then only the notice.
      await openRoute(page, ROUTE);
      await page.locator('[data-testid=media-converter][data-platform=unsupported]').waitFor();
      await uiExpect(page.locator('h1')).toHaveCount(1);
      await uiExpect(page.locator('h1')).toHaveText(copy.title);
      const notice = page.getByTestId('media-converter-unsupported');
      await uiExpect(notice).toBeVisible();
      await uiExpect(notice.getByRole('heading', { level: 2 })).toHaveText(copy.unsupported);
      await uiExpect(notice).toContainText(copy.unsupportedBody);
      await uiExpect(page.locator('[data-slot=tool-detail-layout]')).toContainText(copy.pageDescription);
      await uiExpect(page.locator('[data-slot=tool-file-picker], [data-slot=tool-config-panel]')).toHaveCount(0);
      await uiExpect(toolNameInBottomBar(page, copy.title)).toBeVisible();
      const layout = await page.evaluate(() => {
        const content = document.querySelector('[data-slot=tool-detail-layout] > .grid')!.getBoundingClientRect();
        const notice = document.querySelector('[data-testid=media-converter-unsupported]')!.getBoundingClientRect();
        const h1 = document.querySelector('h1')!.getBoundingClientRect();
        const aside = document.querySelector('[data-slot=tool-detail-layout] aside')!;
        return {
          asideDisplay: getComputedStyle(aside).display, asideChildren: aside.childElementCount,
          noticeLeft: Math.round(notice.left), contentLeft: Math.round(content.left), noticeWidth: Math.round(notice.width), contentWidth: Math.round(content.width),
          noticeHeight: Math.round(notice.height), h1Top: h1.top, expectedTop: 40 + (innerHeight <= 650 ? 20 : 24),
        };
      });
      expect(layout.asideDisplay).toBe('none');
      expect(layout.asideChildren).toBe(0);
      // The notice spans the content width, where the settings and the queue would be.
      expect(layout.noticeLeft).toBe(layout.contentLeft);
      expect(layout.noticeWidth).toBe(layout.contentWidth);
      expect(layout.h1Top).toBeCloseTo(layout.expectedTop, 0);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      evidence[label] = layout;
      await shoot(page, run, `T-WORKBENCH-01-unsupported-${label}`);

      await page.locator('h1').click();
      await page.keyboard.press('Escape');
      await uiExpect(page).toHaveURL(/#\/tools$/);
      await openRoute(page, ROUTE);
      await page.locator('div.fixed.bottom-0').getByRole('button', { name: copy.back, exact: true }).click();
      await uiExpect(page).toHaveURL(/#\/tools$/);
      await uiExpect(page.locator('[data-slot=tool-detail-layout]')).toHaveCount(0);
    }

    await writeFile(path.join(run, 'T-WORKBENCH-01-unsupported.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 120_000);
});

// ── T-WORKBENCH-02: the controller, the preferences, the settings panel and the engine badge ──────

const PREFERENCES_KEY = 'fusionkit.media-converter.preferences.v1';

const SETTINGS_COPY = {
  zh: {
    task: { compress: '压缩视频', convert: '转换格式', 'extract-audio': '提取音频' },
    codec: { av1: '最小体积（AV1）', hevc: '苹果与较新设备（HEVC）', h264: '最大兼容（H.264）' },
    compatibility: {
      av1: '体积最小；iPhone 15 Pro 之前的 iPhone、M3 之前的 Mac 自带播放器无法播放',
      hevc: '苹果设备都能播放；Windows 自带的「照片」需要安装 HEVC 扩展',
      h264: '几乎所有设备和 App 都能播放，体积较大',
    },
    original: '保持原始', copyTrack: '保持原音轨（无损）',
    gpuHint: '更快，但体积约大一倍',
    gpuCodec: '只有「最小体积（AV1）」可以选择是否用显卡编码。HEVC 和 H.264 会自动使用显卡（如果有）。',
    gpuHardware: '本机没有可用的 AV1 显卡编码器。HEVC 和 H.264 会自动使用显卡（如果有）。',
    gpuDetecting: '正在检测编码能力，完成后才知道能否用显卡编码 AV1。HEVC 和 H.264 会自动使用显卡（如果有）。',
    weakH264: '本机没有可用的 H.264 显卡编码器，只能用较弱的 OpenH264（CPU）编码，体积会偏大。',
    weakHevc: '本机没有可用的 HEVC 显卡编码器，只能用较弱的 Kvazaar HEVC（CPU）编码，体积会偏大。',
    useAv1: '改用 AV1', overwrite: '会把同名旧文件移到回收站；源文件永远不会被覆盖', lowUsageHint: '编码更慢，但尽量不影响游戏和其他程序',
    missing: '之前选择的输出文件夹已不可用，已改回「源文件旁」',
    detecting: '正在检测编码能力', cpuOnly: '仅 CPU', nvenc: 'NVIDIA NVENC', unavailable: '不可用：编码组件已损坏',
    advice: '随附的 FFmpeg 缺失或被改动。请重新安装 FusionKit 后再试。', redetect: '重新检测', redetectBusy: '有显卡编码任务在运行，结束后才能重新检测',
    driver: 'NVIDIA NVENC 的显卡驱动过旧：需要 570 或更新版本。请更新显卡驱动后点「重新检测」。',
    uploadUnavailable: '暂时无法添加文件：编码组件已损坏。随附的 FFmpeg 缺失或被改动。请重新安装 FusionKit 后再试。', added: '已加入 1 个文件',
  },
  en: {
    task: { compress: 'Compress', convert: 'Convert', 'extract-audio': 'Extract audio' },
    codec: { av1: 'Smallest size (AV1)', hevc: 'Apple & newer devices (HEVC)', h264: 'Widest compatibility (H.264)' },
    compatibility: {
      av1: 'Smallest files; the built-in players of iPhones before the iPhone 15 Pro and Macs before M3 cannot play them',
      hevc: 'Plays on every Apple device; the Windows Photos app needs the HEVC extension',
      h264: 'Plays on almost every device and app; larger files',
    },
    original: 'Keep original', copyTrack: 'Keep the original track (lossless)',
    gpuHint: 'Faster, but files are about twice as large',
    gpuCodec: 'Only "Smallest size (AV1)" lets you choose the graphics card. HEVC and H.264 use the graphics card automatically when there is one.',
    gpuHardware: 'No AV1 graphics encoder works on this computer. HEVC and H.264 use the graphics card automatically when there is one.',
    gpuDetecting: 'The encoders are still being detected; whether the graphics card can encode AV1 is known afterwards. HEVC and H.264 use the graphics card automatically when there is one.',
    weakH264: 'Only the weaker OpenH264 (CPU) can encode H.264 here, so files come out larger.',
    weakHevc: 'Only the weaker Kvazaar HEVC (CPU) can encode HEVC here, so files come out larger.',
    useAv1: 'Use AV1', overwrite: 'The old file of that name goes to the Recycle Bin; a source file is never overwritten',
    lowUsageHint: 'Encodes more slowly but keeps games and other apps running smoothly',
    missing: 'The output folder chosen before is no longer available; files are saved next to their sources again',
    detecting: 'Detecting encoders', cpuOnly: 'CPU only', nvenc: 'NVIDIA NVENC', unavailable: 'Unavailable: Encoder files damaged',
    advice: 'The bundled FFmpeg is missing or was changed. Reinstall FusionKit and try again.', redetect: 'Detect again',
    redetectBusy: 'A graphics card encode is running; detect again when it ends',
    driver: 'The NVIDIA NVENC graphics driver is too old: version 570 or newer is needed. Update the graphics driver, then click "Detect again".',
    uploadUnavailable: 'Files cannot be added right now: Encoder files damaged. The bundled FFmpeg is missing or was changed. Reinstall FusionKit and try again.',
    added: '1 file added',
  },
} as const;

const settingsPanel = (page: Page) => page.getByTestId('media-converter-settings');
/** The upload area's own button ("choose files"); the file-type menu beside it is `media-upload-filter`. */
const uploadButton = (page: Page) => page.getByTestId('media-upload').locator('button:not([data-testid=media-upload-filter])');
/** The page header (ToolPageHeader): icon, title, description and the engine status. */
const HEADER = '[data-slot=tool-detail-layout] > .mb-5';

/** Moves the pointer away in steps, past the tooltip's hover grace area, and waits until no tooltip is open. */
async function leaveHover(page: Page) {
  await page.mouse.move(4, 4, { steps: 6 });
  await page.mouse.move(2, 120, { steps: 6 });
  await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveCount(0);
}
const segment = (page: Page, testId: string) => page.getByTestId(testId);
const engineBadge = (page: Page) => page.getByTestId('media-engine-status');

/** The converter page with the preferences of a first visit (or `preferences` as stored), in `appearance`. */
async function openSettings(media: MediaApp, appearance: { theme: Theme; language: Language }, preferences: unknown = null) {
  await media.page.evaluate(({ key, preferences }) => {
    if (preferences === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ state: preferences, version: 1 }));
  }, { key: PREFERENCES_KEY, preferences });
  await setAppearance(media.page, { ...appearance, route: ROUTE });
  await settingsPanel(media.page).waitFor();
  await settle(media.page, '[data-testid=media-converter-settings], h1');
}

const waitForEngine = (page: Page, state: 'detecting' | 'ready' | 'unavailable') =>
  uiExpect(engineBadge(page)).toHaveAttribute('data-state', state, { timeout: 30_000 });

/** A clip around the boxes of `selectors` (all that are visible), with a margin, inside the page. */
async function clipAround(page: Page, selectors: string[], margin = 12) {
  return page.evaluate(({ selectors, margin }) => {
    const boxes = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
    if (!boxes.length) throw new Error(`Nothing to clip: ${selectors.join(', ')}`);
    const left = Math.max(0, Math.min(...boxes.map(box => box.left)) - margin);
    const top = Math.max(0, Math.min(...boxes.map(box => box.top)) - margin);
    const right = Math.min(innerWidth, Math.max(...boxes.map(box => box.right)) + margin);
    const bottom = Math.min(innerHeight, Math.max(...boxes.map(box => box.bottom)) + margin);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, { selectors, margin });
}

/**
 * The panel against the window (V-WORKBENCH-02-2): its height open and folded, measured by opening
 * and folding "output and performance", the room the window leaves it (below the 40px sticky top,
 * above the floating bottom bar), and what the page chose by itself before.
 */
async function measurePanel(page: Page) {
  const group = page.getByTestId('media-output-group');
  const facts = () => page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid=media-converter-settings]')!;
    const aside = panel.closest('aside')!;
    // The floating bottom bar (its pill), which a single-column page scrolls under.
    const barTop = document.querySelector('div.fixed.bottom-0 .rounded-full.border')!.getBoundingClientRect().top;
    return {
      height: Math.round(panel.getBoundingClientRect().height), viewport: { width: innerWidth, height: innerHeight },
      room: Math.round(barTop - 40), barHeight: Math.round(innerHeight - barTop), position: getComputedStyle(aside).position,
      expanded: document.querySelector('[data-testid=media-output-group]')!.getAttribute('aria-expanded') === 'true',
      sideBySide: aside.getBoundingClientRect().left < document.querySelector('[data-slot=tool-detail-layout] main')!.getBoundingClientRect().left,
      // Clipped content: anything wider than its box that hides the rest (an ellipsis included), with its text; screen-reader text is clipped on purpose.
      overflowing: [...panel.querySelectorAll<HTMLElement>('*')]
        .filter(element => !element.classList.contains('sr-only') && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible')
        .map(element => `${element.tagName.toLowerCase()}.${element.className.toString().split(' ').slice(0, 3).join('.')} "${element.textContent?.slice(0, 60)}" ${element.scrollWidth}>${element.clientWidth}`),
    };
  });
  const initial = await facts();
  const toggleTo = async (expanded: boolean) => {
    if ((await group.getAttribute('aria-expanded') === 'true') !== expanded) await group.click();
    await uiExpect(group).toHaveAttribute('aria-expanded', String(expanded));
    await page.waitForTimeout(300);
  };
  await toggleTo(true);
  const open = await facts();
  await toggleTo(false);
  const folded = await facts();
  await toggleTo(initial.expanded);
  return { initial, openHeight: open.height, foldedHeight: folded.height, room: initial.room };
}

/** The panel's height and whether "output and performance" is open, as it stands. */
const panelFacts = (page: Page) => page.evaluate(() => ({
  height: Math.round(document.querySelector('[data-testid=media-converter-settings]')!.getBoundingClientRect().height),
  expanded: document.querySelector('[data-testid=media-output-group]')!.getAttribute('aria-expanded') === 'true',
}));

describeMediaUi('Media converter settings in Electron (T-WORKBENCH-02)', () => {
  let media: MediaApp | undefined;

  // As above: no app outlives its test, passed or not, and it is closed before the run folder is cleaned.
  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  // AC-WORKBENCH-03-1–4, AC-WORKBENCH-05-2; V-WORKBENCH-02-2 with FUSIONKIT_TEST_MEDIA_CAPS=cpu_only.
  it('settings: defaults per task, the codec sentences, the weak CPU encoder hint, the GPU tooltip and the fold, across windows, themes and languages', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } });
    const { page } = media;
    const evidence: Record<string, unknown> = {};
    const matrix: [Theme, 'zh' | 'en', number, number][] = [
      ['light', 'zh', 1280, 800], ['dark', 'en', 1280, 800], ['light', 'en', 1024, 700], ['dark', 'zh', 1024, 700], ['light', 'zh', 786, 540], ['dark', 'en', 786, 540],
    ];

    for (const [theme, language, width, height] of matrix) {
      const copy = SETTINGS_COPY[language];
      const label = `${theme}-${language}-${width}x${height}`;
      await openSettings(media, { theme, language });
      const viewport = await setWindowSize(media, { width, height });
      await waitForEngine(page, 'ready');
      await uiExpect(engineBadge(page)).toContainText(copy.cpuOnly);
      // A ready engine takes files (AC-WORKBENCH-05-1).
      await uiExpect(page.getByTestId('media-upload')).toHaveAttribute('data-state', 'ready');
      await uiExpect(uploadButton(page)).toBeEnabled();

      // The defaults of "compress video" on a computer without a hardware encoder (AC-WORKBENCH-03-2, AC-ENCODE-02-7).
      await uiExpect(segment(page, 'media-task-compress')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(segment(page, 'media-tier-balanced')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(segment(page, 'media-codec-h264')).toHaveAttribute('aria-checked', 'true');
      for (const codec of ['av1', 'hevc', 'h264'] as const) await uiExpect(segment(page, `media-codec-${codec}`)).toHaveText(copy.codec[codec]);
      await uiExpect(page.getByTestId('media-codec-compatibility')).toHaveText(copy.compatibility.h264);
      await uiExpect(segment(page, 'media-container-auto')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(page.getByTestId('media-resolution')).toHaveText(copy.original);
      await uiExpect(page.locator('#media-use-gpu')).toBeDisabled();
      await uiExpect(page.locator('#media-use-gpu')).toHaveAttribute('aria-checked', 'false');
      await uiExpect(page.getByTestId('media-use-gpu')).toContainText(copy.gpuHint);
      await uiExpect(page.locator('#media-discard-if-not-smaller')).toHaveAttribute('aria-checked', 'true');
      // Only the slow OpenH264 encodes H.264 here (AC-WORKBENCH-05-2). The link follows a Chinese full stop directly, an English one after a space.
      await uiExpect(page.getByTestId('media-weak-encoder')).toHaveText(`${copy.weakH264}${language === 'en' ? ' ' : ''}${copy.useAv1}`);
      await uiExpect(page.getByTestId('media-use-av1')).toHaveText(copy.useAv1);

      // The page as it opens, from the top.
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
      await settle(page, '[data-testid=media-converter-settings] *, h1');
      await shoot(page, run, `T-WORKBENCH-02-compress-${label}`);

      // Folded when the open panel is taller than the room the window leaves it (V-WORKBENCH-02-2).
      // The page keeps 6px clear of the bottom bar, so a panel within 6px of the room may go either way.
      const fit = await measurePanel(page);
      const margin = 6;
      if (fit.openHeight <= fit.room - margin) expect(fit.initial.expanded).toBe(true);
      if (fit.openHeight > fit.room) expect(fit.initial.expanded).toBe(false);
      if (fit.initial.sideBySide) {
        // Held in place only while what it shows fits; a panel taller than the room even folded scrolls with
        // the page instead, so its end can be reached.
        if (fit.initial.position === 'sticky') expect(fit.initial.height).toBeLessThanOrEqual(fit.room);
        if (fit.foldedHeight > fit.room) expect(fit.initial.position).toBe('static');
        if (fit.foldedHeight <= fit.room - margin) expect(fit.initial.position).toBe('sticky');
      }
      // At 1280×800 the folded panel fits and stays in view, even with the weak encoder hint of a CPU-only computer.
      if (width === 1280) expect({ position: fit.initial.position, expanded: fit.initial.expanded }).toEqual({ position: 'sticky', expanded: false });
      // Output format and maximum resolution share one row, their labels and controls on the same lines.
      const formatRow = await page.getByTestId('media-format-row').evaluate(row => {
        const [container, resolution] = [row.querySelector('[data-slot=segmented-control]')!, row.querySelector('[data-testid=media-resolution]')!].map(element => element.getBoundingClientRect());
        return {
          fieldTops: [...row.children].map(child => Math.round(child.getBoundingClientRect().top)),
          controlTops: [container.top, resolution.top].map(Math.round), controlHeights: [container.height, resolution.height].map(Math.round),
        };
      });
      expect(new Set(formatRow.fieldTops).size).toBe(1);
      expect(formatRow.controlTops[0]).toBe(formatRow.controlTops[1]);
      expect(formatRow.controlHeights[0]).toBe(formatRow.controlHeights[1]);
      evidence[`format-row-${label}`] = formatRow;
      expect(fit.initial.overflowing).toEqual([]);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      evidence[`compress-${label}`] = { viewport, ...fit };
      // The end of the panel, where the folded group docks to its border.
      if (fit.foldedHeight + 120 > viewport.height) {
        await bringIntoView(page, page.getByTestId('media-output-group'));
        await shoot(page, run, `T-WORKBENCH-02-compress-end-${label}`);
      }
    }

    // The three tasks with their defaults, and the three codec sentences, in both languages (1280×800).
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const copy = SETTINGS_COPY[language];
      const label = `${theme}-${language}`;
      await openSettings(media, { theme, language });
      await setWindowSize(media, { width: 1280, height: 800 });
      await waitForEngine(page, 'ready');

      for (const codec of ['av1', 'hevc', 'h264'] as const) {
        await segment(page, `media-codec-${codec}`).click();
        await uiExpect(page.getByTestId('media-codec-compatibility')).toHaveText(copy.compatibility[codec]);
        if (codec === 'av1') await uiExpect(page.getByTestId('media-weak-encoder')).toHaveCount(0);
        else await uiExpect(page.getByTestId('media-weak-encoder')).toContainText(codec === 'hevc' ? copy.weakHevc : copy.weakH264);
        await settle(page, '[data-testid=media-codec-field] *');
        await shoot(page, run, `T-WORKBENCH-02-codec-${codec}-${label}`, await clipAround(page, ['[data-testid=media-codec-field]']));
      }

      // The GPU switch cannot be turned on: the tooltip says why (AC-WORKBENCH-03-2).
      for (const [codec, reason] of [['h264', copy.gpuCodec], ['av1', copy.gpuHardware]] as const) {
        await segment(page, `media-codec-${codec}`).click();
        await page.getByTestId('media-use-gpu-reason-trigger').hover();
        await uiExpect(page.getByTestId('media-use-gpu-reason')).toContainText(reason);
        await uiExpect(page.locator('#media-use-gpu')).toBeDisabled();
        await settle(page, '[data-testid=media-use-gpu-reason]');
        await shoot(page, run, `T-WORKBENCH-02-gpu-tooltip-${codec}-${label}`, await clipAround(page, ['[data-testid=media-use-gpu-reason-trigger]', '[data-testid=media-use-gpu-reason]']));
        await leaveHover(page);
      }

      // "Use AV1" from the weak encoder hint, by keyboard: the hint goes away and the focus lands on the codec it chose.
      await segment(page, 'media-codec-hevc').click();
      await page.getByTestId('media-use-av1').focus();
      await page.keyboard.press('Enter');
      await uiExpect(segment(page, 'media-codec-av1')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(page.getByTestId('media-weak-encoder')).toHaveCount(0);
      await uiExpect(segment(page, 'media-codec-av1')).toBeFocused();

      // "Convert" and "extract audio", with their defaults (AC-WORKBENCH-03-3, AC-WORKBENCH-03-1).
      await segment(page, 'media-task-convert').click();
      await uiExpect(page.getByTestId('media-settings-convert')).toBeVisible();
      await uiExpect(page.getByTestId('media-codec-field')).toHaveCount(0);
      await uiExpect(page.getByTestId('media-convert-target')).toHaveText('MP4');
      await uiExpect(page.locator('#media-prefer-remux')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(segment(page, 'media-tier-balanced')).toHaveAttribute('aria-checked', 'true');
      await settle(page, '[data-testid=media-converter-settings] *');
      // Shorter than the room the window leaves it: "output and performance" opens by itself.
      await uiExpect(page.getByTestId('media-output-group')).toHaveAttribute('aria-expanded', 'true');
      evidence[`convert-${label}`] = await panelFacts(page);
      await shoot(page, run, `T-WORKBENCH-02-convert-${label}`, await clipAround(page, ['[data-testid=media-converter-settings]']));
      await page.getByTestId('media-convert-target').click();
      const options = page.getByRole('option');
      await uiExpect(options).toHaveText(['MP4', 'MKV', 'WebM', 'MOV', 'MP3', 'M4A (AAC)', 'Opus', 'FLAC', 'WAV', 'ALAC']);
      await settle(page, '[role=listbox]');
      await shoot(page, run, `T-WORKBENCH-02-convert-targets-${label}`, await clipAround(page, ['[data-testid=media-convert-target]', '[role=listbox]']));
      await page.getByRole('option', { name: 'FLAC' }).click();
      await uiExpect(page.getByTestId('media-convert-target')).toHaveText('FLAC');

      await segment(page, 'media-task-extract-audio').click();
      await uiExpect(page.getByTestId('media-extract-format')).toHaveText(copy.copyTrack);
      await uiExpect(page.getByTestId('media-settings-extract-audio').locator('[data-testid^=media-tier-]')).toHaveCount(0);
      await uiExpect(page.locator('#media-all-tracks')).toHaveAttribute('aria-checked', 'false');
      await settle(page, '[data-testid=media-converter-settings] *');
      await uiExpect(page.getByTestId('media-output-group')).toHaveAttribute('aria-expanded', 'true');
      evidence[`extract-${label}`] = await panelFacts(page);
      await shoot(page, run, `T-WORKBENCH-02-extract-${label}`, await clipAround(page, ['[data-testid=media-converter-settings]']));
      // A lossy format shows its quality tier.
      await page.getByTestId('media-extract-format').click();
      await page.getByRole('option', { name: 'Opus' }).click();
      await uiExpect(segment(page, 'media-tier-balanced')).toHaveAttribute('aria-checked', 'true');

      // Output and performance: overwrite warns; low-usage mode goes to the main process (AC-WORKBENCH-03-4).
      await segment(page, 'media-task-compress').click();
      const group = page.getByTestId('media-output-group');
      // The compress panel is taller: let it fold "output and performance" by itself before reading whether it is open.
      await settle(page, '[data-testid=media-converter-settings] *');
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
      await segment(page, 'media-conflict-overwrite').click();
      await uiExpect(page.getByTestId('media-overwrite-warning')).toHaveText(copy.overwrite);
      await uiExpect(page.getByTestId('media-low-usage')).toContainText(copy.lowUsageHint);
      await bringIntoView(page, page.getByTestId('media-low-usage'));
      await settle(page, '[data-testid=media-converter-settings] *');
      await shoot(page, run, `T-WORKBENCH-02-output-${label}`, await clipAround(page, ['[data-slot=tool-config-disclosure]']));
      await segment(page, 'media-conflict-number').click();
    }

    // Japanese, one screen (design 验证与风险): nothing clipped or pushed sideways.
    await openSettings(media, { theme: 'light', language: 'ja' });
    await setWindowSize(media, { width: 1280, height: 800 });
    await waitForEngine(page, 'ready');
    const japanese = await measurePanel(page);
    expect(japanese.initial.overflowing).toEqual([]);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    evidence['compress-light-ja-1280x800'] = japanese;
    await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
    await settle(page, '[data-testid=media-converter-settings] *, h1');
    await shoot(page, run, 'T-WORKBENCH-02-compress-light-ja-1280x800');

    // Escape closes the open select first and stays on the page (useToolPageEscape's order).
    await page.getByTestId('media-resolution').click();
    await uiExpect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(page.getByRole('listbox')).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(new URL(page.url()).hash).toBe(`#${ROUTE}`);

    await writeFile(path.join(run, 'T-WORKBENCH-02-settings.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 300_000);

  // AC-WORKBENCH-03-2/4: every setting but "overwrite" survives a restart; low-usage mode is the main process's; a vanished folder falls back.
  it('settings: restores the preferences after a restart, never overwrite, and falls back from a folder the engine no longer knows', async () => {
    const run = await createMediaRun();
    const folder = path.join(run, 'exports');
    await mkdir(folder, { recursive: true });
    const clip = await makeSample(run, 'h264-aac.mp4', 'picked.mp4');
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } });
    let page = media.page;
    const copy = SETTINGS_COPY.zh;
    await openSettings(media, { theme: 'light', language: 'zh' });
    await waitForEngine(page, 'ready');
    await stubDialogs(media.app, { directory: folder, files: [clip] });

    // The upload area opens the main-process dialog for every media type and adds what it returns.
    await uploadButton(page).click();
    await uiExpect(page.getByText(copy.added)).toBeVisible();
    const [pickCall] = await dialogCalls(media.app);
    expect(pickCall.properties).toEqual(['openFile', 'multiSelections']);
    expect(pickCall.filters.flatMap(filter => filter.extensions)).toEqual(expect.arrayContaining(['mp4', 'mkv', 'mp3', 'flac']));
    const added = await page.evaluate(() => window.mediaConverter!.getSnapshot());
    expect(added.ok && added.value.items.map(item => item.displayName)).toEqual(['picked.mp4']);

    await segment(page, 'media-tier-size').click();
    await page.getByTestId('media-use-av1').click();
    await segment(page, 'media-container-mkv').click();
    await page.getByTestId('media-resolution').click();
    await page.getByRole('option', { name: '720p' }).click();
    await page.locator('#media-discard-if-not-smaller').click();
    const group = page.getByTestId('media-output-group');
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
    await segment(page, 'media-output-directory').click();
    await uiExpect(segment(page, 'media-output-directory')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(page.locator('[data-slot=tool-config-disclosure] input')).toHaveValue('exports');
    await segment(page, 'media-conflict-overwrite').click();
    await page.locator('#media-low-usage').click();
    await uiExpect(page.locator('#media-low-usage')).toHaveAttribute('aria-checked', 'true');
    const options = await page.evaluate(() => window.mediaConverter!.getSnapshot());
    expect(options.ok && options.value.options).toEqual({ concurrency: 1, lowUsage: true });
    const stored = await page.evaluate(key => localStorage.getItem(key), PREFERENCES_KEY);
    expect(stored).not.toContain('overwrite');
    expect(stored).not.toContain('lowUsage');
    expect(stored).not.toContain(run.replaceAll('\\', '\\\\'));

    // A restart with the same profile.
    await media.close();
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } });
    page = media.page;
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });
    await settingsPanel(page).waitFor();
    await waitForEngine(page, 'ready');
    await uiExpect(segment(page, 'media-tier-size')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(segment(page, 'media-codec-av1')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(segment(page, 'media-container-mkv')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(page.getByTestId('media-resolution')).toHaveText('720p');
    await uiExpect(page.locator('#media-discard-if-not-smaller')).toHaveAttribute('aria-checked', 'false');
    const restoredGroup = page.getByTestId('media-output-group');
    if (await restoredGroup.getAttribute('aria-expanded') !== 'true') await restoredGroup.click();
    await uiExpect(segment(page, 'media-output-directory')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(page.locator('[data-slot=tool-config-disclosure] input')).toHaveValue('exports');
    // "Overwrite" is for one session only; low-usage mode came back from the main process.
    await uiExpect(segment(page, 'media-conflict-number')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(page.getByTestId('media-overwrite-warning')).toHaveCount(0);
    await uiExpect(page.locator('#media-low-usage')).toHaveAttribute('aria-checked', 'true');

    // A folder id the engine no longer lists: back to "beside the source", with a notice.
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).state, PREFERENCES_KEY);
    await openSettings(media, { theme: 'light', language: 'zh' }, { ...saved, output: { mode: 'directory', directory: { id: 'vanished_folder', displayName: 'old exports' } } });
    await uiExpect(page.getByText(copy.missing)).toBeVisible();
    const fallbackGroup = page.getByTestId('media-output-group');
    if (await fallbackGroup.getAttribute('aria-expanded') !== 'true') await fallbackGroup.click();
    await uiExpect(segment(page, 'media-output-source')).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).state.output, PREFERENCES_KEY)).toEqual({ mode: 'source' });
    await shoot(page, run, 'T-WORKBENCH-02-folder-fallback-light-zh');

    // Low-usage mode off again, through the main process, by keyboard: the switch keeps the focus while it is saved.
    await page.locator('#media-low-usage').focus();
    await page.keyboard.press('Space');
    await uiExpect(page.locator('#media-low-usage')).toHaveAttribute('aria-checked', 'false');
    await uiExpect(page.locator('#media-low-usage')).toBeFocused();
    const switched = await page.evaluate(() => window.mediaConverter!.getSnapshot());
    expect(switched.ok && switched.value.options.lowUsage).toBe(false);
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 180_000);

  // AC-WORKBENCH-05-1, AC-ENCODE-02-7 with FUSIONKIT_TEST_MEDIA_CAPS=nvenc: HEVC by default, NVENC in the badge, the GPU switch for AV1.
  it('settings: an NVENC computer defaults to HEVC, offers the GPU for AV1, names the driver update and blocks detecting again during a hardware encode', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, switches: { caps: 'nvenc' }, size: { width: 1280, height: 800 } });
    const { app, page } = media;
    const evidence: Record<string, unknown> = {};
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const copy = SETTINGS_COPY[language];
      const label = `${theme}-${language}`;
      await openSettings(media, { theme, language });
      await waitForEngine(page, 'ready');
      await uiExpect(engineBadge(page)).toContainText(copy.nvenc);
      await uiExpect(segment(page, 'media-codec-hevc')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(page.getByTestId('media-codec-compatibility')).toHaveText(copy.compatibility.hevc);
      for (const codec of ['hevc', 'h264', 'av1'] as const) {
        await segment(page, `media-codec-${codec}`).click();
        await uiExpect(page.getByTestId('media-weak-encoder')).toHaveCount(0);
      }
      // AV1 with its hardware encoder: the switch works and says what it costs.
      await uiExpect(page.locator('#media-use-gpu')).toBeEnabled();
      await uiExpect(page.getByTestId('media-use-gpu-reason-trigger')).toHaveCount(0);
      await page.locator('#media-use-gpu').click();
      await uiExpect(page.locator('#media-use-gpu')).toHaveAttribute('aria-checked', 'true');
      await settle(page, '[data-testid=media-converter-settings] *');
      await shoot(page, run, `T-WORKBENCH-02-gpu-enabled-${label}`, await clipAround(page, ['[data-testid=media-codec-field]', '[data-testid=media-use-gpu]']));
      // Another codec turns it off and explains why.
      await segment(page, 'media-codec-hevc').click();
      await uiExpect(page.locator('#media-use-gpu')).toBeDisabled();
      await uiExpect(page.locator('#media-use-gpu')).toHaveAttribute('aria-checked', 'false');

      await page.getByTestId('media-engine-badge').hover();
      const details = page.getByTestId('media-engine-details');
      await uiExpect(details).toContainText('NVIDIA NVENC HEVC');
      // One encoder per line, never broken inside a name.
      await uiExpect(page.getByTestId('media-engine-encoders').locator('li')).toHaveText(['NVIDIA NVENC AV1', 'NVIDIA NVENC HEVC', 'NVIDIA NVENC H.264']);
      await settle(page, '[data-testid=media-engine-details]');
      await shoot(page, run, `T-WORKBENCH-02-engine-ready-nvenc-${label}`, await clipAround(page, [HEADER, '[data-testid=media-engine-details]']));
      await leaveHover(page);

      // The engine reports a driver too old for NVENC (AC-ENGINE-03-4), as a computer with that driver would: no
      // graphics encoder works, every codec falls to the CPU, and the badge warns and names the version.
      const snapshot = await page.evaluate(() => window.mediaConverter!.getSnapshot());
      if (!snapshot.ok || snapshot.value.engine.capabilities.state !== 'ready') throw new Error('The engine is not ready');
      const ready = snapshot.value.engine;
      const outdated = {
        ...ready,
        capabilities: { ...ready.capabilities, hardwareEncoders: [], resolvedEncoders: CPU_RESOLVED_ENCODERS, defaults: { compressCodec: 'h264' }, driverUpdates: [{ family: 'nvenc', minimumVersion: '570' }] },
      };
      await sendQueueEvent(app, { sequence: snapshot.value.sequence + 1_000, kind: 'engine', engine: outdated });
      await uiExpect(engineBadge(page)).toHaveAttribute('data-warning', 'true');
      await uiExpect(engineBadge(page)).toContainText(copy.cpuOnly);
      await page.getByTestId('media-engine-badge').hover();
      await uiExpect(page.getByTestId('media-engine-driver-update')).toHaveText(copy.driver);
      await uiExpect(page.getByTestId('media-engine-encoders')).toHaveCount(0);
      await settle(page, '[data-testid=media-engine-details]');
      await shoot(page, run, `T-WORKBENCH-02-engine-driver-update-${label}`, await clipAround(page, ['[data-testid=media-engine-status]', '[data-testid=media-engine-details]']));
      await leaveHover(page);

      // A hardware encode runs: "detect again" waits for it (AC-WORKBENCH-05-1).
      await sendQueueEvent(app, { sequence: snapshot.value.sequence + 1_001, kind: 'engine', engine: ready });
      await uiExpect(engineBadge(page)).toContainText(copy.nvenc);
      await uiExpect(engineBadge(page)).not.toHaveAttribute('data-warning', 'true');
      await uiExpect(page.getByTestId('media-engine-redetect')).toBeEnabled();
      await sendQueueEvent(app, { sequence: snapshot.value.sequence + 1_002, kind: 'items', removed: [], items: [hardwareRunningItem()] });
      await uiExpect(page.getByTestId('media-engine-redetect')).toBeDisabled();
      await page.getByTestId('media-engine-redetect-wrapper').hover();
      await uiExpect(page.getByTestId('media-engine-redetect-tooltip')).toContainText(copy.redetectBusy);
      await settle(page, '[data-testid=media-engine-redetect-tooltip]');
      await shoot(page, run, `T-WORKBENCH-02-engine-redetect-busy-${label}`, await clipAround(page, ['[data-testid=media-engine-status]', '[data-testid=media-engine-redetect-tooltip]']));
      await leaveHover(page);
      evidence[label] = { snapshotSequence: snapshot.value.sequence };
    }
    await writeFile(path.join(run, 'T-WORKBENCH-02-nvenc.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 180_000);

  // AC-WORKBENCH-05-1 with FUSIONKIT_TEST_MEDIA_CAPS=detecting_ms: detecting, then ready; detecting again.
  it('settings: shows the detection while it runs, keeps the GPU switch off until it ends, and detects again on request', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, switches: { caps: 'detecting_ms:10000' }, size: { width: 1280, height: 800 } });
    const { page } = media;
    const copy = SETTINGS_COPY.zh;
    await openSettings(media, { theme: 'light', language: 'zh' });
    await waitForEngine(page, 'detecting');
    await uiExpect(engineBadge(page)).toContainText(copy.detecting);
    await uiExpect(page.getByTestId('media-engine-redetect')).toBeDisabled();
    // Files can be added while the encoders are detected; only the start waits (module-engine R-ENGINE-03).
    await uiExpect(page.getByTestId('media-upload')).toHaveAttribute('data-state', 'ready');
    await uiExpect(uploadButton(page)).toBeEnabled();
    // No weak hint before the detection has said which encoders work.
    await uiExpect(page.getByTestId('media-weak-encoder')).toHaveCount(0);
    await segment(page, 'media-codec-av1').click();
    await page.getByTestId('media-use-gpu-reason-trigger').hover();
    await uiExpect(page.getByTestId('media-use-gpu-reason')).toContainText(copy.gpuDetecting);
    await shoot(page, run, 'T-WORKBENCH-02-engine-detecting-light-zh', await clipAround(page, [HEADER]));
    await leaveHover(page);
    await waitForEngine(page, 'ready');
    await uiExpect(engineBadge(page)).toContainText(copy.cpuOnly);
    await shoot(page, run, 'T-WORKBENCH-02-engine-ready-cpu-light-zh', await clipAround(page, [HEADER]));

    // Detect again: detecting for another 10 s, then ready.
    await page.getByTestId('media-engine-redetect').click();
    await waitForEngine(page, 'detecting');
    await uiExpect(page.getByTestId('media-engine-redetect')).toBeDisabled();
    await setAppearance(page, { theme: 'dark', language: 'en', route: ROUTE });
    await uiExpect(engineBadge(page)).toContainText(SETTINGS_COPY.en.detecting);
    await shoot(page, run, 'T-WORKBENCH-02-engine-detecting-dark-en', await clipAround(page, [HEADER]));
    await waitForEngine(page, 'ready');
    await uiExpect(page.getByTestId('media-engine-redetect')).toBeEnabled();
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 120_000);

  // AC-WORKBENCH-05-1 with FUSIONKIT_TEST_MEDIA_CAPS=unavailable:runtime_invalid: the reason and the advice.
  it('settings: says why the engine is unavailable and what to do', async () => {
    const run = await createMediaRun();
    media = await launchMediaApp({ run, switches: { caps: 'unavailable:runtime_invalid' }, size: { width: 1280, height: 800 } });
    const { page } = media;
    for (const [theme, language, width, height] of [['light', 'zh', 1280, 800], ['dark', 'en', 786, 540]] as [Theme, 'zh' | 'en', number, number][]) {
      const copy = SETTINGS_COPY[language];
      const label = `${theme}-${language}-${width}x${height}`;
      await openSettings(media, { theme, language });
      await setWindowSize(media, { width, height });
      await waitForEngine(page, 'unavailable');
      await uiExpect(engineBadge(page)).toContainText(copy.unavailable);
      // The upload area is disabled and says why (AC-WORKBENCH-05-1).
      const upload = page.getByTestId('media-upload');
      await uiExpect(upload).toHaveAttribute('data-state', 'unavailable');
      await uiExpect(uploadButton(page)).toBeDisabled();
      // The file-type menu next to it as well (T-WORKBENCH-03).
      await uiExpect(page.getByTestId('media-upload-filter')).toBeDisabled();
      await uiExpect(page.getByTestId('media-upload-reason')).toHaveText(copy.uploadUnavailable);
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
      await settle(page, '[data-testid=media-converter] *');
      await shoot(page, run, `T-WORKBENCH-02-unavailable-page-${label}`);
      await page.getByTestId('media-engine-badge').hover();
      await uiExpect(page.getByTestId('media-engine-details')).toContainText(copy.advice);
      await settle(page, '[data-testid=media-engine-details]');
      expect(await hasHorizontalOverflow(page)).toBe(false);
      await shoot(page, run, `T-WORKBENCH-02-engine-unavailable-${label}`, await clipAround(page, [HEADER, '[data-testid=media-engine-details]']));
      await leaveHover(page);
      // Detecting again is allowed (and answers the same here).
      await uiExpect(page.getByTestId('media-engine-redetect')).toBeEnabled();
    }
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 120_000);
});

/** A change event as the main process sends it (`media-converter:changed`); the preload checks it like any other. */
async function sendQueueEvent(app: MediaApp['app'], event: unknown) {
  await app.evaluate(({ BrowserWindow }, event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('media-converter:changed', event);
  }, event);
}

/** What every codec resolves to on a computer without a working graphics encoder (as `cpu_only` reports it). */
const CPU_RESOLVED_ENCODERS = (() => {
  const cpu = (encoder: string, variant: string, weak: boolean) => ({ encoder, variant, hardware: false, weak, nameKey: `media:encoders.${encoder}` });
  const pair = (encoder: string, variant: string, weak: boolean) => ({ gpuOff: cpu(encoder, variant, weak), gpuOn: cpu(encoder, variant, weak) });
  return { av1: pair('libsvtav1', '10bit', false), hevc: pair('libkvazaar', '8bit', true), h264: pair('libopenh264', '8bit', true) };
})();

/** A queue item that runs on NVENC, as the queue would summarise it. */
function hardwareRunningItem() {
  return {
    id: 'hardware_run', displayName: 'running.mp4', folderName: 'media', media: null, state: { status: 'running', phase: 'encoding' },
    job: {
      settings: { task: 'compress', tier: 'balanced', codec: 'hevc', container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true },
      plan: {
        task: 'compress', remuxOnly: false, encoders: [{ encoder: 'hevc_nvenc', variant: '10bit_uhq' }], warnings: [], confirmations: [],
        outputs: [{ container: 'mp4', extension: 'mp4', track: null, streams: [], attachments: { count: 0, kept: true }, chapters: { count: 0, kept: true }, dataStreamsDropped: 0 }],
      },
      output: { mode: 'source', directoryName: null, conflict: 'number' },
    },
    progress: null, result: null, log: null, addedAt: 1, finishedAt: null,
  };
}

// ── T-WORKBENCH-03: adding files, media information, plans and loss warnings ─────────────────────

/**
 * The long name of design 内容与验收样本, made longer still so that even the widest row cuts it: CJK brackets
 * and spaces, the middle gives way, the end with the extension stays.
 */
const LONG_NAME = '【4K HDR】2026 年家庭聚会 - 第三部分（完整版）爷爷奶奶八十大寿全家福合影与晚宴现场完整实录（含花絮与采访）· 多机位剪辑终版 final_final_v2.mkv';

const SRT = '1\r\n00:00:00,200 --> 00:00:01,500\r\nHello\r\n';
/** Two styles, a positioned sign and overlapping events: the probe calls it styled (AC-ENCODE-01-8). */
const STYLED_ASS = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 320', 'PlayResY: 180', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1',
  'Style: Sign,Arial,16,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,8,10,10,10,1', '',
  '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.20,0:00:01.50,Default,,0,0,0,,Hello', 'Dialogue: 0,0:00:00.20,0:00:01.50,Sign,,0,0,0,,{\\pos(160,20)}Sign', '',
].join('\r\n');

/**
 * A raw PGS (.sup) stream with one 64×16 caption from 0.2 s to 1.6 s, as a Blu-ray carries it. ffmpeg
 * cannot make image subtitles out of text, so the segments (PCS, WDS, PDS, ODS with run-length lines, END)
 * are written here and muxed as they are.
 */
function pgsCaption(): Buffer {
  const u16 = (value: number) => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; };
  const segment = (pts: number, type: number, payload: Buffer) => {
    const header = Buffer.alloc(13);
    header.write('PG', 0, 'latin1');
    header.writeUInt32BE(pts, 2);
    header.writeUInt8(type, 10);
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
  };
  const [width, height] = [64, 16];
  const composition = (number: number, state: number, objects: number) => Buffer.concat([u16(320), u16(180), Buffer.from([0x10]), u16(number),
    Buffer.from([state, 0, 0, objects]), ...(objects ? [u16(0), Buffer.from([0, 0]), u16(128), u16(150)] : [])]);
  const window = Buffer.concat([Buffer.from([1, 0]), u16(128), u16(150), u16(width), u16(height)]);
  const palette = Buffer.from([0, 0, 1, 235, 128, 128, 255]);
  // One line: `00 11LLLLLL LLLLLLLL CC` (64 pixels of colour 1), then `00 00`.
  const rle = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0x00, 0xc0 | (width >> 8), width & 0xff, 0x01, 0x00, 0x00])));
  const length = 4 + rle.length;
  const object = Buffer.concat([u16(0), Buffer.from([0, 0xc0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]), u16(width), u16(height), rle]);
  const [show, hide] = [0.2 * 90_000, 1.6 * 90_000];
  return Buffer.concat([
    segment(show, 0x16, composition(0, 0x80, 1)), segment(show, 0x17, window), segment(show, 0x14, palette), segment(show, 0x15, object), segment(show, 0x80, Buffer.alloc(0)),
    segment(hide, 0x16, composition(1, 0x00, 0)), segment(hide, 0x17, window), segment(hide, 0x80, Buffer.alloc(0)),
  ]);
}

interface FileSamples {
  /**
   * HEVC 1080×1920 at a variable rate (as phones record), tagged HDR10 in its bitstream, two 44.1 kHz AAC tracks and a
   * text subtitle: the vertical sample of design 内容与验收样本 at its real size, as its metadata is what the row shows.
   */
  vertical: string;
  /** H.264 and AAC in Matroska with two PGS subtitles and a styled ASS one. */
  subtitles: string;
  long: string;
  /** FLAC with a PNG cover: audio only. */
  cover: string;
  /** A text file named .mp4, a playlist and a WeChat voice message: none can be converted. */
  notMedia: string;
  playlist: string;
  silk: string;
  /** Matroska holding only a subtitle track: a container, but no audio or video in it. */
  subtitleOnly: string;
}

/** The samples of design 内容与验收样本, made in the run folder at idle priority: 2 s at most. */
async function makeFileSamples(run: string): Promise<FileSamples> {
  const folder = path.join(run, 'media');
  await mkdir(folder, { recursive: true });
  const write = async (name: string, content: string | Buffer) => { const file = path.join(folder, name); await writeFile(file, content); return file; };
  const [srt, ass, sup] = await Promise.all([write('caption.srt', SRT), write('styled.ass', STYLED_ASS), write('caption.sup', pgsCaption())]);
  const coverArt = await makeMedia(run, 'cover.png', ['-f', 'lavfi', '-i', 'color=c=orange:s=128x128', '-frames:v', '1', '-update', '1', '-c:v', 'png']);
  const [vertical, subtitles, long, cover] = await Promise.all([
    makeMedia(run, 'vertical-hdr.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30000/1001:duration=2', ...lavfi.tone({ frequency: 440, sampleRate: 44_100 }), ...lavfi.tone({ frequency: 660, sampleRate: 44_100 }), '-i', `file:${srt}`,
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
      // A third of the frames over the first second: base rate 29.97, a lower average.
      '-vf', 'select=if(lt(t\\,1)\\,not(mod(n\\,3))\\,1)', '-fps_mode', 'vfr',
      // kvazaar writes no colour description; the bitstream filter puts BT.2020 + PQ into the VUI, as an HDR10 phone video has it.
      '-c:v', 'libkvazaar', '-kvazaar-params', 'preset=ultrafast', '-pix_fmt', 'yuv420p', '-bsf:v', 'hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9',
      // No -shortest: it would end the file before the subtitle packets are muxed (the inputs are all 2 s long anyway).
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-c:s', 'mov_text',
    ]),
    makeMedia(run, 'subtitles.mkv', [
      ...lavfi.video(), ...lavfi.tone(), '-i', `file:${sup}`, '-i', `file:${sup}`, '-i', `file:${ass}`,
      '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s', '-map', '4:s', '-c:v', 'libopenh264', '-b:v', '300k', '-c:a', 'aac', '-b:a', '96k', '-c:s', 'copy',
      '-metadata:s:s:0', 'language=chi', '-metadata:s:s:1', 'language=eng', '-metadata:s:s:2', 'language=jpn',
    ]),
    makeMedia(run, LONG_NAME, [...lavfi.video(), ...lavfi.tone(), '-c:v', 'libopenh264', '-b:v', '300k', '-c:a', 'aac', '-b:a', '96k', '-shortest']),
    makeMedia(run, 'cover.flac', [...lavfi.tone(), '-i', `file:${coverArt}`, '-map', '0:a', '-map', '1:v', '-ac', '2', '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic']),
  ]);
  const [notMedia, playlist, silk] = await Promise.all([
    write('notes.mp4', 'These are meeting notes saved with the wrong extension, not a video.\r\n'),
    write('playlist.m3u8', '#EXTM3U\r\n#EXTINF:2,\r\nvertical-hdr.mp4\r\n'),
    write('voice.silk', Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3', 'latin1'), Buffer.alloc(512, 0x5a)])),
  ]);
  const subtitleOnly = await makeMedia(run, 'subtitles-only.mkv', ['-i', `file:${srt}`, '-c:s', 'copy']);
  return { vertical, subtitles, long, cover, notMedia, playlist, silk, subtitleOnly };
}

const FILES_COPY = {
  zh: {
    analyzing: '分析中…', vfr: /约 \d+(\.\d)? fps（可变帧率）/, notApplicable: '当前任务不适用', audioCompress: '这是音频文件，「压缩视频」只处理视频', toMp3: '改为转换成 MP3',
    stereo: '立体声', tracks: '2 条音轨', subtitle: '1 条字幕', subtitles: '3 条字幕', cover: '含封面', hdr: 'HDR10', planTitle: '处理计划',
    duplicate: (name: string) => `「${name}」已在列表中，没有重复加入。`,
    folder: (name: string) => `「${name}」是文件夹：暂不支持文件夹，请选择其中的文件。`,
    tempCopy: (name: string) => `「${name}」是临时副本，找不到原文件：请先解压，或用选择文件添加。`,
    unreadable: (name: string) => `「${name}」无法读取：找不到它在磁盘上的位置，请用选择文件添加。`,
    added100: '已加入 100 个文件。', truncated: '一次最多加入 100 个文件，另有 1 个没有加入。', queueFull: '列表已满（最多 500 个），另有 3 个文件没有加入。', dropLabel: '松开以加入音视频转换', remove: '移除',
    separator: '、', filters: ['只选视频文件', '只选音频文件', '所有音视频文件'],
  },
  en: {
    analyzing: 'Analyzing…', vfr: /~\d+(\.\d)? fps \(variable\)/, notApplicable: 'Not for this task', audioCompress: 'This is an audio file; Compress handles videos', toMp3: 'Convert to MP3 instead',
    stereo: 'Stereo', tracks: '2 audio tracks', subtitle: '1 subtitle', subtitles: '3 subtitles', cover: 'Cover art', hdr: 'HDR10', planTitle: 'Plan',
    duplicate: (name: string) => `“${name}” is already in the list, so it was not added again.`,
    folder: (name: string) => `“${name}” is a folder. Folders are not supported yet; choose the files inside it.`,
    tempCopy: (name: string) => `“${name}” is a temporary copy whose original cannot be found. Extract it first, or add it with Choose files.`,
    unreadable: (name: string) => `“${name}” cannot be read: its place on disk is unknown. Add it with Choose files.`,
    added100: '100 files added.', truncated: 'Up to 100 files can be added at a time; 1 more was not added.', queueFull: 'The list is full (500 files at most); 3 more were not added.', dropLabel: 'Release to add to the Media Converter', remove: 'Remove',
    separator: ', ', filters: ['Video files only', 'Audio files only', 'All audio and video files'],
  },
} as const;

/** Why a file cannot be processed, and what to do, by the code the engine gives it (AC-WORKBENCH-02-3). */
const PROBE_COPY: Record<'zh' | 'en', Record<string, [string, string]>> = {
  zh: {
    no_media_streams: ['不是音视频文件', '请选择视频或音频文件。'],
    probe_failed: ['文件已损坏或无法读取', '请确认文件能正常播放，或换一个文件。'],
    container_not_allowed: ['文件格式不受支持（如播放列表）', '请添加播放列表指向的实际音视频文件。'],
    wechat_silk_unsupported: ['微信语音格式暂不支持', '这类语音暂时无法转换。'],
  },
  en: {
    no_media_streams: ['Not an audio or video file', 'Choose a video or audio file.'],
    probe_failed: ['The file is damaged or cannot be read', 'Check that the file plays, or try another file.'],
    container_not_allowed: ['Unsupported file type (such as a playlist)', 'Add the actual media files the playlist points to.'],
    wechat_silk_unsupported: ['WeChat voice messages are not supported yet', 'This kind of voice message cannot be converted yet.'],
  },
};

/** Friendly encoder names (media:encoders) the plans of these samples can name. */
const ENCODER_NAMES: Record<'zh' | 'en', Record<string, string>> = {
  zh: { libopenh264: 'OpenH264（CPU）', libsvtav1: 'SVT-AV1（CPU）', libkvazaar: 'Kvazaar HEVC（CPU）', aac: 'AAC', mov_text: 'MP4 文本字幕', libmp3lame: 'MP3（LAME）', flac: 'FLAC' },
  en: { libopenh264: 'OpenH264 (CPU)', libsvtav1: 'SVT-AV1 (CPU)', libkvazaar: 'Kvazaar HEVC (CPU)', aac: 'AAC', mov_text: 'MP4 text subtitles', libmp3lame: 'MP3 (LAME)', flac: 'FLAC' },
};

/** The loss sentences (media:warnings) these samples can bring. */
const LOSS_COPY: Record<'zh' | 'en', Record<string, (count: number) => string>> = {
  zh: {
    hdr_tonemapped: () => 'HDR 将转为 SDR', subtitle_styling_lost: () => 'ASS 字幕样式将丢失', cover_dropped: () => '封面将被丢弃',
    subtitle_dropped: count => `${count} 条图形字幕将被丢弃`, chapters_dropped: () => '章节信息将被丢弃', downmixed_to_stereo: () => '多声道音频将缩混为立体声',
  },
  en: {
    hdr_tonemapped: () => 'HDR will be converted to SDR', subtitle_styling_lost: () => 'ASS subtitle styling will be lost', cover_dropped: () => 'The cover art will be dropped',
    subtitle_dropped: count => `${count} image subtitle${count === 1 ? '' : 's'} will be dropped`, chapters_dropped: () => 'Chapters will be dropped',
    downmixed_to_stereo: () => 'Multichannel audio will be downmixed to stereo',
  },
};
const LOSS_CODES = new Set(['subtitle_dropped', 'attachment_dropped', 'cover_dropped', 'chapters_dropped', 'subtitle_styling_lost', 'hdr_tonemapped', 'dolby_vision_rpu_dropped', 'downmixed_to_stereo', 'chroma_subsampled']);

/** The four files nothing can convert: a text file named .mp4, a playlist, a WeChat voice message, a subtitle-only MKV. */
const UNSUPPORTED_NAMES = ['notes.mp4', 'playlist.m3u8', 'voice.silk', 'subtitles-only.mkv'];

/** The row of a file by its name (the row's own name, not an output's). */
const queueRow = (page: Page, name: string) => page.locator('[data-testid=media-queue-row]').filter({ has: page.locator(`.studio-task-name .studio-file-name .sr-only`, { hasText: name }) });
const queueItems = async (page: Page): Promise<ItemSummary[]> => {
  const snapshot = await page.evaluate(() => window.mediaConverter!.getSnapshot());
  if (!snapshot.ok) throw new Error(`No snapshot: ${snapshot.error.code}`);
  return snapshot.value.items;
};
const itemNamed = async (page: Page, name: string) => {
  const item = (await queueItems(page)).find(entry => entry.displayName === name);
  if (!item) throw new Error(`${name} is not in the queue`);
  return item;
};
/** The plan the main process makes for an item with these settings, asked the way the page asks (AC-WORKBENCH-03-5). */
async function mainPlan(page: Page, itemId: string, settings: ConversionSettings): Promise<PreviewPlanResult> {
  const result = await page.evaluate(request => window.mediaConverter!.previewPlan(request), { itemId, settings });
  if (!result.ok) throw new Error(`No plan: ${result.error.code}`);
  return result.value;
}
const compressSettings = (patch: Partial<Extract<ConversionSettings, { task: 'compress' }>> = {}): ConversionSettings =>
  ({ task: 'compress', tier: 'balanced', codec: 'h264', container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true, ...patch });

/** The loss line the row should show for a plan: its loss warnings in plan order (AC-WORKBENCH-03-6). */
const expectedLossLine = (plan: PlanSummary, language: 'zh' | 'en') => plan.warnings.filter(warning => LOSS_CODES.has(warning.code))
  .map(warning => LOSS_COPY[language][warning.code](warning.count)).join(FILES_COPY[language].separator);

type PlanCall = { at: number; itemId: string; settings: Record<string, unknown> };
type PlanCallGlobals = typeof globalThis & { __mediaPlanCalls?: PlanCall[] };

/**
 * Records every `preview-plan` request the main process receives, with its time, by wrapping the handler
 * the media converter registered on ipcMain (test-only, like the dialog stubs; Electron keeps the handlers
 * in `ipcMain._invokeHandlers`).
 */
async function recordPlanRequests(app: MediaApp['app']) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
    const channel = 'media-converter:preview-plan';
    const original = handlers?.get(channel);
    if (!handlers || !original) throw new Error('ipcMain keeps no preview-plan handler to observe');
    const globals = globalThis as PlanCallGlobals;
    globals.__mediaPlanCalls = [];
    handlers.set(channel, (event, request, ...rest) => {
      const value = request as { itemId?: string; settings?: Record<string, unknown> } | undefined;
      globals.__mediaPlanCalls!.push({ at: Date.now(), itemId: String(value?.itemId), settings: value?.settings ?? {} });
      return original(event, request, ...rest);
    });
  });
}
const planCalls = (app: MediaApp['app']) => app.evaluate(() => [...((globalThis as PlanCallGlobals).__mediaPlanCalls ?? [])]);

/**
 * Answers the next `pick-files` request with `value`, as the main process would, without asking the queue
 * (test-only, like `recordPlanRequests`); the request after it goes to the real handler again. For outcomes
 * too costly to bring about, such as a queue holding 500 unfinished items.
 */
async function answerNextPick(app: MediaApp['app'], value: AddFilesResult) {
  await app.evaluate(({ ipcMain }, value) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    const channel = 'media-converter:pick-files';
    const original = handlers?.get(channel);
    if (!handlers || !original) throw new Error('ipcMain keeps no pick-files handler to answer');
    handlers.set(channel, () => {
      handlers.set(channel, original);
      return { ok: true, value };
    });
  }, value);
}

/**
 * Drags paths onto `target` the way Explorer does, through Chromium's own drag pipeline (CDP
 * Input.dispatchDragEvent with files): the page gets OS-backed Files, a folder included, which a
 * DataTransfer made in the page cannot hold. `drop()` releases, `cancel()` lets go outside.
 */
async function startNativeDrag(page: Page, target: Locator, paths: string[]) {
  const session = await page.context().newCDPSession(page);
  const box = (await target.boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
  return {
    drop: async () => {
      await session.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
      await session.detach();
    },
  };
}
const dropNatively = async (page: Page, target: Locator, paths: string[]) => (await startNativeDrag(page, target, paths)).drop();

/**
 * Launches the app with its %TEMP% in the run folder (the only change in its environment), so a file
 * dropped from there is what Explorer hands over for a file inside an archive: a Shell copy whose
 * original the main process cannot prove (FK-PIT-0099). The real %TEMP% is never used.
 */
async function launchWithShellTemp(options: LaunchOptions, temp: string) {
  await mkdir(temp, { recursive: true });
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = temp;
  process.env.TMP = temp;
  try {
    return await launchMediaApp(options);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Scrolls the app's scroll area so the row `selector` starts just below the fixed title bar, the rows after it above the bottom bar. */
async function showRowsFrom(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => {
    element.scrollIntoView({ block: 'start' });
    const viewport = element.closest('[data-slot=scroll-area-viewport]');
    if (viewport) viewport.scrollTop -= 64;
  });
  await page.mouse.move(2, 120, { steps: 4 });
  await settle(page, QUEUE_BOXES);
}

/**
 * The queue's boxes for `settle`, less its icons: a spinning icon (analyzing, running) turns, and its box with it,
 * every frame.
 */
const QUEUE_BOXES = '[data-testid=media-queue] *:not(svg):not(svg *)';

/** Rows and their parts against the row: nothing sticks out, chips wrap, the name is cut in its middle (AC-WORKBENCH-02-2). */
const rowGeometry = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid=media-queue-row]')].map(row => {
  const box = row.getBoundingClientRect();
  const inner = { left: box.left + 8, right: box.right - 8 };
  const groups = [...row.querySelectorAll<HTMLElement>('[data-testid^=media-meta-]')].filter(element => element.dataset.testid !== 'media-meta-hdr');
  const lines = new Set(groups.map(group => Math.round(group.getBoundingClientRect().top))).size;
  const meta = row.querySelector<HTMLElement>('[data-testid=media-meta]');
  // What the groups would take on one line, against what the row gives them.
  const oneLine = meta ? groups.reduce((sum, group) => sum + group.getBoundingClientRect().width, 0) + Math.max(0, groups.length - 1) * parseFloat(getComputedStyle(meta).columnGap) : 0;
  const start = row.querySelector<HTMLElement>('.studio-file-name-start');
  const remove = row.querySelector<HTMLElement>('[data-testid=media-row-remove]')?.getBoundingClientRect();
  return {
    name: row.querySelector('.studio-file-name .sr-only')?.textContent ?? '',
    state: row.dataset.state,
    height: Math.round(box.height),
    metaLines: lines,
    metaFits: meta ? oneLine <= meta.clientWidth + 0.5 : true,
    overflow: [...row.querySelectorAll<HTMLElement>('*')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && !element.closest('.studio-file-name') && (rect.right > inner.right + 0.5 || rect.left < inner.left - 0.5);
    }).map(element => `${element.tagName.toLowerCase()}[${element.dataset.testid ?? element.className.toString().slice(0, 40)}]`),
    nameCut: start ? start.scrollWidth > start.clientWidth : false,
    nameEnd: row.querySelector('.studio-file-name-end')?.textContent ?? '',
    removeInset: remove ? { top: Math.round(remove.top - box.top), right: Math.round(box.right - remove.right) } : null,
  };
}));

describeMediaUi('Media converter files, media information and plans in Electron (T-WORKBENCH-03)', () => {
  let media: MediaApp | undefined;

  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  // AC-WORKBENCH-02-1–3, AC-WORKBENCH-03-5, AC-WORKBENCH-03-6; V-WORKBENCH-03-2 (dialog and drop, the rows, the plan).
  it('files: adds by the dialog and by drop, shows the media information, unsupported and not-applicable rows, the loss line and the plan', async () => {
    const run = await createMediaRun();
    const samples = await makeFileSamples(run);
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } });
    const { app, page } = media;
    const evidence: Record<string, unknown> = {};
    await openSettings(media, { theme: 'light', language: 'zh' });
    await waitForEngine(page, 'ready');
    await recordPlanRequests(app);

    // Empty: the tall, centred upload area (design 上传区: stacked ≈160px).
    const upload = page.getByTestId('media-upload');
    await uiExpect(upload).toHaveAttribute('data-layout', 'stacked');
    await uiExpect(page.getByTestId('media-queue')).toHaveCount(0);
    evidence.uploadStacked = Math.round((await upload.boundingBox())!.height);
    await shoot(page, run, 'T-WORKBENCH-03-upload-empty-light-zh-1280x800');

    // The file-type menu opens the main-process dialog with that filter only (AC-WORKBENCH-02-1).
    await stubDialogs(app, { files: [samples.cover] });
    await page.getByTestId('media-upload-filter').click();
    await uiExpect(page.getByTestId('media-upload-filter-menu').getByRole('menuitem')).toHaveText([...FILES_COPY.zh.filters]);
    await settle(page, '[data-testid=media-upload-filter-menu]');
    await shoot(page, run, 'T-WORKBENCH-03-filter-menu-light-zh', await clipAround(page, ['[data-testid=media-upload]', '[data-testid=media-upload-filter-menu]']));
    await page.getByTestId('media-upload-filter-audio').click();
    await uiExpect(queueRow(page, 'cover.flac')).toHaveCount(1);
    const [audioCall] = await dialogCalls(app);
    expect(audioCall.properties).toEqual(['openFile', 'multiSelections']);
    expect(audioCall.filters).toHaveLength(1);
    expect(audioCall.filters[0].extensions).toEqual(expect.arrayContaining(['flac', 'mp3', 'm4a']));
    expect(audioCall.filters[0].extensions).not.toContain('mp4');
    // The upload area becomes the compact bar, its height moving there (design 上传区: horizontal ≈72px).
    await uiExpect(upload).toHaveAttribute('data-layout', 'horizontal');
    await settle(page, '[data-testid=media-upload]');
    evidence.uploadCompact = Math.round((await upload.boundingBox())!.height);
    expect(evidence.uploadCompact).toBeLessThan(evidence.uploadStacked as number);
    expect(evidence.uploadCompact).toBeLessThanOrEqual(90);

    // The upload button: every media file; then a drop of three files nothing can convert.
    await stubDialogs(app, { files: [samples.vertical, samples.subtitles, samples.long] });
    await uploadButton(page).click();
    const allCall = (await dialogCalls(app)).at(-1)!;
    expect(allCall.filters.flatMap(filter => filter.extensions)).toEqual(expect.arrayContaining(['mp4', 'mkv', 'flac', '*']));
    await dropFiles(page, '[data-testid=media-upload]', [samples.notMedia, samples.playlist, samples.silk, samples.subtitleOnly]);
    const names = ['cover.flac', 'vertical-hdr.mp4', 'subtitles.mkv', LONG_NAME, 'notes.mp4', 'playlist.m3u8', 'voice.silk', 'subtitles-only.mkv'];
    // Every file shows at once, analyzing first; then its media information or why it cannot be converted.
    await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(8);
    await uiExpect.poll(async () => (await queueItems(page)).map(item => item.displayName)).toEqual(names);
    await uiExpect(page.locator('[data-testid=media-queue-row][data-state=analyzing]')).toHaveCount(0, { timeout: 30_000 });
    const items = await queueItems(page);
    const byName = new Map(items.map(item => [item.displayName, item]));
    for (const name of UNSUPPORTED_NAMES) expect(byName.get(name)!.state.status, name).toBe('unsupported');
    expect(byName.get('subtitles-only.mkv')!.state).toEqual({ status: 'unsupported', code: 'no_media_streams' });
    expect(byName.get('playlist.m3u8')!.state).toEqual({ status: 'unsupported', code: 'container_not_allowed' });
    expect(byName.get('voice.silk')!.state).toEqual({ status: 'unsupported', code: 'wechat_silk_unsupported' });
    // The audio file does not fit "compress video": the plan says so and the row offers the task that fits.
    await uiExpect(queueRow(page, 'cover.flac')).toHaveAttribute('data-state', 'not_applicable', { timeout: 15_000 });
    for (const name of ['vertical-hdr.mp4', 'subtitles.mkv', LONG_NAME]) await uiExpect(queueRow(page, name)).toHaveAttribute('data-plan', 'ready', { timeout: 15_000 });

    const checkRows = async (language: 'zh' | 'en') => {
      const copy = FILES_COPY[language];
      for (const name of UNSUPPORTED_NAMES) {
        const state = byName.get(name)!.state as { code: string };
        const [reason, advice] = PROBE_COPY[language][state.code];
        await uiExpect(queueRow(page, name).getByTestId('media-row-reason'), name).toHaveText(reason);
        await uiExpect(queueRow(page, name).getByTestId('media-row-advice'), name).toHaveText(advice);
      }
      const cover = queueRow(page, 'cover.flac');
      await uiExpect(cover.getByTestId('media-row-not-applicable')).toContainText(copy.notApplicable);
      await uiExpect(cover.getByTestId('media-row-not-applicable')).toContainText(copy.audioCompress);
      await uiExpect(cover.getByTestId('media-row-switch-task')).toHaveText(copy.toMp3);
      await uiExpect(cover.getByTestId('media-meta-audio')).toContainText('FLAC');
      await uiExpect(cover.getByTestId('media-meta-audio')).toContainText(copy.stereo);
      await uiExpect(cover.getByTestId('media-meta-audio')).toContainText('48 kHz');
      await uiExpect(cover.getByTestId('media-meta-tracks')).toHaveText(copy.cover);
      // The vertical phone video: its picture as shown, rate, codec, the HDR mark, both tracks and the subtitle.
      const vertical = queueRow(page, 'vertical-hdr.mp4');
      await uiExpect(vertical.getByTestId('media-meta-file')).toContainText('0:02');
      await uiExpect(vertical.getByTestId('media-meta-file')).toContainText(/\d (KB|MB)$/);
      await uiExpect(vertical.getByTestId('media-meta-video')).toContainText('1080×1920');
      await uiExpect(vertical.getByTestId('media-meta-video')).toContainText(copy.vfr);
      await uiExpect(vertical.getByTestId('media-meta-video')).toContainText('HEVC');
      await uiExpect(vertical.getByTestId('media-meta-hdr')).toHaveText(copy.hdr);
      await uiExpect(vertical.getByTestId('media-meta-audio')).toHaveText(new RegExp(`^AAC·${copy.stereo}·44\\.1 kHz·12\\d kbps$`));
      await uiExpect(vertical.getByTestId('media-meta-tracks')).toHaveText(`${copy.tracks}·${copy.subtitle}`);
      await uiExpect(queueRow(page, 'subtitles.mkv').getByTestId('media-meta-tracks')).toContainText(copy.subtitles);
    };
    await checkRows('zh');

    // The HDR video loses its HDR to H.264: one line on the row, the same the main process plans (AC-WORKBENCH-03-6).
    const verticalPlan = await mainPlan(page, byName.get('vertical-hdr.mp4')!.id, compressSettings());
    if (verticalPlan.status !== 'ready') throw new Error(`The vertical clip planned ${verticalPlan.status}`);
    expect(verticalPlan.plan.warnings.map(warning => warning.code)).toContain('hdr_tonemapped');
    await uiExpect(queueRow(page, 'vertical-hdr.mp4').getByTestId('media-row-loss')).toHaveText(expectedLossLine(verticalPlan.plan, 'zh'));
    // Automatic container: image subtitles keep the MKV, so nothing is lost and no line shows.
    await uiExpect(queueRow(page, 'subtitles.mkv').getByTestId('media-row-loss')).toHaveCount(0);

    // The whole page and its rows, in both themes and languages, wide and at the smallest window.
    const wrapped: string[] = [];
    for (const [theme, language, width, height] of [['light', 'zh', 1280, 800], ['dark', 'en', 1280, 800], ['light', 'en', 786, 540], ['dark', 'zh', 786, 540]] as [Theme, 'zh' | 'en', number, number][]) {
      const label = `${theme}-${language}-${width}x${height}`;
      await setAppearance(page, { theme, language, route: ROUTE });
      const viewport = await setWindowSize(media, { width, height });
      await waitForEngine(page, 'ready');
      await uiExpect(queueRow(page, 'cover.flac')).toHaveAttribute('data-state', 'not_applicable', { timeout: 15_000 });
      await uiExpect(queueRow(page, 'vertical-hdr.mp4').getByTestId('media-row-loss')).toHaveCount(1, { timeout: 15_000 });
      await checkRows(language);
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
      await settle(page, '[data-testid=media-queue] *, [data-testid=media-upload]');
      const rows = await rowGeometry(page);
      for (const row of rows) expect(row.overflow, `${row.name} ${label}`).toEqual([]);
      // The long name gives way in its middle; its end, with the extension, stays.
      const long = rows.find(row => row.name === LONG_NAME)!;
      expect(long.nameEnd).toBe('final_v2.mkv');
      expect(long.nameCut).toBe(true);
      // A not-applicable line is as tall as a plan line: a row keeps its height whichever it shows (one line of chips each).
      if (width > 1000) expect(rows.find(row => row.name === 'cover.flac')!.height).toBe(long.height);
      // Groups that do not fit one line wrap instead of running out of the row (the vertical video at the smallest window).
      for (const row of rows) expect(row.metaLines > 1, `${row.name} ${label}`).toBe(!row.metaFits);
      if (width < 1000 && !rows.find(row => row.name === 'vertical-hdr.mp4')!.metaFits) wrapped.push(label);
      // The remove button sits as far from the row's top as from its right edge (visual-contract 靠角等距).
      for (const row of rows) if (row.removeInset) expect(row.removeInset.top, row.name).toBe(row.removeInset.right);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      evidence[`rows-${label}`] = { viewport, rows };
      await shoot(page, run, `T-WORKBENCH-03-queue-${label}`);
      if (width < 1000) {
        await bringIntoView(page, queueRow(page, 'subtitles-only.mkv'));
        await shoot(page, run, `T-WORKBENCH-03-queue-end-${label}`);
      }
    }

    // The vertical video's media information needed a second line at the smallest window, in at least one language.
    expect(wrapped.length).toBeGreaterThan(0);
    evidence.wrappedAt786 = wrapped;

    // States up close (light zh and dark en, 1280×800): unsupported, not applicable with its switch, the chips.
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const label = `${theme}-${language}`;
      await setAppearance(page, { theme, language, route: ROUTE });
      await setWindowSize(media, { width: 1280, height: 800 });
      await uiExpect(queueRow(page, 'cover.flac')).toHaveAttribute('data-state', 'not_applicable', { timeout: 15_000 });
      await settle(page, '[data-testid=media-queue] *');
      const rowsClip = async (rowNames: string[]) => {
        await showRowsFrom(page, `[data-item-id="${byName.get(rowNames[0])!.id}"]`);
        return clipAround(page, rowNames.map(name => `[data-testid=media-queue-row][data-item-id="${byName.get(name)!.id}"]`), 8);
      };
      await shoot(page, run, `T-WORKBENCH-03-row-not-applicable-${label}`, await rowsClip(['cover.flac']));
      await shoot(page, run, `T-WORKBENCH-03-rows-unsupported-${label}`, await rowsClip(UNSUPPORTED_NAMES));
      await shoot(page, run, `T-WORKBENCH-03-rows-media-${label}`, await rowsClip(['vertical-hdr.mp4', 'subtitles.mkv', LONG_NAME]));

      // The long name in full, by pointer and by keyboard.
      const longName = queueRow(page, LONG_NAME).locator('.studio-file-name');
      await longName.hover();
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveText(LONG_NAME);
      await settle(page, '[data-slot=tooltip-content]');
      await shoot(page, run, `T-WORKBENCH-03-long-name-tooltip-${label}`, await clipAround(page, [`[data-item-id="${byName.get(LONG_NAME)!.id}"]`, '[data-slot=tooltip-content]']));
      await leaveHover(page);
      await longName.focus();
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveText(LONG_NAME);
      await page.locator('h1').click();
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveCount(0);
    }

    // MP4 instead of automatic: the image subtitles and the styling go, one line says so (AC-WORKBENCH-03-6), and the
    // plan, opened, is the main process's plan (AC-WORKBENCH-03-5).
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const label = `${theme}-${language}`;
      await setAppearance(page, { theme, language, route: ROUTE });
      await setWindowSize(media, { width: 1280, height: 800 });
      await segment(page, 'media-container-mp4').click();
      const row = queueRow(page, 'subtitles.mkv');
      const plan = await mainPlan(page, byName.get('subtitles.mkv')!.id, compressSettings({ container: 'mp4' }));
      if (plan.status !== 'ready') throw new Error(`The subtitles clip planned ${plan.status}`);
      expect(plan.plan.warnings.find(warning => warning.code === 'subtitle_dropped')).toMatchObject({ count: 2 });
      expect(plan.plan.warnings.map(warning => warning.code)).toContain('subtitle_styling_lost');
      await uiExpect(row.getByTestId('media-row-loss')).toHaveText(expectedLossLine(plan.plan, language), { timeout: 15_000 });
      await settle(page, '[data-testid=media-queue] *');
      await showRowsFrom(page, `[data-item-id="${byName.get('vertical-hdr.mp4')!.id}"]`);
      await shoot(page, run, `T-WORKBENCH-03-loss-line-${label}`, await clipAround(page, [`[data-item-id="${byName.get('subtitles.mkv')!.id}"]`, `[data-item-id="${byName.get('vertical-hdr.mp4')!.id}"]`], 8));

      await row.getByTestId('media-row-plan-toggle').click();
      const view = row.getByTestId('media-plan');
      await uiExpect(view).toBeVisible();
      await uiExpect(view).not.toHaveAttribute('data-stale', 'true');
      const encoders = plan.plan.encoders.map(entry => `${ENCODER_NAMES[language][entry.encoder] ?? `?${entry.encoder}`}${entry.variant?.startsWith('10bit') ? ' · 10-bit' : ''}`);
      await uiExpect(view.getByTestId('media-plan-encoders')).toHaveText(encoders.join(FILES_COPY[language].separator));
      const streams = plan.plan.outputs.flatMap(output => output.streams.map(stream => `${stream.kind}:${stream.action}`));
      expect(await view.getByTestId('media-plan-stream').evaluateAll(lines => lines.map(line => `${line.getAttribute('data-kind')}:${line.getAttribute('data-action')}`))).toEqual(streams);
      expect(await view.locator('[data-testid=media-plan-warnings] li').evaluateAll(lines => lines.map(line => line.getAttribute('data-code'))))
        .toEqual([...plan.plan.warnings.map(warning => warning.code), ...plan.plan.confirmations]);
      // Both image subtitles dropped for MP4, with the reason; the styled ASS converted to MP4 text.
      await uiExpect(view.locator('[data-testid=media-plan-stream][data-kind=subtitle][data-action=drop]')).toHaveCount(2);
      await settle(page, '[data-testid=media-plan]');
      await showRowsFrom(page, `[data-item-id="${byName.get('subtitles.mkv')!.id}"]`);
      await shoot(page, run, `T-WORKBENCH-03-plan-${label}-1280x800`, await clipAround(page, [`[data-item-id="${byName.get('subtitles.mkv')!.id}"]`], 8));
      evidence[`plan-${label}`] = { encoders, streams, warnings: plan.plan.warnings };
      if (language === 'zh') {
        // The same open plan at the smallest window.
        await setWindowSize(media, { width: 786, height: 540 });
        await bringIntoView(page, view);
        expect(await hasHorizontalOverflow(page)).toBe(false);
        await shoot(page, run, 'T-WORKBENCH-03-plan-light-zh-786x540');
        await setWindowSize(media, { width: 1280, height: 800 });
      }
      await row.getByTestId('media-row-plan-toggle').click();
      await segment(page, 'media-container-auto').click();
    }

    // Settings changes ask again only once they rest for 300 ms (design 处理计划): two tiers 100 ms apart ask for the last only.
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });
    await uiExpect(queueRow(page, 'vertical-hdr.mp4').getByTestId('media-row-loss')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(800);
    const before = (await planCalls(app)).length;
    const clicked = await page.evaluate(async () => {
      const radio = (value: string) => document.querySelector<HTMLElement>(`[data-testid=media-tier-${value}]`)!;
      radio('quality').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      radio('size').click();
      return Date.now();
    });
    await uiExpect(segment(page, 'media-tier-size')).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(1500);
    const burst = (await planCalls(app)).slice(before);
    const plannable = items.filter(item => item.state.status === 'idle').map(item => item.id);
    expect(burst.length).toBeGreaterThan(0);
    expect(burst.every(call => call.settings.tier === 'size'), JSON.stringify(burst)).toBe(true);
    expect(Math.min(...burst.map(call => call.at)) - clicked).toBeGreaterThanOrEqual(250);
    expect(new Set(burst.map(call => call.itemId)).size).toBe(burst.length);
    expect(burst.every(call => plannable.includes(call.itemId))).toBe(true);
    evidence.debounce = { calls: burst.map(call => ({ delayMs: call.at - clicked, itemId: call.itemId })) };
    await segment(page, 'media-tier-balanced').click();

    // "Convert to MP3 instead", by keyboard: the task and its target change, the audio file fits, the videos are planned
    // again, and the focus stays on the file rather than falling back to the page.
    await queueRow(page, 'cover.flac').getByTestId('media-row-switch-task').focus();
    await page.keyboard.press('Enter');
    await uiExpect(segment(page, 'media-task-convert')).toHaveAttribute('aria-checked', 'true');
    await uiExpect(page.getByTestId('media-convert-target')).toHaveText('MP3');
    await uiExpect(queueRow(page, 'cover.flac')).toHaveAttribute('data-state', 'idle', { timeout: 15_000 });
    await uiExpect(queueRow(page, 'cover.flac')).toHaveAttribute('data-plan', 'ready');
    await uiExpect(queueRow(page, 'cover.flac').getByTestId('media-row-not-applicable')).toHaveCount(0);
    await uiExpect(queueRow(page, 'cover.flac').locator('.studio-file-name')).toBeFocused();
    await settle(page, '[data-testid=media-queue] *');
    await shoot(page, run, 'T-WORKBENCH-03-switched-light-zh', await clipAround(page, ['[data-testid=media-converter-settings] [data-slot=segmented-control]', `[data-item-id="${byName.get('cover.flac')!.id}"]`], 8));
    await segment(page, 'media-task-compress').click();

    // Removing a file that cannot be converted takes it off the list (the other rows stay).
    await queueRow(page, 'voice.silk').getByTestId('media-row-remove').click();
    await uiExpect(queueRow(page, 'voice.silk')).toHaveCount(0);
    expect((await queueItems(page)).map(item => item.displayName)).toEqual(names.filter(name => name !== 'voice.silk'));

    // States after the start keep what the engine sends with them until T-WORKBENCH-04 renders the run (injected as the
    // main process would send them; the preload checks them like any event): the plan a queued item was started with, the
    // space a disk_space_low failure needs, the outputs a cancelled "all tracks" extraction had saved.
    const longItem = await itemNamed(page, LONG_NAME);
    const startedPlan = await mainPlan(page, longItem.id, compressSettings());
    if (startedPlan.status !== 'ready') throw new Error(`The long clip planned ${startedPlan.status}`);
    const job = { settings: compressSettings(), plan: startedPlan.plan, output: { mode: 'source', directoryName: null, conflict: 'number' } };
    const carried = (id: string, displayName: string, state: unknown, extra: Record<string, unknown> = {}) => ({
      id, displayName, folderName: 'media', media: longItem.media, state, job, progress: null, result: null, log: null, addedAt: 1, finishedAt: null, ...extra,
    });
    const snapshot = await page.evaluate(() => window.mediaConverter!.getSnapshot());
    if (!snapshot.ok) throw new Error('No snapshot');
    await sendQueueEvent(app, {
      sequence: snapshot.value.sequence + 1_000, kind: 'items', removed: [], items: [
        carried('carried_queued', 'queued.mkv', { status: 'queued' }),
        carried('carried_failed', 'no-space.mkv', { status: 'failed', code: 'disk_space_low', partial: false, space: { requiredBytes: Math.round(5.5 * 1024 ** 3), availableBytes: Math.round(1.2 * 1024 ** 3) } }, { finishedAt: 2 }),
        carried('carried_cancelled', 'all-tracks.mkv', { status: 'cancelled' }, {
          finishedAt: 3,
          result: { outputs: [{ index: 0, fileName: 'all-tracks.track1.m4a', folderName: 'media', sizeBytes: 40_960, replaced: false }], outputCount: 3, sourceBytes: 101_000, outputBytes: 40_960, warnings: [] },
        }),
      ],
    });
    await uiExpect(queueRow(page, 'queued.mkv').getByTestId('media-row-status')).toHaveText('排队中');
    await uiExpect(queueRow(page, 'queued.mkv').getByTestId('media-row-remove')).toHaveCount(0);
    await uiExpect(queueRow(page, 'no-space.mkv').getByTestId('media-row-disk-space')).toHaveText('磁盘空间不足：需要 5.5 GB，可用 1.2 GB');
    await uiExpect(queueRow(page, 'all-tracks.mkv').getByTestId('media-row-published')).toHaveText('已保存 1/3 个输出');
    await queueRow(page, 'queued.mkv').getByTestId('media-row-plan-toggle').click();
    await uiExpect(queueRow(page, 'queued.mkv').getByTestId('media-plan-frozen')).toHaveText('按开始时的设置处理');
    await showRowsFrom(page, '[data-item-id=carried_queued]');
    await shoot(page, run, 'T-WORKBENCH-03-carried-queued-light-zh', await clipAround(page, ['[data-item-id=carried_queued]'], 8));
    await queueRow(page, 'queued.mkv').getByTestId('media-row-plan-toggle').click();
    await showRowsFrom(page, '[data-item-id=carried_failed]');
    await shoot(page, run, 'T-WORKBENCH-03-carried-ended-light-zh', await clipAround(page, ['[data-item-id=carried_failed]', '[data-item-id=carried_cancelled]'], 8));

    await writeFile(path.join(run, 'T-WORKBENCH-03-files.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 600_000);

  // AC-WORKBENCH-02-1, AC-WORKBENCH-02-3, AC-WORKBENCH-02-4; V-WORKBENCH-03-2 (duplicates, a folder, a temporary copy, 101 files).
  it('files: explains duplicates, folders, temporary copies, files without a path and more than 100 files, and plans only rows in view', async () => {
    const run = await createMediaRun();
    const clip = await makeSample(run, 'h264-aac.mp4', 'clip.mp4');
    const folder = path.join(run, 'media', '素材文件夹');
    await mkdir(folder, { recursive: true });
    await copyFile(clip, path.join(folder, 'inside.mp4'));
    // The same name in another folder: another file.
    const sameName = path.join(run, 'media', 'other', 'clip.mp4');
    await mkdir(path.dirname(sameName), { recursive: true });
    await copyFile(clip, sameName);
    // The app's %TEMP% is a folder of this run (launchWithShellTemp): a copy there stands for one Explorer made.
    const shellTemp = path.join(run, 'shell-temp');
    await mkdir(shellTemp, { recursive: true });
    const tempCopy = path.join(shellTemp, '临时副本.mp4');
    await copyFile(clip, tempCopy);
    const batch = path.join(run, 'batch');
    await mkdir(batch, { recursive: true });
    const batchFiles = Array.from({ length: 101 }, (_, index) => path.join(batch, `batch-${String(index + 1).padStart(3, '0')}.mp4`));
    for (const file of batchFiles) await copyFile(clip, file);

    media = await launchWithShellTemp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } }, shellTemp);
    const { app, page } = media;
    const evidence: Record<string, unknown> = {};
    await openSettings(media, { theme: 'light', language: 'zh' });
    await waitForEngine(page, 'ready');
    const upload = page.getByTestId('media-upload');

    // Anywhere on the page, the settings panel included (AC-WORKBENCH-02-1: 拖到页面任意位置).
    await dropFiles(page, '[data-testid=media-converter-settings]', [clip]);
    await uiExpect(queueRow(page, 'clip.mp4')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await uiExpect(page.getByTestId('media-add-notice')).toHaveCount(0);

    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const copy = FILES_COPY[language];
      const label = `${theme}-${language}`;
      await setAppearance(page, { theme, language, route: ROUTE });
      await setWindowSize(media, { width: 1280, height: 800 });
      await waitForEngine(page, 'ready');
      const notice = page.getByTestId('media-add-notice');
      // The pointer leaves the notice first, so its dismiss button is not shown hovered.
      const noticeClip = async () => {
        await page.mouse.move(2, 120, { steps: 4 });
        return clipAround(page, ['[data-testid=media-upload]', '[data-testid=media-add-notice]', '[data-testid=media-queue-row]'], 12);
      };

      // The same file again, by identity: said once, not added (AC-WORKBENCH-02-4).
      await dropFiles(page, '[data-testid=media-upload]', [clip]);
      await uiExpect(page.getByTestId('media-add-notice-duplicate')).toHaveText(copy.duplicate('clip.mp4'));
      // Nothing went wrong: a polite status, not an alert.
      await uiExpect(notice).toHaveAttribute('role', 'status');
      await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(1);
      await settle(page, '[data-testid=media-add-notice], [data-testid=media-upload]');
      await shoot(page, run, `T-WORKBENCH-03-duplicate-notice-${label}`, await noticeClip());

      // A folder, dragged as Explorer drags it: the page-wide drop shows, then the notice says to choose its files (AC-WORKBENCH-02-1).
      const drag = await startNativeDrag(page, upload, [folder]);
      const overlay = page.getByTestId('tool-page-drop-overlay');
      await uiExpect(overlay).toBeVisible();
      await uiExpect(overlay).toContainText(copy.dropLabel);
      await uiExpect(upload).toHaveAttribute('data-layout', 'horizontal');
      await settle(page, '[data-testid=tool-page-drop-overlay]');
      if (language === 'zh') await shoot(page, run, `T-WORKBENCH-03-drop-overlay-${label}`);
      await drag.drop();
      await uiExpect(page.getByTestId('media-add-notice-folder_not_supported')).toHaveText(copy.folder('素材文件夹'));
      await uiExpect(notice).toHaveAttribute('data-problem', 'true');
      // A file left out is announced at once, as the long-text notices announce problems.
      await uiExpect(notice).toHaveAttribute('role', 'alert');
      await uiExpect(overlay).toHaveCount(0);
      await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(1);
      await settle(page, '[data-testid=media-add-notice], [data-testid=media-upload]');
      await shoot(page, run, `T-WORKBENCH-03-folder-notice-${label}`, await noticeClip());

      // A temporary copy whose original cannot be proven, and a File with no path at all (AC-WORKBENCH-02-3).
      await dropNatively(page, upload, [tempCopy]);
      // The main process asks Explorer for its selection first (a hidden PowerShell query), which can take a few seconds at idle priority.
      await uiExpect(page.getByTestId('media-add-notice-temporary_copy_unresolved')).toHaveText(copy.tempCopy('临时副本.mp4'), { timeout: 30_000 });
      await dropVirtualFiles(page, '[data-testid=media-upload]', [{ name: 'from-archive.mp4', content: 'not on disk' }]);
      await uiExpect(page.getByTestId('media-add-notice-file_unavailable')).toHaveText(copy.unreadable('from-archive.mp4'));
      await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(1);
      if (language === 'zh') {
        await settle(page, '[data-testid=media-add-notice], [data-testid=media-upload]');
        await shoot(page, run, `T-WORKBENCH-03-unreadable-notice-${label}`, await noticeClip());
      }
      // Dismissed, it goes.
      await page.getByTestId('media-add-notice-dismiss').click();
      await uiExpect(notice).toHaveCount(0);
    }
    expect((await queueItems(page)).map(item => item.displayName)).toEqual(['clip.mp4']);

    // 101 files in one drop at the smallest window: the first 100 are added, the rest counted (AC-WORKBENCH-02-1); each
    // shows at once as analyzing (AC-WORKBENCH-02-2) and the list stays usable while they are probed (R-WORKBENCH-02).
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });
    const small = await setWindowSize(media, { width: 786, height: 540 });
    await waitForEngine(page, 'ready');
    await recordPlanRequests(app);
    const planned = (await planCalls(app)).length;
    await dropFiles(page, '[data-testid=media-upload]', batchFiles);
    await uiExpect(page.getByTestId('media-add-notice-added')).toHaveText(FILES_COPY.zh.added100);
    await uiExpect(page.getByTestId('media-add-notice-truncated')).toHaveText(FILES_COPY.zh.truncated);
    await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(101);
    const analyzing = page.locator('[data-testid=media-queue-row][data-state=analyzing]');
    const seenAnalyzing = await analyzing.count();
    evidence.analyzingWhenShown = seenAnalyzing;
    expect(seenAnalyzing).toBeGreaterThan(0);
    await analyzing.last().evaluate(element => element.scrollIntoView({ block: 'end' }));
    await uiExpect(analyzing.last().getByTestId('media-row-analyzing')).toHaveText(FILES_COPY.zh.analyzing);
    await shoot(page, run, 'T-WORKBENCH-03-analyzing-light-zh-786x540');
    // The rows in view stay where they are while the files finish analyzing, the ones in view included: a row being
    // analyzed already holds the plan line it gets (R-WORKBENCH-02: the list stays usable while a hundred are probed).
    const lastRow = page.locator('[data-testid=media-queue-row]').last();
    const watch = async () => ({ top: await lastRow.evaluate(element => Math.round(element.getBoundingClientRect().top)), analyzing: await analyzing.count() });
    const watched = [await watch()];
    while (watched.at(-1)!.analyzing > 0 && watched.length < 240) {
      await page.waitForTimeout(250);
      watched.push(await watch());
    }
    evidence.lastRowWhileAnalyzing = watched;
    expect(watched.at(-1)!.analyzing).toBe(0);
    expect(new Set(watched.map(sample => sample.top)).size, JSON.stringify(watched)).toBe(1);
    // The notice at the top, once every file is analyzed.
    await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
    await uiExpect(analyzing).toHaveCount(0, { timeout: 120_000 });
    await settle(page, '[data-testid=media-add-notice], [data-testid=media-upload]');
    await shoot(page, run, 'T-WORKBENCH-03-overflow-notice-light-zh-786x540');
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Only rows in view ask for their plan (design 风险: 预览请求过多): those seen at the end and at the top, not one in the
    // middle the page never showed, which asks once scrolled to.
    await page.waitForTimeout(1000);
    const batchItems = (await queueItems(page)).filter(item => item.displayName.startsWith('batch-'));
    expect(batchItems).toHaveLength(100);
    expect(batchItems.map(item => item.displayName)).toEqual(batchFiles.slice(0, 100).map(file => path.basename(file)));
    const inView = (await planCalls(app)).slice(planned).map(call => call.itemId);
    const askedBatch = new Set(inView.filter(id => batchItems.some(item => item.id === id)));
    evidence.plansBeforeScroll = { asked: askedBatch.size, of: batchItems.length, viewport: small };
    expect(askedBatch.size).toBeGreaterThan(0);
    expect(askedBatch.size).toBeLessThan(20);
    const last = batchItems.at(-1)!;
    const far = batchItems[49];
    expect(askedBatch.has(far.id)).toBe(false);
    // Rows just below the scrolled area ask as well (the observer's 120 px margin on the app's scroll area), so a
    // row's plan is usually there by the time it scrolls in.
    const nearBelow = await page.evaluate(() => {
      const area = document.querySelector('.app > [data-slot=scroll-area] [data-slot=scroll-area-viewport]')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('[data-testid=media-queue-row]')]
        .map(row => ({ id: row.dataset.itemId!, below: Math.round(row.querySelector('.studio-task-meta')!.getBoundingClientRect().top - area.bottom) }))
        .filter(row => row.below > 0 && row.below < 100);
    });
    evidence.plansNearBelow = nearBelow.map(row => ({ ...row, asked: inView.includes(row.id) }));
    expect(nearBelow.length).toBeGreaterThan(0);
    for (const row of nearBelow) expect(inView.includes(row.id), `${row.id} ${row.below}px below`).toBe(true);
    await page.locator(`[data-testid=media-queue-row][data-item-id="${far.id}"]`).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await uiExpect.poll(async () => (await planCalls(app)).some(call => call.itemId === far.id), { timeout: 10_000 }).toBe(true);
    await setAppearance(page, { theme: 'dark', language: 'en', route: ROUTE });
    await setWindowSize(media, { width: 786, height: 540 });
    await page.locator(`[data-testid=media-queue-row][data-item-id="${last.id}"]`).evaluate(element => element.scrollIntoView({ block: 'end' }));
    await settle(page, '[data-testid=media-queue] *');
    await shoot(page, run, 'T-WORKBENCH-03-queue-end-dark-en-786x540-101');
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Identity, not the name, makes a duplicate (AC-WORKBENCH-02-4): the same name from another folder is added; the
    // hundred copies above, all the same content under other names, were each added as well.
    await dropFiles(page, '[data-testid=media-upload]', [sameName]);
    await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(102);
    await uiExpect.poll(async () => (await queueItems(page)).filter(item => item.displayName === 'clip.mp4').map(item => item.folderName)).toEqual(['media', 'other']);

    // A queue of 500 unfinished items has no room either, which the notice tells apart from the 100 of one add (the
    // main process's answer to one pick is stubbed: filling the queue would take 500 probes).
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });
    await answerNextPick(app, { added: [], duplicates: [], rejected: [], truncated: 3 });
    await uploadButton(page).click();
    await uiExpect(page.getByTestId('media-add-notice-queue_full')).toHaveText(FILES_COPY.zh.queueFull);
    await uiExpect(page.getByTestId('media-add-notice-truncated')).toHaveCount(0);
    await uiExpect(page.getByTestId('media-add-notice')).toHaveAttribute('role', 'alert');
    await settle(page, '[data-testid=media-add-notice], [data-testid=media-upload]');
    await page.mouse.move(2, 120, { steps: 4 });
    await shoot(page, run, 'T-WORKBENCH-03-queue-full-notice-light-zh-786x540', await clipAround(page, ['[data-testid=media-upload]', '[data-testid=media-add-notice]'], 12));
    expect((await queueItems(page)).length).toBe(102);

    await writeFile(path.join(run, 'T-WORKBENCH-03-adds.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 600_000);
});

// ── T-WORKBENCH-04: queue actions, the confirmation before the start, progress and results ────────

const RUN_COPY = {
  zh: {
    pgsLoss: '2 条图形字幕将被丢弃', resolved: '已改为 MKV，内容会完整保留', start: (count: number) => `开始 ${count} 个文件`,
    background: '转换会在后台继续，回到此页面即可查看进度', notSmaller: '压缩后没有明显变小，没有保存输出',
    outputOpenFailed: '无法创建输出文件', code: (code: string) => `错误码：${code}`,
    outputOpenAdvice: 'FFmpeg 无法在目标文件夹中创建输出文件，可能没有写入权限，或被安全软件拦截。请检查后重试，或换一个输出位置。',
    detecting: '正在用小样测试本机的显卡和 CPU 编码器。可以先添加文件，检测完成后才能开始。',
    lossless: '有损音频转为无损格式：体积会变大，音质不会变好', replace: (names: string) => `会把同名旧文件移到回收站：${names}`, skipped: '本次跳过，不会开始',
    cancelAllTitle: '取消全部转换？', cancelAllBody: '将取消 1 个排队中或处理中的文件。未完成的临时文件会被删除，已经保存的输出会保留。', cancelAllConfirm: '全部取消',
    notification: '音视频转换完成',
    saved: (name: string, percent: string) => `${name} 已完成，节省 ${percent}`, larger: (name: string, change: string) => `${name} 已完成，体积变化 ${change}`,
    cancelled: (name: string) => `${name} 已取消`, skippedAnnounce: (name: string, reason: string) => `${name} 已跳过：${reason}`,
    failed: (name: string, reason: string) => `${name} 失败：${reason}`,
    files: (count: number) => `${count} 个文件`, done: (count: number) => `完成 ${count}`,
  },
  en: {
    outputOpenFailed: 'The output file could not be created', code: (code: string) => `Error code: ${code}`,
  },
} as const;

/** The samples of the run: a file that loses its image subtitles in MP4, a long take, a clip that compresses, one that cannot. */
interface RunSamples { pgs: string; longTake: string; clip: string; tight: string }

/**
 * Made in the run folder at idle priority. All are 2 s at 320×180 but the long take: 150 s at 640×360, the
 * one sample past the usual size, so that one run lasts while the page is left, opened again and reloaded
 * (AC-WORKBENCH-04-4); it is cancelled after about ten seconds. The clips that should come out smaller
 * are made at 2 Mbit/s; the tight one at 16 kbit/s, already smaller than any compression of it.
 */
async function makeRunSamples(run: string): Promise<RunSamples> {
  const folder = path.join(run, 'media');
  await mkdir(folder, { recursive: true });
  const sup = path.join(folder, 'caption.sup');
  await writeFile(sup, pgsCaption());
  const [pgs, longTake, clip, tight] = await Promise.all([
    makeMedia(run, 'pgs.mkv', [
      ...lavfi.video(), ...lavfi.tone(), '-i', `file:${sup}`, '-i', `file:${sup}`, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
      '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'aac', '-b:a', '128k', '-c:s', 'copy', '-metadata:s:s:0', 'language=chi', '-metadata:s:s:1', 'language=eng',
    ]),
    makeMedia(run, 'long-take.mp4', [...lavfi.video({ size: '640x360', seconds: 150 }), '-c:v', 'libopenh264', '-b:v', '500k']),
    makeMedia(run, 'clip.mp4', [...lavfi.video(), ...lavfi.tone(), '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'aac', '-b:a', '128k', '-shortest']),
    makeMedia(run, 'tight.mp4', [...lavfi.video(), '-c:v', 'libopenh264', '-b:v', '16k']),
  ]);
  return { pgs, longTake, clip, tight };
}

/** `.fusionkit-media-<id>.partial` files in a folder: an output being written (AC-ENGINE-06-1). */
const partialsIn = async (folder: string) => (await readdir(folder)).filter(name => /^\.fusionkit-media-[0-9a-f]{8}\.partial$/.test(name));

type AnnouncementGlobals = typeof globalThis & { __mediaAnnouncements?: string[]; __mediaAnnouncementRecorder?: MutationObserver };
/**
 * Records every line the live region gets (AC-WORKBENCH-04-3), as a screen reader would hear it added: a line added
 * to the region, and the lines of a region inserted together with its text. One observer per page, on the document,
 * so it also works as an init script, before the page has a body; a second call only starts the list again.
 */
function recordAnnouncementsInPage() {
  const globals = globalThis as AnnouncementGlobals;
  globals.__mediaAnnouncements = [];
  if (globals.__mediaAnnouncementRecorder) return;
  globals.__mediaAnnouncementRecorder = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const lines = node.parentElement?.dataset.testid === 'media-live' ? [node] : [...node.querySelectorAll('[data-testid=media-live] > *')];
        for (const line of lines) globals.__mediaAnnouncements!.push(line.textContent ?? '');
      }
    }
  });
  globals.__mediaAnnouncementRecorder.observe(document, { childList: true, subtree: true });
}
/** Records from now on; after a reload, again (or from the page's start, with `page.addInitScript(recordAnnouncementsInPage)`). */
const recordAnnouncements = (page: Page) => page.evaluate(recordAnnouncementsInPage);
const announcedLines = (page: Page) => page.evaluate(() => [...((globalThis as AnnouncementGlobals).__mediaAnnouncements ?? [])]);

type SeenEvent = { sequence: number; kind: string; itemId: string | null; fraction: number | null; at: number };
type EventGlobals = typeof globalThis & { __mediaEvents?: SeenEvent[] };
/** Records the change events the page receives (AC-ENGINE-05-1): sequence, kind, and for progress its item and share. */
async function recordQueueEvents(page: Page) {
  await page.evaluate(() => {
    const globals = globalThis as EventGlobals;
    globals.__mediaEvents = [];
    window.mediaConverter!.onChanged(event => globals.__mediaEvents!.push({
      sequence: event.sequence, kind: event.kind, at: performance.now(),
      itemId: event.kind === 'progress' ? event.itemId : null, fraction: event.kind === 'progress' ? event.progress.fraction : null,
    }));
  });
}
const queueEvents = (page: Page) => page.evaluate(() => [...((globalThis as EventGlobals).__mediaEvents ?? [])]);

/** The value of a row's determinate progress bar, or null while it has none. */
const rowFraction = async (row: Locator) => {
  const bar = row.locator('progress.studio-task-progress');
  return await bar.count() ? bar.evaluate(element => (element as HTMLProgressElement).value) : null;
};

/** The numbers of a running row and where they are (AC-WORKBENCH-04-2): their text and their boxes, to the half pixel. */
const statFrame = (row: Locator) => row.evaluate(element => {
  const half = (value: number) => Math.round(value * 2) / 2;
  const cells = [...element.querySelectorAll<HTMLElement>('[data-testid=media-row-stats], [data-testid^=media-stat-], [data-testid=media-row-status], progress')];
  return {
    texts: cells.filter(cell => cell.dataset.testid?.startsWith('media-stat-')).map(cell => cell.textContent ?? ''),
    boxes: cells.map(cell => { const box = cell.getBoundingClientRect(); return `${cell.dataset.testid ?? cell.tagName}:${half(box.left)},${half(box.top)},${half(box.width)},${half(box.height)}`; }),
  };
});

/**
 * Makes the page report that the window is not in front, as a batch that ends in the background finds it
 * (AC-WORKBENCH-04-4). The quiet window is never focused, but Playwright's focus emulation can make the page
 * believe it is: that is turned off first; only if the page still says it has focus is `hasFocus` replaced.
 * Nothing here touches the real windows of the desktop (no blur, which would activate another window).
 */
async function leaveTheWindow(target: MediaApp): Promise<string> {
  const { page } = target;
  if (!await page.evaluate(() => document.hasFocus())) return 'the window was not in front';
  const session = await target.page.context().newCDPSession(page);
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  if (!await page.evaluate(() => document.hasFocus())) return 'focus emulation off: the window is not in front';
  await page.evaluate(() => { document.hasFocus = () => false; });
  return 'document.hasFocus replaced: the quiet window still reported focus';
}

/** The window is on the run's computer; nothing in a log may say where. */
const ABSOLUTE_PATH = /[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/(?:Users|home)\//;

describeMediaUi('Media converter queue, progress and results in Electron (T-WORKBENCH-04)', () => {
  let media: MediaApp | undefined;

  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  // AC-WORKBENCH-03-6, AC-WORKBENCH-04-1–4, AC-ENGINE-05-1; V-WORKBENCH-04-1 with the bundled ffmpeg.
  it('run: confirms the loss before the start, shows progress through leaving and reloading, cancels, reveals, skips, converts anyway, announces and notifies', async () => {
    const run = await createMediaRun();
    const samples = await makeRunSamples(run);
    const folder = path.join(run, 'media');
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only', reveal: 'record' }, size: { width: 1280, height: 800 } });
    const { app, page } = media;
    const copy = RUN_COPY.zh;
    const evidence: Record<string, unknown> = {};
    await recordNotifications(app);
    // System notifications on, as the settings page turns them on; AV1 in MP4, which cannot hold the image subtitles.
    await page.evaluate(() => localStorage.setItem('fusionkit-notification', JSON.stringify({ state: { enabled: true }, version: 0 })));
    await openSettings(media, { theme: 'light', language: 'zh' }, { task: 'compress', compress: { codec: 'av1', container: 'mp4' } });
    await waitForEngine(page, 'ready');
    // Low-usage mode: idle priority on half the processors, gentle on whatever runs in front.
    expect(await page.evaluate(async () => (await window.mediaConverter!.setOptions({ lowUsage: true })).ok)).toBe(true);
    await stubDialogs(app, { files: [samples.pgs, samples.longTake, samples.clip] });
    await uploadButton(page).click();
    for (const name of ['pgs.mkv', 'long-take.mp4', 'clip.mp4']) await uiExpect(queueRow(page, name)).toHaveAttribute('data-plan', 'ready', { timeout: 30_000 });
    await uiExpect(queueRow(page, 'pgs.mkv').getByTestId('media-row-loss')).toHaveText(copy.pgsLoss);
    // Every file is idle: "start all" offers them, "cancel all" is not there yet, "clear done" has nothing to clear.
    await uiExpect(page.getByTestId('media-start-all')).toBeEnabled();
    await uiExpect(page.getByTestId('media-cancel-all')).toHaveCount(0);
    await uiExpect(page.getByTestId('media-clear-done')).toBeDisabled();
    await recordAnnouncements(page);
    await recordQueueEvents(page);
    const announced: string[] = [];
    const events: SeenEvent[][] = [];

    // "Start all": the file that would lose its subtitles is listed before anything starts (AC-WORKBENCH-03-6).
    await page.getByTestId('media-start-all').click();
    const dialog = page.getByTestId('media-confirm');
    await uiExpect(dialog).toBeVisible();
    const entries = dialog.getByTestId('media-confirm-item');
    await uiExpect(entries).toHaveCount(1);
    const pgsEntry = entries.first();
    await uiExpect(pgsEntry.locator('.studio-file-name .sr-only')).toHaveText('pgs.mkv');
    await uiExpect(pgsEntry.getByTestId('media-confirm-loss')).toHaveText(copy.pgsLoss);
    await uiExpect(dialog.getByTestId('media-confirm-start')).toHaveText(copy.start(3));
    expect((await queueItems(page)).map(item => item.state.status)).toEqual(['idle', 'idle', 'idle']);
    await settle(page, '[role=dialog]');
    await shoot(page, run, 'T-WORKBENCH-04-confirm-light-zh');

    // "Change to MKV": the panel's output becomes MKV and the plan with it, so the subtitles stay.
    await pgsEntry.getByTestId('media-confirm-use-mkv').click();
    await uiExpect(pgsEntry).toHaveAttribute('data-resolved', 'true');
    await uiExpect(pgsEntry.getByTestId('media-confirm-resolved')).toHaveText(copy.resolved);
    await uiExpect(pgsEntry.getByTestId('media-confirm-loss')).toHaveCount(0);
    await uiExpect(pgsEntry.getByTestId('media-confirm-use-mkv')).toHaveCount(0);
    await uiExpect(segment(page, 'media-container-mkv')).toHaveAttribute('aria-checked', 'true');
    const pgsId = (await itemNamed(page, 'pgs.mkv')).id;
    const mp4Plan = await mainPlan(page, pgsId, compressSettings({ codec: 'av1', container: 'mp4' }));
    const mkvPlan = await mainPlan(page, pgsId, compressSettings({ codec: 'av1', container: 'mkv' }));
    if (mp4Plan.status !== 'ready' || mkvPlan.status !== 'ready') throw new Error('The PGS file could not be planned');
    expect(mp4Plan.plan.warnings.find(warning => warning.code === 'subtitle_dropped')).toMatchObject({ count: 2 });
    expect(mkvPlan.plan.warnings.map(warning => warning.code)).not.toContain('subtitle_dropped');
    evidence.mkv = {
      mp4: { container: mp4Plan.plan.outputs[0].container, warnings: mp4Plan.plan.warnings.map(warning => warning.code) },
      mkv: { container: mkvPlan.plan.outputs[0].container, warnings: mkvPlan.plan.warnings.map(warning => warning.code) },
    };
    await settle(page, '[role=dialog]');
    await shoot(page, run, 'T-WORKBENCH-04-confirm-mkv-light-zh');
    await dialog.getByTestId('media-confirm-start').click();
    await uiExpect(dialog).toHaveCount(0);
    // The PGS file started as MKV with both subtitles copied: the plan the start froze is the changed one.
    const startedPgs = await itemNamed(page, 'pgs.mkv');
    expect(startedPgs.job?.plan.outputs[0].container).toBe('mkv');
    expect(startedPgs.job?.plan.outputs[0].streams.filter(stream => stream.kind === 'subtitle').map(stream => stream.action)).toEqual(['copy', 'copy']);
    await uiExpect(page.getByTestId('media-cancel-all')).toBeVisible();

    // The long take runs: its partial output exists, the bar and the numbers move, the boxes do not (AC-WORKBENCH-04-2).
    const longRow = queueRow(page, 'long-take.mp4');
    const longId = (await itemNamed(page, 'long-take.mp4')).id;
    await uiExpect(longRow).toHaveAttribute('data-state', 'running', { timeout: 60_000 });
    await uiExpect(longRow.locator('progress.studio-task-progress')).toHaveCount(1, { timeout: 20_000 });
    await uiExpect.poll(() => partialsIn(folder)).toHaveLength(1);
    const [longPartial] = await partialsIn(folder);
    const shares: number[] = [];
    for (let sample = 0; sample < 4; sample++) {
      shares.push((await rowFraction(longRow))!);
      await page.waitForTimeout(450);
    }
    evidence.shares = shares;
    for (let index = 1; index < shares.length; index++) expect(shares[index], JSON.stringify(shares)).toBeGreaterThan(shares[index - 1]);
    await uiExpect(longRow.getByTestId('media-row-status')).toHaveText('处理中 · 编码中');
    for (const stat of ['speed', 'fps', 'written', 'eta']) await uiExpect(longRow.getByTestId(`media-stat-${stat}`)).not.toHaveText('—');
    await page.mouse.move(2, 120, { steps: 4 });
    const frames: Awaited<ReturnType<typeof statFrame>>[] = [];
    for (let frame = 1; frame <= 3; frame++) {
      await page.waitForTimeout(320);
      frames.push(await statFrame(longRow));
      await shoot(page, run, `T-WORKBENCH-04-progress-frame-${frame}-light-zh`, await clipAround(page, [`[data-item-id="${longId}"]`], 8));
    }
    evidence.frames = frames;
    expect(new Set(frames.map(frame => frame.texts.join('|'))).size, JSON.stringify(frames)).toBeGreaterThan(1);
    for (const frame of frames.slice(1)) expect(frame.boxes).toEqual(frames[0].boxes);

    // Leaving the page says once that the run goes on; back on it, the run has gone on (AC-WORKBENCH-04-4).
    const beforeLeave = (await rowFraction(longRow))!;
    await openRoute(page, '/tools');
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: copy.background });
    await uiExpect(toast).toHaveCount(1);
    await settle(page, '[data-sonner-toast]');
    await shoot(page, run, 'T-WORKBENCH-04-background-toast-light-zh', await clipAround(page, ['[data-sonner-toast]'], 16));
    await openRoute(page, ROUTE);
    await uiExpect(longRow).toHaveAttribute('data-state', 'running');
    await uiExpect.poll(async () => (await rowFraction(longRow)) ?? 0, { timeout: 10_000 }).toBeGreaterThan(beforeLeave);
    const afterReturn = (await rowFraction(longRow))!;
    // A reload reads the snapshot again, then the events after it: the run goes on (AC-ENGINE-05-1).
    announced.push(...await announcedLines(page));
    events.push(await queueEvents(page));
    // The reloaded page records its live region from its first node on, so files that ended before the reload (the PGS
    // file) would be heard again if the page took the snapshot's list for news.
    await page.addInitScript(recordAnnouncementsInPage);
    const beforeReload = (await rowFraction(longRow))!;
    await page.reload();
    await waitForApp(page);
    await uiExpect(longRow).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
    await uiExpect(longRow.locator('progress.studio-task-progress')).toHaveCount(1);
    await uiExpect(queueRow(page, 'pgs.mkv')).toHaveAttribute('data-state', 'succeeded');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => !!(globalThis as AnnouncementGlobals).__mediaAnnouncementRecorder)).toBe(true);
    expect(await announcedLines(page), 'announced after the reload').toEqual([]);
    await recordQueueEvents(page);
    const afterReload = (await rowFraction(longRow))!;
    expect(afterReload).toBeGreaterThanOrEqual(beforeReload);
    await uiExpect.poll(async () => (await rowFraction(longRow)) ?? 0, { timeout: 10_000 }).toBeGreaterThan(afterReload);
    evidence.continuity = { beforeLeave, afterReturn, beforeReload, afterReload, later: await rowFraction(longRow) };

    // The batch ends with the window behind: a system notification (AC-WORKBENCH-04-4).
    evidence.focus = await leaveTheWindow(media);
    // Cancelling it deletes its partial output (AC-ENGINE-06-1); the clip after it runs.
    await longRow.getByTestId('media-row-cancel').click();
    await uiExpect(longRow).toHaveAttribute('data-state', 'cancelled', { timeout: 30_000 });
    await uiExpect(longRow.getByTestId('media-row-reason')).toHaveText('未完成的临时文件已删除，可以重试');
    await uiExpect(longRow.getByTestId('media-row-retry')).toBeVisible();
    await uiExpect.poll(async () => (await partialsIn(folder)).includes(longPartial), { timeout: 15_000 }).toBe(false);
    evidence.partial = { during: longPartial, after: await partialsIn(folder) };

    // The clip is done: its output name, both sizes and the change, and "show in folder" (AC-WORKBENCH-04-3).
    const clipRow = queueRow(page, 'clip.mp4');
    await uiExpect(clipRow).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 });
    await uiExpect(queueRow(page, 'pgs.mkv')).toHaveAttribute('data-state', 'succeeded');
    const clip = await itemNamed(page, 'clip.mp4');
    const pgs = await itemNamed(page, 'pgs.mkv');
    const output = clip.result!.outputs[0];
    // "Change to MKV" changed the panel, so every file of that start became MKV.
    expect(output.fileName).toBe('clip-compressed.mkv');
    expect(pgs.result!.outputs[0].fileName).toBe('pgs-compressed.mkv');
    expect((await stat(path.join(folder, output.fileName))).size).toBe(output.sizeBytes);
    expect(clip.result!.outputBytes).toBeLessThan(clip.result!.sourceBytes);
    await uiExpect(clipRow.getByTestId('media-row-output-name').locator('.sr-only')).toHaveText('clip-compressed.mkv');
    await uiExpect(clipRow.getByTestId('media-row-sizes')).toHaveText(`${formatBytes(clip.result!.sourceBytes, 'zh')} → ${formatBytes(clip.result!.outputBytes, 'zh')}`);
    await uiExpect(clipRow.getByTestId('media-row-change')).toHaveText(formatSizeChange(clip.result!.sourceBytes, clip.result!.outputBytes, 'zh'));
    await uiExpect(clipRow.getByTestId('media-row-change')).toHaveText(/^−\d+%$/);
    await uiExpect(page.getByTestId('media-cancel-all')).toHaveCount(0);
    await clipRow.getByTestId('media-row-reveal').click();
    await uiExpect.poll(() => revealedFiles(media!)).toEqual(['clip-compressed.mkv']);
    const saved = [pgs, clip].reduce((sum, item) => sum + Math.max(0, item.result!.sourceBytes - item.result!.outputBytes), 0);
    await uiExpect.poll(() => notifications(app), { timeout: 15_000 }).toHaveLength(1);
    expect((await notifications(app))[0]).toEqual({ title: copy.notification, body: `成功 2 个，失败 0 个，跳过 0 个。 共节省 ${formatBytes(saved, 'zh')}。` });
    await page.mouse.move(2, 120, { steps: 4 });
    await showRowsFrom(page, `[data-item-id="${pgsId}"]`);
    await shoot(page, run, 'T-WORKBENCH-04-results-light-zh', await clipAround(page, [`[data-item-id="${pgsId}"]`, `[data-item-id="${longId}"]`, `[data-item-id="${clip.id}"]`], 8));

    // A source already smaller than any compression of it is skipped; "convert anyway" keeps the larger output.
    await stubDialogs(app, { files: [samples.tight] });
    await uploadButton(page).click();
    const tightRow = queueRow(page, 'tight.mp4');
    await uiExpect(tightRow).toHaveAttribute('data-plan', 'ready', { timeout: 30_000 });
    await tightRow.getByTestId('media-row-start').click();
    await uiExpect(tightRow).toHaveAttribute('data-state', 'skipped', { timeout: 60_000 });
    expect((await itemNamed(page, 'tight.mp4')).state).toEqual({ status: 'skipped', reason: 'not_smaller' });
    await uiExpect(tightRow.getByTestId('media-row-reason')).toHaveText(copy.notSmaller);
    await page.mouse.move(2, 120, { steps: 4 });
    await showRowsFrom(page, `[data-item-id="${(await itemNamed(page, 'tight.mp4')).id}"]`);
    await shoot(page, run, 'T-WORKBENCH-04-skipped-light-zh', await clipAround(page, [`[data-item-id="${(await itemNamed(page, 'tight.mp4')).id}"]`], 8));
    await tightRow.getByTestId('media-row-convert-anyway').click();
    await uiExpect(tightRow).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 });
    const tight = await itemNamed(page, 'tight.mp4');
    expect(tight.result!.outputBytes).toBeGreaterThan(tight.result!.sourceBytes);
    await uiExpect(tightRow.getByTestId('media-row-change')).toHaveText(formatSizeChange(tight.result!.sourceBytes, tight.result!.outputBytes, 'zh'));
    await uiExpect(tightRow.getByTestId('media-row-change')).toHaveAttribute('data-direction', 'larger');

    // Retried, the long take runs again; "cancel all" asks first, then cancels it (AC-WORKBENCH-04-1).
    await longRow.getByTestId('media-row-retry').click();
    await uiExpect(longRow).toHaveAttribute('data-state', 'running', { timeout: 60_000 });
    await page.getByTestId('media-cancel-all').click();
    const cancelDialog = page.getByRole('dialog', { name: copy.cancelAllTitle });
    await uiExpect(cancelDialog).toBeVisible();
    await uiExpect(cancelDialog).toContainText(copy.cancelAllBody);
    await settle(page, '[role=dialog]');
    await shoot(page, run, 'T-WORKBENCH-04-cancel-all-light-zh');
    await cancelDialog.getByRole('button', { name: copy.cancelAllConfirm }).click();
    await uiExpect(longRow).toHaveAttribute('data-state', 'cancelled', { timeout: 30_000 });
    await uiExpect(page.getByTestId('media-cancel-all')).toHaveCount(0);

    // The summary: files, their size, done, what compression saved (the larger output saves nothing).
    const items = await queueItems(page);
    const sourceTotal = items.reduce((sum, item) => sum + (item.media?.sizeBytes ?? 0), 0);
    const summary = page.getByTestId('media-summary');
    await uiExpect(summary.getByTestId('media-summary-files')).toHaveText(copy.files(4));
    await uiExpect(summary.getByTestId('media-summary-size')).toHaveText(formatBytes(sourceTotal, 'zh'));
    await uiExpect(summary.getByTestId('media-summary-done')).toHaveText(copy.done(3));
    await uiExpect(summary.getByTestId('media-summary-saved')).toHaveText(`节省 ${formatBytes(saved, 'zh')}`);
    await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
    await page.mouse.move(2, 120, { steps: 4 });
    await settle(page, `${QUEUE_BOXES}, [data-testid=media-summary]`);
    await shoot(page, run, 'T-WORKBENCH-04-run-end-light-zh-1280x800');

    // Every end was announced once, in order (AC-WORKBENCH-04-3): through the reload, a retry ending again included.
    announced.push(...await announcedLines(page));
    events.push(await queueEvents(page));
    const percent = (item: ItemSummary) => `${Math.round((1 - item.result!.outputBytes / item.result!.sourceBytes) * 100)}%`;
    expect(announced).toEqual([
      copy.saved('pgs.mkv', percent(pgs)),
      copy.cancelled('long-take.mp4'),
      copy.saved('clip.mp4', percent(clip)),
      copy.skippedAnnounce('tight.mp4', copy.notSmaller),
      copy.larger('tight.mp4', formatSizeChange(tight.result!.sourceBytes, tight.result!.outputBytes, 'zh')),
      copy.cancelled('long-take.mp4'),
    ]);
    const live = page.getByTestId('media-live');
    await uiExpect(live).toHaveAttribute('aria-live', 'polite');
    const tree = await page.getByRole('log').ariaSnapshot();
    expect(tree).toContain(copy.cancelled('long-take.mp4'));
    evidence.announced = announced;
    evidence.liveTree = tree;

    // The events: a strictly increasing sequence in each recording, and at most four progress events a second per item.
    const progressStats: Record<string, unknown>[] = [];
    for (const recording of events) {
      for (let index = 1; index < recording.length; index++) expect(recording[index].sequence).toBeGreaterThan(recording[index - 1].sequence);
      const progress = recording.filter(event => event.kind === 'progress' && event.itemId === longId);
      progressStats.push({ recording: progressStats.length, events: recording.length, progress: progress.length });
      if (progress.length < 3) continue;
      const gaps = progress.slice(1).map((event, index) => event.at - progress[index].at);
      const seconds = (progress.at(-1)!.at - progress[0].at) / 1000;
      const perSecond = (progress.length - 1) / seconds;
      progressStats.push({ events: progress.length, seconds: Math.round(seconds * 10) / 10, perSecond: Math.round(perSecond * 100) / 100, minGapMs: Math.round(Math.min(...gaps)) });
      expect(perSecond).toBeLessThanOrEqual(4.2);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
    }
    expect(progressStats.filter(entry => 'perSecond' in entry).length).toBeGreaterThan(0);
    evidence.progressEvents = progressStats;

    // "Clear done" takes the finished files off the list, not their outputs.
    await page.getByTestId('media-clear-done').click();
    await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(1);
    await uiExpect(longRow).toHaveCount(1);
    expect((await stat(path.join(folder, 'clip-compressed.mkv'))).size).toBe(output.sizeBytes);

    await writeFile(path.join(run, 'T-WORKBENCH-04-run.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 600_000);

  // AC-WORKBENCH-04-1, AC-WORKBENCH-04-3, AC-WORKBENCH-03-6 (lossless in the same dialog); V-WORKBENCH-04-1 (failure, retry, detecting).
  it('failures and holds: the error code and the redacted log, a retry that succeeds, no start while detecting, lossless and replaced files in one confirmation', async () => {
    const run = await createMediaRun();
    const folder = path.join(run, 'media');
    const clipFile = await makeMedia(run, 'clip.mp4', [...lavfi.video(), ...lavfi.tone(), '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'aac', '-b:a', '128k', '-shortest']);
    const [song, memo] = await Promise.all([
      makeMedia(run, 'song.m4a', [...lavfi.tone({ frequency: 523 }), '-c:a', 'aac', '-b:a', '128k']),
      makeMedia(run, 'memo.m4a', [...lavfi.tone({ frequency: 330 }), '-c:a', 'aac', '-b:a', '96k']),
    ]);
    // An older export where the song's FLAC goes: "overwrite" replaces it through the recycle bin (the test shell deletes it).
    const oldExport = path.join(folder, 'song.flac');
    await writeFile(oldExport, 'an older export of the song\n');
    const evidence: Record<string, unknown> = {};

    // The first run of every item fails as an output that cannot be opened would (FUSIONKIT_TEST_MEDIA_FAIL).
    media = await launchMediaApp({ run, profile: 'profile-fail', switches: { caps: 'cpu_only', fail: 'output_open_failed:first_attempt' }, size: { width: 1280, height: 800 } });
    let { app, page } = media;
    await openSettings(media, { theme: 'light', language: 'zh' });
    await waitForEngine(page, 'ready');
    await recordAnnouncements(page);
    await stubDialogs(app, { files: [clipFile] });
    await uploadButton(page).click();
    const clipRow = queueRow(page, 'clip.mp4');
    await uiExpect(clipRow).toHaveAttribute('data-plan', 'ready', { timeout: 30_000 });
    await page.getByTestId('media-start-all').click();
    await uiExpect(clipRow).toHaveAttribute('data-state', 'failed', { timeout: 60_000 });
    const failed = await itemNamed(page, 'clip.mp4');
    expect(failed.state).toEqual({ status: 'failed', code: 'output_open_failed', partial: false });
    await uiExpect(clipRow.getByTestId('media-row-reason')).toHaveText(RUN_COPY.zh.outputOpenFailed);
    await uiExpect(clipRow.getByTestId('media-row-retry')).toBeVisible();
    // Nothing was left behind by the failed run.
    expect(await partialsIn(folder)).toEqual([]);

    const checkDetails = async (language: 'zh' | 'en', label: string) => {
      await clipRow.getByTestId('media-row-details').click();
      const modal = page.getByRole('dialog');
      await uiExpect(modal).toBeVisible();
      await uiExpect(modal).toContainText('clip.mp4');
      await uiExpect(modal).toContainText(RUN_COPY[language].outputOpenFailed);
      await uiExpect(modal).toContainText(RUN_COPY[language].code('output_open_failed'));
      if (language === 'zh') await uiExpect(modal.getByTestId('media-failure-advice')).toHaveText(RUN_COPY.zh.outputOpenAdvice);
      const text = await modal.innerText();
      // The redacted tail: the injected failure's own lines, the output by its placeholder, no path of this computer.
      expect(text).toContain('[FUSIONKIT_TEST_MEDIA_FAIL] output_open_failed was injected into the first run of this item.');
      expect(text).toContain('Error opening output <output>: Permission denied');
      expect(text).not.toMatch(ABSOLUTE_PATH);
      expect(text).not.toContain(run);
      expect(text.toLowerCase()).not.toContain(os.userInfo().username.toLowerCase());
      expect(failed.log ?? '').not.toMatch(ABSOLUTE_PATH);
      evidence[`details-${label}`] = text;
      await settle(page, '[role=dialog]');
      await shoot(page, run, `T-WORKBENCH-04-error-details-${label}`);
      // Escape closes the details and nothing else: the page stays (useToolPageEscape leaves it to the dialog).
      await page.keyboard.press('Escape');
      await uiExpect(modal).toHaveCount(0);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => location.hash)).toBe(`#${ROUTE}`);
    };
    await checkDetails('zh', 'light-zh');
    await setAppearance(page, { theme: 'dark', language: 'en', route: ROUTE });
    await uiExpect(clipRow).toHaveAttribute('data-state', 'failed');
    await checkDetails('en', 'dark-en');
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });
    await recordAnnouncements(page);
    // A retry runs for real and succeeds (only first runs fail).
    await clipRow.getByTestId('media-row-retry').click();
    await uiExpect(clipRow).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 });
    const succeeded = await itemNamed(page, 'clip.mp4');
    expect(succeeded.log).toBeNull();
    expect((await stat(path.join(folder, succeeded.result!.outputs[0].fileName))).size).toBe(succeeded.result!.outputs[0].sizeBytes);
    expect(await announcedLines(page)).toEqual([RUN_COPY.zh.saved('clip.mp4', `${Math.round((1 - succeeded.result!.outputBytes / succeeded.result!.sourceBytes) * 100)}%`)]);
    expect(media.errors).toEqual([]);
    await media.close();

    // Detecting (FUSIONKIT_TEST_MEDIA_CAPS=detecting_ms): files come in, nothing starts, and the reason is told.
    media = await launchMediaApp({ run, profile: 'profile-detect', switches: { caps: 'detecting_ms:12000' }, size: { width: 1280, height: 800 } });
    ({ app, page } = media);
    // Converting AAC to FLAC: lossy audio to a lossless format, which is confirmed before the start.
    await openSettings(media, { theme: 'light', language: 'zh' }, { task: 'convert', convert: { target: 'flac' } });
    await waitForEngine(page, 'detecting');
    await stubDialogs(app, { files: [song, memo] });
    await uploadButton(page).click();
    for (const name of ['song.m4a', 'memo.m4a']) await uiExpect(queueRow(page, name)).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await uiExpect(page.getByTestId('media-engine-status')).toHaveAttribute('data-state', 'detecting');
    const startAll = page.getByTestId('media-start-all');
    await uiExpect(startAll).toBeDisabled();
    await uiExpect(queueRow(page, 'song.m4a').getByTestId('media-row-start')).toBeDisabled();
    await page.getByTestId('media-start-all-reason-trigger').hover();
    await uiExpect(page.getByTestId('media-start-all-reason')).toHaveText(RUN_COPY.zh.detecting);
    await settle(page, '[data-testid=media-start-all-reason]');
    await shoot(page, run, 'T-WORKBENCH-04-start-detecting-light-zh', await clipAround(page, ['.media-queue [data-slot=tool-panel-header]', '[data-testid=media-start-all-reason]'], 12));
    await leaveHover(page);
    // The keyboard reaches the reason too.
    await page.getByTestId('media-start-all-reason-trigger').focus();
    await uiExpect(page.getByTestId('media-start-all-reason')).toHaveText(RUN_COPY.zh.detecting);
    await page.locator('h1').click();
    evidence.detecting = { startAll: 'disabled while detecting', rowStart: 'disabled while detecting' };
    await waitForEngine(page, 'ready');
    await uiExpect(startAll).toBeEnabled();
    await uiExpect(queueRow(page, 'song.m4a').getByTestId('media-row-start')).toBeEnabled();

    // Lossy AAC to FLAC, replacing an older export: both in the one confirmation, each file can be skipped.
    const group = page.getByTestId('media-output-group');
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
    await segment(page, 'media-conflict-overwrite').click();
    await uiExpect(segment(page, 'media-conflict-overwrite')).toHaveAttribute('aria-checked', 'true');
    await startAll.click();
    const dialog = page.getByTestId('media-confirm');
    await uiExpect(dialog).toBeVisible();
    const entry = (name: string) => dialog.getByTestId('media-confirm-item').filter({ has: page.locator('.studio-file-name .sr-only', { hasText: name }) });
    await uiExpect(dialog.getByTestId('media-confirm-item')).toHaveCount(2);
    await uiExpect(entry('song.m4a').getByTestId('media-confirm-lossless')).toHaveText(RUN_COPY.zh.lossless);
    await uiExpect(entry('song.m4a').getByTestId('media-confirm-replace')).toHaveText(RUN_COPY.zh.replace('song.flac'));
    await uiExpect(entry('memo.m4a').getByTestId('media-confirm-lossless')).toHaveText(RUN_COPY.zh.lossless);
    await uiExpect(entry('memo.m4a').getByTestId('media-confirm-replace')).toHaveCount(0);
    // Nothing started while the dialog asks, and the old export is untouched.
    expect((await queueItems(page)).map(item => item.state.status)).toEqual(['idle', 'idle']);
    expect(await readFile(oldExport, 'utf8')).toBe('an older export of the song\n');
    await settle(page, '[role=dialog]');
    await shoot(page, run, 'T-WORKBENCH-04-confirm-lossless-replace-light-zh');
    // Skipped, then closed with Escape: nothing starts, the page stays, and the next "start all" asks afresh.
    await entry('memo.m4a').getByTestId('media-confirm-skip').click();
    await uiExpect(entry('memo.m4a')).toHaveAttribute('data-skipped', 'true');
    await page.keyboard.press('Escape');
    await uiExpect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => location.hash)).toBe(`#${ROUTE}`);
    expect((await queueItems(page)).map(item => item.state.status)).toEqual(['idle', 'idle']);
    await startAll.click();
    await uiExpect(dialog).toBeVisible();
    await uiExpect(entry('memo.m4a')).not.toHaveAttribute('data-skipped', 'true');
    await uiExpect(entry('song.m4a').getByTestId('media-confirm-replace')).toHaveText(RUN_COPY.zh.replace('song.flac'));
    await entry('memo.m4a').getByTestId('media-confirm-skip').click();
    await uiExpect(entry('memo.m4a')).toHaveAttribute('data-skipped', 'true');
    await uiExpect(entry('memo.m4a').getByTestId('media-confirm-skipped')).toHaveText(RUN_COPY.zh.skipped);
    await uiExpect(dialog.getByTestId('media-confirm-start')).toHaveText(RUN_COPY.zh.start(1));
    await settle(page, '[role=dialog]');
    await shoot(page, run, 'T-WORKBENCH-04-confirm-skip-light-zh');
    await dialog.getByTestId('media-confirm-start').click();
    await uiExpect(dialog).toHaveCount(0);
    const songRow = queueRow(page, 'song.m4a');
    await uiExpect(songRow).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 });
    await uiExpect(queueRow(page, 'memo.m4a')).toHaveAttribute('data-state', 'idle');
    const songItem = await itemNamed(page, 'song.m4a');
    expect(songItem.job?.plan.confirmations).toEqual(['lossy_to_lossless']);
    expect(songItem.result!.outputs[0]).toMatchObject({ fileName: 'song.flac', replaced: true });
    expect((await readFile(oldExport)).subarray(0, 4).toString('latin1')).toBe('fLaC');
    const trashed = (await shellCalls(app)).filter(call => call.kind === 'trashItem').map(call => path.basename(call.target));
    expect(trashed).toEqual(['song.flac']);
    evidence.replaced = { result: songItem.result, trashed };
    await writeFile(path.join(run, 'T-WORKBENCH-04-failures.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 600_000);

  // V-WORKBENCH-04-2: thirty items in every state, four windows, both themes, zh and en, scrolled to the end.
  it('review: thirty items in every state across windows, themes and languages, the corners, the dock and steady numbers', async () => {
    const run = await createMediaRun();
    const clipFile = await makeMedia(run, 'vacation.mp4', [...lavfi.video(), ...lavfi.tone(), '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'aac', '-b:a', '128k', '-shortest']);
    const longFile = await makeMedia(run, LONG_NAME, [...lavfi.video(), ...lavfi.tone(), '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'aac', '-b:a', '128k', '-shortest']);
    media = await launchMediaApp({ run, switches: { caps: 'cpu_only' }, size: { width: 1280, height: 800 } });
    const { app, page } = media;
    const evidence: Record<string, unknown> = {};
    await openSettings(media, { theme: 'light', language: 'zh' });
    await waitForEngine(page, 'ready');
    await stubDialogs(app, { files: [clipFile, longFile] });
    await uploadButton(page).click();
    for (const name of ['vacation.mp4', LONG_NAME]) await uiExpect(queueRow(page, name)).toHaveAttribute('data-plan', 'ready', { timeout: 30_000 });
    const real = await itemNamed(page, 'vacation.mp4');
    const realPlan = await mainPlan(page, real.id, compressSettings());
    if (realPlan.status !== 'ready') throw new Error('The clip could not be planned');
    const reviewItems = makeReviewItems(real.media!, realPlan.plan);

    /** The thirty rows: the two real idle files and the injected ones, with the running item at its first numbers. */
    const inject = async () => {
      const snapshot = await page.evaluate(() => window.mediaConverter!.getSnapshot());
      if (!snapshot.ok) throw new Error('No snapshot');
      const base = snapshot.value.sequence + 1_000;
      await sendQueueEvent(app, { sequence: base, kind: 'items', removed: [], items: reviewItems });
      await uiExpect(page.locator('[data-testid=media-queue-row]')).toHaveCount(30);
      return base;
    };
    const progressAt = async (sequence: number, frame: number) => {
      await sendQueueEvent(app, { sequence, kind: 'progress', itemId: 'review_00', progress: REVIEW_PROGRESS[frame] });
      await uiExpect(queueRow(page, 'vacation-2026.mp4').getByTestId('media-stat-eta')).toHaveText(REVIEW_PROGRESS_ETA[frame]);
    };

    const matrix: [Theme, 'zh' | 'en', number, number][] = [
      ['light', 'zh', 1280, 800], ['dark', 'en', 1280, 800], ['light', 'en', 1080, 786], ['dark', 'zh', 1024, 700], ['light', 'zh', 786, 540], ['dark', 'en', 786, 540],
    ];
    const measured: Record<string, unknown> = {};
    for (const [theme, language, width, height] of matrix) {
      const label = `${theme}-${language}-${width}x${height}`;
      await setAppearance(page, { theme, language, route: ROUTE });
      const viewport = await setWindowSize(media, { width, height });
      await waitForEngine(page, 'ready');
      const base = await inject();
      await progressAt(base + 1, 0);
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
      await page.mouse.move(2, 120, { steps: 4 });
      await settle(page, `${QUEUE_BOXES}, [data-testid=media-summary]`);
      const top = await reviewGeometry(page);
      await shoot(page, run, `T-WORKBENCH-04-review-${label}`);
      // The end of the list, as far as the page scrolls.
      await scrollViewport(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
      await settle(page, QUEUE_BOXES);
      const end = await reviewGeometry(page);
      await shoot(page, run, `T-WORKBENCH-04-review-end-${label}`);
      if (width < 1024) {
        // One column: the settings come after the queue, so the list's own end is shown as well.
        await bringIntoView(page, page.locator('[data-testid=media-queue-row]').last());
        await shoot(page, run, `T-WORKBENCH-04-review-list-end-${label}`);
      }
      const rows = await rowGeometry(page);
      for (const row of rows) expect(row.overflow, `${row.name} ${label}`).toEqual([]);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      // Corners (visual-contract 靠角等距): the header's last button and every row's last button as far from the top as from the right.
      expect(top.header.top, label).toBe(top.header.right);
      for (const row of top.rows) if (row.corner) expect(row.corner.top, `${row.name} ${label}`).toBe(row.corner.right);
      // The last row clears the bottom bar once the page is scrolled to its end, and the floating AgentDock covers nothing then.
      expect(end.lastRowBottom, label).toBeLessThanOrEqual(end.barTop);
      expect(end.dock?.covered ?? [], label).toEqual([]);
      measured[label] = { viewport, top, end: { lastRowBottom: end.lastRowBottom, barTop: end.barTop, dock: end.dock }, heights: heightsByState(top.rows) };
      expect(top.rows.length).toBe(30);
    }
    evidence.windows = measured;
    // Rows of one kind are one height at 1280×800: every state, with the same number of listed outputs.
    for (const label of ['light-zh-1280x800', 'dark-en-1280x800']) {
      const { heights } = measured[label] as { heights: Record<string, number[]> };
      for (const [state, values] of Object.entries(heights)) expect(new Set(values).size, `${label} ${state} ${values}`).toBe(1);
    }

    // Up close, light zh and dark en at 1280×800: the header and summary, each group of states, numbers in three frames.
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']] as [Theme, 'zh' | 'en'][]) {
      const label = `${theme}-${language}`;
      await setAppearance(page, { theme, language, route: ROUTE });
      await setWindowSize(media, { width: 1280, height: 800 });
      await waitForEngine(page, 'ready');
      const base = await inject();
      await progressAt(base + 1, 0);
      await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
      await page.mouse.move(2, 120, { steps: 4 });
      await settle(page, `${QUEUE_BOXES}, [data-testid=media-summary]`);
      await shoot(page, run, `T-WORKBENCH-04-header-${label}`, await clipAround(page, ['[data-testid=media-summary]', '.media-queue [data-slot=tool-panel-header]'], 8));
      for (const [group, ids] of Object.entries(REVIEW_GROUPS)) {
        await showRowsFrom(page, `[data-item-id="${ids[0]}"]`);
        await shoot(page, run, `T-WORKBENCH-04-rows-${group}-${label}`, await clipAround(page, ids.map(id => `[data-item-id="${id}"]`), 8));
      }
      // Numbers that change keep their places: three frames of new values (AC-WORKBENCH-04-2).
      const running = queueRow(page, 'vacation-2026.mp4');
      await showRowsFrom(page, '[data-item-id="review_00"]');
      const frames: Awaited<ReturnType<typeof statFrame>>[] = [];
      for (let frame = 0; frame < 3; frame++) {
        await progressAt(base + 2 + frame, frame);
        frames.push(await statFrame(running));
        await shoot(page, run, `T-WORKBENCH-04-review-frame-${frame + 1}-${label}`, await clipAround(page, ['[data-item-id="review_00"]'], 8));
      }
      expect(new Set(frames.map(frame => frame.texts.join('|'))).size).toBe(3);
      for (const frame of frames.slice(1)) expect(frame.boxes, label).toEqual(frames[0].boxes);
      evidence[`frames-${label}`] = frames;
    }

    // The floating AgentDock against the page at 1280×800, top and end, and against another tool page with a long settings panel.
    await setAppearance(page, { theme: 'light', language: 'zh', route: ROUTE });
    await setWindowSize(media, { width: 1280, height: 800 });
    await waitForEngine(page, 'ready');
    await inject();
    await scrollViewport(page).evaluate(element => { element.scrollTop = 0; });
    await settle(page, QUEUE_BOXES);
    const dockTop = (await reviewGeometry(page)).dock;
    await shoot(page, run, 'T-WORKBENCH-04-dock-light-zh-1280x800', { x: 0, y: 500, width: 420, height: 306 });
    await openRoute(page, '/tools/subtitle/converter');
    const converterDock = await page.evaluate(() => {
      const launcher = document.querySelector('[data-testid=agent-dock-launcher]')?.getBoundingClientRect();
      const aside = document.querySelector('[data-slot=tool-detail-layout] aside')?.getBoundingClientRect();
      return launcher && aside ? { launcher: { left: launcher.left, top: launcher.top, right: launcher.right, bottom: launcher.bottom }, aside: { left: aside.left, top: aside.top, right: aside.right, bottom: aside.bottom },
        overlap: launcher.left < aside.right && launcher.right > aside.left && launcher.top < aside.bottom && launcher.bottom > aside.top } : null;
    });
    evidence.dock = { media: dockTop, subtitleConverter: converterDock };

    // The transcription queue's header corner, for comparison (design 靠角留白): the same panel, measured the same way.
    await page.evaluate(route => { location.hash = route; }, '/tools/subtitle/studio?view=transcription');
    evidence.transcriptionHeader = await page.locator('.studio-transcription-queue [data-slot=tool-panel-header]').first().waitFor({ timeout: 15_000 })
      .then(() => page.evaluate(() => {
        const panel = document.querySelector('.studio-transcription-queue')!;
        const box = panel.getBoundingClientRect();
        const border = parseFloat(getComputedStyle(panel).borderTopWidth);
        const buttons = [...panel.querySelectorAll('[data-slot=tool-panel-header] button')].filter(button => button.getClientRects().length);
        const last = buttons.at(-1)!.getBoundingClientRect();
        return { top: Math.round((last.top - box.top - border) * 10) / 10, right: Math.round((box.right - border - last.right) * 10) / 10, buttonHeight: Math.round(last.height) };
      }))
      .catch(error => `not measured: ${String(error).split('\n')[0]}`);

    // "Cancel all" on the injected running and queued items asks first; kept here, nothing is sent.
    await openRoute(page, ROUTE);
    await inject();
    await page.getByTestId('media-cancel-all').click();
    const cancelDialog = page.getByRole('dialog');
    await uiExpect(cancelDialog).toContainText('将取消 5 个排队中或处理中的文件');
    await settle(page, '[role=dialog]');
    await cancelDialog.getByRole('button', { name: '继续转换' }).click();
    await uiExpect(cancelDialog).toHaveCount(0);
    // A failure's details with a longer redacted log, in the narrow window (once the leave toast of the route changes above is gone).
    await setWindowSize(media, { width: 786, height: 540 });
    await uiExpect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
    await queueRow(page, 'subtitle-burn-in.mkv').getByTestId('media-row-details').click();
    const modal = page.getByRole('dialog');
    await uiExpect(modal).toContainText('<input>');
    await settle(page, '[role=dialog]');
    await shoot(page, run, 'T-WORKBENCH-04-error-details-light-zh-786x540');
    await page.keyboard.press('Escape');

    await writeFile(path.join(run, 'T-WORKBENCH-04-review.json'), JSON.stringify(evidence, null, 2));
    expect(media.errors).toEqual([]);
    await media.close();
    media = undefined;
  }, 900_000);
});

/** Three frames of a running item's numbers whose text widths differ (two-digit and three-digit fps, 9.9 → 100 MB). */
const REVIEW_PROGRESS = [
  { fraction: 0.41, processedUs: 49_200_000, writtenBytes: Math.round(9.9 * 1024 ** 2), speed: 2.95, fps: 99, etaMs: 59_000, outputIndex: 0, outputCount: 1 },
  { fraction: 0.47, processedUs: 56_400_000, writtenBytes: Math.round(10.4 * 1024 ** 2), speed: 10.2, fps: 100, etaMs: 61_000, outputIndex: 0, outputCount: 1 },
  { fraction: 0.53, processedUs: 63_600_000, writtenBytes: 100 * 1024 ** 2, speed: 0.85, fps: 7, etaMs: 1_000, outputIndex: 0, outputCount: 1 },
];
const REVIEW_PROGRESS_ETA = ['0:59', '1:01', '0:01'];

/** Rows of each kind, shown together in the close-ups. */
const REVIEW_GROUPS: Record<string, string[]> = {
  running: ['review_00', 'review_01', 'review_02', 'review_03'],
  done: ['review_05', 'review_06', 'review_07', 'review_08', 'review_09', 'review_10', 'review_11'],
  failed: ['review_12', 'review_13', 'review_14', 'review_15', 'review_16', 'review_17', 'review_18'],
  ended: ['review_19', 'review_20', 'review_21', 'review_22', 'review_23', 'review_24', 'review_25', 'review_26', 'review_27'],
};

/**
 * Twenty-eight items as the main process would send them after a long session: running (with and without a
 * known length), queued, done (one of three tracks extracted, one larger than its source), partly done, failed
 * for several reasons, skipped, interrupted, cancelled (one with a saved track) and changed. They carry a real
 * probe and a real plan; only their states and results are made up, as no run could produce them all at once.
 */
function makeReviewItems(media: MediaInfo, plan: PlanSummary): unknown[] {
  const MB = 1024 ** 2;
  const GB = 1024 ** 3;
  const now = Date.UTC(2026, 9, 28, 14, 0, 0);
  const job = (task: 'compress' | 'extract-audio' = 'compress') => ({
    settings: task === 'compress' ? compressSettings() : { task: 'extract-audio', format: 'm4a', tier: 'balanced', allTracks: true },
    plan, output: { mode: 'source', directoryName: null, conflict: 'number' },
  });
  const output = (index: number, fileName: string, sizeBytes: number) => ({ index, fileName, folderName: 'media', sizeBytes: Math.round(sizeBytes), replaced: false });
  const result = (outputs: ReturnType<typeof output>[], outputCount: number, sourceBytes: number) =>
    ({ outputs, outputCount, sourceBytes: Math.round(sourceBytes), outputBytes: outputs.reduce((sum, entry) => sum + entry.sizeBytes, 0), warnings: [] });
  const log = [
    "[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0000000000000000] [info] Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '<input>':",
    '[vost#0:0/libopenh264 @ 0000000000000000] [enc:libopenh264 @ 0000000000000000] [error] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
    '[vost#0:0/libopenh264 @ 0000000000000000] [error] Could not open encoder before EOF',
    '[out#0/mp4 @ 0000000000000000] [error] Nothing was written into output file <output>, because at least one of its streams received no packets.',
    '[media-converter] The fonts of [path] were not attached.',
  ].join('\n');
  const entries: [string, unknown, Record<string, unknown>][] = [
    ['vacation-2026.mp4', { status: 'running', phase: 'encoding' }, { progress: REVIEW_PROGRESS[0] }],
    ['live-stream-capture.ts', { status: 'running', phase: 'encoding' }, { progress: { fraction: null, processedUs: 42_000_000, writtenBytes: Math.round(3.1 * MB), speed: 1.42, fps: 35.6, etaMs: null, outputIndex: 0, outputCount: 1 } }],
    ['interview-camera-b.mov', { status: 'queued' }, {}],
    ['drone-flight-0417.mp4', { status: 'queued' }, {}],
    ['家庭聚会-第二部分.mkv', { status: 'queued' }, {}],
    ['screen-recording.mkv', { status: 'succeeded' }, { result: result([output(0, 'screen-recording-compressed.mkv', 310 * MB)], 1, 1.2 * GB) }],
    ['phone-video-IMG_4821.MOV', { status: 'succeeded' }, { result: result([output(0, 'phone-video-IMG_4821-compressed.mp4', 41.2 * MB)], 1, 96.4 * MB) }],
    [LONG_NAME.replace('.mkv', ' (2).mkv'), { status: 'succeeded' }, { result: result([output(0, LONG_NAME.replace('.mkv', ' (2)-compressed.mkv'), 0.9 * GB)], 1, 2.1 * GB) }],
    ['podcast-episode-12.mp4', { status: 'succeeded' }, { job: job('extract-audio'), result: result([output(0, 'podcast-episode-12.track1.jpn.m4a', 18.4 * MB), output(1, 'podcast-episode-12.track2.eng.m4a', 18.1 * MB), output(2, 'podcast-episode-12.track3.m4a', 9.2 * MB)], 3, 412 * MB) }],
    ['already-small.mp4', { status: 'succeeded' }, { result: result([output(0, 'already-small-compressed.mp4', 2.6 * MB)], 1, 2.2 * MB) }],
    ['lecture-week-3.webm', { status: 'succeeded' }, { result: result([output(0, 'lecture-week-3-compressed.mp4', 88 * MB)], 1, 640 * MB) }],
    ['birthday.mp4', { status: 'succeeded' }, { result: result([output(0, 'birthday-compressed.mp4', 24.3 * MB)], 1, 64 * MB) }],
    ['concert-multi-audio.mkv', { status: 'failed', code: 'encode_failed', partial: true }, { job: job('extract-audio'), log, result: result([output(0, 'concert-multi-audio.track1.m4a', 52 * MB), output(1, 'concert-multi-audio.track2.m4a', 51 * MB)], 3, 3.4 * GB) }],
    ['audiobook-chapters.mka', { status: 'failed', code: 'disk_full', partial: true }, { job: job('extract-audio'), log, result: result([output(0, 'audiobook-chapters.track1.m4a', 120 * MB)], 2, 610 * MB) }],
    ['subtitle-burn-in.mkv', { status: 'failed', code: 'encode_failed', partial: false }, { log }],
    ['locked-folder-export.mp4', { status: 'failed', code: 'output_open_failed', partial: false }, { log }],
    ['4k-timelapse.mov', { status: 'failed', code: 'disk_space_low', partial: false, space: { requiredBytes: Math.round(5.5 * GB), availableBytes: Math.round(1.2 * GB) } }, {}],
    ['moved-away.mp4', { status: 'failed', code: 'input_missing', partial: false }, {}],
    ['frozen-encoder.mp4', { status: 'failed', code: 'encoder_stalled', partial: false }, { log }],
    ['compressed-before.mp4', { status: 'skipped', reason: 'not_smaller' }, {}],
    ['tiny-gif-export.mp4', { status: 'skipped', reason: 'not_smaller' }, {}],
    ['already-h264.mp4', { status: 'skipped', reason: 'already_target' }, {}],
    ['already-mkv.mkv', { status: 'skipped', reason: 'already_target' }, {}],
    ['night-shift.mp4', { status: 'interrupted' }, {}],
    ['before-update.mkv', { status: 'interrupted' }, {}],
    ['changed-mind.mp4', { status: 'cancelled' }, {}],
    ['all-tracks.mkv', { status: 'cancelled' }, { job: job('extract-audio'), result: result([output(0, 'all-tracks.track1.m4a', 40 * 1024)], 3, 101_000) }],
    ['edited-after-adding.mp4', { status: 'input_changed' }, {}],
  ];
  // The probe's size is the source size the result names, so the summary adds up as it would after a real session.
  const sizes = [1.4 * GB, 820 * MB, 2.3 * GB, 640 * MB, 4.1 * GB];
  return entries.map(([displayName, state, extra], index) => ({
    id: `review_${String(index).padStart(2, '0')}`, displayName, folderName: 'media',
    media: { ...media, sizeBytes: Math.round((extra.result as { sourceBytes?: number } | undefined)?.sourceBytes ?? sizes[index % sizes.length]) },
    state, job: job(), progress: null, result: null, log: null,
    addedAt: now - (60 - index) * 60_000,
    finishedAt: ['running', 'queued'].includes((state as { status: string }).status) ? null : now - (30 - index) * 60_000,
    ...extra,
  }));
}

/** Heights of the rows by their state, and by how many saved outputs they list. */
const heightsByState = (rows: { state: string | undefined; height: number; outputs: number }[]) => {
  const heights: Record<string, number[]> = {};
  for (const row of rows) (heights[`${row.state ?? '?'}${row.outputs ? `+${row.outputs}` : ''}`] ??= []).push(row.height);
  return heights;
};

/**
 * The queue against its frame (V-WORKBENCH-04-2): the header's last button against the panel's inner edges, each
 * row's last button against the row, every row's height, where the bottom bar starts and where the last row ends,
 * and what the floating AgentDock launcher covers.
 */
const reviewGeometry = (page: Page) => page.evaluate(() => {
  const tenth = (value: number) => Math.round(value * 10) / 10;
  const panel = document.querySelector<HTMLElement>('.media-queue')!;
  const box = panel.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(panel).borderTopWidth);
  const headerButtons = [...panel.querySelectorAll<HTMLElement>('[data-slot=tool-panel-header] button')].filter(button => button.getClientRects().length);
  const last = headerButtons.at(-1)!.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid=media-queue-row]')].map(row => {
    const rowBox = row.getBoundingClientRect();
    const button = [...row.querySelectorAll<HTMLElement>('.studio-task-actions > button')].at(-1)?.getBoundingClientRect();
    return {
      name: row.querySelector('.studio-task-name .studio-file-name .sr-only')?.textContent ?? '', state: row.dataset.state, height: Math.round(rowBox.height),
      outputs: row.querySelectorAll('[data-testid=media-row-output]').length,
      corner: button ? { top: tenth(button.top - rowBox.top), right: tenth(rowBox.right - button.right) } : null,
    };
  });
  const launcher = document.querySelector('[data-testid=agent-dock-launcher]')?.getBoundingClientRect() ?? null;
  const hits = (target: DOMRect) => !!launcher && launcher.left < target.right && launcher.right > target.left && launcher.top < target.bottom && launcher.bottom > target.top;
  const covered = launcher ? [...document.querySelectorAll<HTMLElement>('[data-testid=media-converter-settings], [data-testid=media-summary], [data-testid=media-queue-row] button, [data-slot=tool-panel-header] button, [data-testid=media-row-result], [data-testid=media-meta]')]
    .filter(element => hits(element.getBoundingClientRect())).map(element => element.dataset.testid ?? element.tagName.toLowerCase()) : [];
  // What it covers inside the settings panel: controls, icons and text, not just the panel's box.
  const coveredContent = launcher ? [...document.querySelectorAll<Element>('[data-testid=media-converter-settings] :is(button, input, label, svg, p, h2, h3, [role=radio])')]
    .filter(element => hits(element.getBoundingClientRect())).map(element => `${element.tagName.toLowerCase()}${element.textContent?.trim() ? ` "${element.textContent.trim().slice(0, 20)}"` : ''}`) : [];
  const queueRows = document.querySelectorAll('[data-testid=media-queue-row]');
  const barTop = document.querySelector('div.fixed.bottom-0 .rounded-full.border')?.getBoundingClientRect().top ?? innerHeight;
  return {
    header: { top: tenth(last.top - box.top - border), right: tenth(box.right - border - last.right), buttonHeight: Math.round(last.height) },
    rows,
    lastRowBottom: Math.round(queueRows[queueRows.length - 1].getBoundingClientRect().bottom),
    barTop: Math.round(barTop),
    dock: launcher ? { launcher: { left: tenth(launcher.left), top: tenth(launcher.top), right: tenth(launcher.right), bottom: tenth(launcher.bottom) }, covered, coveredContent } : null,
  };
});
