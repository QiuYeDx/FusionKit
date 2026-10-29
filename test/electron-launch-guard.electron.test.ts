import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { LAUNCH_GUARD, missingAppEntry, REPORT_PREFIX, takeErrorBoxReports } from '../scripts/guard-electron-launch.mjs';
import { liveUiTestRuns } from '../scripts/ui-test-lock.mjs';
import { createTestRun } from './support/testRun';

const artifacts = path.resolve('test-results/electron-launch-guard');
const skip = process.platform === 'linux' || process.env.CODEX_SANDBOX === 'seatbelt' || process.env.FUSIONKIT_SKIP_E2E === '1';

describe.skipIf(skip)('Electron UI test launches', () => {
  let app: ElectronApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('load the launch guard ahead of the app, so Electron error boxes never reach the screen', async () => {
    // vitest.setup.ts registered this file with the build lock before it started.
    expect(liveUiTestRuns().map(entry => entry.pid)).toContain(process.pid);
    const run = await createTestRun(artifacts);
    // A plain test-file launch: vitest.setup.ts has guarded the shared `_electron`.
    app = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(run, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' },
    });
    await app.firstWindow();
    const main = await app.evaluate(({ dialog }) => ({ argv: process.argv, cwd: process.cwd(), showErrorBox: dialog.showErrorBox.name }));

    expect(main.argv).toContain(LAUNCH_GUARD);
    expect(main.showErrorBox).toBe('reportErrorBoxToStderr');
    // The guard reads this same argv inside Electron: from a checkout without dist-electron/ it exits first.
    expect(missingAppEntry(main.argv.slice(1), main.cwd)).toBeNull();
    expect(missingAppEntry(main.argv.slice(1), run)).toMatch(/does not exist/);

    // An uncaught main-process error: Electron's own handler reports it with dialog.showErrorBox, which the
    // guard (checked above, so no box can reach the screen) turns into a report for the test.
    await app.evaluate(() => { setTimeout(() => { throw new Error('launch guard probe'); }); });
    const reports: string[] = [];
    for (let tries = 0; tries < 50 && !reports.some(line => line.includes('launch guard probe')); tries++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      reports.push(...takeErrorBoxReports());
    }
    expect(reports[0]).toBe(`${REPORT_PREFIX} A JavaScript error occurred in the main process`);
    expect(reports.join('\n')).toContain('Error: launch guard probe');
  }, 120_000);
});
