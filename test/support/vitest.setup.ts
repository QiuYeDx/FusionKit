import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { guardElectronLaunch, takeErrorBoxReports } from '../../scripts/guard-electron-launch.mjs';
import { joinUiTestRun, leaveUiTestRun } from '../../scripts/ui-test-lock.mjs';

const require = createRequire(import.meta.url);

// A test file that loaded Playwright may launch Electron or copy dist/ and dist-electron/. Before its own
// hooks and tests run, guard its launches and register it, so a build waits for it and it waits for a build.
// The timeout outlasts joinUiTestRun's own, whose message says which build it waited for.
beforeAll(async () => {
  if (!Object.keys(require.cache).some(id => /[\\/]playwright-core[\\/]/.test(id))) return;
  guardElectronLaunch(require('@playwright/test')._electron);
  await joinUiTestRun();
}, 16 * 60 * 1000);

// Electron's error boxes go to stderr and a report file in tests (scripts/electron-launch-guard.cjs). A box used
// to block the app, so a report still fails the test (or the file's afterAll) during which it is collected; with
// an app shared across tests, a late main-process error from one test can surface in the next.
function failOnErrorBoxes() {
  const reports = takeErrorBoxReports();
  if (reports.length) throw new Error(`Electron reported an error in the main process since the previous check (it may come from an earlier test that shares this app):\n${reports.join('\n')}`);
}
afterEach(failOnErrorBoxes);
afterAll(() => {
  leaveUiTestRun();
  failOnErrorBoxes();
});
