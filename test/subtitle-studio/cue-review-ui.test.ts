import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';
import { createTestRun } from '../support/testRun';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

type Segment = { text: string; startMs: number; endMs: number; confidence?: number };
/** Every review reason, ordinary lines around them and one long line that wraps. Flagged: 2, 4, 5, 6, 7, 9, 12 and 13. */
const REVIEW: Segment[] = [
  { text: '先輩、おはようございます。', startMs: 0, endMs: 2000, confidence: 0.91 },
  { text: 'ご視聴ありがとうございました', startMs: 2000, endMs: 4500, confidence: 0.31 },
  { text: 'って、もう眠そうじゃないですか。', startMs: 4500, endMs: 7000, confidence: 0.88 },
  { text: '♪～♪', startMs: 7000, endMs: 9000, confidence: 0.7 },
  { text: 'あああああああああああ', startMs: 9000, endMs: 12_000, confidence: 0.6 },
  { text: 'まだ朝なのに。', startMs: 12_000, endMs: 14_000, confidence: 0.32 },
  { text: '今日はとても良い天気ですね本当にそう思います', startMs: 14_000, endMs: 15_000, confidence: 0.86 },
  { text: 'そうなんですね', startMs: 15_500, endMs: 17_000, confidence: 0.9 },
  { text: 'そうなんですね', startMs: 17_200, endMs: 18_500, confidence: 0.9 },
  { text: 'ん？なんですか？', startMs: 19_000, endMs: 21_000, confidence: 0.85 },
  { text: '昨日の夜、駅前の本屋で新しい小説を買ってから家に帰って、夜遅くまでずっと読んでいたので今日はとても眠いです。', startMs: 21_000, endMs: 28_000, confidence: 0.84 },
  { text: 'はい、はい、はい、はい', startMs: 28_000, endMs: 31_000, confidence: 0.72 },
  { text: 'Thanks for watching!', startMs: 31_000, endMs: 33_000, confidence: 0.4 },
  { text: '君は白鸽だから?', startMs: 34_000, endMs: 36_000, confidence: 0.9 },
];
const CLEAN: Segment[] = ['先輩、おはようございます。', 'って、もう眠そうじゃないですか。', 'まだ朝なのに。', 'ん？なんですか？']
  .map((text, index) => ({ text, startMs: index * 3000, endMs: index * 3000 + 2000, confidence: 0.9 }));
/** An older transcript: no confidence, so only the text rules flag lines 2 and 4. */
const OLD: Segment[] = ['先輩、おはようございます。', 'チャンネル登録よろしくお願いします', 'まだ朝なのに。', '♪～♪', 'ん？なんですか？']
  .map((text, index) => ({ text, startMs: index * 3000, endMs: index * 3000 + 2000 }));
const MANY: Segment[] = Array.from({ length: 1200 }, (_, index) => ({ text: `第${index + 1}句のせりふです`, startMs: index * 2000, endMs: index * 2000 + 1500, confidence: 0.2 }));
/** Three pages with flagged lines 3 and 205 only: the middle page has none. */
const PAGED: Segment[] = Array.from({ length: 230 }, (_, index) => ({ text: `第${index + 1}句のせりふです`, startMs: index * 2000, endMs: index * 2000 + 1500, confidence: index === 2 || index === 204 ? 0.2 : 0.9 }));
const RUN = path.resolve('test-results/asr-quality-ab/run-2512BY/drama.standard.json');

async function tone(file: string, seconds: number) {
  const samples = new Int16Array(16000 * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 3000));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, 16000, 1), new Uint8Array(samples.buffer)]));
  return file;
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('reviewing transcribed cues', () => {
  it('counts flagged cues, filters and moves through them, plays, recognizes, collapses, ignores and keeps the ignores', async () => {
    const fixture = await buildTranscriptionUiApp('controlled', { mediaRuntime: true });
    const artifacts = await createTestRun(path.resolve('test-results/studio-cue-review'));
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio', 'documents'));
    const create = async (name: string, segments: Segment[], durationMs: number, media?: string) => repository.create(transcriptToDocument({ schemaVersion: 1,
      source: { displayName: name, durationMs }, model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cuda' }, detectedLanguage: 'ja',
      segments: segments.map((segment, index) => ({ id: `s${index}`, ...segment })) }, { newId: randomUUID }), undefined, media ? await captureSourceInput(media) : undefined);
    await create('Review.wav', REVIEW, 40_000, await tone(path.join(fixture.artifacts, 'media', 'Review.wav'), 40));
    await create('Clean.wav', CLEAN, 12_000);
    await create('Old.wav', OLD, 15_000);
    await create('Many.wav', MANY, 2_400_000);
    await create('Paged.wav', PAGED, 460_000);
    // A real transcript from the A/B run (large-v3, its own confidence), when that run is on this computer.
    const real = existsSync(RUN) ? JSON.parse(await readFile(RUN, 'utf8')) as { cues: Segment[]; sample: { durationMs: number; path: string } } : undefined;
    if (real) await create('drama.standard.wav', real.cues, real.sample.durationMs, existsSync(real.sample.path) ? real.sample.path : undefined);
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')), r = locale.cue_review;
    const evidence: Record<string, unknown> = { realDocument: !!real };
    const errors: string[] = [];
    let app: ElectronApplication | undefined;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      const page: Page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15_000);
      const win = await app.browserWindow(page);
      await win.evaluate(window => window.webContents.setBackgroundThrottling(false));
      // The page's viewport is the target size; the frame is corrected by what the page reports.
      const size = async (width: number, height: number) => {
        await win.evaluate((window, [w, h]) => window.setSize(w, h), [width, height] as const);
        await page.waitForTimeout(300);
        const [innerW, innerH] = await page.evaluate(() => [innerWidth, innerHeight] as const);
        await win.evaluate((window, [w, h]) => window.setSize(w, h), [width * 2 - innerW, height * 2 - innerH] as const);
        await page.waitForFunction(([w, h]) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1, [width, height] as const);
      };
      const start = async (theme: 'light' | 'dark', lang = 'zh') => {
        await page.evaluate(([value, language]) => {
          localStorage.setItem('lang', language); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: value }, version: 0 }));
          location.hash = '/tools/subtitle/studio';
        }, [theme, lang] as const);
        await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      };
      const shot = async (name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      /** Moves the pointer off a mark in more than one step, as a hand does: a tooltip closes on the move after leaving. */
      const leave = async () => {
        await page.mouse.move(4, 4, { steps: 3 }); await page.mouse.move(8, 8);
        await uiExpect(page.locator('.studio-cue-review-tip')).toHaveCount(0);
      };
      const rows = page.locator('.studio-cue-table tbody tr[data-cue-id]');
      const row = (number: number) => rows.filter({ has: page.locator('.studio-cue-number-text', { hasText: new RegExp(`^${number}$`) }) });
      /** The listed rows' numbers, and each row's height by its number. */
      const numbers = () => rows.locator('.studio-cue-number-text').allTextContents().then(items => items.map(Number));
      const heightsByNumber = () => rows.evaluateAll(items => Object.fromEntries(items.map(item => [item.querySelector('.studio-cue-number-text')!.textContent, item.getBoundingClientRect().height])));
      const source = (number: number) => row(number).locator('[data-field=source]');
      const bar = page.getByTestId('studio-cue-review');
      const count = bar.getByTestId('studio-cue-review-count');
      const trigger = page.getByTestId('studio-cue-toolbar-review');
      const open = async (name: string) => {
        await page.getByTestId('studio-library-row').filter({ hasText: name }).locator('button.studio-document').click();
        await uiExpect(page.locator('.studio-document-heading')).toContainText(name);
        await uiExpect(rows.first()).toBeVisible();
      };
      const choose = async (label: RegExp) => {
        const filter = bar.locator('.studio-cue-review-filter');
        if (await filter.getAttribute('data-mode') === 'select') {
          await bar.getByTestId('studio-cue-review-filter').click();
          await page.getByRole('option', { name: label }).click();
          // A closing select leaves the rest of the page hidden from assistive technology for a moment.
          await uiExpect(page.locator('[data-slot=select-content]')).toHaveCount(0);
        } else await bar.getByRole('radio', { name: label }).click();
      };
      /** The bar and list geometry: the bar against the find bar's frame, the marks against their row and the number and time text. */
      const geometry = () => page.evaluate(() => {
        const rect = (element: Element | null) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const bar = document.querySelector('[data-testid=studio-cue-review]');
        const badges = Array.from(document.querySelectorAll('[data-testid=studio-cue-review-badge]')).map(badge => {
          const tr = badge.closest('tr')!, number = tr.querySelector('.studio-cue-number-text')!, time = tr.querySelector('.studio-time-range')!;
          return { badge: rect(badge), row: rect(tr), number: rect(number), time: rect(time) };
        });
        const plain = Array.from(document.querySelectorAll('.studio-cue-table tbody tr')).filter(tr => !tr.querySelector('[data-testid=studio-cue-review-badge]'))
          .slice(0, 3).map(tr => tr.getBoundingClientRect().height);
        const head = document.querySelector<HTMLTableSectionElement>('.studio-cue-table thead');
        return { viewport: [innerWidth, innerHeight], bar: rect(bar), scrollTop: document.querySelector('.studio-reader')?.scrollTop ?? 0,
          labelsRow: rect(head?.rows[0]?.cells[0] ?? null), barRow: rect(head?.rows[1]?.cells[0] ?? null), barStyle: bar && { padding: getComputedStyle(bar).padding, radius: getComputedStyle(bar).borderRadius },
          badges, plainRowHeights: plain, filterMode: document.querySelector('.studio-cue-review-filter')?.getAttribute('data-mode') ?? null,
          trigger: rect(document.querySelector('[data-testid=studio-cue-toolbar-review]')),
          overflow: Array.from(document.querySelectorAll('.studio-cue-review, .studio-cue-review-current, .studio-cue-find-row')).some(element => element.scrollWidth > element.clientWidth + 1) };
      });

      await start('light'); await size(1280, 800);
      await open('Review.wav');
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');
      // The toolbar counts the flagged cues; the rows show no marks until the bar is open.
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveText('8');
      await uiExpect(trigger).toHaveAccessibleName(r.open_count.replace('{{count}}', '8'));
      await uiExpect(page.getByTestId('studio-cue-review-badge')).toHaveCount(0);
      await uiExpect(rows).toHaveCount(14);
      const heights = await heightsByNumber();
      await trigger.click();
      await uiExpect(bar).toBeFocused();
      await uiExpect(count).toHaveText('第 1 / 8 条');
      await uiExpect(row(2)).toHaveAttribute('aria-selected', 'true');
      // The list shows only the flagged cues, each with its mark.
      const only = bar.getByTestId('studio-cue-review-only');
      await uiExpect(only).toHaveAttribute('aria-pressed', 'true');
      await uiExpect(only).toHaveAccessibleName(r.only);
      await uiExpect(rows).toHaveCount(8);
      expect(await numbers()).toEqual([2, 4, 5, 6, 7, 9, 12, 13]);
      await uiExpect(page.getByTestId('studio-cue-review-badge')).toHaveCount(8);
      await uiExpect(row(2).getByTestId('studio-cue-review-badge')).toHaveAttribute('data-current', 'true');
      await uiExpect(bar.getByTestId('studio-cue-review-current')).toContainText(`${r.reasons.low_confidence}、${r.reasons.phantom_phrase}`);
      // Marks change no row height; only the table's last row has no bottom border.
      for (const [number, height] of Object.entries(await heightsByNumber()).slice(0, -1)) expect(height, `row ${number}`).toBe(heights[number]);
      evidence.light1280 = await geometry();
      await shot('cue-review--01-bar-1280-light');
      await row(2).getByTestId('studio-cue-review-badge').hover();
      await uiExpect(page.locator('.studio-cue-review-tip')).toContainText('0.31');
      await shot('cue-review--02-badge-tip-1280-light');
      await leave();
      // Turned off, every row is listed again with the flagged ones marked; turned on, only those.
      await only.click();
      await uiExpect(only).toHaveAttribute('aria-pressed', 'false');
      await uiExpect(rows).toHaveCount(14);
      await uiExpect(page.getByTestId('studio-cue-review-badge')).toHaveCount(8);
      expect(await heightsByNumber()).toEqual(heights);
      await uiExpect(row(2)).toHaveAttribute('aria-selected', 'true');
      await shot('cue-review--03-all-rows-1280-light');
      await only.click();
      await uiExpect(rows).toHaveCount(8);

      // Enter and Shift+Enter move through the flagged cues, as the buttons do.
      await bar.focus(); await page.keyboard.press('Enter');
      await uiExpect(count).toHaveText('第 2 / 8 条'); await uiExpect(row(4)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Shift+Enter');
      await uiExpect(count).toHaveText('第 1 / 8 条'); await uiExpect(row(2)).toHaveAttribute('aria-selected', 'true');
      await bar.getByTestId('studio-cue-review-previous').click();
      await uiExpect(count).toHaveText('第 8 / 8 条'); await uiExpect(row(13)).toHaveAttribute('aria-selected', 'true');

      // Filtering by a reason lists only its cues; collapsing the repetition is an ordinary edit that undoes.
      await choose(new RegExp(`^${r.reasons.repetition_loop}`));
      await uiExpect(count).toHaveText('第 1 / 2 条'); await uiExpect(row(5)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(rows).toHaveCount(2);
      expect(await numbers()).toEqual([5, 12]);
      await shot('cue-review--04-filter-repetition-1280-light');
      await uiExpect(bar.getByTestId('studio-cue-review-collapse')).toHaveAccessibleName(r.collapse.replace('{{text}}', 'あ'));
      await bar.getByTestId('studio-cue-review-collapse').click();
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName(`撤销：${locale.cue_history.labels.collapse.replace('{{count}}', '1')}`);
      // Collapsed, line 5 is no longer flagged and leaves the list; the bar goes on to the next one.
      await uiExpect(count).toHaveText('第 1 / 1 条'); await uiExpect(row(12)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(row(5)).toHaveCount(0);
      await only.click();
      await uiExpect(source(5)).toHaveText('あ');
      await only.click();
      await page.getByTestId('studio-cue-undo').click();
      await uiExpect(source(5)).toHaveText(REVIEW[4].text);
      await uiExpect(count).toHaveText(/\/ 2 条$/);
      await choose(new RegExp(`^${r.all.replace(' {{count}}', '')}`));
      await uiExpect(count).toHaveText(/\/ 8 条$/);
      await uiExpect(rows).toHaveCount(8);

      // Play and recognize work on the current cue.
      while (await row(7).getAttribute('aria-selected') !== 'true') await bar.getByTestId('studio-cue-review-next').click();
      await uiExpect(bar.getByTestId('studio-cue-review-current')).toContainText(r.reasons.abnormal_rate);
      const play = bar.getByTestId('studio-cue-review-play');
      await play.click();
      await uiExpect(play).not.toHaveAttribute('data-state', 'idle');
      await uiExpect(play).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
      await bar.getByTestId('studio-cue-review-recognize').click();
      const recognize = page.getByRole('dialog', { name: locale.cue_recognize.title });
      await uiExpect(recognize).toBeVisible();
      await uiExpect(recognize.getByTestId('studio-cue-recognize-item')).toHaveCount(1);
      await uiExpect(recognize.getByTestId('studio-cue-recognize-item')).toContainText(REVIEW[6].text);
      await page.keyboard.press('Escape'); await uiExpect(recognize).toBeHidden();

      // Ignoring hides the flag on this computer; editing a low-confidence line drops its confidence flag.
      await bar.getByTestId('studio-cue-review-ignore').click();
      await uiExpect(count).toHaveText('第 5 / 7 条'); await uiExpect(row(9)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(row(7)).toHaveCount(0);
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveText('7');
      await uiExpect(bar.getByTestId('studio-cue-review-ignored')).toContainText(r.ignored.replace('{{count}}', '1'));
      await only.click();
      await uiExpect(row(7).getByTestId('studio-cue-review-badge')).toHaveCount(0);
      await source(6).dblclick();
      await page.locator('.studio-cue-editor textarea').fill('まだ朝なのに！');
      await page.keyboard.press('Enter');
      await uiExpect(source(6)).toHaveText('まだ朝なのに！');
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveText('6');
      await uiExpect(row(6).getByTestId('studio-cue-review-badge')).toHaveCount(0);
      await only.click();
      await uiExpect(rows).toHaveCount(6);
      expect(await numbers()).toEqual([2, 4, 5, 9, 12, 13]);
      // Esc in the bar closes it; every row and no mark is shown again.
      await bar.focus(); await page.keyboard.press('Escape');
      await uiExpect(bar).toBeHidden(); await uiExpect(page.getByTestId('studio-cue-review-badge')).toHaveCount(0);
      await uiExpect(rows).toHaveCount(14);

      // Opened again after a reload, the ignored flag stays hidden until it is restored.
      await start('light'); await open('Review.wav');
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveText('6');
      await trigger.click();
      await uiExpect(count).toHaveText('第 1 / 6 条');
      await uiExpect(row(7)).toHaveCount(0);
      await uiExpect(row(5).getByTestId('studio-cue-review-badge')).toHaveCount(1);
      await uiExpect(bar.getByTestId('studio-cue-review-ignored')).toContainText(r.ignored.replace('{{count}}', '1'));
      evidence.ignored1280 = await geometry();
      await shot('cue-review--05-ignored-note-1280-light');
      await bar.getByTestId('studio-cue-review-restore').click();
      await uiExpect(bar.getByTestId('studio-cue-review-ignored')).toHaveCount(0);
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveText('7');
      await uiExpect(count).toHaveText(/\/ 7 条$/);
      await uiExpect(row(7).getByTestId('studio-cue-review-badge')).toHaveCount(1);

      // No flags; text rules only; more than 999 flags across twelve pages; a page without flags.
      await open('Clean.wav');
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveCount(0);
      await uiExpect(bar).toBeVisible();
      await uiExpect(count).toHaveText(r.none);
      await uiExpect(bar.getByTestId('studio-cue-review-next')).toBeDisabled();
      await uiExpect(only).toBeDisabled(); await uiExpect(only).toHaveAttribute('aria-pressed', 'false');
      await uiExpect(bar.locator('.studio-cue-review-filter')).toHaveCount(0);
      await uiExpect(rows).toHaveCount(4);
      await shot('cue-review--06-none-1280-light');
      await open('Old.wav');
      await uiExpect(bar.getByTestId('studio-cue-review-no-confidence')).toHaveText(r.no_confidence);
      await uiExpect(count).toHaveText('第 1 / 2 条');
      await uiExpect(bar.locator('.studio-cue-review-filter')).toHaveAttribute('data-mode', 'segments');
      expect(await numbers()).toEqual([2, 4]);
      evidence.old1280 = await geometry();
      await shot('cue-review--07-old-1280-light');
      await open('Many.wav');
      await uiExpect(page.getByTestId('studio-cue-toolbar-review-count')).toHaveText('999+');
      await uiExpect(count).toHaveText('第 1 / 1200 条');
      await bar.focus(); await page.keyboard.press('Shift+Enter');
      await uiExpect(count).toHaveText('第 1200 / 1200 条');
      await uiExpect(row(1200)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(page.getByTestId('studio-cue-review-badge')).toHaveCount(100);
      evidence.many1280 = await geometry();
      await shot('cue-review--08-many-1280-light');
      // Next goes from page one to page three; the middle page, turned to by hand, says it has none.
      await open('Paged.wav');
      await uiExpect(count).toHaveText('第 1 / 2 条');
      expect(await numbers()).toEqual([3]);
      await bar.getByTestId('studio-cue-review-next').click();
      await uiExpect(count).toHaveText('第 2 / 2 条'); await uiExpect(row(205)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(rows).toHaveCount(1);
      await page.locator('.studio-reader-footer').getByRole('button', { name: locale.previous }).click();
      await uiExpect(page.locator('.studio-reader-footer .studio-range')).toContainText('101–200');
      await uiExpect(page.getByTestId('studio-cue-review-page-empty')).toHaveText(r.page_empty);
      await uiExpect(rows).toHaveCount(0);
      evidence.pagedEmpty1280 = await page.evaluate(() => {
        const empty = document.querySelector('[data-testid=studio-cue-review-page-empty]')!.getBoundingClientRect();
        const head = document.querySelector('.studio-cue-table thead')!.getBoundingClientRect();
        return { empty: { top: empty.top, height: empty.height, width: empty.width }, headBottom: head.bottom };
      });
      await shot('cue-review--09-page-without-flags-1280-light');
      await bar.getByTestId('studio-cue-review-next').click();
      await uiExpect(count).toHaveText('第 1 / 2 条'); await uiExpect(row(3)).toHaveAttribute('aria-selected', 'true');
      if (real) {
        await open('drama.standard.wav');
        await uiExpect(count).toHaveText(/^第 1 \/ \d+ 条$/);
        evidence.real1280 = { count: await count.textContent(), toolbar: await page.getByTestId('studio-cue-toolbar-review-count').textContent(), rows: await numbers() };
        await shot('cue-review--10-real-drama-1280-light');
      }

      // Dark, at 1280 × 800 and 1024 × 700.
      await start('dark'); await size(1024, 700);
      await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await size(1280, 800); await open('Review.wav');
      await trigger.click();
      await uiExpect(count).toHaveText('第 1 / 7 条');
      evidence.dark1280 = await geometry();
      await shot('cue-review--11-bar-1280-dark');
      await size(1024, 700);
      evidence.dark1024 = await geometry();
      await shot('cue-review--12-bar-1024-dark');
      await bar.getByTestId('studio-cue-review-filter').click();
      await shot('cue-review--13-filter-open-1024-dark');
      await page.keyboard.press('Escape');
      await uiExpect(page.locator('[data-slot=select-content]')).toHaveCount(0);
      await row(2).getByTestId('studio-cue-review-badge').hover();
      await shot('cue-review--14-badge-tip-1024-dark');
      await leave();
      await size(1280, 800); await open('Old.wav'); await size(1024, 700);
      await shot('cue-review--15-old-1024-dark');
      await size(1280, 800); await open('Many.wav'); await size(1024, 700);
      evidence.manyDark1024 = await geometry();
      await shot('cue-review--16-many-1024-dark');
      // Longer English labels at 1024.
      await start('dark', 'en'); await size(1280, 800); await open('Review.wav'); await size(1024, 700);
      await trigger.click();
      evidence.english1024 = await geometry();
      await shot('cue-review--17-bar-1024-dark-en');
      await start('light'); await size(1024, 700);
      await size(1280, 800); await open('Review.wav'); await size(1024, 700);
      await trigger.click();
      evidence.light1024 = await geometry();
      await shot('cue-review--18-bar-1024-light');
      for (const key of ['light1280', 'ignored1280', 'old1280', 'many1280', 'dark1280', 'dark1024', 'manyDark1024', 'english1024', 'light1024']) {
        const value = evidence[key] as { overflow: boolean; labelsRow: { bottom: number } | null; barRow: { top: number } | null; badges: { badge: { left: number; right: number; top: number; bottom: number }; row: { top: number; bottom: number }; number: { right: number }; time: { left: number } }[] };
        expect(value.overflow, key).toBe(false);
        // Scrolled or not, the bar's row sticks below the column labels and toolbar, never over them.
        expect(value.barRow!.top, key).toBeGreaterThanOrEqual(value.labelsRow!.bottom - 1);
        // Each mark sits inside its row, clear of the number and of the time text.
        for (const item of value.badges) {
          expect(item.badge.top, key).toBeGreaterThanOrEqual(item.row.top);
          expect(item.badge.bottom, key).toBeLessThanOrEqual(item.row.bottom);
          expect(item.badge.left, key).toBeGreaterThanOrEqual(item.number.right);
          expect(item.badge.right, key).toBeLessThanOrEqual(item.time.left);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await writeFile(path.join(artifacts, 'evidence.json'), JSON.stringify({ ...evidence, errors }, null, 2));
      await app?.close().catch(() => undefined); await fixture.cleanup();
    }
  }, 300_000);
});
