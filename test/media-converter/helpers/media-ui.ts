import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'vitest';
import { _electron as electron, type ElectronApplication, type JSHandle, type Page } from 'playwright/test';
import type { BrowserWindow } from 'electron';
import {
  TEST_MEDIA_CAPS_ENV, TEST_MEDIA_FAIL_ENV, TEST_MEDIA_REVEAL_ENV,
  parseMediaCapsOverride, parseMediaFailInjection, type MediaFailCode,
} from '../../../electron/main/media-converter/test-hooks';
import type { EngineReasonCode } from '../../../src/media-converter/contract';
import { createTestRun } from '../../support/testRun';

/**
 * The media converter's Electron UI tests (module-workbench tasks, 通用验证约定): one quiet app per
 * launch with its own profile in a run folder under test-results/media-converter, media made there by
 * the bundled ffmpeg at idle priority, the native dialogs and the shell replaced, drops simulated with
 * OS-backed Files, and the main process's test switches (module-engine design §9). Run them after
 * `pnpm run pretest` with FUSIONKIT_MEDIA_E2E=1.
 *
 * The window stays as vitest.config.ts makes it: quiet (off-screen, never focused, muted, no system
 * notifications), because the environment keeps FUSIONKIT_TEST_WINDOW from `process.env`.
 */

export const MEDIA_UI_E2E = process.env.FUSIONKIT_MEDIA_E2E === '1';
/** `describe`, run only with FUSIONKIT_MEDIA_E2E=1. */
export const describeMediaUi = describe.runIf(MEDIA_UI_E2E);

export const MEDIA_ARTIFACTS = path.resolve('test-results/media-converter');
/**
 * Where review screenshots are copied as well, when set (for example
 * docs/features/media-converter/records/i1/screenshots); the run folder always gets them.
 */
export const REVIEW_DIR_ENV = 'FUSIONKIT_MEDIA_REVIEW_DIR';

/** The run folder of the current test (`createTestRun`): folders in it go when the test passes, files at its top stay. */
export const createMediaRun = () => createTestRun(MEDIA_ARTIFACTS, 'ui-');

// ── Test switches ──────────────────────────────────────────────────────────────────────────────

/** `FUSIONKIT_TEST_MEDIA_CAPS`, as electron/main/media-converter/test-hooks.ts reads it. */
export type MediaCapsSwitch = 'cpu_only' | 'nvenc' | `unavailable:${EngineReasonCode}` | `detecting_ms:${number}`;
/** `FUSIONKIT_TEST_MEDIA_FAIL`: the first ffmpeg run of every item fails with that code. */
export type MediaFailSwitch = `${MediaFailCode}:first_attempt`;

export interface MediaSwitches {
  caps?: MediaCapsSwitch;
  fail?: MediaFailSwitch;
  /** `record`: "show in folder" is logged (see `revealedFiles`) instead of opening Explorer. */
  reveal?: 'record';
}

/**
 * The app's environment: the built renderer of a test build (NODE_ENV=test, which the switches need),
 * everything else of `process.env` (the quiet window mode among it) except switches left over from the
 * shell, then `switches`. A switch the main process would ignore as malformed fails here instead.
 */
export function mediaEnv(switches: MediaSwitches = {}): Record<string, string> {
  const value: Record<string, string> = { VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' };
  const dropped = new Set(['ELECTRON_RUN_AS_NODE', 'FUSIONKIT_TEST_ONBOARDING', TEST_MEDIA_CAPS_ENV, TEST_MEDIA_FAIL_ENV, TEST_MEDIA_REVEAL_ENV]);
  for (const [key, entry] of Object.entries(process.env)) {
    if (entry !== undefined && !(key in value) && !dropped.has(key)) value[key] = entry;
  }
  if (switches.caps !== undefined) {
    if (!parseMediaCapsOverride(switches.caps)) throw new Error(`${TEST_MEDIA_CAPS_ENV}=${switches.caps} would be ignored`);
    value[TEST_MEDIA_CAPS_ENV] = switches.caps;
  }
  if (switches.fail !== undefined) {
    if (!parseMediaFailInjection(switches.fail)) throw new Error(`${TEST_MEDIA_FAIL_ENV}=${switches.fail} would be ignored`);
    value[TEST_MEDIA_FAIL_ENV] = switches.fail;
  }
  if (switches.reveal !== undefined) value[TEST_MEDIA_REVEAL_ENV] = switches.reveal;
  return value;
}

// ── The app ────────────────────────────────────────────────────────────────────────────────────

export interface MediaApp {
  app: ElectronApplication;
  page: Page;
  window: JSHandle<BrowserWindow>;
  /** Uncaught renderer errors. */
  errors: string[];
  /** The main process's stdout and stderr, line by line. */
  mainLog: string[];
  close(): Promise<void>;
}

export interface LaunchOptions {
  run: string;
  /** The profile folder in the run (`--user-data-dir`); launching again with the same one keeps the queue. */
  profile?: string;
  switches?: MediaSwitches;
  /**
   * `unsupported`: the preload runs as on macOS, so `window.mediaConverter.supported` is false (I4).
   * Only the renderer's view changes; the main process still runs the Windows engine.
   */
  platform?: 'unsupported';
  /** The window's outer size; 1080×786 is the app's default. */
  size?: { width: number; height: number };
}

const UNSUPPORTED_PRELOAD = `"use strict";
// FusionKit media converter UI test: the app preload after this one sees another platform.
Object.defineProperty(process, "platform", { value: "darwin", configurable: true, enumerable: true });
`;

export async function launchMediaApp(options: LaunchOptions): Promise<MediaApp> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(options.run, options.profile ?? 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(),
    env: mediaEnv(options.switches),
  });
  try {
    const mainLog: string[] = [];
    // Whole lines only: a chunk can end in the middle of one, and each stream keeps its own rest.
    const collector = () => {
      let rest = '';
      return (chunk: Buffer) => {
        const lines = (rest + chunk.toString('utf8')).split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) if (line) mainLog.push(line);
      };
    };
    app.process().stdout?.on('data', collector());
    app.process().stderr?.on('data', collector());
    const page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    const window = await app.browserWindow(page);
    await stubShell(app);
    if (options.platform === 'unsupported') {
      const preload = path.join(options.run, 'platform-unsupported.preload.js');
      await writeFile(preload, UNSUPPORTED_PRELOAD);
      await app.evaluate(({ session }, filePath) => { session.defaultSession.registerPreloadScript({ type: 'frame', id: 'media-ui-platform', filePath }); }, preload);
      await page.reload();
    }
    await waitForApp(page);
    if (options.size) await setWindowSize({ page, window }, options.size);
    let closed = false;
    return {
      app, page, window, errors, mainLog,
      close: async () => {
        if (closed) return;
        closed = true;
        await app.close();
      },
    };
  } catch (error) {
    // The test never gets a handle to an app that failed to come up, so nothing else would close it.
    await app.close().catch(() => undefined);
    throw error;
  }
}

/** The global loading screen is gone (FK-PIT-0001) and the app has rendered. */
export async function waitForApp(page: Page) {
  await page.waitForFunction(() => Boolean(document.querySelector('#root')?.firstElementChild)
    && !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'), undefined, { timeout: 30_000 });
}

/**
 * Nothing moves any more: no finite animation running (a spinner or an idle orb loops forever), and
 * the boxes of `selector` the same over five frames (Motion runs some transforms off the Web
 * Animations API).
 */
export async function settle(page: Page, selector = 'h1, main, [data-tool-card], [data-slot=tool-panel]') {
  await page.waitForFunction(selector => new Promise<boolean>(resolve => {
    const boxes = () => JSON.stringify([...document.querySelectorAll(selector)].map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height, getComputedStyle(element).opacity];
    }));
    let last = boxes();
    let same = 0;
    const frame = () => {
      const next = boxes();
      same = next === last ? same + 1 : 0;
      last = next;
      if (same >= 5) {
        resolve(document.getAnimations().every(animation => animation.effect?.getTiming().iterations === Infinity || animation.playState !== 'running'));
      }
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }), selector, { timeout: 15_000, polling: 100 });
}

/** Goes to a route the way a link does (the hash router), then waits for its page. */
export async function openRoute(page: Page, route: string) {
  await page.evaluate(route => { location.hash = route; }, route);
  if (route === '/tools') await page.locator('[data-testid=tools-catalog]').waitFor();
  else if (route.startsWith('/tools/')) await page.locator('[data-slot=tool-detail-layout]').first().waitFor();
  await settle(page);
}

export type Theme = 'light' | 'dark';
export type Language = 'zh' | 'en' | 'ja' | 'zh-Hant';

/**
 * Theme and language as the app keeps them (the `fusionkit-theme` store and `lang`), then a reload
 * so both stores read them again, as the other Electron UI tests do; `route` is where to land.
 */
export async function setAppearance(page: Page, appearance: { theme: Theme; language: Language; route?: string }) {
  await page.evaluate(({ theme, language, route }) => {
    localStorage.setItem('lang', language);
    localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    if (route) location.hash = route;
  }, appearance);
  await page.reload();
  await waitForApp(page);
  const dark = await page.locator('html').evaluate(element => element.classList.contains('dark'));
  if (dark !== (appearance.theme === 'dark')) throw new Error(`The ${appearance.theme} theme did not apply`);
  if (appearance.route) await openRoute(page, appearance.route);
}

/**
 * The window's outer size (the minimum is 786×540). Off-screen, the page is a few pixels larger than
 * the size given (FK-PIT-0188); the page's own size is returned.
 */
export async function setWindowSize(target: Pick<MediaApp, 'page' | 'window'>, size: { width: number; height: number }) {
  await target.window.evaluate((win, { width, height }) => win.setSize(width, height), size);
  await target.page.waitForFunction(({ width, height }) => Math.abs(innerWidth - width) <= 16 && Math.abs(innerHeight - height) <= 16, size);
  await settle(target.page);
  return target.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

/**
 * Whether anything sticks out sideways. The window itself can never scroll: the app clips sideways
 * overflow under its scroll area (`overflow-x-clip` in App.tsx), so the page roots are measured as
 * well, whose scroll width counts every descendant not clipped on the way.
 */
export const hasHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1
  || [...document.querySelectorAll('[data-testid=tools-catalog], [data-slot=tool-detail-layout]')]
    .some(root => root.scrollWidth > root.clientWidth + 1 || root.getBoundingClientRect().right > innerWidth + 1));

/**
 * A JPEG (quality 85) of the page, or of `clip`, into the run folder, and into FUSIONKIT_MEDIA_REVIEW_DIR
 * as well when that is set. Returns the run folder's file.
 */
export async function shoot(page: Page, run: string, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  const file = path.join(run, `${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 85, clip, animations: 'disabled' });
  const review = process.env[REVIEW_DIR_ENV];
  if (review) {
    await mkdir(review, { recursive: true });
    await copyFile(file, path.join(review, `${name}.jpg`));
  }
  return file;
}

// ── Native dialogs, the shell and notifications ────────────────────────────────────────────────

export interface DialogAnswer {
  /** What "select files" returns; empty: the user cancelled. */
  files?: string[];
  /** What "select folder" returns; null: the user cancelled. */
  directory?: string | null;
}

export interface DialogCall {
  properties: string[];
  filters: { name: string; extensions: string[] }[];
}

type DialogGlobals = typeof globalThis & { __mediaDialogAnswer?: DialogAnswer; __mediaDialogCalls?: DialogCall[] };

/**
 * Replaces the main process's open dialog: it answers `answer` and records what it was asked. Save
 * dialogs answer "cancelled". Call again to change the answer.
 */
export async function stubDialogs(app: ElectronApplication, answer: DialogAnswer) {
  await app.evaluate(({ dialog }, answer) => {
    const globals = globalThis as DialogGlobals;
    globals.__mediaDialogAnswer = answer;
    globals.__mediaDialogCalls ??= [];
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as Electron.OpenDialogOptions;
      const properties = [...(options.properties ?? [])];
      globals.__mediaDialogCalls!.push({ properties, filters: (options.filters ?? []).map(filter => ({ name: filter.name, extensions: [...filter.extensions] })) });
      const current = globals.__mediaDialogAnswer ?? {};
      if (properties.includes('openDirectory')) {
        return current.directory ? { canceled: false, filePaths: [current.directory] } : { canceled: true, filePaths: [] };
      }
      const files = current.files ?? [];
      return { canceled: files.length === 0, filePaths: files };
    }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as unknown as typeof dialog.showSaveDialog;
  }, answer);
}

export const dialogCalls = (app: ElectronApplication) => app.evaluate(() => [...((globalThis as DialogGlobals).__mediaDialogCalls ?? [])]);

type ShellGlobals = typeof globalThis & { __mediaShellCalls?: { kind: string; target: string }[] };

/**
 * Nothing opens outside the app: "show in folder", opening files and links are recorded. Moving to
 * the recycle bin (overwriting, design §7 of module-engine) deletes the test file instead, so tests
 * never fill the user's recycle bin; it is recorded too. A deletion is permanent, so only a path
 * inside the media test runs (MEDIA_ARTIFACTS) is deleted; anything else is refused, never touched.
 */
export async function stubShell(app: ElectronApplication) {
  await app.evaluate(({ shell }, runs) => {
    const globals = globalThis as ShellGlobals;
    const calls = globals.__mediaShellCalls ??= [];
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
    const path = process.getBuiltinModule('node:path') as typeof import('node:path');
    shell.showItemInFolder = target => { calls.push({ kind: 'showItemInFolder', target }); };
    shell.openPath = async target => { calls.push({ kind: 'openPath', target }); return ''; };
    shell.openExternal = async target => { calls.push({ kind: 'openExternal', target }); };
    shell.trashItem = async target => {
      calls.push({ kind: 'trashItem', target });
      const relative = path.relative(runs, path.resolve(target));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`The test shell refuses to delete ${target}, outside ${runs}`);
      await fs.promises.rm(target, { recursive: true, force: true });
    };
  }, MEDIA_ARTIFACTS);
}

export const shellCalls = (app: ElectronApplication) => app.evaluate(() => [...((globalThis as ShellGlobals).__mediaShellCalls ?? [])]);

/** The file names "show in folder" recorded with `switches.reveal = 'record'`, from the main process's log. */
export function revealedFiles(media: Pick<MediaApp, 'mainLog'>): string[] {
  return media.mainLog.flatMap(line => /\[media-converter\] reveal-output recorded: (.+)$/.exec(line)?.[1] ?? []);
}

type NotificationGlobals = typeof globalThis & { __mediaNotifications?: { title: string; body: string }[] };

/** Records the system notifications the main process would show (quiet mode shows none anyway). */
export async function recordNotifications(app: ElectronApplication) {
  await app.evaluate(({ Notification }) => {
    const globals = globalThis as NotificationGlobals;
    const records = globals.__mediaNotifications ??= [];
    Notification.prototype.show = function show(this: Electron.Notification) { records.push({ title: this.title, body: this.body }); };
  });
}

export const notifications = (app: ElectronApplication) => app.evaluate(() => [...((globalThis as NotificationGlobals).__mediaNotifications ?? [])]);

// ── Drops ──────────────────────────────────────────────────────────────────────────────────────

const dispatchDrop = (page: Page, target: string, marker: string) => page.evaluate(({ target, marker }) => {
  const input = document.querySelector<HTMLInputElement>(`[${marker}]`)!;
  const element = document.querySelector(target);
  if (!element) throw new Error(`No drop target ${target}`);
  const transfer = new DataTransfer();
  for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
  for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  input.remove();
}, { target, marker });

/**
 * Drops files from disk on `target` (a selector) as Explorer would: the Files are OS-backed, so the
 * preload can read their paths. They must not be in %TEMP%, where the drop resolver refuses them as
 * temporary copies (FK-PIT-0099).
 */
export async function dropFiles(page: Page, target: string, files: string[]) {
  // os.tmpdir() can be an 8.3 short name (C:\Users\ADMINI~1\...): compare long forms as well.
  const forms = async (entry: string) => [...new Set([path.resolve(entry), await realpath(entry).catch(() => path.resolve(entry))])]
    .map(form => form.toLowerCase());
  const temps = (await forms(os.tmpdir())).map(temp => temp + path.sep);
  for (const file of files) {
    if ((await forms(file)).some(form => temps.some(temp => form.startsWith(temp)))) throw new Error(`${file} is in %TEMP%; make test media in the run folder`);
  }
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.setAttribute('data-media-ui-drop', '');
    document.body.append(input);
  });
  await page.locator('[data-media-ui-drop]').setInputFiles(files);
  await dispatchDrop(page, target, 'data-media-ui-drop');
}

/** Drops Files made in the page, which have no path on disk (as a copy an archive viewer drags out might not). */
export async function dropVirtualFiles(page: Page, target: string, files: { name: string; content: string }[]) {
  await page.evaluate(({ target, files }) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`No drop target ${target}`);
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([file.content], file.name));
    for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { target, files });
}

// ── Media ──────────────────────────────────────────────────────────────────────────────────────

export const BUNDLED_FFMPEG = path.resolve('build/subtitle-studio-resources/transcription/win-x64/media/ffmpeg.exe');
const FFMPEG_DEADLINE_MS = 60_000;

/** lavfi sources: 2 s at most and 640×360 at most unless a test needs otherwise. */
export const lavfi = {
  video: ({ size = '320x180', rate = 25, seconds = 2 }: { size?: string; rate?: number; seconds?: number } = {}) =>
    ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`],
  tone: ({ seconds = 2, sampleRate = 48_000, frequency = 440 }: { seconds?: number; sampleRate?: number; frequency?: number } = {}) =>
    ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${sampleRate}:duration=${seconds}`],
};

/** Ready-made samples: arguments between the inputs and the output file. */
export const SAMPLES = {
  /** H.264 (OpenH264) and AAC in MP4, 320×180, 2 s. */
  'h264-aac.mp4': [...lavfi.video(), ...lavfi.tone(), '-c:v', 'libopenh264', '-b:v', '300k', '-c:a', 'aac', '-b:a', '96k', '-shortest'],
  /** FLAC, 2 s, no picture. */
  'tone.flac': [...lavfi.tone(), '-c:a', 'flac'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Makes `<run>/media/<name>` with the bundled ffmpeg (`-y`, the arguments, the file), at idle priority
 * so a game in front keeps its frames. Returns the file.
 */
export async function makeMedia(run: string, name: string, args: readonly string[]): Promise<string> {
  await access(BUNDLED_FFMPEG).catch(() => { throw new Error(`The bundled ffmpeg is not staged at ${BUNDLED_FFMPEG}`); });
  const folder = path.join(run, 'media');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, name);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(BUNDLED_FFMPEG, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-y', ...args, file],
      { cwd: folder, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* It has exited already. */ }
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ffmpeg did not make ${name} in ${FFMPEG_DEADLINE_MS} ms`)); }, FFMPEG_DEADLINE_MS);
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg could not make ${name} (exit ${code}): ${stderr}`));
    });
  });
  return file;
}

/** `makeMedia` with one of `SAMPLES`, under its own name or `as`. */
export const makeSample = (run: string, sample: keyof typeof SAMPLES, as: string = sample) => makeMedia(run, as, SAMPLES[sample]);
